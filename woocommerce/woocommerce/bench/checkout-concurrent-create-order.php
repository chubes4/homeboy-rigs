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
	ini_set( 'display_errors', '0' );

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
		'https://github.com/woocommerce/woocommerce/pull/65588',
		'https://github.com/woocommerce/woocommerce/pull/65588#pullrequestreview-4488383929',
		'https://github.com/chubes4/homeboy-rigs/issues/269',
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
	$cart_hash          = WC()->cart->get_cart_hash();
	$session_marker     = WC()->session ? (string) WC()->session->get_customer_id() : '';
	$session_marker_two = 'homeboy-session-switch-' . md5( $run_id );
	$email              = 'homeboy-' . $run_id . '@example.com';
	$data               = array(
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
	$make_checkout_data = static function ( string $billing_email, string $suffix = '' ) use ( $data ): array {
		$scenario_data                         = $data;
		$scenario_data['billing_email']        = $billing_email;
		$scenario_data['billing_first_name']   = 'Homeboy' . $suffix;
		$scenario_data['shipping_first_name']  = 'Homeboy' . $suffix;
		$scenario_data['order_comments']       = trim( $data['order_comments'] . ' ' . $suffix );

		return $scenario_data;
	};
	$checkout     = WC()->checkout();
	$get_identity = static function ( array $checkout_data, string $scenario_session_marker, int $customer_id ) use ( $cart_hash ): array {
		return array(
			'is_guest'       => 0 === $customer_id,
			'customer_id'    => $customer_id,
			'billing_email'  => isset( $checkout_data['billing_email'] ) ? (string) $checkout_data['billing_email'] : '',
			'cart_hash'      => $cart_hash,
			'session_marker' => $scenario_session_marker,
		);
	};
	$order_snapshot = static function ( WC_Order $order ): array {
		return array(
			'id'            => $order->get_id(),
			'status'        => $order->get_status(),
			'total'         => (float) $order->get_total(),
			'cart_hash'     => $order->get_cart_hash(),
			'customer_id'   => $order->get_customer_id(),
			'billing_email' => $order->get_billing_email(),
			'item_count'    => count( $order->get_items() ),
		);
	};
	$run_identity_scenario = static function ( string $scenario, array $first_context, array $second_context, bool $expect_reuse, string $first_session_marker, string $second_session_marker ) use ( $checkout, $get_identity, $make_checkout_data, $order_snapshot ): array {
		if ( WC()->session ) {
			WC()->session->__unset( 'order_awaiting_payment' );
		}

		wp_set_current_user( (int) $first_context['customer_id'] );
		$first_data = $make_checkout_data( (string) $first_context['billing_email'], (string) $first_context['suffix'] );
		$order_id_1 = $checkout->create_order( $first_data );
		if ( is_wp_error( $order_id_1 ) ) {
			throw new RuntimeException( $scenario . ' first create_order failed: ' . $order_id_1->get_error_message() );
		}

		if ( WC()->session ) {
			WC()->session->set( 'order_awaiting_payment', absint( $order_id_1 ) );
		}
		$first_order_before_second = wc_get_order( absint( $order_id_1 ) );
		$first_order_before_second = $first_order_before_second ? $order_snapshot( $first_order_before_second ) : array();

		wp_set_current_user( (int) $second_context['customer_id'] );
		$second_data = $make_checkout_data( (string) $second_context['billing_email'], (string) $second_context['suffix'] );
		$order_id_2  = $checkout->create_order( $second_data );
		if ( is_wp_error( $order_id_2 ) ) {
			throw new RuntimeException( $scenario . ' second create_order failed: ' . $order_id_2->get_error_message() );
		}

		$order_id_1 = absint( $order_id_1 );
		$order_id_2 = absint( $order_id_2 );
		$reused     = $order_id_1 === $order_id_2;
		$orders     = array_filter( array_map( 'wc_get_order', array( $order_id_1, $order_id_2 ) ) );
		$first_order_after_second = wc_get_order( $order_id_1 );
		$first_order_after_second = $first_order_after_second ? $order_snapshot( $first_order_after_second ) : array();
		$first_order_mutated      = $first_order_before_second && $first_order_after_second && (
			$first_order_before_second['customer_id'] !== $first_order_after_second['customer_id']
			|| $first_order_before_second['billing_email'] !== $first_order_after_second['billing_email']
		);

		return array(
			'name'           => $scenario,
			'expected_reuse' => $expect_reuse,
			'actual_reuse'   => $reused,
			'passed'         => $expect_reuse === $reused,
			'order_ids'      => array( $order_id_1, $order_id_2 ),
			'unique_orders'  => array_values( array_unique( array( $order_id_1, $order_id_2 ) ) ),
			'identities'     => array(
				'first'  => $get_identity( $first_data, $first_session_marker, (int) $first_context['customer_id'] ),
				'second' => $get_identity( $second_data, $second_session_marker, (int) $second_context['customer_id'] ),
			),
			'first_order_before_second_attempt' => $first_order_before_second,
			'first_order_after_second_attempt'  => $first_order_after_second,
			'first_order_mutated_by_second_attempt' => $first_order_mutated,
			'orders'         => array_map( $order_snapshot, $orders ),
		);
	};

	$before   = microtime( true );
	$order_id_1 = $checkout->create_order( $data );
	$order_id_2 = $checkout->create_order( $data );
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
	$duplicate_created = count( $unique_order_ids ) > 1 ? 1 : 0;

	$logged_in_user_id_1 = wp_insert_user(
		array(
			'user_login' => 'homeboy_checkout_' . md5( $run_id . '_one' ),
			'user_pass'  => wp_generate_password( 20 ),
			'user_email' => 'homeboy-user-one-' . $run_id . '@example.com',
			'role'       => 'customer',
		)
	);
	$logged_in_user_id_2 = wp_insert_user(
		array(
			'user_login' => 'homeboy_checkout_' . md5( $run_id . '_two' ),
			'user_pass'  => wp_generate_password( 20 ),
			'user_email' => 'homeboy-user-two-' . $run_id . '@example.com',
			'role'       => 'customer',
		)
	);
	if ( is_wp_error( $logged_in_user_id_1 ) || is_wp_error( $logged_in_user_id_2 ) ) {
		throw new RuntimeException( 'Failed to create checkout identity guardrail users.' );
	}

	$identity_scenarios = array(
		$run_identity_scenario(
			'guest_same_cart_retry',
			array( 'customer_id' => 0, 'billing_email' => 'homeboy-guest-' . $run_id . '@example.com', 'suffix' => ' Guest A' ),
			array( 'customer_id' => 0, 'billing_email' => 'homeboy-guest-' . $run_id . '@example.com', 'suffix' => ' Guest A Retry' ),
			true,
			$session_marker,
			$session_marker
		),
		$run_identity_scenario(
			'logged_in_same_cart_retry',
			array( 'customer_id' => $logged_in_user_id_1, 'billing_email' => 'homeboy-user-one-' . $run_id . '@example.com', 'suffix' => ' User A' ),
			array( 'customer_id' => $logged_in_user_id_1, 'billing_email' => 'homeboy-user-one-' . $run_id . '@example.com', 'suffix' => ' User A Retry' ),
			true,
			$session_marker,
			$session_marker
		),
		$run_identity_scenario(
			'same_cart_hash_different_billing_email',
			array( 'customer_id' => 0, 'billing_email' => 'homeboy-guest-one-' . $run_id . '@example.com', 'suffix' => ' Guest Email A' ),
			array( 'customer_id' => 0, 'billing_email' => 'homeboy-guest-two-' . $run_id . '@example.com', 'suffix' => ' Guest Email B' ),
			false,
			$session_marker,
			$session_marker
		),
		$run_identity_scenario(
			'same_cart_hash_different_customer_id',
			array( 'customer_id' => $logged_in_user_id_1, 'billing_email' => 'homeboy-user-one-' . $run_id . '@example.com', 'suffix' => ' User A' ),
			array( 'customer_id' => $logged_in_user_id_2, 'billing_email' => 'homeboy-user-two-' . $run_id . '@example.com', 'suffix' => ' User B' ),
			false,
			$session_marker,
			$session_marker
		),
		$run_identity_scenario(
			'session_user_switch_isolation',
			array( 'customer_id' => $logged_in_user_id_1, 'billing_email' => 'homeboy-session-one-' . $run_id . '@example.com', 'suffix' => ' Session A' ),
			array( 'customer_id' => $logged_in_user_id_2, 'billing_email' => 'homeboy-session-two-' . $run_id . '@example.com', 'suffix' => ' Session B' ),
			false,
			$session_marker,
			$session_marker_two
		),
	);
	wp_set_current_user( 0 );
	$identity_guardrails_passed = count(
		array_filter(
			$identity_scenarios,
			static function ( array $scenario ): bool {
				return ! empty( $scenario['passed'] );
			}
		)
	);
	$identity_guardrails_failed = count( $identity_scenarios ) - $identity_guardrails_passed;
	$identity_mutation_failures = count(
		array_filter(
			$identity_scenarios,
			static function ( array $scenario ): bool {
				return ! empty( $scenario['first_order_mutated_by_second_attempt'] );
			}
		)
	);

	$artifact = array(
		'run_id'             => $run_id,
		'issues'             => $issues,
		'cart_hash'          => $cart_hash,
		'product_id'         => $product->get_id(),
		'cart_item_key'      => $cart_item_key,
		'billing_email'      => $email,
		'identity_dimensions' => array(
			'cart_hash'      => $cart_hash,
			'session_marker' => $session_marker,
			'dimensions'     => array( 'is_guest', 'customer_id', 'billing_email', 'cart_hash', 'session_marker' ),
		),
		'identity_scenarios' => $identity_scenarios,
		'order_ids'          => $order_ids,
		'unique_order_ids'   => $unique_order_ids,
		'duplicate_created'  => (bool) $duplicate_created,
		'orders'             => array_map( $order_snapshot, $orders ),
	);

	$summary = array(
		'success_rate'               => 1,
		'duplicate_reproduced'       => $duplicate_created,
		'order_create_attempts'      => 2,
		'unique_order_count'         => count( $unique_order_ids ),
		'duplicate_order_count'      => max( 0, count( $unique_order_ids ) - 1 ),
		'elapsed_ms'                 => $elapsed_ms,
		'cart_items'                 => WC()->cart->get_cart_contents_count(),
		'cart_total'                 => (float) WC()->cart->get_total( 'edit' ),
		'identity_guardrail_scenarios' => count( $identity_scenarios ),
		'identity_guardrails_passed' => $identity_guardrails_passed,
		'identity_guardrails_failed' => $identity_guardrails_failed,
		'identity_mutation_failures' => $identity_mutation_failures,
		'identity_guardrails_success_rate' => count( $identity_scenarios ) > 0 ? $identity_guardrails_passed / count( $identity_scenarios ) : 0,
		'guest_same_cart_retry_reused' => (int) $identity_scenarios[0]['actual_reuse'],
		'logged_in_same_cart_retry_reused' => (int) $identity_scenarios[1]['actual_reuse'],
		'different_billing_email_reused' => (int) $identity_scenarios[2]['actual_reuse'],
		'different_customer_id_reused' => (int) $identity_scenarios[3]['actual_reuse'],
		'session_user_switch_reused'  => (int) $identity_scenarios[4]['actual_reuse'],
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
			'identity_guardrails_failed' => $identity_guardrails_failed,
		),
		'artifacts' => $artifact_path ? array( 'raw_result' => array( 'path' => $artifact_path, 'kind' => 'json' ) ) : array(),
	);
};
