<?php
/**
 * WP Codebox-backed WooCommerce cart session overwrite race repro workload.
 *
 * Reproduces the stale serialized-session overwrite described in:
 * https://github.com/woocommerce/woocommerce/issues/46483
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
	if ( ! class_exists( 'WC_Session_Handler' ) || ! class_exists( 'WC_Cart' ) || ! class_exists( 'WC_Cart_Session' ) ) {
		throw new RuntimeException( 'WooCommerce cart session classes are not available.' );
	}
	if ( ! did_action( 'woocommerce_init' ) ) {
		WC()->init();
	}

	global $wpdb;

	$run_id = 'woocommerce-cart-session-overwrite-race-' . getmypid() . '-' . time() . '-' . wp_generate_password( 6, false );
	$issues = array(
		'https://github.com/woocommerce/woocommerce/issues/46483',
	);

	wp_set_current_user( 0 );
	update_option( 'woocommerce_default_country', 'US:CA' );
	update_option( 'woocommerce_currency', 'USD' );
	update_option( 'woocommerce_prices_include_tax', 'no' );
	update_option( 'woocommerce_calc_taxes', 'no' );

	$product = new WC_Product_Simple();
	$product->set_name( 'Homeboy Cart Session Race Product ' . $run_id );
	$product->set_slug( 'homeboy-cart-session-race-' . $run_id );
	$product->set_status( 'publish' );
	$product->set_sku( 'homeboy-cart-session-race-' . $run_id );
	$product->set_regular_price( '19.99' );
	$product->set_price( '19.99' );
	$product->set_virtual( true );
	$product->set_manage_stock( false );
	$product->set_stock_status( 'instock' );
	$product->save();

	$session_probe = new WC_Session_Handler();
	$cookie_name   = ( new ReflectionProperty( WC_Session_Handler::class, '_cookie' ) )->getValue( $session_probe );
	$session_table = $wpdb->prefix . 'woocommerce_sessions';
	$customer_id   = 't_homeboy_' . md5( $run_id );
	$expiration    = time() + 2 * DAY_IN_SECONDS;
	$expiring      = time() + DAY_IN_SECONDS;
	$hash_method   = new ReflectionMethod( WC_Session_Handler::class, 'hash' );
	$hash_method->setAccessible( true );
	$cookie_value = $customer_id . '|' . $expiration . '|' . $expiring . '|' . $hash_method->invoke( $session_probe, $customer_id . '|' . $expiration );

	$wpdb->delete( $session_table, array( 'session_key' => $customer_id ) );
	$_COOKIE[ $cookie_name ] = $cookie_value;

	$make_request_session = static function () use ( $cookie_name, $cookie_value ): WC_Session_Handler {
		$_COOKIE[ $cookie_name ] = $cookie_value;
		$session = new WC_Session_Handler();
		$session->init();
		return $session;
	};

	$get_persisted_session = static function () use ( $wpdb, $session_table, $customer_id ): array {
		$row = $wpdb->get_var(
			$wpdb->prepare(
				'SELECT session_value FROM %i WHERE session_key = %s',
				$session_table,
				$customer_id
			)
		);
		return $row ? (array) maybe_unserialize( $row ) : array();
	};

	$add_to_cart_session = $make_request_session();
	$cart_page_session   = $make_request_session();

	WC()->session = $add_to_cart_session;
	WC()->cart    = new WC_Cart();
	WC()->cart->add_to_cart( $product->get_id(), 1 );
	WC()->cart->calculate_totals();
	$cart_session = new WC_Cart_Session( WC()->cart );
	$cart_session->set_session();
	$add_to_cart_session->save_data();

	$after_add_to_cart = $get_persisted_session();
	$cart_after_add    = isset( $after_add_to_cart['cart'] ) ? maybe_unserialize( $after_add_to_cart['cart'] ) : array();

	WC()->session = $cart_page_session;
	WC()->cart    = new WC_Cart();
	WC()->session->set(
		'wc_notices',
		array(
			'notice' => array(
				array(
					'notice' => 'Homeboy cart page refresh dirtied the stale session snapshot.',
					'data'   => array(),
				),
			),
		)
	);
	$cart_page_session->save_data();

	$after_stale_cart_page_save = $get_persisted_session();
	$cart_after_stale_save      = isset( $after_stale_cart_page_save['cart'] ) ? maybe_unserialize( $after_stale_cart_page_save['cart'] ) : array();
	$notices_after_stale_save   = isset( $after_stale_cart_page_save['wc_notices'] ) ? maybe_unserialize( $after_stale_cart_page_save['wc_notices'] ) : array();

	$cart_item_count_after_add        = is_array( $cart_after_add ) ? count( $cart_after_add ) : 0;
	$cart_item_count_after_stale_save = is_array( $cart_after_stale_save ) ? count( $cart_after_stale_save ) : 0;
	$overwrite_reproduced             = $cart_item_count_after_add > 0 && 0 === $cart_item_count_after_stale_save && ! empty( $notices_after_stale_save );

	$artifact = array(
		'run_id'                       => $run_id,
		'issues'                       => $issues,
		'customer_id'                  => $customer_id,
		'cookie_name'                  => $cookie_name,
		'product_id'                   => $product->get_id(),
		'after_add_to_cart_keys'       => array_keys( $after_add_to_cart ),
		'after_stale_save_keys'        => array_keys( $after_stale_cart_page_save ),
		'cart_after_add'               => $cart_after_add,
		'cart_after_stale_save'        => $cart_after_stale_save,
		'notices_after_stale_save'     => $notices_after_stale_save,
		'overwrite_reproduced'         => $overwrite_reproduced,
	);

	$summary = array(
		'success_rate'                          => 1,
		'overwrite_reproduced'                  => $overwrite_reproduced ? 1 : 0,
		'cart_item_count_after_add_to_cart'      => $cart_item_count_after_add,
		'cart_item_count_after_stale_save'       => $cart_item_count_after_stale_save,
		'wc_notices_present_after_stale_save'    => empty( $notices_after_stale_save ) ? 0 : 1,
		'persisted_key_count_after_add_to_cart'  => count( $after_add_to_cart ),
		'persisted_key_count_after_stale_save'   => count( $after_stale_cart_page_save ),
	);

	$artifact_path = '';
	$shared_state  = getenv( 'HOMEBOY_BENCH_SHARED_STATE' );
	if ( $shared_state ) {
		$artifact_dir = rtrim( $shared_state, '/' ) . '/cart-session-overwrite-race';
		wp_mkdir_p( $artifact_dir );
		$artifact_path = $artifact_dir . '/' . $run_id . '.json';
		file_put_contents( $artifact_path, wp_json_encode( array_merge( $artifact, array( 'metrics' => $summary ) ), JSON_PRETTY_PRINT ) . "\n" );
	}

	return array(
		'metrics'   => $summary,
		'metadata'  => array(
			'runner'   => 'wp-codebox',
			'workload' => 'cart-session-overwrite-race',
			'issues'   => $issues,
		),
		'artifacts' => $artifact_path ? array( 'raw_result' => array( 'path' => $artifact_path, 'kind' => 'json' ) ) : array(),
	);
};
