<?php
/**
 * WP Codebox-backed WooCommerce checkout atomicity repro workload.
 *
 * Reproduces the race window tracked in:
 * - https://github.com/woocommerce/woocommerce/issues/14541
 * - https://github.com/woocommerce/woocommerce/issues/62659
 * - https://github.com/woocommerce/woocommerce/issues/43770
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

	$run_id = 'woocommerce-checkout-concurrent-create-order-' . getmypid() . '-' . time() . '-' . wp_generate_password( 6, false );
	$issues = array(
		'https://github.com/woocommerce/woocommerce/issues/14541',
		'https://github.com/woocommerce/woocommerce/issues/62659',
		'https://github.com/woocommerce/woocommerce/issues/43770',
	);

	wp_set_current_user( 0 );
	update_option( 'woocommerce_default_country', 'US:CA' );
	update_option( 'woocommerce_currency', 'USD' );
	update_option( 'woocommerce_prices_include_tax', 'no' );
	update_option( 'woocommerce_calc_taxes', 'no' );
	update_option( 'woocommerce_enable_guest_checkout', 'yes' );

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
	WC()->cart->empty_cart();

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

	$cart_item_key = 'homeboy_concurrent_checkout_' . md5( $run_id );
	WC()->cart->cart_contents = array(
		$cart_item_key => array(
			'key'               => $cart_item_key,
			'product_id'        => $product->get_id(),
			'variation_id'      => 0,
			'variation'         => array(),
			'quantity'          => 1,
			'data'              => $product,
			'line_subtotal'     => 19.99,
			'line_subtotal_tax' => 0,
			'line_total'        => 19.99,
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
	$cart_hash = WC()->cart->get_cart_hash();
	$email     = 'homeboy-' . $run_id . '@example.com';
	$data      = array(
		'billing_first_name' => 'Homeboy',
		'billing_last_name'  => 'Checkout',
		'billing_company'    => '',
		'billing_country'    => 'US',
		'billing_address_1'  => '123 Atomicity Way',
		'billing_address_2'  => '',
		'billing_city'       => 'San Francisco',
		'billing_state'      => 'CA',
		'billing_postcode'   => '94107',
		'billing_phone'      => '5555555555',
		'billing_email'      => $email,
		'shipping_first_name' => 'Homeboy',
		'shipping_last_name' => 'Checkout',
		'shipping_company'   => '',
		'shipping_country'   => 'US',
		'shipping_address_1' => '123 Atomicity Way',
		'shipping_address_2' => '',
		'shipping_city'      => 'San Francisco',
		'shipping_state'     => 'CA',
		'shipping_postcode'  => '94107',
		'order_comments'     => 'Homeboy checkout atomicity repro ' . $run_id,
		'payment_method'     => '',
		'terms'              => 1,
		'createaccount'      => 0,
		'ship_to_different_address' => 0,
	);

	$checkout = WC()->checkout();
	$before   = microtime( true );
	$unexpected_output = '';
	ob_start();
	try {
		$order_id_1 = $checkout->create_order( $data );
		$order_id_2 = $checkout->create_order( $data );
	} finally {
		$unexpected_output = (string) ob_get_clean();
	}
	$elapsed_ms = ( microtime( true ) - $before ) * 1000;

	if ( is_wp_error( $order_id_1 ) ) {
		throw new RuntimeException( 'First create_order failed: ' . $order_id_1->get_error_message() );
	}
	if ( is_wp_error( $order_id_2 ) ) {
		throw new RuntimeException( 'Second create_order failed: ' . $order_id_2->get_error_message() );
	}

	$order_ids = array_map( 'absint', array( $order_id_1, $order_id_2 ) );
	$orders    = array_filter( array_map( 'wc_get_order', $order_ids ) );
	$unique_order_ids = array_values( array_unique( $order_ids ) );
	$unique_orders    = array_filter( array_map( 'wc_get_order', $unique_order_ids ) );
	$main_order       = wc_get_order( $order_ids[0] );
	$duplicate_created = count( $unique_order_ids ) > 1 ? 1 : 0;
	$main_order_item_count = $main_order instanceof WC_Order ? count( $main_order->get_items() ) : 0;
	$main_order_total      = $main_order instanceof WC_Order ? (float) $main_order->get_total() : 0;

	$artifact = array(
		'run_id'             => $run_id,
		'issues'             => $issues,
		'cart_hash'          => $cart_hash,
		'product_id'         => $product->get_id(),
		'cart_item_key'      => $cart_item_key,
		'billing_email'      => $email,
		'order_ids'          => $order_ids,
		'unique_order_ids'   => $unique_order_ids,
		'duplicate_created'  => (bool) $duplicate_created,
		'unexpected_output'  => $unexpected_output,
		'orders'             => array_map(
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
		'success_rate'               => 1,
		'duplicate_reproduced'       => $duplicate_created,
		'order_create_attempts'      => 2,
		'unique_order_count'         => count( $unique_order_ids ),
		'duplicate_order_count'      => max( 0, count( $unique_order_ids ) - 1 ),
		'second_attempt_reused_first_order' => $order_ids[0] === $order_ids[1] ? 1 : 0,
		'main_order_succeeded'       => $main_order instanceof WC_Order ? 1 : 0,
		'main_order_item_count'      => $main_order_item_count,
		'main_order_total'           => $main_order_total,
		'unexpected_output_detected' => '' === $unexpected_output ? 0 : 1,
		'unexpected_output_bytes'    => strlen( $unexpected_output ),
		'elapsed_ms'                 => $elapsed_ms,
		'cart_items'                 => WC()->cart->get_cart_contents_count(),
		'cart_total'                 => (float) WC()->cart->get_total( 'edit' ),
		'unique_same_cart_hash_order_count' => count(
			array_filter(
				$unique_orders,
				static function ( WC_Order $order ) use ( $cart_hash ): bool {
					return $order->get_cart_hash() === $cart_hash;
				}
			)
		),
		'same_cart_hash_order_count' => count(
			array_filter(
				$orders,
				static function ( WC_Order $order ) use ( $cart_hash ): bool {
					return $order->get_cart_hash() === $cart_hash;
				}
			)
		),
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
			'runner'   => 'wp-codebox',
			'workload' => 'checkout-concurrent-create-order',
			'issues'   => $issues,
			'cart_hash' => $cart_hash,
		),
		'artifacts' => $artifact_path ? array( 'raw_result' => array( 'path' => $artifact_path, 'kind' => 'json' ) ) : array(),
	);
};
