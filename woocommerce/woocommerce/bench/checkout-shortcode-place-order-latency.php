<?php
/**
 * WP Codebox-backed WooCommerce shortcode checkout place-order workload.
 *
 * Models the slow shortcode checkout report tracked in:
 * - https://github.com/chubes4/homeboy-rigs/issues/223
 * - https://wordpress.org/support/topic/checkout-is-very-slow/
 */
return function (): array {
	global $wpdb;

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
	if ( ! function_exists( 'wc_load_cart' ) ) {
		throw new RuntimeException( 'WooCommerce cart loader is not available.' );
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

	$run_id            = 'woocommerce-checkout-shortcode-place-order-' . getmypid() . '-' . time() . '-' . wp_generate_password( 6, false );
	$product_count     = max( 1, min( 300, (int) ( getenv( 'WC_SHORTCODE_CHECKOUT_PRODUCTS' ) ?: 150 ) ) );
	$variation_count   = max( 0, min( 300, (int) ( getenv( 'WC_SHORTCODE_CHECKOUT_VARIATIONS' ) ?: 125 ) ) );
	$historical_orders = max( 0, min( 250, (int) ( getenv( 'WC_SHORTCODE_CHECKOUT_HISTORICAL_ORDERS' ) ?: 25 ) ) );
	$payment_methods   = array_values(
		array_filter(
			array_map(
				'trim',
				explode( ',', (string) ( getenv( 'WC_SHORTCODE_CHECKOUT_PAYMENT_METHODS' ) ?: 'cod,homeboy_synthetic' ) )
			)
		)
	);
	$issues            = array(
		'https://github.com/chubes4/homeboy-rigs/issues/223',
		'https://wordpress.org/support/topic/checkout-is-very-slow/',
		'https://pastebin.com/DPN319jb',
		'https://automattic.zendesk.com/agent/tickets/9426116',
	);

	wp_set_current_user( 0 );
	update_option( 'woocommerce_default_country', 'US:CA' );
	update_option( 'woocommerce_currency', 'USD' );
	update_option( 'woocommerce_prices_include_tax', 'no' );
	update_option( 'woocommerce_calc_taxes', 'no' );
	update_option( 'woocommerce_enable_guest_checkout', 'yes' );
	update_option( 'woocommerce_enable_checkout_login_reminder', 'no' );
	update_option( 'woocommerce_enable_signup_and_login_from_checkout', 'no' );
	update_option( 'woocommerce_custom_orders_table_enabled', 'no' );
	update_option( 'woocommerce_cod_settings', array( 'enabled' => 'yes', 'title' => 'Cash on delivery' ) );

	$checkout_page_id = wp_insert_post(
		array(
			'post_title'   => 'Homeboy Shortcode Checkout ' . $run_id,
			'post_name'    => 'homeboy-shortcode-checkout-' . $run_id,
			'post_type'    => 'page',
			'post_status'  => 'publish',
			'post_content' => '[woocommerce_checkout]',
		)
	);
	if ( is_wp_error( $checkout_page_id ) || ! $checkout_page_id ) {
		throw new RuntimeException( 'Failed to create shortcode checkout page.' );
	}
	update_option( 'woocommerce_checkout_page_id', (int) $checkout_page_id );

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

	if ( ! class_exists( 'Homeboy_Synthetic_Checkout_Gateway', false ) && class_exists( 'WC_Payment_Gateway' ) ) {
		class Homeboy_Synthetic_Checkout_Gateway extends WC_Payment_Gateway {
			/** Constructor. */
			public function __construct() {
				$this->id                 = 'homeboy_synthetic';
				$this->method_title       = 'Homeboy Synthetic Gateway';
				$this->method_description = 'Synthetic successful payment gateway for Homeboy checkout latency rigs.';
				$this->has_fields         = false;
				$this->enabled            = 'yes';
				$this->title              = 'Homeboy Synthetic Gateway';
			}

			/** Process synthetic payment. */
			public function process_payment( $order_id ) {
				$order = wc_get_order( $order_id );
				if ( $order ) {
					$order->payment_complete();
				}
				WC()->cart->empty_cart();

				return array(
					'result'   => 'success',
					'redirect' => $order ? $this->get_return_url( $order ) : wc_get_checkout_url(),
				);
			}
		}
	}

	$register_gateway = static function ( array $gateways ): array {
		$gateways[] = 'Homeboy_Synthetic_Checkout_Gateway';
		return $gateways;
	};
	add_filter( 'woocommerce_payment_gateways', $register_gateway );
	if ( WC()->payment_gateways ) {
		WC()->payment_gateways->init();
	}

	$action_scheduler_count = static function ( string $status = '' ) use ( $wpdb ): int {
		$table = $wpdb->prefix . 'actionscheduler_actions';
		if ( (string) $wpdb->get_var( $wpdb->prepare( 'SHOW TABLES LIKE %s', $table ) ) !== $table ) {
			return 0;
		}
		if ( '' === $status ) {
			return (int) $wpdb->get_var( "SELECT COUNT(*) FROM {$table}" ); // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared
		}
		return (int) $wpdb->get_var( $wpdb->prepare( "SELECT COUNT(*) FROM {$table} WHERE status = %s", $status ) ); // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared
	};

	$created_products = array();
	$seed_started     = microtime( true );
	for ( $i = 0; $i < $product_count; $i++ ) {
		$product = new WC_Product_Simple();
		$product->set_name( 'Homeboy Checkout Product ' . $run_id . ' #' . ( $i + 1 ) );
		$product->set_slug( 'homeboy-checkout-product-' . $run_id . '-' . ( $i + 1 ) );
		$product->set_status( 'publish' );
		$product->set_sku( 'homeboy-checkout-product-' . $run_id . '-' . ( $i + 1 ) );
		$product->set_regular_price( (string) ( 10 + ( $i % 25 ) ) );
		$product->set_price( (string) ( 10 + ( $i % 25 ) ) );
		$product->set_virtual( true );
		$product->set_manage_stock( false );
		$product->set_stock_status( 'instock' );
		$product->save();
		$created_products[] = $product->get_id();
	}

	$variable_product_id = 0;
	$variation_ids       = array();
	if ( $variation_count > 0 && class_exists( 'WC_Product_Variable' ) && class_exists( 'WC_Product_Variation' ) ) {
		$variable = new WC_Product_Variable();
		$variable->set_name( 'Homeboy Checkout Variable Product ' . $run_id );
		$variable->set_slug( 'homeboy-checkout-variable-' . $run_id );
		$variable->set_status( 'publish' );
		$variable->set_sku( 'homeboy-checkout-variable-' . $run_id );
		$variable->save();
		$variable_product_id = $variable->get_id();

		for ( $i = 0; $i < $variation_count; $i++ ) {
			$variation = new WC_Product_Variation();
			$variation->set_parent_id( $variable_product_id );
			$variation->set_status( 'publish' );
			$variation->set_sku( 'homeboy-checkout-variation-' . $run_id . '-' . ( $i + 1 ) );
			$variation->set_regular_price( (string) ( 15 + ( $i % 20 ) ) );
			$variation->set_price( (string) ( 15 + ( $i % 20 ) ) );
			$variation->set_virtual( true );
			$variation->set_manage_stock( false );
			$variation->set_stock_status( 'instock' );
			$variation->save();
			$variation_ids[] = $variation->get_id();
		}
	}

	for ( $i = 0; $i < $historical_orders; $i++ ) {
		$order = wc_create_order(
			array(
				'created_via' => 'homeboy-shortcode-checkout-seed',
				'status'      => 'completed',
			)
		);
		if ( is_wp_error( $order ) || ! $order instanceof WC_Order ) {
			continue;
		}
		$product = wc_get_product( $created_products[ $i % count( $created_products ) ] );
		if ( $product ) {
			$order->add_product( $product, 1 );
		}
		$order->set_billing_email( 'history-' . $run_id . '-' . ( $i + 1 ) . '@example.com' );
		$order->calculate_totals();
		$order->save();
	}
	$seed_elapsed_ms = ( microtime( true ) - $seed_started ) * 1000;

	$get_slowest_queries = static function ( int $start_index ) use ( $wpdb ): array {
		if ( ! isset( $wpdb->queries ) || ! is_array( $wpdb->queries ) ) {
			return array();
		}
		$queries = array_slice( $wpdb->queries, $start_index );
		$rows    = array();
		foreach ( $queries as $query ) {
			$sql     = (string) ( $query[0] ?? '' );
			$elapsed = (float) ( $query[1] ?? 0 );
			$sql     = preg_replace( '/\s+/', ' ', trim( $sql ) );
			$sql     = preg_replace( '/\b\d+\b/', '?', $sql );
			$sql     = preg_replace( "/'[^']*'/", '?', $sql );
			$rows[]  = array(
				'elapsed_ms' => $elapsed * 1000,
				'signature'  => substr( $sql, 0, 220 ),
			);
		}
		usort(
			$rows,
			static function ( array $a, array $b ): int {
				return $b['elapsed_ms'] <=> $a['elapsed_ms'];
			}
		);
		return array_slice( $rows, 0, 10 );
	};

	$run_checkout = static function ( string $payment_method ) use ( $run_id, $wpdb, $action_scheduler_count, $get_slowest_queries, $created_products ): array {
		WC()->cart->empty_cart();
		WC()->session->__unset( 'order_awaiting_payment' );
		wc_clear_notices();

		$product = wc_get_product( $created_products[0] );
		if ( ! $product ) {
			throw new RuntimeException( 'Checkout product failed to reload.' );
		}
		WC()->cart->add_to_cart( $product->get_id(), 1 );
		WC()->cart->calculate_totals();

		if ( WC()->customer ) {
			WC()->customer->set_billing_first_name( 'Homeboy' );
			WC()->customer->set_billing_last_name( 'Checkout' );
			WC()->customer->set_billing_email( 'checkout-' . $payment_method . '-' . $run_id . '@example.com' );
			WC()->customer->set_billing_phone( '5555555555' );
			WC()->customer->set_billing_country( 'US' );
			WC()->customer->set_billing_state( 'CA' );
			WC()->customer->set_billing_postcode( '94107' );
			WC()->customer->set_billing_city( 'San Francisco' );
			WC()->customer->set_billing_address( '123 Checkout Way' );
			WC()->customer->save();
		}

		$order_id             = 0;
		$redirect             = '';
		$checkout_started     = 0.0;
		$order_processed_at   = 0.0;
		$create_order_started = 0.0;
		$create_order_ms      = 0.0;
		$sentinel_message     = 'homeboy-shortcode-checkout-complete-' . $payment_method . '-' . $run_id;

		$before_create_order = static function ( WC_Order $order ) use ( &$create_order_started ): void {
			unset( $order );
			$create_order_started = microtime( true );
		};
		$after_processed     = static function ( int $processed_order_id ) use ( &$order_id, &$order_processed_at, &$create_order_started, &$create_order_ms ): void {
			$order_id           = $processed_order_id;
			$order_processed_at = microtime( true );
			if ( $create_order_started > 0 ) {
				$create_order_ms = ( $order_processed_at - $create_order_started ) * 1000;
			}
		};
		$intercept_redirect  = static function ( array $result ) use ( &$redirect, $sentinel_message ): array {
			$redirect = (string) ( $result['redirect'] ?? '' );
			throw new RuntimeException( $sentinel_message );
		};

		add_action( 'woocommerce_checkout_create_order', $before_create_order, 1 );
		add_action( 'woocommerce_checkout_order_processed', $after_processed, 10, 1 );
		add_filter( 'woocommerce_payment_successful_result', $intercept_redirect, 999 );

		$post_before    = $_POST;
		$request_before = $_REQUEST;
		$query_before   = (int) $wpdb->num_queries;
		$query_index    = isset( $wpdb->queries ) && is_array( $wpdb->queries ) ? count( $wpdb->queries ) : 0;
		$actions_before = $action_scheduler_count();
		$pending_before = $action_scheduler_count( 'pending' );

		$_POST    = array(
			'billing_first_name' => 'Homeboy',
			'billing_last_name'  => 'Checkout',
			'billing_company'    => '',
			'billing_country'    => 'US',
			'billing_address_1'  => '123 Checkout Way',
			'billing_address_2'  => '',
			'billing_city'       => 'San Francisco',
			'billing_state'      => 'CA',
			'billing_postcode'   => '94107',
			'billing_phone'      => '5555555555',
			'billing_email'      => 'checkout-' . $payment_method . '-' . $run_id . '@example.com',
			'order_comments'     => 'Homeboy shortcode checkout latency ' . $run_id,
			'payment_method'     => $payment_method,
			'terms'              => 1,
			'createaccount'      => 0,
			'ship_to_different_address' => 0,
			'woocommerce-process-checkout-nonce' => wp_create_nonce( 'woocommerce-process_checkout' ),
			'_wp_http_referer'   => wc_get_checkout_url(),
		);
		$_REQUEST = array_merge( $_REQUEST, $_POST );

		$checkout_started = microtime( true );
		ob_start();
		WC()->checkout()->process_checkout();
		$unexpected_output = (string) ob_get_clean();
		$checkout_elapsed  = ( microtime( true ) - $checkout_started ) * 1000;

		remove_action( 'woocommerce_checkout_create_order', $before_create_order, 1 );
		remove_action( 'woocommerce_checkout_order_processed', $after_processed, 10 );
		remove_filter( 'woocommerce_payment_successful_result', $intercept_redirect, 999 );
		$_POST    = $post_before;
		$_REQUEST = $request_before;

		if ( ! $order_id ) {
			$notices = wc_get_notices( 'error' );
			throw new RuntimeException( 'Shortcode checkout did not create an order for ' . $payment_method . ': ' . wp_json_encode( $notices ) );
		}

		$order = wc_get_order( $order_id );
		return array(
			'payment_method'                  => $payment_method,
			'order_id'                        => $order_id,
			'order_status'                    => $order ? $order->get_status() : '',
			'order_total'                     => $order ? (float) $order->get_total() : 0,
			'redirect'                        => $redirect,
			'checkout_post_elapsed_ms'        => $checkout_elapsed,
			'checkout_to_order_processed_ms'  => $order_processed_at > 0 ? ( $order_processed_at - $checkout_started ) * 1000 : 0,
			'order_creation_elapsed_ms'       => $create_order_ms,
			'redirect_resolution_elapsed_ms'  => $order_processed_at > 0 ? ( microtime( true ) - $order_processed_at ) * 1000 : 0,
			'query_count'                     => (int) $wpdb->num_queries - $query_before,
			'slowest_queries'                 => $get_slowest_queries( $query_index ),
			'action_scheduler_jobs_created'   => max( 0, $action_scheduler_count() - $actions_before ),
			'action_scheduler_pending_delta'  => $action_scheduler_count( 'pending' ) - $pending_before,
			'unexpected_output_detected'      => '' === $unexpected_output ? 0 : 1,
			'unexpected_output_bytes'         => strlen( $unexpected_output ),
		);
	};

	$rows = array();
	foreach ( $payment_methods as $payment_method ) {
		$rows[] = $run_checkout( $payment_method );
	}

	remove_filter( 'woocommerce_payment_gateways', $register_gateway );

	$primary = $rows[0] ?? array();
	$summary = array(
		'success_rate'                         => count( $rows ) === count( $payment_methods ) ? 1 : 0,
		'payment_method_count'                 => count( $payment_methods ),
		'products_seeded'                      => $product_count,
		'variations_seeded'                    => count( $variation_ids ),
		'historical_orders_seeded'             => $historical_orders,
		'seed_elapsed_ms'                      => $seed_elapsed_ms,
		'checkout_post_elapsed_ms'             => (float) ( $primary['checkout_post_elapsed_ms'] ?? 0 ),
		'checkout_to_order_processed_ms'       => (float) ( $primary['checkout_to_order_processed_ms'] ?? 0 ),
		'order_creation_elapsed_ms'            => (float) ( $primary['order_creation_elapsed_ms'] ?? 0 ),
		'thank_you_redirect_resolution_ms'     => (float) ( $primary['redirect_resolution_elapsed_ms'] ?? 0 ),
		'browser_confirmation_measured'        => 0,
		'query_count'                          => (int) ( $primary['query_count'] ?? 0 ),
		'action_scheduler_jobs_created'        => array_sum( wp_list_pluck( $rows, 'action_scheduler_jobs_created' ) ),
		'action_scheduler_pending_delta'       => array_sum( wp_list_pluck( $rows, 'action_scheduler_pending_delta' ) ),
		'checkout_renderer_shortcode'          => 1,
		'hpos_enabled'                         => class_exists( '\\Automattic\\WooCommerce\\Utilities\\OrderUtil' ) && \Automattic\WooCommerce\Utilities\OrderUtil::custom_orders_table_usage_is_enabled() ? 1 : 0,
	);

	$artifact_path = '';
	$shared_state  = getenv( 'HOMEBOY_BENCH_SHARED_STATE' );
	if ( $shared_state ) {
		$artifact_dir = rtrim( $shared_state, '/' ) . '/checkout-shortcode-place-order-latency';
		wp_mkdir_p( $artifact_dir );
		$artifact_path = $artifact_dir . '/' . $run_id . '.json';
		file_put_contents(
			$artifact_path,
			wp_json_encode(
				array(
					'run_id'              => $run_id,
					'issues'              => $issues,
					'checkout_page_id'    => (int) $checkout_page_id,
					'checkout_renderer'   => 'shortcode',
					'hpos_mode'           => $summary['hpos_enabled'] ? 'hpos' : 'cpt',
					'woocommerce_version' => defined( 'WC_VERSION' ) ? WC_VERSION : '',
					'product_ids'         => $created_products,
					'variable_product_id' => $variable_product_id,
					'variation_ids'       => $variation_ids,
					'rows'                => $rows,
					'metrics'             => $summary,
				),
				JSON_PRETTY_PRINT
			) . "\n"
		);
	}

	return array(
		'metrics'   => $summary,
		'metadata'  => array(
			'runner'                => 'wp-codebox',
			'workload'              => 'checkout-shortcode-place-order-latency',
			'issues'                => $issues,
			'checkout_renderer'     => 'shortcode',
			'browser_backed'        => false,
			'woocommerce_version'   => defined( 'WC_VERSION' ) ? WC_VERSION : '',
			'hpos_mode'             => $summary['hpos_enabled'] ? 'hpos' : 'cpt',
			'payment_methods'       => $payment_methods,
		),
		'artifacts' => $artifact_path ? array( 'raw_result' => array( 'path' => $artifact_path, 'kind' => 'json' ) ) : array(),
	);
};
