<?php
/**
 * WP Codebox-backed WooCommerce layered-nav count cache workload.
 *
 * Reproduces the unbounded `wc_layered_nav_counts_*` transient growth shape from
 * https://github.com/woocommerce/woocommerce/issues/17355.
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
	if ( ! class_exists( Automattic\WooCommerce\Internal\ProductAttributesLookup\Filterer::class ) ) {
		throw new RuntimeException( 'WooCommerce product attribute filterer is not available.' );
	}

	global $wpdb;

	$iterations  = max( 1, min( 5000, (int) ( getenv( 'WC_LAYERED_NAV_CACHE_ITERATIONS' ) ?: 150 ) ) );
	$term_count  = max( 2, min( 100, (int) ( getenv( 'WC_LAYERED_NAV_CACHE_TERMS' ) ?: 6 ) ) );
	$product_count = max( $term_count, min( 1000, (int) ( getenv( 'WC_LAYERED_NAV_CACHE_PRODUCTS' ) ?: 60 ) ) );
	$cache_limit = max( 0, min( 5000, (int) ( getenv( 'WC_LAYERED_NAV_CACHE_LIMIT' ) ?: 25 ) ) );
	$run_id      = 'woocommerce-layered-nav-count-cache-' . getmypid() . '-' . time() . '-' . wp_generate_password( 6, false );
	$issues      = array( 'https://github.com/woocommerce/woocommerce/issues/17355' );

	wp_set_current_user( 1 );
	update_option( 'woocommerce_attribute_lookup_enabled', 'no' );
	delete_transient( 'wc_layered_nav_counts_pa_homeboy_nav' );

	add_filter(
		'woocommerce_layered_nav_count_cache_max_entries',
		static function () use ( $cache_limit ): int {
			return $cache_limit;
		}
	);

	$attribute_id = wc_create_attribute(
		array(
			'name'         => 'Homeboy Layered Nav',
			'slug'         => 'homeboy_nav',
			'type'         => 'select',
			'order_by'     => 'menu_order',
			'has_archives' => false,
		)
	);
	if ( is_wp_error( $attribute_id ) ) {
		throw new RuntimeException( 'Failed to create Homeboy layered-nav attribute: ' . $attribute_id->get_error_message() );
	}

	$taxonomy = wc_attribute_taxonomy_name( 'homeboy_nav' );
	if ( ! taxonomy_exists( $taxonomy ) ) {
		register_taxonomy(
			$taxonomy,
			array( 'product' ),
			array(
				'hierarchical' => false,
				'public'       => false,
				'query_var'    => true,
				'rewrite'      => false,
			)
		);
	}

	$term_ids = array();
	for ( $i = 0; $i < $term_count; $i++ ) {
		$term = wp_insert_term( 'Homeboy Nav ' . ( $i + 1 ) . ' ' . $run_id, $taxonomy, array( 'slug' => 'homeboy-nav-' . $run_id . '-' . ( $i + 1 ) ) );
		if ( is_wp_error( $term ) ) {
			throw new RuntimeException( 'Failed to create Homeboy layered-nav term: ' . $term->get_error_message() );
		}
		$term_ids[] = (int) $term['term_id'];
	}

	$product_ids = array();
	for ( $i = 0; $i < $product_count; $i++ ) {
		$product = new WC_Product_Simple();
		$product->set_name( 'Homeboy Layered Nav Product ' . $run_id . ' #' . ( $i + 1 ) );
		$product->set_slug( 'homeboy-layered-nav-' . $run_id . '-' . ( $i + 1 ) );
		$product->set_status( 'publish' );
		$product->set_sku( 'homeboy-layered-nav-' . $run_id . '-' . ( $i + 1 ) );
		$product->set_regular_price( '10' );
		$product->set_price( '10' );
		$product->set_manage_stock( false );
		$product->set_stock_status( 'instock' );
		$product->save();

		$product_ids[] = $product->get_id();
		wp_set_object_terms( $product->get_id(), array( $term_ids[ $i % $term_count ] ), $taxonomy );
	}

	$transient_key = 'wc_layered_nav_counts_' . sanitize_title( $taxonomy );
	$option_name   = '_transient_' . $transient_key;
	$iteration     = 0;
	$query_filter  = static function ( array $query ) use ( &$iteration, $wpdb ): array {
		$query['where'] .= $wpdb->prepare( ' AND %d = %d', $iteration, $iteration );
		return $query;
	};
	add_filter( 'woocommerce_get_filtered_term_product_counts_query', $query_filter );

	$filterer = wc_get_container()->get( Automattic\WooCommerce\Internal\ProductAttributesLookup\Filterer::class );
	$rows     = array();
	$started  = microtime( true );

	for ( $iteration = 1; $iteration <= $iterations; $iteration++ ) {
		$before = microtime( true );
		$counts = $filterer->get_filtered_term_product_counts( $term_ids, $taxonomy, 'and' );
		$cache  = (array) get_transient( $transient_key );
		$stored = $wpdb->get_var( $wpdb->prepare( "SELECT option_value FROM {$wpdb->options} WHERE option_name = %s", $option_name ) ); // phpcs:ignore WordPress.DB.DirectDatabaseQuery.DirectQuery, WordPress.DB.DirectDatabaseQuery.NoCaching

		$rows[] = array(
			'iteration'             => $iteration,
			'elapsed_ms'            => ( microtime( true ) - $before ) * 1000,
			'returned_term_count'    => count( $counts ),
			'transient_entry_count'  => count( $cache ),
			'serialized_value_bytes' => is_string( $stored ) ? strlen( $stored ) : 0,
		);
	}

	remove_filter( 'woocommerce_get_filtered_term_product_counts_query', $query_filter );
	remove_all_filters( 'woocommerce_layered_nav_count_cache_max_entries' );

	$final_cache          = (array) get_transient( $transient_key );
	$final_serialized     = $wpdb->get_var( $wpdb->prepare( "SELECT option_value FROM {$wpdb->options} WHERE option_name = %s", $option_name ) ); // phpcs:ignore WordPress.DB.DirectDatabaseQuery.DirectQuery, WordPress.DB.DirectDatabaseQuery.NoCaching
	$entry_counts         = wp_list_pluck( $rows, 'transient_entry_count' );
	$serialized_bytes     = wp_list_pluck( $rows, 'serialized_value_bytes' );
	$final_entry_count    = count( $final_cache );
	$final_value_bytes    = is_string( $final_serialized ) ? strlen( $final_serialized ) : 0;
	$expected_capped_max  = $cache_limit > 0 ? $cache_limit : $iterations;
	$cache_exceeded_limit = $cache_limit > 0 && $final_entry_count > $cache_limit;
	$summary             = array(
		'success_rate'                 => 1,
		'iterations'                   => $iterations,
		'cache_limit_setting'          => $cache_limit,
		'term_count'                   => $term_count,
		'product_count'                => $product_count,
		'final_transient_entry_count'  => $final_entry_count,
		'max_transient_entry_count'    => empty( $entry_counts ) ? 0 : max( $entry_counts ),
		'expected_capped_entry_count'  => min( $iterations, $expected_capped_max ),
		'cache_exceeded_limit'         => $cache_exceeded_limit ? 1 : 0,
		'final_serialized_value_bytes' => $final_value_bytes,
		'max_serialized_value_bytes'   => empty( $serialized_bytes ) ? 0 : max( $serialized_bytes ),
		'total_elapsed_ms'             => ( microtime( true ) - $started ) * 1000,
	);

	$artifact_path = '';
	$shared_state  = getenv( 'HOMEBOY_BENCH_SHARED_STATE' );
	if ( $shared_state ) {
		$artifact_dir = rtrim( $shared_state, '/' ) . '/layered-nav-count-cache';
		wp_mkdir_p( $artifact_dir );
		$artifact_path = $artifact_dir . '/' . $run_id . '.json';
		file_put_contents(
			$artifact_path,
			wp_json_encode(
				array(
					'run_id'        => $run_id,
					'issues'        => $issues,
					'transient_key' => $transient_key,
					'option_name'   => $option_name,
					'product_ids'   => $product_ids,
					'term_ids'      => $term_ids,
					'rows'          => $rows,
					'metrics'       => $summary,
				),
				JSON_PRETTY_PRINT
			) . "\n"
		);
	}

	return array(
		'metrics'   => $summary,
		'metadata'  => array(
			'runner'        => 'wp-codebox',
			'workload'      => 'layered-nav-count-cache',
			'issues'        => $issues,
			'transient_key' => $transient_key,
			'cache_shape'   => 'many query hashes inside one taxonomy transient',
		),
		'artifacts' => $artifact_path ? array( 'raw_result' => array( 'path' => $artifact_path, 'kind' => 'json' ) ) : array(),
	);
};
