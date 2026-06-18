<?php
/**
 * WP Codebox-backed WooCommerce checkout shipping-cache workload.
 *
 * Runs inside the disposable WordPress runtime owned by `wordpress.bench`.
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
		// The bench runner executes in a direct request context; ensure wc_load_cart() is allowed to initialize cart services.
		do_action( 'before_woocommerce_init' );
	}
	if ( ! WC()->countries && class_exists( 'WC_Countries' ) ) {
		WC()->countries = new WC_Countries();
	}

	$cart_items       = max( 1, min( 1000, (int) ( getenv( 'WC_SHIPPING_CACHE_CART_ITEMS' ) ?: 40 ) ) );
	$packages         = max( 1, min( $cart_items, (int) ( getenv( 'WC_SHIPPING_CACHE_PACKAGES' ) ?: 8 ) ) );
	$warm_runs        = max( 1, min( 100, (int) ( getenv( 'WC_SHIPPING_CACHE_WARM_RUNS' ) ?: 5 ) ) );
	$total_churn_runs = max( 1, min( 100, (int) ( getenv( 'WC_SHIPPING_CACHE_TOTAL_CHURN_RUNS' ) ?: 3 ) ) );
	$rehash_runs      = max( 1, min( 100, (int) ( getenv( 'WC_SHIPPING_CACHE_REHASH_RUNS' ) ?: 3 ) ) );
	$run_id           = 'woocommerce-checkout-shipping-cache-' . getmypid() . '-' . time() . '-' . wp_generate_password( 6, false );
	$issues           = array(
		'https://github.com/woocommerce/woocommerce/issues/49259',
		'https://github.com/woocommerce/woocommerce/issues/32055',
		'https://github.com/woocommerce/woocommerce/issues/26569',
	);
	$synthetic_unknown_key = 'homeboy_synthetic_unknown_package_key';

	wp_set_current_user( 1 );
	update_option( 'woocommerce_store_address', '123 Performance Way' );
	update_option( 'woocommerce_store_city', 'San Francisco' );
	update_option( 'woocommerce_default_country', 'US:CA' );
	update_option( 'woocommerce_currency', 'USD' );
	update_option( 'woocommerce_weight_unit', 'lbs' );
	update_option( 'woocommerce_dimension_unit', 'in' );

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
	}
	wc_load_cart();
	if ( ! WC()->cart ) {
		throw new RuntimeException( 'WooCommerce cart failed to initialize.' );
	}
	WC()->cart->empty_cart();

	if ( WC()->customer ) {
		WC()->customer->set_billing_country( 'US' );
		WC()->customer->set_billing_state( 'CA' );
		WC()->customer->set_billing_postcode( '94107' );
		WC()->customer->set_shipping_country( 'US' );
		WC()->customer->set_shipping_state( 'CA' );
		WC()->customer->set_shipping_postcode( '94107' );
		WC()->customer->set_shipping_city( 'San Francisco' );
		WC()->customer->set_shipping_address( '123 Performance Way' );
		WC()->customer->save();
	}

	$zone = new WC_Shipping_Zone();
	$zone->set_zone_name( 'Homeboy Performance US ' . $run_id );
	$zone->set_zone_order( 0 );
	$zone->add_location( 'US', 'country' );
	$zone->save();
	$flat_rate_instance_id = $zone->add_shipping_method( 'flat_rate' );
	update_option(
		'woocommerce_flat_rate_' . $flat_rate_instance_id . '_settings',
		array(
			'enabled'    => 'yes',
			'title'      => 'Homeboy Flat Rate',
			'tax_status' => 'none',
			'cost'       => '5',
		)
	);
	if ( class_exists( 'WC_Cache_Helper' ) ) {
		WC_Cache_Helper::get_transient_version( 'shipping', true );
	}

	$product_ids   = array();
	$cart_contents = array();
	for ( $i = 0; $i < $cart_items; $i++ ) {
		$product = new WC_Product_Simple();
		$product->set_name( 'Homeboy Shipping Cache Product ' . $run_id . ' #' . ( $i + 1 ) );
		$product->set_slug( 'homeboy-shipping-cache-' . $run_id . '-' . ( $i + 1 ) );
		$product->set_status( 'publish' );
		$product->set_sku( 'homeboy-shipping-cache-' . $run_id . '-' . ( $i + 1 ) );
		$product->set_regular_price( '10' );
		$product->set_price( '10' );
		$product->set_virtual( false );
		$product->set_weight( '1' );
		$product->set_length( '4' );
		$product->set_width( '4' );
		$product->set_height( '4' );
		$product->set_manage_stock( false );
		$product->set_stock_status( 'instock' );
		$product->save();
		$product_ids[]                    = $product->get_id();
		$cart_item_key                    = 'homeboy_' . $i;
		$cart_contents[ $cart_item_key ] = array(
			'key'               => $cart_item_key,
			'product_id'        => $product->get_id(),
			'variation_id'      => 0,
			'variation'         => array(),
			'quantity'          => 1,
			'data'              => $product,
			'line_subtotal'     => 10,
			'line_subtotal_tax' => 0,
			'line_total'        => 10,
			'line_tax'          => 0,
			'line_tax_data'     => array(
				'subtotal' => array(),
				'total'    => array(),
			),
			'homeboy_line'      => $i,
		);
	}

	$base_shipping_packages = static function () use ( &$cart_contents ): array {
		return array(
			array(
				'contents'        => $cart_contents,
				'contents_cost'   => array_sum( wp_list_pluck( $cart_contents, 'line_total' ) ),
				'applied_coupons' => array(),
				'user'            => array(
					'ID' => get_current_user_id(),
				),
				'destination'     => array(
					'country'   => WC()->customer ? WC()->customer->get_shipping_country() : 'US',
					'state'     => WC()->customer ? WC()->customer->get_shipping_state() : 'CA',
					'postcode'  => WC()->customer ? WC()->customer->get_shipping_postcode() : '94107',
					'city'      => WC()->customer ? WC()->customer->get_shipping_city() : 'San Francisco',
					'address'   => WC()->customer ? WC()->customer->get_shipping_address() : '123 Performance Way',
					'address_1' => WC()->customer ? WC()->customer->get_shipping_address_1() : '123 Performance Way',
					'address_2' => WC()->customer ? WC()->customer->get_shipping_address_2() : '',
				),
				'cart_subtotal'   => array_sum( wp_list_pluck( $cart_contents, 'line_subtotal' ) ),
			),
		);
	};

	$current_phase = array(
		'field' => '',
		'step'  => 0,
	);
	$split_packages = static function ( array $cart_packages ) use ( $packages, &$current_phase, $synthetic_unknown_key, $flat_rate_instance_id ): array {
		$base_package = $cart_packages[0] ?? array();
		$contents     = array_values( $base_package['contents'] ?? array() );
		if ( empty( $contents ) ) {
			return $cart_packages;
		}

		$chunk_size = max( 1, (int) ceil( count( $contents ) / $packages ) );
		$split      = array();
		foreach ( array_chunk( $contents, $chunk_size ) as $index => $chunk ) {
			$package             = $base_package;
			$package['contents'] = array();
			foreach ( $chunk as $item_index => $item ) {
				$package['contents'][ 'homeboy_' . $index . '_' . $item_index ] = $item;
			}
			$step                             = (int) $current_phase['step'];
			$package['package_id']             = 'homeboy-package-' . $index;
			$package['package_name']           = 'Homeboy Package ' . ( $index + 1 );
			$package['package_index']          = $index;
			$package['homeboy_package_index']  = $index;
			$package['subtotal']               = (float) array_sum( wp_list_pluck( $package['contents'], 'line_subtotal' ) );
			$package['total']                  = (float) array_sum( wp_list_pluck( $package['contents'], 'line_total' ) );

			switch ( $current_phase['field'] ) {
				case 'subtotal':
					$package['subtotal'] += (float) ( $step + $index + 1 );
					break;
				case 'total':
					$package['total'] += (float) ( $step + $index + 1 );
					break;
				case 'package_id':
					$package['package_id'] .= '-churn-' . $step;
					break;
				case 'package_name':
					$package['package_name'] .= ' Churn ' . $step;
					break;
				case 'rates':
					$package['rates'] = array(
						'homeboy_prefilled_rate' => new WC_Shipping_Rate( 'homeboy_prefilled_rate_' . $step . '_' . $index, 'Prefilled Homeboy Rate', '7.00', array(), 'flat_rate', $flat_rate_instance_id ),
					);
					break;
				case 'package_index':
					$package['package_index'] = $index + $step;
					break;
				case 'contents_cost':
					$package['contents_cost'] = (float) $package['contents_cost'] + $step + $index + 1;
					break;
				case 'destination_postcode':
					$package['destination']['postcode'] = '942' . str_pad( (string) ( $step + $index ), 2, '0', STR_PAD_LEFT );
					break;
				case 'unknown_package_key':
					$package[ $synthetic_unknown_key ] = 'default-invalidates-' . $step . '-' . $index;
					break;
		}

			$split[] = $package;
		}

		return $split;
	};

	$rate_calculation_calls = 0;
	$count_rate_calculation = static function () use ( &$rate_calculation_calls ): void {
		++$rate_calculation_calls;
	};
	add_action( 'woocommerce_before_get_rates_for_package', $count_rate_calculation );

	$clear_shipping_cache = static function () use ( $packages ): void {
		if ( ! WC()->session ) {
			return;
		}
		for ( $i = 0; $i < $packages; $i++ ) {
			WC()->session->__unset( 'shipping_for_package_' . $i );
		}
		WC()->session->__unset( 'chosen_shipping_methods' );
	};

	$session_cache_keys = static function () use ( $packages ): array {
		$keys = array();
		if ( ! WC()->session ) {
			return $keys;
		}
		for ( $i = 0; $i < $packages; $i++ ) {
			$key = 'shipping_for_package_' . $i;
			if ( null !== WC()->session->get( $key, null ) ) {
				$keys[] = $key;
			}
		}
		return $keys;
	};

	$measure_shipping = static function ( string $label, string $phase_type = 'control', string $churn_field = '' ) use ( $base_shipping_packages, $split_packages, $session_cache_keys, &$rate_calculation_calls ): array {
		$rate_calls_before = $rate_calculation_calls;
		$shipping_packages = $split_packages( $base_shipping_packages() );
		$before            = microtime( true );
		$packages          = WC()->shipping()->calculate_shipping( $shipping_packages );
		$elapsed           = ( microtime( true ) - $before ) * 1000;
		$rate_calls_delta  = $rate_calculation_calls - $rate_calls_before;
		$rates             = 0;
		foreach ( $packages as $package ) {
			if ( $package instanceof WC_Shipping_Rate ) {
				$rates++;
				continue;
			}
			if ( is_array( $package ) ) {
				$rates += count( $package['rates'] ?? array() );
			}
		}

		return array(
			'label'                  => $label,
			'phase_type'             => $phase_type,
			'churn_field'            => $churn_field,
			'elapsed_ms'             => $elapsed,
			'package_count'          => count( $packages ),
			'rate_count'             => $rates,
			'rate_calculation_calls' => $rate_calls_delta,
			'cache_invalidated'      => $rate_calls_delta > 0,
			'session_cache_keys'     => $session_cache_keys(),
		);
	};

	$rows = array();

	$clear_shipping_cache();
	$rows[] = $measure_shipping( 'cold', 'control' );

	$current_phase = array( 'field' => '', 'step' => 0 );
	for ( $i = 0; $i < $warm_runs; $i++ ) {
		$rows[] = $measure_shipping( 'warm_' . ( $i + 1 ), 'warm_cache' );
	}

	$churn_fields = array( 'subtotal', 'total', 'package_id', 'package_name', 'rates', 'package_index' );
	foreach ( $churn_fields as $field ) {
		for ( $i = 0; $i < $total_churn_runs; $i++ ) {
			$current_phase = array( 'field' => $field, 'step' => $i + 1 );
			$label_prefix  = 'total' === $field ? 'total_field_churn' : $field . '_churn';
			$rows[]        = $measure_shipping( $label_prefix . '_' . ( $i + 1 ), 'field_churn', $field );
		}
	}

	// Preserve the historical aggregate total_churn_* row family for dashboards that already consume it.
	for ( $i = 0; $i < $total_churn_runs; $i++ ) {
		$current_phase = array( 'field' => 'total', 'step' => $i + 1 );
		$rows[]        = $measure_shipping( 'total_churn_' . ( $i + 1 ), 'legacy_total_churn', 'total' );
	}

	$guardrail_fields = array( 'destination_postcode', 'contents_cost', 'unknown_package_key' );
	foreach ( $guardrail_fields as $field ) {
		for ( $i = 0; $i < $rehash_runs; $i++ ) {
			$current_phase = array( 'field' => $field, 'step' => $i + 1 );
			if ( 'destination_postcode' === $field && WC()->customer ) {
				WC()->customer->set_shipping_postcode( '941' . str_pad( (string) ( 10 + $i ), 2, '0', STR_PAD_LEFT ) );
				WC()->customer->save();
			}
			$rows[] = $measure_shipping( $field . '_rehash_' . ( $i + 1 ), 'real_input_guardrail', $field );
		}
	}

	// Preserve the historical rehash_* row family while keeping it backed by a real shipping input.
	for ( $i = 0; $i < $rehash_runs; $i++ ) {
		$current_phase = array( 'field' => 'destination_postcode', 'step' => $i + 101 );
		if ( WC()->customer ) {
			WC()->customer->set_shipping_postcode( '943' . str_pad( (string) ( 10 + $i ), 2, '0', STR_PAD_LEFT ) );
			WC()->customer->save();
		}
		$rows[] = $measure_shipping( 'rehash_' . ( $i + 1 ), 'real_rehash', 'destination_postcode' );
	}

	$current_phase = array( 'field' => '', 'step' => 0 );
	remove_action( 'woocommerce_before_get_rates_for_package', $count_rate_calculation );

	$percentile = static function ( array $values, float $percentile ): float {
		if ( empty( $values ) ) {
			return 0.0;
		}
		sort( $values, SORT_NUMERIC );
		$index = (int) floor( ( count( $values ) - 1 ) * $percentile );
		return (float) $values[ $index ];
	};
	$only_elapsed = static function ( array $rows, string $prefix ): array {
		$values = array();
		foreach ( $rows as $row ) {
			if ( 0 === strpos( $row['label'], $prefix ) ) {
				$values[] = (float) $row['elapsed_ms'];
			}
		}
		return $values;
	};
	$sum_rate_calls = static function ( array $rows, string $prefix ): int {
		$calls = 0;
		foreach ( $rows as $row ) {
			if ( 0 === strpos( $row['label'], $prefix ) ) {
				$calls += (int) ( $row['rate_calculation_calls'] ?? 0 );
			}
		}
		return $calls;
	};
	$phase_metrics = static function ( array $rows, string $prefix ) use ( $only_elapsed, $percentile, $sum_rate_calls ): array {
		$values = $only_elapsed( $rows, $prefix );
		return array(
			'runs'                   => count( $values ),
			'shipping_p50_ms'        => $percentile( $values, 0.50 ),
			'shipping_max_ms'        => empty( $values ) ? 0 : max( $values ),
			'rate_calculation_calls' => $sum_rate_calls( $rows, $prefix ),
		);
	};

	$cold_row           = $rows[0];
	$warm_values        = $only_elapsed( $rows, 'warm_' );
	$total_churn_values = $only_elapsed( $rows, 'total_churn_' );
	$rehash_values      = $only_elapsed( $rows, 'rehash_' );
	$warm_p50           = $percentile( $warm_values, 0.50 );
	$warm_p95           = $percentile( $warm_values, 0.95 );
	$total_churn_p50    = $percentile( $total_churn_values, 0.50 );
	$rehash_p50         = $percentile( $rehash_values, 0.50 );
	$final_cache        = $session_cache_keys();
	$per_churn_metrics  = array();
	foreach ( array_merge( $churn_fields, $guardrail_fields ) as $field ) {
		$prefix = $field . '_churn_';
		if ( 'total' === $field ) {
			$prefix = 'total_field_churn_';
		}
		if ( in_array( $field, $guardrail_fields, true ) ) {
			$prefix = $field . '_rehash_';
		}
		$per_churn_metrics[ $field ] = $phase_metrics( $rows, $prefix );
	}
	$summary = array(
		'success_rate'                         => 1,
		'cart_items'                           => $cart_items,
		'configured_package_target'            => $packages,
		'actual_package_count'                 => (int) $cold_row['package_count'],
		'shipping_rate_count'                  => (int) $cold_row['rate_count'],
		'warm_runs'                            => $warm_runs,
		'total_churn_runs'                     => $total_churn_runs,
		'rehash_runs'                          => $rehash_runs,
		'cold_shipping_ms'                     => (float) $cold_row['elapsed_ms'],
		'cold_rate_calculation_calls'          => (int) $cold_row['rate_calculation_calls'],
		'warm_shipping_p50_ms'                 => $warm_p50,
		'warm_shipping_p95_ms'                 => $warm_p95,
		'warm_shipping_max_ms'                 => empty( $warm_values ) ? 0 : max( $warm_values ),
		'warm_rate_calculation_calls'          => $sum_rate_calls( $rows, 'warm_' ),
		'total_churn_shipping_p50_ms'          => $total_churn_p50,
		'total_churn_shipping_max_ms'          => empty( $total_churn_values ) ? 0 : max( $total_churn_values ),
		'total_churn_rate_calculation_calls'   => $sum_rate_calls( $rows, 'total_churn_' ),
		'rehash_shipping_p50_ms'               => $rehash_p50,
		'rehash_shipping_max_ms'               => empty( $rehash_values ) ? 0 : max( $rehash_values ),
		'rehash_rate_calculation_calls'        => $sum_rate_calls( $rows, 'rehash_' ),
		'warm_to_cold_ratio'                   => (float) $cold_row['elapsed_ms'] > 0 ? $warm_p50 / (float) $cold_row['elapsed_ms'] : 0,
		'total_churn_to_warm_ratio'            => $warm_p50 > 0 ? $total_churn_p50 / $warm_p50 : 0,
		'rehash_to_warm_ratio'                 => $warm_p50 > 0 ? $rehash_p50 / $warm_p50 : 0,
		'session_cache_key_count'              => count( $final_cache ),
		'per_churn_metrics'                    => $per_churn_metrics,
		'subtotal_churn_rate_calculation_calls' => $per_churn_metrics['subtotal']['rate_calculation_calls'],
		'total_field_churn_rate_calculation_calls' => $per_churn_metrics['total']['rate_calculation_calls'],
		'package_id_churn_rate_calculation_calls' => $per_churn_metrics['package_id']['rate_calculation_calls'],
		'package_name_churn_rate_calculation_calls' => $per_churn_metrics['package_name']['rate_calculation_calls'],
		'rates_churn_rate_calculation_calls'   => $per_churn_metrics['rates']['rate_calculation_calls'],
		'package_index_churn_rate_calculation_calls' => $per_churn_metrics['package_index']['rate_calculation_calls'],
		'destination_postcode_rehash_rate_calculation_calls' => $per_churn_metrics['destination_postcode']['rate_calculation_calls'],
		'contents_cost_rehash_rate_calculation_calls' => $per_churn_metrics['contents_cost']['rate_calculation_calls'],
		'unknown_package_key_rehash_rate_calculation_calls' => $per_churn_metrics['unknown_package_key']['rate_calculation_calls'],
		'synthetic_unknown_package_key'        => $synthetic_unknown_key,
	);

	$artifact_path = '';
	$shared_state  = getenv( 'HOMEBOY_BENCH_SHARED_STATE' );
	if ( $shared_state ) {
		$artifact_dir = rtrim( $shared_state, '/' ) . '/checkout-shipping-cache';
		wp_mkdir_p( $artifact_dir );
		$artifact_path = $artifact_dir . '/' . $run_id . '.json';
		file_put_contents(
			$artifact_path,
			wp_json_encode(
				array(
					'run_id'             => $run_id,
					'issues'             => $issues,
					'product_ids'        => $product_ids,
					'shipping_zone_id'   => $zone->get_id(),
					'shipping_method_id' => $flat_rate_instance_id,
					'rows'               => $rows,
					'final_cache_keys'   => $final_cache,
					'metrics'            => $summary,
				),
				JSON_PRETTY_PRINT
			) . "\n"
		);
	}

	return array(
		'metrics'   => $summary,
		'metadata'  => array(
			'runner'                     => 'wp-codebox',
			'workload'                   => 'checkout-shipping-cache',
			'issues'                     => $issues,
			'zone_id'                    => $zone->get_id(),
			'product_seed'               => 'simple-physical',
		),
		'artifacts' => $artifact_path ? array( 'raw_result' => array( 'path' => $artifact_path, 'kind' => 'json' ) ) : array(),
	);
};
