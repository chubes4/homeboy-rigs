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
	update_option( 'woocommerce_enable_coupons', 'yes' );

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

	$coupon_code = 'homeboy-cart-race-' . strtolower( wp_generate_password( 6, false ) );
	$coupon      = new WC_Coupon();
	$coupon->set_code( $coupon_code );
	$coupon->set_discount_type( 'fixed_cart' );
	$coupon->set_amount( '5.00' );
	$coupon->set_individual_use( false );
	$coupon->save();

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

	$guardrail_session_domains = array(
		'applied_coupons'         => array(
			'label' => 'Applied coupons',
			'key'   => 'applied_coupons',
		),
		'chosen_shipping_methods' => array(
			'label' => 'Chosen shipping methods',
			'key'   => 'chosen_shipping_methods',
		),
		'shipping_for_package_0'  => array(
			'label' => 'Shipping package rates',
			'key'   => 'shipping_for_package_0',
		),
		'removed_cart_contents'   => array(
			'label' => 'Removed cart contents',
			'key'   => 'removed_cart_contents',
		),
		'order_awaiting_payment'  => array(
			'label' => 'Order awaiting payment',
			'key'   => 'order_awaiting_payment',
		),
		'store_api_draft_order'   => array(
			'label' => 'Store API draft order',
			'key'   => 'store_api_draft_order',
		),
		'customer'                => array(
			'label' => 'Customer session metadata',
			'key'   => 'customer',
		),
		'homeboy_custom_metadata' => array(
			'label' => 'Custom session metadata',
			'key'   => 'homeboy_custom_metadata',
		),
	);

	$get_session_value = static function ( array $session, string $key ) {
		return array_key_exists( $key, $session ) ? maybe_unserialize( $session[ $key ] ) : null;
	};

	$seed_session = static function ( array $values ) use ( $wpdb, $session_table, $customer_id, $make_request_session ): array {
		$wpdb->delete( $session_table, array( 'session_key' => $customer_id ) );
		$session = $make_request_session();
		foreach ( $values as $key => $value ) {
			$session->set( $key, $value );
		}
		$session->save_data();
		return $values;
	};

	$summarize_guardrails = static function ( array $before, array $after ) use ( $guardrail_session_domains, $get_session_value ): array {
		$summary = array();
		foreach ( $guardrail_session_domains as $domain => $definition ) {
			$key           = $definition['key'];
			$before_exists = array_key_exists( $key, $before );
			$after_exists  = array_key_exists( $key, $after );
			$summary[ $domain ] = array(
				'label'         => $definition['label'],
				'key'           => $key,
				'before_exists' => $before_exists,
				'after_exists'  => $after_exists,
				'lost'          => $before_exists && ! $after_exists,
				'before_value'  => $get_session_value( $before, $key ),
				'after_value'   => $get_session_value( $after, $key ),
			);
		}

		return $summary;
	};

	$add_to_cart_session = $make_request_session();
	$cart_page_session   = $make_request_session();

	WC()->session = $add_to_cart_session;
	WC()->cart    = new WC_Cart();
	$cart_item_key = WC()->cart->add_to_cart( $product->get_id(), 1 );
	WC()->cart->apply_coupon( $coupon_code );
	WC()->cart->calculate_totals();
	$cart_session = new WC_Cart_Session( WC()->cart );
	$cart_session->set_session();
	WC()->session->set( 'chosen_shipping_methods', array( 'flat_rate:homeboy' ) );
	WC()->session->set(
		'shipping_for_package_0',
		array(
			'package_hash' => md5( $run_id . ':package-0' ),
			'rates'        => array(
				'flat_rate:homeboy' => array(
					'id'    => 'flat_rate:homeboy',
					'label' => 'Homeboy deterministic flat rate',
					'cost'  => '7.50',
				),
			),
		)
	);
	WC()->session->set(
		'removed_cart_contents',
		array(
			'homeboy_removed_' . $run_id => array(
				'product_id' => $product->get_id(),
				'quantity'   => 1,
				'line_total' => '19.99',
			),
		)
	);
	WC()->session->set( 'order_awaiting_payment', 424242 );
	WC()->session->set( 'store_api_draft_order', 242424 );
	WC()->session->set(
		'customer',
		array(
			'email'      => 'homeboy-cart-race@example.test',
			'first_name' => 'Homeboy',
			'last_name'  => 'Session Race',
			'country'    => 'US',
			'state'      => 'CA',
		)
	);
	WC()->session->set(
		'homeboy_custom_metadata',
		array(
			'run_id'        => $run_id,
			'cart_item_key' => $cart_item_key,
		)
	);
	$add_to_cart_session->save_data();

	$after_add_to_cart = $get_persisted_session();
	$cart_after_add    = isset( $after_add_to_cart['cart'] ) ? maybe_unserialize( $after_add_to_cart['cart'] ) : array();
	$guardrails_after_add = $summarize_guardrails( $after_add_to_cart, $after_add_to_cart );

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
	$guardrails_after_stale_save = $summarize_guardrails( $after_add_to_cart, $after_stale_cart_page_save );

	$cart_item_count_after_add        = is_array( $cart_after_add ) ? count( $cart_after_add ) : 0;
	$cart_item_count_after_stale_save = is_array( $cart_after_stale_save ) ? count( $cart_after_stale_save ) : 0;
	$overwrite_reproduced             = $cart_item_count_after_add > 0 && 0 === $cart_item_count_after_stale_save && ! empty( $notices_after_stale_save );
	$guardrail_expected_keys          = array_map(
		static function ( array $definition ): string {
			return $definition['key'];
		},
		$guardrail_session_domains
	);
	$guardrail_keys_present_after_add = array_values( array_intersect( $guardrail_expected_keys, array_keys( $after_add_to_cart ) ) );
	$guardrail_keys_after_stale_save  = array_values( array_intersect( $guardrail_expected_keys, array_keys( $after_stale_cart_page_save ) ) );
	$guardrail_keys_lost              = array_values( array_diff( $guardrail_keys_present_after_add, $guardrail_keys_after_stale_save ) );
	$guardrail_all_domains_clobbered  = count( $guardrail_keys_present_after_add ) > 0 && count( $guardrail_keys_present_after_add ) === count( $guardrail_keys_lost );

	$delete_seed = $seed_session(
		array(
			'homeboy_delete_target'        => 'delete-me',
			'homeboy_delete_baseline'      => 'delete-baseline',
			'homeboy_delete_concurrent'    => 'before-current-write',
		)
	);
	$stale_delete_session   = $make_request_session();
	$current_delete_session = $make_request_session();
	$current_delete_session->set( 'homeboy_delete_concurrent', 'current-write-survived' );
	$current_delete_session->set( 'homeboy_delete_current_only', 'current-only-survived' );
	$current_delete_session->save_data();
	$stale_delete_session->__unset( 'homeboy_delete_target' );
	$stale_delete_session->save_data();
	$after_stale_delete = $get_persisted_session();

	$update_seed = $seed_session(
		array(
			'homeboy_update_target'        => 'before-stale-update',
			'homeboy_update_baseline'      => 'update-baseline',
			'homeboy_update_concurrent'    => 'before-current-write',
		)
	);
	$stale_update_session   = $make_request_session();
	$current_update_session = $make_request_session();
	$current_update_session->set( 'homeboy_update_concurrent', 'current-write-survived' );
	$current_update_session->set( 'homeboy_update_current_only', 'current-only-survived' );
	$current_update_session->save_data();
	$stale_update_session->set( 'homeboy_update_target', 'stale-update-applied' );
	$stale_update_session->save_data();
	$after_stale_update = $get_persisted_session();

	$same_key_seed = $seed_session(
		array(
			'homeboy_same_key_target'     => 'before-conflict',
			'homeboy_same_key_baseline'   => 'same-key-baseline',
			'homeboy_same_key_concurrent' => 'before-current-write',
		)
	);
	$stale_same_key_session   = $make_request_session();
	$current_same_key_session = $make_request_session();
	$current_same_key_session->set( 'homeboy_same_key_target', 'current-conflict-write' );
	$current_same_key_session->set( 'homeboy_same_key_concurrent', 'current-write-survived' );
	$current_same_key_session->set( 'homeboy_same_key_current_only', 'current-only-survived' );
	$current_same_key_session->save_data();
	$stale_same_key_session->set( 'homeboy_same_key_target', 'stale-conflict-wins' );
	$stale_same_key_session->save_data();
	$after_stale_same_key = $get_persisted_session();

	$merge_guardrails = array(
		'delete'   => array(
			'seed'                         => $delete_seed,
			'after'                        => $after_stale_delete,
			'target_removed'               => ! array_key_exists( 'homeboy_delete_target', $after_stale_delete ),
			'baseline_preserved'           => 'delete-baseline' === $get_session_value( $after_stale_delete, 'homeboy_delete_baseline' ),
			'concurrent_update_preserved'  => 'current-write-survived' === $get_session_value( $after_stale_delete, 'homeboy_delete_concurrent' ),
			'concurrent_insert_preserved'  => 'current-only-survived' === $get_session_value( $after_stale_delete, 'homeboy_delete_current_only' ),
		),
		'update'   => array(
			'seed'                         => $update_seed,
			'after'                        => $after_stale_update,
			'target_updated'               => 'stale-update-applied' === $get_session_value( $after_stale_update, 'homeboy_update_target' ),
			'baseline_preserved'           => 'update-baseline' === $get_session_value( $after_stale_update, 'homeboy_update_baseline' ),
			'concurrent_update_preserved'  => 'current-write-survived' === $get_session_value( $after_stale_update, 'homeboy_update_concurrent' ),
			'concurrent_insert_preserved'  => 'current-only-survived' === $get_session_value( $after_stale_update, 'homeboy_update_current_only' ),
		),
		'same_key' => array(
			'seed'                         => $same_key_seed,
			'after'                        => $after_stale_same_key,
			'last_writer_wins'             => 'stale-conflict-wins' === $get_session_value( $after_stale_same_key, 'homeboy_same_key_target' ),
			'baseline_preserved'           => 'same-key-baseline' === $get_session_value( $after_stale_same_key, 'homeboy_same_key_baseline' ),
			'concurrent_update_preserved'  => 'current-write-survived' === $get_session_value( $after_stale_same_key, 'homeboy_same_key_concurrent' ),
			'concurrent_insert_preserved'  => 'current-only-survived' === $get_session_value( $after_stale_same_key, 'homeboy_same_key_current_only' ),
		),
	);
	$merge_guardrail_all_passed = true;
	foreach ( $merge_guardrails as $phase_summary ) {
		foreach ( $phase_summary as $key => $value ) {
			if ( 'seed' === $key || 'after' === $key ) {
				continue;
			}
			$merge_guardrail_all_passed = $merge_guardrail_all_passed && (bool) $value;
		}
	}

	$artifact = array(
		'run_id'                       => $run_id,
		'issues'                       => $issues,
		'customer_id'                  => $customer_id,
		'cookie_name'                  => $cookie_name,
		'product_id'                   => $product->get_id(),
		'coupon_id'                    => $coupon->get_id(),
		'coupon_code'                  => $coupon_code,
		'after_add_to_cart_keys'       => array_keys( $after_add_to_cart ),
		'after_stale_save_keys'        => array_keys( $after_stale_cart_page_save ),
		'cart_after_add'               => $cart_after_add,
		'cart_after_stale_save'        => $cart_after_stale_save,
		'notices_after_stale_save'     => $notices_after_stale_save,
		'guardrail_domains_after_add'        => $guardrails_after_add,
		'guardrail_domains_after_stale_save' => $guardrails_after_stale_save,
		'merge_guardrails'             => $merge_guardrails,
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
		'guardrail_domain_count_after_add_to_cart'        => count( $guardrail_keys_present_after_add ),
		'guardrail_domain_count_after_stale_save'         => count( $guardrail_keys_after_stale_save ),
		'guardrail_domain_count_lost_after_stale_save' => count( $guardrail_keys_lost ),
		'guardrail_all_domains_clobbered'              => $guardrail_all_domains_clobbered ? 1 : 0,
		'merge_guardrail_all_passed'                   => $merge_guardrail_all_passed ? 1 : 0,
		'merge_guardrail_delete_target_removed'        => $merge_guardrails['delete']['target_removed'] ? 1 : 0,
		'merge_guardrail_delete_baseline_preserved'    => $merge_guardrails['delete']['baseline_preserved'] ? 1 : 0,
		'merge_guardrail_delete_concurrent_update_preserved' => $merge_guardrails['delete']['concurrent_update_preserved'] ? 1 : 0,
		'merge_guardrail_delete_concurrent_insert_preserved' => $merge_guardrails['delete']['concurrent_insert_preserved'] ? 1 : 0,
		'merge_guardrail_update_target_updated'        => $merge_guardrails['update']['target_updated'] ? 1 : 0,
		'merge_guardrail_update_baseline_preserved'    => $merge_guardrails['update']['baseline_preserved'] ? 1 : 0,
		'merge_guardrail_update_concurrent_update_preserved' => $merge_guardrails['update']['concurrent_update_preserved'] ? 1 : 0,
		'merge_guardrail_update_concurrent_insert_preserved' => $merge_guardrails['update']['concurrent_insert_preserved'] ? 1 : 0,
		'merge_guardrail_same_key_last_writer_wins'    => $merge_guardrails['same_key']['last_writer_wins'] ? 1 : 0,
		'merge_guardrail_same_key_baseline_preserved'  => $merge_guardrails['same_key']['baseline_preserved'] ? 1 : 0,
		'merge_guardrail_same_key_concurrent_update_preserved' => $merge_guardrails['same_key']['concurrent_update_preserved'] ? 1 : 0,
		'merge_guardrail_same_key_concurrent_insert_preserved' => $merge_guardrails['same_key']['concurrent_insert_preserved'] ? 1 : 0,
	);

	foreach ( $guardrails_after_stale_save as $domain => $domain_summary ) {
		$metric_key = preg_replace( '/[^a-z0-9_]+/', '_', strtolower( $domain ) );
		$summary[ $metric_key . '_present_after_add_to_cart' ] = $domain_summary['before_exists'] ? 1 : 0;
		$summary[ $metric_key . '_present_after_stale_save' ]  = $domain_summary['after_exists'] ? 1 : 0;
		$summary[ $metric_key . '_lost_after_stale_save' ]     = $domain_summary['lost'] ? 1 : 0;
	}

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
