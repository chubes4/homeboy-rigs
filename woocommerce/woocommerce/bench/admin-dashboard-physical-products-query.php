<?php
/**
 * WP Codebox-backed WooCommerce admin dashboard physical-products query workload.
 *
 * Reproduces the wp-admin/index.php onboarding setup widget path reported in:
 * https://wordpress.org/support/topic/wp_query-get_posts-slow-query-on-dashboard/
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
	if ( ! class_exists( Automattic\WooCommerce\Admin\Features\OnboardingTasks\Tasks\Shipping::class ) ) {
		throw new RuntimeException( 'WooCommerce onboarding shipping task is not available.' );
	}

	global $wpdb;

	$product_count  = max( 1, min( 20000, (int) ( getenv( 'WC_ADMIN_DASHBOARD_PRODUCTS' ) ?: 500 ) ) );
	$term_count     = max( 1, min( 1000, (int) ( getenv( 'WC_ADMIN_DASHBOARD_TERMS' ) ?: 20 ) ) );
	$physical_ratio = max( 0, min( 100, (int) ( getenv( 'WC_ADMIN_DASHBOARD_PHYSICAL_PERCENT' ) ?: 100 ) ) );
	$run_id         = 'woocommerce-admin-dashboard-physical-products-' . getmypid() . '-' . time() . '-' . wp_generate_password( 6, false );
	$sources        = array(
		'https://automattic.zendesk.com/agent/tickets/5428113',
		'https://wordpress.org/support/topic/wp_query-get_posts-slow-query-on-dashboard/',
		'https://github.com/chubes4/homeboy-rigs/issues/224',
	);

	wp_set_current_user( 1 );
	update_option( 'woocommerce_store_address', '123 Performance Way' );
	update_option( 'woocommerce_store_city', 'San Francisco' );
	update_option( 'woocommerce_default_country', 'US:CA' );
	update_option( 'woocommerce_currency', 'USD' );
	update_option( 'woocommerce_task_list_hidden', 'no' );
	update_option( 'woocommerce_task_list_complete', 'no' );
	update_option( 'woocommerce_task_list_hidden_lists', array() );
	update_option( 'woocommerce_task_list_completed_lists', array() );
	update_option( 'woocommerce_admin_created_default_shipping_zones', 'no' );

	if ( class_exists( Automattic\WooCommerce\Internal\Admin\Onboarding\OnboardingProfile::class ) ) {
		update_option(
			Automattic\WooCommerce\Internal\Admin\Onboarding\OnboardingProfile::DATA_OPTION,
			array(
				'product_types' => array( 'physical' ),
				'product_count' => $product_count,
			)
		);
	}

	$feature_filter = static function ( array $features ): array {
		$features = array_values( array_unique( array_merge( $features, array( 'onboarding' ) ) ) );
		return array_values( array_diff( $features, array( 'shipping-smart-defaults' ) ) );
	};
	add_filter( 'woocommerce_admin_features', $feature_filter, 100 );

	$term_ids = array();
	for ( $i = 0; $i < $term_count; $i++ ) {
		$term = wp_insert_term( 'Homeboy Dashboard Term ' . ( $i + 1 ) . ' ' . $run_id, 'product_cat', array( 'slug' => 'homeboy-dashboard-' . $run_id . '-' . ( $i + 1 ) ) );
		if ( is_wp_error( $term ) ) {
			throw new RuntimeException( 'Failed to create Homeboy dashboard product category: ' . $term->get_error_message() );
		}
		$term_ids[] = (int) $term['term_id'];
	}

	$product_ids     = array();
	$physical_count  = 0;
	$virtual_count   = 0;
	$term_product_map = array_fill_keys( $term_ids, 0 );
	for ( $i = 0; $i < $product_count; $i++ ) {
		$is_physical = ( ( $i * 100 ) / $product_count ) < $physical_ratio;
		$product     = new WC_Product_Simple();
		$product->set_name( 'Homeboy Dashboard Product ' . $run_id . ' #' . ( $i + 1 ) );
		$product->set_slug( 'homeboy-dashboard-product-' . $run_id . '-' . ( $i + 1 ) );
		$product->set_status( 'publish' );
		$product->set_sku( 'homeboy-dashboard-' . $run_id . '-' . ( $i + 1 ) );
		$product->set_regular_price( '10' );
		$product->set_price( '10' );
		$product->set_virtual( ! $is_physical );
		$product->set_manage_stock( false );
		$product->set_stock_status( 'instock' );
		$product->save();

		$term_id = $term_ids[ $i % count( $term_ids ) ];
		wp_set_object_terms( $product->get_id(), array( $term_id ), 'product_cat' );
		update_post_meta( $product->get_id(), '_virtual', $is_physical ? 'no' : 'yes' );

		$product_ids[] = $product->get_id();
		if ( $is_physical ) {
			++$physical_count;
		} else {
			++$virtual_count;
		}
		++$term_product_map[ $term_id ];
	}

	$captured_queries = array();
	$query_filter     = static function ( string $query ) use ( &$captured_queries ): string {
		$captured_queries[] = $query;
		return $query;
	};

	$wpdb->save_queries = true;

	$summarize_queries = static function ( array $queries, int $query_count, float $elapsed_ms ): array {
		$matching = array();
		$slowest  = array(
			'sql'        => '',
			'elapsed_ms' => 0,
			'caller'     => '',
		);

		foreach ( $queries as $entry ) {
			$sql       = is_array( $entry ) ? (string) ( $entry[0] ?? '' ) : (string) $entry;
			$query_ms  = is_array( $entry ) ? (float) ( ( $entry[1] ?? 0 ) * 1000 ) : null;
			$caller    = is_array( $entry ) ? (string) ( $entry[2] ?? '' ) : '';
			$lower_sql = strtolower( $sql );

			if ( null !== $query_ms && $query_ms > $slowest['elapsed_ms'] ) {
				$slowest = array(
					'sql'        => substr( preg_replace( '/\s+/', ' ', $sql ), 0, 1000 ),
					'elapsed_ms' => $query_ms,
					'caller'     => $caller,
				);
			}

			if ( false !== strpos( $lower_sql, '_virtual' ) && false !== strpos( $lower_sql, 'product' ) ) {
				$matching[] = array(
					'sql'        => substr( preg_replace( '/\s+/', ' ', $sql ), 0, 2000 ),
					'elapsed_ms' => $query_ms,
					'caller'     => $caller,
				);
			}
		}

		$matching_elapsed = array_values(
			array_filter(
				array_map(
					static function ( array $query ) {
						return $query['elapsed_ms'];
					},
					$matching
				),
				static function ( $value ): bool {
					return null !== $value;
				}
			)
		);

		return array(
			'elapsed_ms'                => $elapsed_ms,
			'query_count'               => $query_count,
			'matching_query_count'      => count( $matching ),
			'matching_query_elapsed_ms' => empty( $matching_elapsed ) ? 0 : max( $matching_elapsed ),
			'slowest_query'             => $slowest,
			'matching_queries'          => $matching,
		);
	};

	$measure = static function ( string $label, callable $callback ) use ( $wpdb, &$captured_queries, $query_filter, $summarize_queries ): array {
		$captured_queries = array();
		$wpdb->queries    = array();
		$queries_before   = (int) $wpdb->num_queries;
		add_filter( 'query', $query_filter );
		$started = microtime( true );
		$result  = $callback();
		$elapsed = ( microtime( true ) - $started ) * 1000;
		remove_filter( 'query', $query_filter );

		$queries = is_array( $wpdb->queries ) && ! empty( $wpdb->queries ) ? $wpdb->queries : $captured_queries;
		return array(
			'label'  => $label,
			'result' => $result,
			'query'  => $summarize_queries( $queries, (int) $wpdb->num_queries - $queries_before, $elapsed ),
		);
	};

	$rows   = array();
	$rows[] = $measure(
		'direct_has_physical_products',
		static function (): array {
			$has_physical_products = Automattic\WooCommerce\Admin\Features\OnboardingTasks\Tasks\Shipping::has_physical_products();
			$shipping_task         = new Automattic\WooCommerce\Admin\Features\OnboardingTasks\Tasks\Shipping();

			return array(
				'has_physical_products' => (bool) $has_physical_products,
				'shipping_can_view'      => (bool) $shipping_task->can_view(),
			);
		}
	);

	$dashboard_setup_widget_available = false;
	$rows[]                          = $measure(
		'dashboard_setup_widget',
		static function () use ( &$dashboard_setup_widget_available ): array {
			$dashboard_file = WC()->plugin_path() . '/includes/admin/class-wc-admin-dashboard-setup.php';
			if ( ! class_exists( 'WC_Admin_Dashboard_Setup', false ) && file_exists( $dashboard_file ) ) {
				include_once $dashboard_file;
			}

			if ( ! class_exists( 'WC_Admin_Dashboard_Setup', false ) ) {
				return array(
					'available' => false,
					'reason'    => 'WC_Admin_Dashboard_Setup class is unavailable.',
				);
			}

			$dashboard_setup_widget_available = true;
			$widget                           = new WC_Admin_Dashboard_Setup();
			$task_list                        = $widget->get_task_list();
			$tasks                            = $task_list ? $widget->get_tasks() : array();
			return array(
				'available'             => true,
				'should_display_widget' => (bool) $widget->should_display_widget(),
				'task_count'            => count( $tasks ),
			);
		}
	);

	remove_filter( 'woocommerce_admin_features', $feature_filter, 100 );

	$direct_row    = $rows[0];
	$dashboard_row = $rows[1];
	$all_matching  = array_merge( $direct_row['query']['matching_queries'], $dashboard_row['query']['matching_queries'] );
	$summary       = array(
		'success_rate'                        => 1,
		'product_count'                       => $product_count,
		'term_count'                          => $term_count,
		'physical_product_count'              => $physical_count,
		'virtual_product_count'               => $virtual_count,
		'onboarding_product_types_physical'    => 1,
		'woocommerce_version'                  => defined( 'WC_VERSION' ) ? WC_VERSION : '',
		'direct_has_physical_products_ms'      => (float) $direct_row['query']['elapsed_ms'],
		'dashboard_setup_widget_ms'            => (float) $dashboard_row['query']['elapsed_ms'],
		'dashboard_setup_widget_available'     => $dashboard_setup_widget_available ? 1 : 0,
		'dashboard_request_available'          => 0,
		'dashboard_request_elapsed_ms'         => 0,
		'matching_query_elapsed_ms'            => max( (float) $direct_row['query']['matching_query_elapsed_ms'], (float) $dashboard_row['query']['matching_query_elapsed_ms'] ),
		'matching_query_count'                 => count( $all_matching ),
		'total_query_count'                    => (int) $direct_row['query']['query_count'] + (int) $dashboard_row['query']['query_count'],
		'direct_has_physical_products_result'  => ! empty( $direct_row['result']['has_physical_products'] ) ? 1 : 0,
		'dashboard_should_display_widget'      => ! empty( $dashboard_row['result']['should_display_widget'] ) ? 1 : 0,
	);

	$artifact_path = '';
	$shared_state  = getenv( 'HOMEBOY_BENCH_SHARED_STATE' );
	if ( $shared_state ) {
		$artifact_dir = rtrim( $shared_state, '/' ) . '/admin-dashboard-physical-products-query';
		wp_mkdir_p( $artifact_dir );
		$artifact_path = $artifact_dir . '/' . $run_id . '.json';
		file_put_contents(
			$artifact_path,
			wp_json_encode(
				array(
					'run_id'           => $run_id,
					'sources'          => $sources,
					'product_ids'      => $product_ids,
					'term_ids'         => $term_ids,
					'term_product_map' => $term_product_map,
					'rows'             => $rows,
					'metrics'          => $summary,
				),
				JSON_PRETTY_PRINT
			) . "\n"
		);
	}

	return array(
		'metrics'   => $summary,
		'metadata'  => array(
			'runner'                  => 'wp-codebox',
			'workload'                => 'admin-dashboard-physical-products-query',
			'sources'                 => $sources,
			'fixture'                 => 'simple-products-product-cat-physical-virtual-split',
			'reported_call_stack'     => 'WC_Admin_Dashboard_Setup->should_display_widget() > TaskList->is_complete() > Shipping->can_view() > Shipping::has_physical_products()',
			'dashboard_request_shape' => 'setup-widget PHP path; full wp-admin/index.php request unavailable in wordpress.bench PHP workload',
		),
		'artifacts' => $artifact_path ? array( 'raw_result' => array( 'path' => $artifact_path, 'kind' => 'json' ) ) : array(),
	);
};
