<?php
/**
 * WP Codebox-backed WooCommerce checkout atomicity and side-effect guardrail workload.
 *
 * Reproduces the duplicate public create_order window and records guardrails for:
 * - https://github.com/woocommerce/woocommerce/issues/62659
 * - https://github.com/woocommerce/woocommerce/pull/65588
 * - https://github.com/woocommerce/woocommerce/pull/65588#pullrequestreview-4488383929
 * - https://github.com/chubes4/homeboy-rigs/issues/253
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
	if ( ! WC()->payment_gateways && class_exists( 'WC_Payment_Gateways' ) ) {
		WC()->payment_gateways = new WC_Payment_Gateways();
	}

	$run_id = 'woocommerce-checkout-concurrent-create-order-' . getmypid() . '-' . time() . '-' . wp_generate_password( 6, false );
	$issues = array(
		'https://github.com/woocommerce/woocommerce/issues/14541',
		'https://github.com/woocommerce/woocommerce/issues/62659',
		'https://github.com/woocommerce/woocommerce/issues/43770',
		'https://github.com/woocommerce/woocommerce/pull/65588',
		'https://github.com/woocommerce/woocommerce/pull/65588#pullrequestreview-4488383929',
		'https://github.com/chubes4/homeboy-rigs/issues/253',
	);

	wp_set_current_user( 0 );
	update_option( 'woocommerce_default_country', 'US:CA' );
	update_option( 'woocommerce_currency', 'USD' );
	update_option( 'woocommerce_prices_include_tax', 'no' );
	update_option( 'woocommerce_calc_taxes', 'no' );
	update_option( 'woocommerce_enable_guest_checkout', 'yes' );
	update_option( 'woocommerce_enable_coupons', 'yes' );

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
