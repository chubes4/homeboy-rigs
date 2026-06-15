<?php
/**
 * WP Codebox-backed WooCommerce checkout atomicity and side-effect guardrail workload.
 *
 * Reproduces the duplicate public create_order window, records side-effect
 * guardrails, and fires true concurrent checkout requests for:
 * - https://github.com/woocommerce/woocommerce/issues/62659
 * - https://github.com/woocommerce/woocommerce/pull/65588
 * - https://github.com/woocommerce/woocommerce/pull/65588#pullrequestreview-4488383929
 * - https://github.com/chubes4/homeboy-rigs/issues/253
 * - https://github.com/chubes4/homeboy-rigs/issues/254
 */
return function (): array {
	if ( ! class_exists( 'WooCommerce' ) ) {
		$woocommerce_entrypoint = WP_PLUGIN_DIR . '/woocommerce/woocommerce.php';
		if ( ! file_exists( $woocommerce_entrypoint ) ) {
			throw new RuntimeException( 'WooCommerce plugin entrypoint is not mounted.' );
		}
		require_once $woocommerce_entrypoint;
	}

	if ( ! class_exists( 'WooCommerce' ) || ! function_exists( 'WC' ) ) {
		throw new RuntimeException( 'WooCommerce is not loaded.' );
	}
	if ( ! function_exists( 'wc_load_cart' ) || ! class_exists( 'WC_Session_Handler' ) || ! class_exists( 'WC_Cart' ) || ! class_exists( 'WC_Cart_Session' ) ) {
		throw new RuntimeException( 'WooCommerce cart/session classes are not available.' );
	}
	if ( ! function_exists( 'curl_multi_init' ) ) {
		throw new RuntimeException( 'PHP cURL multi support is required for true concurrent checkout requests.' );
	}
	if ( ! did_action( 'before_woocommerce_init' ) ) {
		do_action( 'before_woocommerce_init' );
	}
	if ( ! WC()->countries && class_exists( 'WC_Countries' ) ) {
		WC()->countries = new WC_Countries();
	}
	if ( ! WC()->order_factory && class_exists( 'WC_Order_Factory' ) ) {
		WC()->order_factory = new WC_Order_Factory();
	}
	if ( ! WC()->payment_gateways && class_exists( 'WC_Payment_Gateways' ) ) {
		WC()->payment_gateways = new WC_Payment_Gateways();
	}

	global $wpdb;

	$run_id = 'woocommerce-checkout-concurrent-create-order-' . getmypid() . '-' . time() . '-' . wp_generate_password( 6, false );
	$issues = array(
		'https://github.com/woocommerce/woocommerce/issues/14541',
		'https://github.com/woocommerce/woocommerce/issues/62659',
		'https://github.com/woocommerce/woocommerce/issues/43770',
		'https://github.com/woocommerce/woocommerce/pull/65588',
		'https://github.com/woocommerce/woocommerce/pull/65588#pullrequestreview-4488383929',
		'https://github.com/chubes4/homeboy-rigs/issues/253',
		'https://github.com/chubes4/homeboy-rigs/issues/254',
	);
	$request_count = max( 2, min( 8, absint( getenv( 'WC_CONCURRENT_CHECKOUT_REQUESTS' ) ?: 2 ) ) );
	$iterations    = max( 1, min( 10, absint( getenv( 'WC_CONCURRENT_CHECKOUT_ITERATIONS' ) ?: 3 ) ) );
	$payment_mode  = 'free' === strtolower( (string) getenv( 'WC_CONCURRENT_CHECKOUT_PAYMENT_MODE' ) ) ? 'free' : 'cod';
	$checkout_url  = getenv( 'WC_CONCURRENT_CHECKOUT_URL' ) ?: home_url( '/?wc-ajax=checkout' );

	wp_set_current_user( 0 );
	update_option( 'woocommerce_default_country', 'US:CA' );
	update_option( 'woocommerce_currency', 'USD' );
	update_option( 'woocommerce_prices_include_tax', 'no' );
	update_option( 'woocommerce_calc_taxes', 'no' );
	update_option( 'woocommerce_enable_guest_checkout', 'yes' );
	update_option( 'woocommerce_enable_coupons', 'yes' );
	update_option( 'woocommerce_enable_checkout_login_reminder', 'no' );
	update_option(
		'woocommerce_cod_settings',
		array(
			'enabled'            => 'yes',
			'title'              => 'Cash on delivery',
			'description'        => 'Pay with cash upon delivery.',
			'instructions'       => 'Homeboy concurrent checkout COD probe.',
			'enable_for_methods' => array(),
			'enable_for_virtual' => 'yes',
		)
	);

	if ( ! WC()->session ) {
		if ( method_exists( WC(), 'initialize_session' ) ) {
			WC()->initialize_session();
		} elseif ( class_exists( 'WC_Session_Handler' ) ) {
			WC()->session = new WC_Session_Handler();
			WC()->session->init();
		}
	}
	if ( WC()->session ) {
		WC()->session->set_customer_session_cookie( true );
		WC()->session->__unset( 'order_awaiting_payment' );
	}

	wc_load_cart();
	if ( ! WC()->cart ) {
		throw new RuntimeException( 'WooCommerce cart failed to initialize.' );
	}

	$product = new WC_Product_Simple();
	$product->set_name( 'Homeboy Concurrent Checkout Product ' . $run_id );
	$product->set_slug( 'homeboy-concurrent-checkout-' . $run_id );
	$product->set_status( 'publish' );
	$product->set_sku( 'homeboy-concurrent-checkout-' . $run_id );
	$product->set_regular_price( '19.99' );
	$product->set_price( '19.99' );
	$product->set_virtual( true );
	$product->set_manage_stock( false );
	$product->set_stock_status( 'instock' );
	$product->save();

	$email = 'homeboy-' . $run_id . '@example.com';
	$data  = array(
		'billing_first_name'        => 'Homeboy',
		'billing_last_name'         => 'Checkout',
		'billing_company'           => '',
		'billing_country'           => 'US',
		'billing_address_1'         => '123 Atomicity Way',
		'billing_address_2'         => '',
		'billing_city'              => 'San Francisco',
		'billing_state'             => 'CA',
		'billing_postcode'          => '94107',
		'billing_phone'             => '5555555555',
		'billing_email'             => $email,
		'shipping_first_name'       => 'Homeboy',
		'shipping_last_name'        => 'Checkout',
		'shipping_company'          => '',
		'shipping_country'          => 'US',
		'shipping_address_1'        => '123 Atomicity Way',
		'shipping_address_2'        => '',
		'shipping_city'             => 'San Francisco',
		'shipping_state'            => 'CA',
		'shipping_postcode'         => '94107',
		'order_comments'            => 'Homeboy checkout atomicity repro ' . $run_id,
		'payment_method'            => '',
		'terms'                     => 1,
		'createaccount'             => 0,
		'ship_to_different_address' => 0,
	);

	$set_cart = static function ( int $quantity = 1 ) use ( $product, $run_id ): array {
		WC()->cart->empty_cart();
		if ( WC()->session ) {
			WC()->session->__unset( 'order_awaiting_payment' );
		}

		$cart_item_key = 'homeboy_concurrent_checkout_' . md5( $run_id . ':' . $quantity );
		WC()->cart->cart_contents = array(
			$cart_item_key => array(
				'key'               => $cart_item_key,
				'product_id'        => $product->get_id(),
				'variation_id'      => 0,
				'variation'         => array(),
				'quantity'          => $quantity,
				'data'              => $product,
				'line_subtotal'     => 19.99 * $quantity,
				'line_subtotal_tax' => 0,
				'line_total'        => 19.99 * $quantity,
				'line_tax'          => 0,
				'line_tax_data'     => array(
					'subtotal' => array(),
					'total'    => array(),
				),
			),
		);

		if ( WC()->customer ) {
			WC()->customer->set_billing_first_name( 'Homeboy' );
			WC()->customer->set_billing_last_name( 'Checkout' );
			WC()->customer->set_billing_email( 'homeboy-' . $run_id . '@example.com' );
			WC()->customer->set_billing_phone( '5555555555' );
			WC()->customer->set_billing_country( 'US' );
			WC()->customer->set_billing_state( 'CA' );
			WC()->customer->set_billing_postcode( '94107' );
			WC()->customer->set_billing_city( 'San Francisco' );
			WC()->customer->set_billing_address( '123 Atomicity Way' );
			WC()->customer->save();
		}

		WC()->cart->calculate_totals();

		return array(
			'cart_item_key' => $cart_item_key,
			'cart_hash'     => WC()->cart->get_cart_hash(),
			'cart_count'    => WC()->cart->get_cart_contents_count(),
			'cart_total'    => (float) WC()->cart->get_total( 'edit' ),
		);
	};

	$session_order_awaiting_payment = static function (): int {
		return WC()->session ? absint( WC()->session->get( 'order_awaiting_payment' ) ) : 0;
	};

	$unexpected_output = '';
	$create_order      = static function ( array $posted_data ) use ( &$unexpected_output ): int {
		ob_start();
		try {
			$order_id = WC()->checkout()->create_order( $posted_data );
		} finally {
			$unexpected_output .= (string) ob_get_clean();
		}
		if ( is_wp_error( $order_id ) ) {
			throw new RuntimeException( 'create_order failed: ' . $order_id->get_error_message() );
		}
		$order_id = absint( $order_id );
		if ( ! wc_get_order( $order_id ) ) {
			throw new RuntimeException( 'create_order returned a missing order ID: ' . $order_id );
		}

		return $order_id;
	};

	$run_template_redirect_clear = static function ( WC_Order $order, bool $with_session_reference = true ): array {
		global $wp;

		$previous_query_vars = isset( $wp ) && isset( $wp->query_vars ) ? $wp->query_vars : array();
		$previous_get        = $_GET;

		if ( ! isset( $wp ) || ! is_object( $wp ) ) {
			$wp = new WP();
		}
		$wp->query_vars = array();
		$_GET           = array();
		if ( WC()->session ) {
			if ( $with_session_reference ) {
				WC()->session->set( 'order_awaiting_payment', $order->get_id() );
			} else {
				WC()->session->__unset( 'order_awaiting_payment' );
			}
		}

		$before_count = WC()->cart->get_cart_contents_count();
		wc_clear_cart_after_payment();
		$after_count = WC()->cart->get_cart_contents_count();

		$wp->query_vars = $previous_query_vars;
		$_GET           = $previous_get;

		return array(
			'before_count' => $before_count,
			'after_count'  => $after_count,
			'cleared'      => 0 === $after_count && $before_count > 0,
		);
	};

	$session_probe = new WC_Session_Handler();
	$cookie_name   = ( new ReflectionProperty( WC_Session_Handler::class, '_cookie' ) )->getValue( $session_probe );
	$session_table = $wpdb->prefix . 'woocommerce_sessions';
	$hash_method   = new ReflectionMethod( WC_Session_Handler::class, 'hash' );
	$hash_method->setAccessible( true );

	$make_cookie_value = static function ( string $customer_id ) use ( $session_probe, $hash_method ): string {
		$expiration = time() + 2 * DAY_IN_SECONDS;
		$expiring   = time() + DAY_IN_SECONDS;
		return $customer_id . '|' . $expiration . '|' . $expiring . '|' . $hash_method->invoke( $session_probe, $customer_id . '|' . $expiration );
	};

	$get_persisted_session = static function ( string $customer_id ) use ( $wpdb, $session_table ): array {
		$row = $wpdb->get_var(
			$wpdb->prepare(
				'SELECT session_value FROM %i WHERE session_key = %s',
				$session_table,
				$customer_id
			)
		);
		return $row ? (array) maybe_unserialize( $row ) : array();
	};

	$session_cart_count = static function ( array $session ): int {
		$cart = array_key_exists( 'cart', $session ) ? maybe_unserialize( $session['cart'] ) : array();
		return is_array( $cart ) ? count( $cart ) : 0;
	};

	$parse_response_order_id = static function ( array $decoded ): int {
		$redirect = isset( $decoded['redirect'] ) ? (string) $decoded['redirect'] : '';
		if ( preg_match( '#order-received/(\d+)#', $redirect, $matches ) ) {
			return absint( $matches[1] );
		}
		return 0;
	};

	$create_concurrent_product = static function ( string $iteration_id, string $payment_mode ): WC_Product_Simple {
		$product = new WC_Product_Simple();
		$product->set_name( 'Homeboy Concurrent Checkout Product ' . $iteration_id );
		$product->set_slug( 'homeboy-concurrent-checkout-' . $iteration_id );
		$product->set_status( 'publish' );
		$product->set_sku( 'homeboy-concurrent-checkout-' . $iteration_id );
		$product->set_regular_price( 'free' === $payment_mode ? '0' : '19.99' );
		$product->set_price( 'free' === $payment_mode ? '0' : '19.99' );
		$product->set_virtual( true );
		$product->set_manage_stock( false );
		$product->set_stock_status( 'instock' );
		$product->save();
		return $product;
	};

	$seed_checkout_session = static function ( string $iteration_id, string $cookie_value, WC_Product_Simple $product, string $payment_mode ) use ( $cookie_name ): array {
		$_COOKIE[ $cookie_name ] = $cookie_value;
		$session = new WC_Session_Handler();
		$session->init();
		WC()->session = $session;
		WC()->cart    = new WC_Cart();

		$cart_item_key = WC()->cart->add_to_cart( $product->get_id(), 1 );
		WC()->cart->calculate_totals();

		$cart_session = new WC_Cart_Session( WC()->cart );
		$cart_session->set_session();
		$session->set( 'chosen_payment_method', 'free' === $payment_mode ? '' : 'cod' );
		$session->set( 'order_awaiting_payment', null );
		$session->set(
			'customer',
			array(
				'email'      => 'homeboy-' . $iteration_id . '@example.com',
				'first_name' => 'Homeboy',
				'last_name'  => 'Checkout',
				'country'    => 'US',
				'state'      => 'CA',
			)
		);
		$session->save_data();

		return array(
			'cart_item_key' => $cart_item_key,
			'cart_hash'     => WC()->cart->get_cart_hash(),
			'cart_total'    => (float) WC()->cart->get_total( 'edit' ),
		);
	};

	$build_checkout_post_data = static function ( string $iteration_id, string $payment_mode ): array {
		return array(
			'billing_first_name'        => 'Homeboy',
			'billing_last_name'         => 'Checkout',
			'billing_company'           => '',
			'billing_country'           => 'US',
			'billing_address_1'         => '123 Atomicity Way',
			'billing_address_2'         => '',
			'billing_city'              => 'San Francisco',
			'billing_state'             => 'CA',
			'billing_postcode'          => '94107',
			'billing_phone'             => '5555555555',
			'billing_email'             => 'homeboy-' . $iteration_id . '@example.com',
			'shipping_first_name'       => 'Homeboy',
			'shipping_last_name'        => 'Checkout',
			'shipping_company'          => '',
			'shipping_country'          => 'US',
			'shipping_address_1'        => '123 Atomicity Way',
			'shipping_address_2'        => '',
			'shipping_city'             => 'San Francisco',
			'shipping_state'            => 'CA',
			'shipping_postcode'         => '94107',
			'order_comments'            => 'Homeboy true concurrent checkout repro ' . $iteration_id,
			'payment_method'            => 'free' === $payment_mode ? '' : 'cod',
			'terms'                     => 1,
			'createaccount'             => 0,
			'ship_to_different_address' => 0,
			'security'                  => wp_create_nonce( 'woocommerce-process_checkout' ),
		);
	};

	$fire_concurrent_checkout_requests = static function ( string $checkout_url, string $cookie_name, string $cookie_value, array $post_data, int $request_count ): array {
		$multi_handle = curl_multi_init();
		$handles      = array();
		$started_at   = microtime( true );

		for ( $index = 0; $index < $request_count; $index++ ) {
			$handle = curl_init( $checkout_url );
			curl_setopt_array(
				$handle,
				array(
					CURLOPT_POST           => true,
					CURLOPT_POSTFIELDS     => http_build_query( $post_data, '', '&' ),
					CURLOPT_RETURNTRANSFER => true,
					CURLOPT_HEADER         => false,
					CURLOPT_FOLLOWLOCATION => false,
					CURLOPT_CONNECTTIMEOUT => 10,
					CURLOPT_TIMEOUT        => 60,
					CURLOPT_HTTPHEADER     => array(
						'Content-Type: application/x-www-form-urlencoded; charset=UTF-8',
						'X-Requested-With: XMLHttpRequest',
					),
					CURLOPT_COOKIE         => $cookie_name . '=' . $cookie_value,
				)
			);
			curl_multi_add_handle( $multi_handle, $handle );
			$handles[ $index ] = $handle;
		}

		$running = null;
		do {
			$status = curl_multi_exec( $multi_handle, $running );
			if ( CURLM_OK !== $status ) {
				break;
			}
			if ( $running ) {
				curl_multi_select( $multi_handle, 1.0 );
			}
		} while ( $running );

		$responses = array();
		foreach ( $handles as $index => $handle ) {
			$body    = (string) curl_multi_getcontent( $handle );
			$decoded = json_decode( $body, true );
			if ( ! is_array( $decoded ) ) {
				$decoded = array();
			}
			$responses[] = array(
				'index'       => $index,
				'http_code'   => (int) curl_getinfo( $handle, CURLINFO_HTTP_CODE ),
				'curl_errno'  => (int) curl_errno( $handle ),
				'curl_error'  => (string) curl_error( $handle ),
				'elapsed_ms'  => (float) curl_getinfo( $handle, CURLINFO_TOTAL_TIME ) * 1000,
				'body_bytes'  => strlen( $body ),
				'json'        => $decoded,
				'raw_excerpt' => substr( $body, 0, 1000 ),
			);
			curl_multi_remove_handle( $multi_handle, $handle );
			curl_close( $handle );
		}
		curl_multi_close( $multi_handle );

		return array(
			'elapsed_ms' => ( microtime( true ) - $started_at ) * 1000,
			'responses'  => $responses,
		);
	};

	$summarize_checkout_orders = static function ( string $email, int $product_id, string $cart_hash ): array {
		$order_rows = array();
		$orders     = wc_get_orders(
			array(
				'limit'         => -1,
				'billing_email' => $email,
				'orderby'       => 'ID',
				'order'         => 'ASC',
				'return'        => 'objects',
			)
		);

		foreach ( $orders as $order ) {
			if ( ! $order instanceof WC_Order ) {
				continue;
			}
			$product_quantity = 0;
			foreach ( $order->get_items() as $item ) {
				if ( (int) $item->get_product_id() === $product_id ) {
					$product_quantity += (int) $item->get_quantity();
				}
			}
			$order_rows[] = array(
				'id'               => $order->get_id(),
				'status'           => $order->get_status(),
				'total'            => (float) $order->get_total(),
				'cart_hash'        => $order->get_cart_hash(),
				'item_count'       => count( $order->get_items() ),
				'product_quantity' => $product_quantity,
				'payment_method'   => $order->get_payment_method(),
				'needs_payment'    => $order->needs_payment(),
			);
		}

		$item_owner_ids = array_values(
			array_map(
				static function ( array $order ): int {
					return (int) $order['id'];
				},
				array_filter(
					$order_rows,
					static function ( array $order ): bool {
						return $order['product_quantity'] > 0;
					}
				)
			)
		);

		return array(
			'orders'                         => $order_rows,
			'order_ids'                      => array_values( wp_list_pluck( $order_rows, 'id' ) ),
			'unique_order_ids'               => array_values( array_unique( wp_list_pluck( $order_rows, 'id' ) ) ),
			'cart_item_owner_order_ids'      => $item_owner_ids,
			'cart_item_owner_order_count'    => count( $item_owner_ids ),
			'unique_same_cart_hash_order_count' => count(
				array_filter(
					$order_rows,
					static function ( array $order ) use ( $cart_hash ): bool {
						return $cart_hash && $order['cart_hash'] === $cart_hash;
					}
				)
			),
			'payment_attempt_count_observed' => count(
				array_filter(
					$order_rows,
					static function ( array $order ): bool {
						return '' !== $order['payment_method'];
					}
				)
			),
		);
	};

	$before = microtime( true );

	$base_cart                             = $set_cart( 1 );
	$order_id_1                            = $create_order( $data );
	$session_after_first_create_order      = $session_order_awaiting_payment();
	$cart_count_after_first_create_order   = WC()->cart->get_cart_contents_count();
	$order_id_2                            = $create_order( $data );
	$session_after_second_create_order     = $session_order_awaiting_payment();
	$cart_count_after_second_create_order  = WC()->cart->get_cart_contents_count();
	$elapsed_ms                            = ( microtime( true ) - $before ) * 1000;

	$order_ids          = array_map( 'absint', array( $order_id_1, $order_id_2 ) );
	$orders             = array_filter( array_map( 'wc_get_order', $order_ids ) );
	$unique_order_ids   = array_values( array_unique( $order_ids ) );
	$unique_orders      = array_filter( array_map( 'wc_get_order', $unique_order_ids ) );
	$main_order         = wc_get_order( $order_ids[0] );
	$duplicate_created  = count( $unique_order_ids ) > 1 ? 1 : 0;
	$main_order_item_count = $main_order instanceof WC_Order ? count( $main_order->get_items() ) : 0;
	$main_order_total      = $main_order instanceof WC_Order ? (float) $main_order->get_total() : 0;
	$public_side_effect = array(
		'order_awaiting_payment_after_first'  => $session_after_first_create_order,
		'order_awaiting_payment_after_second' => $session_after_second_create_order,
		'cart_count_after_first'              => $cart_count_after_first_create_order,
		'cart_count_after_second'             => $cart_count_after_second_create_order,
		'sets_order_awaiting_payment'         => $session_after_first_create_order > 0 || $session_after_second_create_order > 0,
		'clears_cart'                         => 0 === $cart_count_after_first_create_order || 0 === $cart_count_after_second_create_order,
	);

	$set_cart( 1 );
	$pending_order_id = $create_order( $data );
	WC()->session->set( 'order_awaiting_payment', $pending_order_id );
	$pending_retry_id = $create_order( $data );

	$set_cart( 1 );
	$failed_order_id = $create_order( $data );
	$failed_order    = wc_get_order( $failed_order_id );
	$failed_order->set_status( 'failed' );
	$failed_order->save();
	WC()->session->set( 'order_awaiting_payment', $failed_order_id );
	$failed_retry_id = $create_order( $data );

	$set_cart( 1 );
	$completed_order_id = $create_order( $data );
	$completed_order    = wc_get_order( $completed_order_id );
	$completed_order->set_status( 'completed' );
	$completed_order->save();
	WC()->session->set( 'order_awaiting_payment', $completed_order_id );
	$completed_retry_id    = $create_order( $data );
	$completed_after_retry = wc_get_order( $completed_order_id );

	$set_cart( 1 );
	$changed_cart_order_id = $create_order( $data );
	WC()->session->set( 'order_awaiting_payment', $changed_cart_order_id );
	$changed_original_hash = wc_get_order( $changed_cart_order_id )->get_cart_hash();
	$changed_cart          = $set_cart( 2 );
	WC()->session->set( 'order_awaiting_payment', $changed_cart_order_id );
	$changed_retry_id = $create_order( $data );

	$set_cart( 1 );
	$extension_order = wc_create_order(
		array(
			'created_via' => 'homeboy-extension',
			'status'      => 'completed',
		)
	);
	if ( is_wp_error( $extension_order ) ) {
		throw new RuntimeException( 'Extension-created order setup failed: ' . $extension_order->get_error_message() );
	}
	$extension_order->set_cart_hash( WC()->cart->get_cart_hash() );
	$extension_order->set_total( (float) WC()->cart->get_total( 'edit' ) );
	$extension_order->save();
	$template_redirect_completed = $run_template_redirect_clear( $extension_order, true );

	$set_cart( 1 );
	$safety_order = wc_get_order( $completed_order_id );
	$template_redirect_completed_without_session = $run_template_redirect_clear( $safety_order, false );

	$set_cart( 1 );
	$pending_clear_order       = wc_get_order( $pending_order_id );
	$template_redirect_pending = $run_template_redirect_clear( $pending_clear_order, true );

	$coupon_metrics = array(
		'covered'                         => false,
		'public_create_order_sets_session' => null,
		'public_create_order_clears_cart'  => null,
		'order_coupon_line_count'          => null,
	);
	if ( class_exists( 'WC_Coupon' ) ) {
		$set_cart( 1 );
		$coupon_code = 'homeboy-legacy-' . strtolower( wp_generate_password( 6, false ) );
		$coupon      = new WC_Coupon();
		$coupon->set_code( $coupon_code );
		$coupon->set_discount_type( 'fixed_cart' );
		$coupon->set_amount( 1 );
		$coupon->save();
		WC()->cart->apply_coupon( $coupon_code );
		WC()->cart->calculate_totals();
		$before_coupon_session = $session_order_awaiting_payment();
		$coupon_order_id       = $create_order( $data );
		$coupon_order          = wc_get_order( $coupon_order_id );
		$coupon_metrics        = array(
			'covered'                         => true,
			'public_create_order_sets_session' => $session_order_awaiting_payment() !== $before_coupon_session,
			'public_create_order_clears_cart'  => 0 === WC()->cart->get_cart_contents_count(),
			'order_coupon_line_count'          => count( $coupon_order->get_coupon_codes() ),
		);
	}

	$changed_retry_order = wc_get_order( $changed_retry_id );
	$guardrails          = array(
		'public_create_order_does_not_set_order_awaiting_payment' => ! $public_side_effect['sets_order_awaiting_payment'],
		'public_create_order_does_not_clear_cart'                 => ! $public_side_effect['clears_cart'],
		'pending_retry_reuses_order'                              => $pending_order_id === $pending_retry_id,
		'failed_retry_reuses_order'                               => $failed_order_id === $failed_retry_id,
		'completed_order_is_not_reused'                           => $completed_order_id !== $completed_retry_id,
		'completed_order_status_is_preserved'                     => $completed_after_retry && $completed_after_retry->has_status( 'completed' ),
		'changed_cart_retry_creates_new_order'                    => $changed_cart_order_id !== $changed_retry_id,
		'changed_cart_retry_uses_new_cart_hash'                   => $changed_retry_order && $changed_retry_order->get_cart_hash() === $changed_cart['cart_hash'] && $changed_original_hash !== $changed_cart['cart_hash'],
		'template_redirect_clears_paid_completed_extension_order' => $template_redirect_completed['cleared'],
		'template_redirect_does_not_clear_without_payment_signal' => ! $template_redirect_completed_without_session['cleared'],
		'template_redirect_does_not_clear_pending_retry_order'    => ! $template_redirect_pending['cleared'],
		'legacy_coupon_independence'                              => ! $coupon_metrics['covered'] || ( ! $coupon_metrics['public_create_order_sets_session'] && ! $coupon_metrics['public_create_order_clears_cart'] && $coupon_metrics['order_coupon_line_count'] > 0 ),
	);

	$failed_guardrails = array_keys(
		array_filter(
			$guardrails,
			static function ( bool $passed ): bool {
				return ! $passed;
			}
		)
	);
	if ( $failed_guardrails ) {
		throw new RuntimeException( 'Checkout side-effect guardrail failure: ' . implode( ', ', $failed_guardrails ) );
	}

	$concurrent_iterations = array();
	$concurrent_metrics    = array();
	for ( $iteration = 1; $iteration <= $iterations; $iteration++ ) {
		$iteration_id = $run_id . '-concurrent-' . $iteration;
		$customer_id  = 't_homeboy_checkout_' . md5( $iteration_id );
		$cookie_value = $make_cookie_value( $customer_id );
		$checkout_email = 'homeboy-' . $iteration_id . '@example.com';

		$wpdb->delete( $session_table, array( 'session_key' => $customer_id ) );
		$concurrent_product = $create_concurrent_product( $iteration_id, $payment_mode );
		$seed               = $seed_checkout_session( $iteration_id, $cookie_value, $concurrent_product, $payment_mode );
		$session_before     = $get_persisted_session( $customer_id );
		$post_data          = $build_checkout_post_data( $iteration_id, $payment_mode );
		$burst              = $fire_concurrent_checkout_requests( $checkout_url, $cookie_name, $cookie_value, $post_data, $request_count );
		$session_after      = $get_persisted_session( $customer_id );
		$order_summary      = $summarize_checkout_orders( $checkout_email, $concurrent_product->get_id(), $seed['cart_hash'] );

		$response_order_ids = array_values(
			array_filter(
				array_map(
					static function ( array $response ) use ( $parse_response_order_id ): int {
						return $parse_response_order_id( $response['json'] );
					},
					$burst['responses']
				)
			)
		);
		$successful_responses = count(
			array_filter(
				$burst['responses'],
				static function ( array $response ): bool {
					return 200 === $response['http_code'] && isset( $response['json']['result'] ) && 'success' === $response['json']['result'];
				}
			)
		);
		$failed_responses = count(
			array_filter(
				$burst['responses'],
				static function ( array $response ): bool {
					return 200 !== $response['http_code'] || ! isset( $response['json']['result'] ) || 'success' !== $response['json']['result'];
				}
			)
		);
		$safe_losing_responses = max( 0, $request_count - $successful_responses ) === $failed_responses ? $failed_responses : 0;
		$duplicate_reproduced  = $order_summary['cart_item_owner_order_count'] > 1 || count( $order_summary['unique_order_ids'] ) > 1;

		$metrics = array(
			'checkout_request_count'             => $request_count,
			'successful_response_count'          => $successful_responses,
			'failed_response_count'              => $failed_responses,
			'safe_losing_response_count'         => $safe_losing_responses,
			'unique_order_count'                 => count( $order_summary['unique_order_ids'] ),
			'duplicate_order_count'              => max( 0, count( $order_summary['unique_order_ids'] ) - 1 ),
			'duplicate_reproduced'               => $duplicate_reproduced ? 1 : 0,
			'cart_item_owner_order_count'        => $order_summary['cart_item_owner_order_count'],
			'only_one_order_contains_cart_items' => 1 === $order_summary['cart_item_owner_order_count'] ? 1 : 0,
			'payment_attempt_count_observed'     => $order_summary['payment_attempt_count_observed'],
			'cart_session_exists_after_burst'    => empty( $session_after ) ? 0 : 1,
			'cart_session_parseable_after_burst' => is_array( $session_after ) ? 1 : 0,
			'cart_items_before_burst'            => $session_cart_count( $session_before ),
			'cart_items_after_burst'             => $session_cart_count( $session_after ),
			'order_awaiting_payment_after_burst' => isset( $session_after['order_awaiting_payment'] ) ? absint( maybe_unserialize( $session_after['order_awaiting_payment'] ) ) : 0,
			'same_cart_hash_order_count'         => $order_summary['unique_same_cart_hash_order_count'],
			'burst_elapsed_ms'                   => $burst['elapsed_ms'],
		);

		$concurrent_metrics[] = $metrics;
		$concurrent_iterations[] = array(
			'iteration'          => $iteration,
			'customer_id'        => $customer_id,
			'cookie_name'        => $cookie_name,
			'checkout_url'       => $checkout_url,
			'product_id'         => $concurrent_product->get_id(),
			'cart_item_key'      => $seed['cart_item_key'],
			'cart_hash'          => $seed['cart_hash'],
			'billing_email'      => $checkout_email,
			'response_order_ids' => $response_order_ids,
			'order_summary'      => $order_summary,
			'session_before_keys' => array_keys( $session_before ),
			'session_after_keys' => array_keys( $session_after ),
			'responses'          => $burst['responses'],
			'metrics'            => $metrics,
		);
	}

	$sum_concurrent_metric = static function ( string $key ) use ( $concurrent_metrics ): float {
		return array_sum(
			array_map(
				static function ( array $metrics ) use ( $key ): float {
					return isset( $metrics[ $key ] ) ? (float) $metrics[ $key ] : 0.0;
				},
				$concurrent_metrics
			)
		);
	};
	$max_concurrent_metric = static function ( string $key ) use ( $concurrent_metrics ): float {
		$values = array_map(
			static function ( array $metrics ) use ( $key ): float {
				return isset( $metrics[ $key ] ) ? (float) $metrics[ $key ] : 0.0;
			},
			$concurrent_metrics
		);
		return empty( $values ) ? 0.0 : max( $values );
	};
	$concurrent_summary = array(
		'concurrent_checkout_iterations'        => $iterations,
		'checkout_request_count'                => $request_count * $iterations,
		'checkout_request_count_per_iteration'  => $request_count,
		'successful_response_count'             => $sum_concurrent_metric( 'successful_response_count' ),
		'failed_response_count'                 => $sum_concurrent_metric( 'failed_response_count' ),
		'safe_losing_response_count'            => $sum_concurrent_metric( 'safe_losing_response_count' ),
		'unique_order_count'                    => $sum_concurrent_metric( 'unique_order_count' ),
		'max_unique_order_count_per_iteration'  => $max_concurrent_metric( 'unique_order_count' ),
		'duplicate_order_count'                 => $sum_concurrent_metric( 'duplicate_order_count' ),
		'duplicate_reproduced'                  => $max_concurrent_metric( 'duplicate_reproduced' ) > 0 ? 1 : 0,
		'duplicate_reproduced_iteration_count'  => $sum_concurrent_metric( 'duplicate_reproduced' ),
		'cart_item_owner_order_count'           => $sum_concurrent_metric( 'cart_item_owner_order_count' ),
		'max_cart_item_owner_order_count_per_iteration' => $max_concurrent_metric( 'cart_item_owner_order_count' ),
		'only_one_order_contains_cart_items_iteration_count' => $sum_concurrent_metric( 'only_one_order_contains_cart_items' ),
		'payment_attempt_count_observed'        => $sum_concurrent_metric( 'payment_attempt_count_observed' ),
		'cart_session_integrity_after_burst_iteration_count' => $sum_concurrent_metric( 'cart_session_parseable_after_burst' ),
		'cart_session_exists_after_burst_iteration_count' => $sum_concurrent_metric( 'cart_session_exists_after_burst' ),
		'cart_items_before_burst'               => $sum_concurrent_metric( 'cart_items_before_burst' ),
		'cart_items_after_burst'                => $sum_concurrent_metric( 'cart_items_after_burst' ),
		'same_cart_hash_order_count'            => $sum_concurrent_metric( 'same_cart_hash_order_count' ),
		'repeated_iteration_stability'          => count( array_unique( wp_list_pluck( $concurrent_metrics, 'duplicate_reproduced' ) ) ) <= 1 ? 1 : 0,
		'max_burst_elapsed_ms'                  => $max_concurrent_metric( 'burst_elapsed_ms' ),
	);

	$artifact = array(
		'run_id'            => $run_id,
		'issues'            => $issues,
		'cart_hash'         => $base_cart['cart_hash'],
		'product_id'        => $product->get_id(),
		'cart_item_key'     => $base_cart['cart_item_key'],
		'billing_email'     => $email,
		'order_ids'         => $order_ids,
		'unique_order_ids'  => $unique_order_ids,
		'duplicate_created' => (bool) $duplicate_created,
		'unexpected_output' => $unexpected_output,
		'public_side_effects' => $public_side_effect,
		'retry_behavior'    => array(
			'pending_order_id'      => $pending_order_id,
			'pending_retry_id'      => $pending_retry_id,
			'failed_order_id'       => $failed_order_id,
			'failed_retry_id'       => $failed_retry_id,
			'completed_order_id'    => $completed_order_id,
			'completed_retry_id'    => $completed_retry_id,
			'changed_cart_order_id' => $changed_cart_order_id,
			'changed_cart_retry_id' => $changed_retry_id,
			'changed_original_hash' => $changed_original_hash,
			'changed_retry_hash'    => $changed_retry_order ? $changed_retry_order->get_cart_hash() : '',
		),
		'template_redirect' => array(
			'completed_extension_order' => $template_redirect_completed,
			'completed_without_signal'  => $template_redirect_completed_without_session,
			'pending_retry_order'       => $template_redirect_pending,
		),
		'legacy_coupon'     => $coupon_metrics,
		'guardrails'        => $guardrails,
		'failed_guardrails' => $failed_guardrails,
		'concurrent_checkout' => array(
			'request_count' => $request_count,
			'iterations'    => $iterations,
			'payment_mode'  => $payment_mode,
			'checkout_url'  => $checkout_url,
			'iterations_artifact' => $concurrent_iterations,
			'metrics'       => $concurrent_summary,
		),
		'orders'            => array_map(
			static function ( WC_Order $order ): array {
				return array(
					'id'         => $order->get_id(),
					'status'     => $order->get_status(),
					'total'      => (float) $order->get_total(),
					'cart_hash'  => $order->get_cart_hash(),
					'item_count' => count( $order->get_items() ),
				);
			},
			$orders
		),
	);

	$summary = array(
		'success_rate'                                            => 1,
		'duplicate_reproduced'                                    => $duplicate_created,
		'order_create_attempts'                                   => 2,
		'unique_order_count'                                      => count( $unique_order_ids ),
		'duplicate_order_count'                                   => max( 0, count( $unique_order_ids ) - 1 ),
		'second_attempt_reused_first_order'                       => $order_ids[0] === $order_ids[1] ? 1 : 0,
		'main_order_succeeded'                                    => $main_order instanceof WC_Order ? 1 : 0,
		'main_order_item_count'                                   => $main_order_item_count,
		'main_order_total'                                        => $main_order_total,
		'unexpected_output_detected'                              => '' === $unexpected_output ? 0 : 1,
		'unexpected_output_bytes'                                 => strlen( $unexpected_output ),
		'elapsed_ms'                                              => $elapsed_ms,
		'cart_items'                                              => WC()->cart->get_cart_contents_count(),
		'cart_total'                                              => (float) WC()->cart->get_total( 'edit' ),
		'unique_same_cart_hash_order_count'                       => count(
			array_filter(
				$unique_orders,
				static function ( WC_Order $order ) use ( $base_cart ): bool {
					return $order->get_cart_hash() === $base_cart['cart_hash'];
				}
			)
		),
		'same_cart_hash_order_count'                              => count(
			array_filter(
				$orders,
				static function ( WC_Order $order ) use ( $base_cart ): bool {
					return $order->get_cart_hash() === $base_cart['cart_hash'];
				}
			)
		),
		'public_create_order_sets_order_awaiting_payment'         => (int) $public_side_effect['sets_order_awaiting_payment'],
		'public_create_order_clears_cart'                         => (int) $public_side_effect['clears_cart'],
		'order_awaiting_payment_after_public_create_order'        => $session_after_second_create_order,
		'pending_retry_reuses_order'                              => (int) $guardrails['pending_retry_reuses_order'],
		'failed_retry_reuses_order'                               => (int) $guardrails['failed_retry_reuses_order'],
		'completed_order_is_not_reused'                           => (int) $guardrails['completed_order_is_not_reused'],
		'completed_order_status_is_preserved'                     => (int) $guardrails['completed_order_status_is_preserved'],
		'changed_cart_retry_creates_new_order'                    => (int) $guardrails['changed_cart_retry_creates_new_order'],
		'changed_cart_retry_uses_new_cart_hash'                   => (int) $guardrails['changed_cart_retry_uses_new_cart_hash'],
		'template_redirect_clears_paid_completed_extension_order' => (int) $guardrails['template_redirect_clears_paid_completed_extension_order'],
		'template_redirect_does_not_clear_without_payment_signal' => (int) $guardrails['template_redirect_does_not_clear_without_payment_signal'],
		'template_redirect_does_not_clear_pending_retry_order'    => (int) $guardrails['template_redirect_does_not_clear_pending_retry_order'],
		'legacy_coupon_independence'                              => (int) $guardrails['legacy_coupon_independence'],
		'guardrail_failure_count'                                 => count( $failed_guardrails ),
	);
	foreach ( $concurrent_summary as $metric_name => $metric_value ) {
		$summary[ 'concurrent_' . $metric_name ] = $metric_value;
	}
	$summary['true_concurrent_duplicate_reproduced'] = $concurrent_summary['duplicate_reproduced'];

	$artifact_path = '';
	$shared_state  = getenv( 'HOMEBOY_BENCH_SHARED_STATE' );
	if ( $shared_state ) {
		$artifact_dir = rtrim( $shared_state, '/' ) . '/checkout-concurrent-create-order';
		wp_mkdir_p( $artifact_dir );
		$artifact_path = $artifact_dir . '/' . $run_id . '.json';
		file_put_contents( $artifact_path, wp_json_encode( array_merge( $artifact, array( 'metrics' => $summary ) ), JSON_PRETTY_PRINT ) . "\n" );
	}

	return array(
		'metrics'   => $summary,
		'metadata'  => array(
			'runner'    => 'wp-codebox',
			'workload'  => 'checkout-concurrent-create-order',
			'issues'    => $issues,
			'cart_hash' => $base_cart['cart_hash'],
		),
		'artifacts' => $artifact_path ? array( 'raw_result' => array( 'path' => $artifact_path, 'kind' => 'json' ) ) : array(),
	);
};
