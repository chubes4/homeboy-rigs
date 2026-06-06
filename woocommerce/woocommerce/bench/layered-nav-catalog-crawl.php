<?php
/**
 * WP Codebox-backed WooCommerce layered-nav catalog crawl workload.
 *
 * Exercises the real layered-nav widget path with many distinct filter request
 * combinations to reproduce the cache-growth traffic shape from bots/crawlers.
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
	if ( ! class_exists( 'WC_Widget_Layered_Nav' ) ) {
		throw new RuntimeException( 'WooCommerce layered nav widget is not available.' );
	}

	global $wpdb, $wp_query, $wp_the_query;

	$request_count = max( 1, min( 5000, (int) ( getenv( 'WC_LAYERED_NAV_CRAWL_REQUESTS' ) ?: 150 ) ) );
	$term_count    = max( 2, min( 20, (int) ( getenv( 'WC_LAYERED_NAV_CRAWL_TERMS' ) ?: 12 ) ) );
	$product_count = max( $term_count, min( 1000, (int) ( getenv( 'WC_LAYERED_NAV_CRAWL_PRODUCTS' ) ?: 120 ) ) );
	$cache_limit   = max( 0, min( 5000, (int) ( getenv( 'WC_LAYERED_NAV_CRAWL_LIMIT' ) ?: 25 ) ) );
	$run_id        = 'woocommerce-layered-nav-catalog-crawl-' . getmypid() . '-' . time() . '-' . wp_generate_password( 6, false );
	$issues        = array( 'https://github.com/woocommerce/woocommerce/issues/17355' );

	wp_set_current_user( 1 );
	update_option( 'woocommerce_attribute_lookup_enabled', 'no' );
	delete_transient( 'wc_layered_nav_counts_pa_homeboy_crawl' );

	add_filter(
		'woocommerce_layered_nav_count_cache_max_entries',
		static function () use ( $cache_limit ): int {
			return $cache_limit;
		}
	);

	$attribute_id = wc_create_attribute(
		array(
			'name'         => 'Homeboy Crawl',
			'slug'         => 'homeboy_crawl',
			'type'         => 'select',
			'order_by'     => 'menu_order',
			'has_archives' => false,
		)
	);
	if ( is_wp_error( $attribute_id ) ) {
		throw new RuntimeException( 'Failed to create Homeboy crawl attribute: ' . $attribute_id->get_error_message() );
	}
	$facet_attribute_id = wc_create_attribute(
		array(
			'name'         => 'Homeboy Facet',
			'slug'         => 'homeboy_facet',
			'type'         => 'select',
			'order_by'     => 'menu_order',
			'has_archives' => false,
		)
	);
	if ( is_wp_error( $facet_attribute_id ) ) {
		throw new RuntimeException( 'Failed to create Homeboy facet attribute: ' . $facet_attribute_id->get_error_message() );
	}

	$taxonomy       = wc_attribute_taxonomy_name( 'homeboy_crawl' );
	$facet_taxonomy = wc_attribute_taxonomy_name( 'homeboy_facet' );
	foreach ( array( $taxonomy, $facet_taxonomy ) as $registered_taxonomy ) {
		if ( taxonomy_exists( $registered_taxonomy ) ) {
			continue;
		}
		register_taxonomy(
			$registered_taxonomy,
			array( 'product' ),
			array(
				'hierarchical' => false,
				'public'       => false,
				'query_var'    => true,
				'rewrite'      => false,
			)
		);
	}

	$term_ids         = array();
	$term_slugs       = array();
	$facet_term_ids   = array();
	$facet_term_slugs = array();
	for ( $i = 0; $i < $term_count; $i++ ) {
		$term = wp_insert_term( 'Homeboy Crawl ' . ( $i + 1 ) . ' ' . $run_id, $taxonomy, array( 'slug' => 'homeboy-crawl-' . $run_id . '-' . ( $i + 1 ) ) );
		if ( is_wp_error( $term ) ) {
			throw new RuntimeException( 'Failed to create Homeboy crawl term: ' . $term->get_error_message() );
		}
		$term_ids[]   = (int) $term['term_id'];
		$term_slugs[] = get_term( $term['term_id'], $taxonomy )->slug;

		$facet_term = wp_insert_term( 'Homeboy Facet ' . ( $i + 1 ) . ' ' . $run_id, $facet_taxonomy, array( 'slug' => 'homeboy-facet-' . $run_id . '-' . ( $i + 1 ) ) );
		if ( is_wp_error( $facet_term ) ) {
			throw new RuntimeException( 'Failed to create Homeboy facet term: ' . $facet_term->get_error_message() );
		}
		$facet_term_ids[]   = (int) $facet_term['term_id'];
		$facet_term_slugs[] = get_term( $facet_term['term_id'], $facet_taxonomy )->slug;
	}

	$product_ids = array();
	for ( $i = 0; $i < $product_count; $i++ ) {
		$product = new WC_Product_Simple();
		$product->set_name( 'Homeboy Crawl Product ' . $run_id . ' #' . ( $i + 1 ) );
		$product->set_slug( 'homeboy-layered-nav-crawl-' . $run_id . '-' . ( $i + 1 ) );
		$product->set_status( 'publish' );
		$product->set_sku( 'homeboy-layered-nav-crawl-' . $run_id . '-' . ( $i + 1 ) );
		$product->set_regular_price( '10' );
		$product->set_price( '10' );
		$product->set_manage_stock( false );
		$product->set_stock_status( 'instock' );
		$product->save();

		$product_ids[] = $product->get_id();
		wp_set_object_terms( $product->get_id(), array( $term_ids[ $i % $term_count ] ), $taxonomy );
		wp_set_object_terms( $product->get_id(), array( $facet_term_ids[ $i % $term_count ] ), $facet_taxonomy );
	}

	$widget      = new WC_Widget_Layered_Nav();
	$reflection  = new ReflectionClass( $widget );
	$list_method = $reflection->getMethod( 'layered_nav_list' );
	$list_method->setAccessible( true );
	$terms         = get_terms( $taxonomy, array( 'hide_empty' => '1' ) );
	$filter_name   = 'filter_' . wc_attribute_taxonomy_slug( $facet_taxonomy );
	$query_type    = 'and';
	$transient_key = 'wc_layered_nav_counts_' . sanitize_title( $taxonomy );
	$option_name   = '_transient_' . $transient_key;
	$query_reflection = new ReflectionClass( 'WC_Query' );
	$product_query_property = $query_reflection->getProperty( 'product_query' );
	$product_query_property->setAccessible( true );

	$build_terms_for_request = static function ( int $request_index ) use ( $facet_term_slugs ): array {
		$selected = array();
		$count    = count( $facet_term_slugs );
		for ( $bit = 0; $bit < $count; $bit++ ) {
			if ( 0 !== ( $request_index & ( 1 << $bit ) ) ) {
				$selected[] = $facet_term_slugs[ $bit ];
			}
		}

		return empty( $selected ) ? array( $facet_term_slugs[0] ) : $selected;
	};

	$rows    = array();
	$started = microtime( true );

	for ( $request_index = 1; $request_index <= $request_count; $request_index++ ) {
		$selected_terms = $build_terms_for_request( $request_index );
		$_GET           = array(
			$filter_name                       => implode( ',', $selected_terms ),
			'query_type_' . wc_attribute_taxonomy_slug( $taxonomy ) => $query_type,
		);

		WC_Query::reset_chosen_attributes();
		$wp_query = new WP_Query(
			array(
				'post_type'      => 'product',
				'post_status'    => 'publish',
				'posts_per_page' => 12,
				'tax_query'      => array(
					array(
						'taxonomy' => $facet_taxonomy,
						'field'    => 'slug',
						'terms'    => $selected_terms,
						'operator' => 'AND',
					),
				),
			)
		);
		$wp_the_query = $wp_query;
		$product_query_property->setValue( null, $wp_query );

		$before = microtime( true );
		ob_start();
		$list_method->invoke( $widget, $terms, $taxonomy, $query_type );
		$rendered = ob_get_clean();
		$cache    = (array) get_transient( $transient_key );
		$stored   = $wpdb->get_var( $wpdb->prepare( "SELECT option_value FROM {$wpdb->options} WHERE option_name = %s", $option_name ) ); // phpcs:ignore WordPress.DB.DirectDatabaseQuery.DirectQuery, WordPress.DB.DirectDatabaseQuery.NoCaching

		$rows[] = array(
			'request_index'          => $request_index,
			'filter_terms'           => $selected_terms,
			'filter_taxonomy'        => $facet_taxonomy,
			'filter_url'             => add_query_arg( $_GET, home_url( '/shop/' ) ),
			'elapsed_ms'             => ( microtime( true ) - $before ) * 1000,
			'rendered_bytes'         => strlen( $rendered ),
			'transient_entry_count'  => count( $cache ),
			'serialized_value_bytes' => is_string( $stored ) ? strlen( $stored ) : 0,
		);
	}

	$_GET = array();
	WC_Query::reset_chosen_attributes();
	remove_all_filters( 'woocommerce_layered_nav_count_cache_max_entries' );

	$final_cache          = (array) get_transient( $transient_key );
	$final_serialized     = $wpdb->get_var( $wpdb->prepare( "SELECT option_value FROM {$wpdb->options} WHERE option_name = %s", $option_name ) ); // phpcs:ignore WordPress.DB.DirectDatabaseQuery.DirectQuery, WordPress.DB.DirectDatabaseQuery.NoCaching
	$entry_counts         = wp_list_pluck( $rows, 'transient_entry_count' );
	$serialized_bytes     = wp_list_pluck( $rows, 'serialized_value_bytes' );
	$final_entry_count    = count( $final_cache );
	$final_value_bytes    = is_string( $final_serialized ) ? strlen( $final_serialized ) : 0;
	$expected_capped_max  = $cache_limit > 0 ? $cache_limit : $request_count;
	$cache_exceeded_limit = $cache_limit > 0 && $final_entry_count > $cache_limit;
	$summary              = array(
		'success_rate'                 => 1,
		'crawl_request_count'          => $request_count,
		'cache_limit_setting'          => $cache_limit,
		'term_count'                   => $term_count,
		'product_count'                => $product_count,
		'final_transient_entry_count'  => $final_entry_count,
		'max_transient_entry_count'    => empty( $entry_counts ) ? 0 : max( $entry_counts ),
		'expected_capped_entry_count'  => min( $request_count, $expected_capped_max ),
		'cache_exceeded_limit'         => $cache_exceeded_limit ? 1 : 0,
		'final_serialized_value_bytes' => $final_value_bytes,
		'max_serialized_value_bytes'   => empty( $serialized_bytes ) ? 0 : max( $serialized_bytes ),
		'total_elapsed_ms'             => ( microtime( true ) - $started ) * 1000,
	);

	$artifact_path = '';
	$shared_state  = getenv( 'HOMEBOY_BENCH_SHARED_STATE' );
	if ( $shared_state ) {
		$artifact_dir = rtrim( $shared_state, '/' ) . '/layered-nav-catalog-crawl';
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
					'facet_term_ids' => $facet_term_ids,
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
			'workload'      => 'layered-nav-catalog-crawl',
			'issues'        => $issues,
			'transient_key' => $transient_key,
			'cache_shape'   => 'many real filter request combinations rendered through layered nav widget',
		),
		'artifacts' => $artifact_path ? array( 'raw_result' => array( 'path' => $artifact_path, 'kind' => 'json' ) ) : array(),
	);
};
