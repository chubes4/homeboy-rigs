<?php
/**
 * WP Codebox-backed WooCommerce REST product batch write workload.
 *
 * Reproduces the slow product/variation import shape from
 * https://github.com/woocommerce/woocommerce/issues/26029.
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
	if ( ! did_action( 'woocommerce_init' ) ) {
		WC()->init();
	}

	global $wpdb;

	$batch_size       = max( 1, min( 100, (int) ( getenv( 'WC_REST_BATCH_IMPORT_ITEMS' ) ?: 25 ) ) );
	$attribute_count  = max( 1, min( 10, (int) ( getenv( 'WC_REST_BATCH_IMPORT_ATTRIBUTES' ) ?: 3 ) ) );
	$terms_per_attr   = max( 2, min( 25, (int) ( getenv( 'WC_REST_BATCH_IMPORT_TERMS_PER_ATTRIBUTE' ) ?: 8 ) ) );
	$catalog_products = max( 0, min( 5000, (int) ( getenv( 'WC_REST_BATCH_IMPORT_CATALOG_PRODUCTS' ) ?: 0 ) ) );
	$run_id           = 'woocommerce-rest-batch-import-' . getmypid() . '-' . time() . '-' . wp_generate_password( 6, false );
	$issues           = array( 'https://github.com/woocommerce/woocommerce/issues/26029' );

	update_option( 'woocommerce_currency', 'USD' );
	update_option( 'woocommerce_weight_unit', 'lbs' );
	update_option( 'woocommerce_dimension_unit', 'in' );
	if ( function_exists( 'wc_install' ) ) {
		wc_install();
	}
	if ( class_exists( 'WC_Post_types' ) ) {
		WC_Post_types::register_post_types();
		WC_Post_types::register_taxonomies();
	}
	if ( class_exists( 'WC_Install' ) ) {
		WC_Install::create_terms();
	}

	$user_id = username_exists( 'homeboy_bench_admin' );
	if ( ! $user_id ) {
		$user_id = wp_insert_user(
			array(
				'user_login' => 'homeboy_bench_admin',
				'user_pass'  => wp_generate_password( 24, true ),
				'user_email' => 'homeboy-bench-admin@example.invalid',
				'role'       => 'administrator',
			)
		);
	}
	if ( is_wp_error( $user_id ) ) {
		throw new RuntimeException( 'Failed to create benchmark admin user: ' . $user_id->get_error_message() );
	}
	wp_set_current_user( (int) $user_id );
	$allow_product_rest_writes = static function ( $permission, string $context, int $object_id, string $post_type ) {
		if ( in_array( $post_type, array( 'product', 'product_variation' ), true ) && in_array( $context, array( 'create', 'edit', 'batch' ), true ) ) {
			return true;
		}
		return $permission;
	};
	add_filter( 'woocommerce_rest_check_permissions', $allow_product_rest_writes, 10, 4 );

	if ( class_exists( Automattic\WooCommerce\RestApi\Server::class ) ) {
		rest_get_server();
		Automattic\WooCommerce\RestApi\Server::instance()->register_rest_routes();
	}

	$attribute_taxonomies = array();
	for ( $attribute_index = 1; $attribute_index <= $attribute_count; $attribute_index++ ) {
		global $wc_product_attributes;

		$attribute_slug = 'hb_' . substr( md5( $run_id . '-' . $attribute_index ), 0, 12 );
		$attribute_name = 'Homeboy Import Attribute ' . $attribute_index;
		$attribute_id   = wc_create_attribute(
			array(
				'name'         => $attribute_name,
				'slug'         => $attribute_slug,
				'type'         => 'select',
				'order_by'     => 'menu_order',
				'has_archives' => false,
			)
		);
		if ( is_wp_error( $attribute_id ) ) {
			throw new RuntimeException( 'Failed to create import attribute: ' . $attribute_id->get_error_message() );
		}

		$taxonomy = wc_attribute_taxonomy_name( $attribute_slug );
		$wc_product_attributes[ $taxonomy ] = (object) array(
			'attribute_id'      => (string) $attribute_id,
			'attribute_name'    => $attribute_slug,
			'attribute_label'   => $attribute_name,
			'attribute_type'    => 'select',
			'attribute_orderby' => 'menu_order',
			'attribute_public'  => 0,
		);
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

		$terms = array();
		for ( $term_index = 1; $term_index <= $terms_per_attr; $term_index++ ) {
			$term = wp_insert_term(
				'Homeboy Import ' . $attribute_index . '-' . $term_index . ' ' . $run_id,
				$taxonomy,
				array( 'slug' => 'homeboy-import-' . $attribute_index . '-' . $term_index . '-' . $run_id )
			);
			if ( is_wp_error( $term ) ) {
				throw new RuntimeException( 'Failed to create import attribute term: ' . $term->get_error_message() );
			}
			$term_object = get_term( (int) $term['term_id'], $taxonomy );
			$terms[]     = array(
				'id'   => (int) $term['term_id'],
				'name' => $term_object ? $term_object->name : '',
				'slug' => $term_object ? $term_object->slug : '',
			);
		}

		$attribute_taxonomies[] = array(
			'id'       => (int) $attribute_id,
			'taxonomy' => $taxonomy,
			'terms'    => $terms,
		);
	}
	if ( class_exists( 'WC_Post_types' ) ) {
		WC_Post_types::register_taxonomies();
	}

	$catalog_seed_started = microtime( true );
	for ( $i = 0; $i < $catalog_products; $i++ ) {
		$product = new WC_Product_Simple();
		$product->set_name( 'Homeboy Existing Catalog Product ' . $run_id . ' #' . ( $i + 1 ) );
		$product->set_slug( 'homeboy-existing-catalog-' . $run_id . '-' . ( $i + 1 ) );
		$product->set_status( 'publish' );
		$product->set_sku( 'homeboy-existing-catalog-' . $run_id . '-' . ( $i + 1 ) );
		$product->set_regular_price( '10' );
		$product->set_price( '10' );
		$product->set_manage_stock( true );
		$product->set_stock_quantity( 10 );
		$product->set_stock_status( 'instock' );
		$product->save();
	}
	$catalog_seed_ms = ( microtime( true ) - $catalog_seed_started ) * 1000;

	$parent = new WC_Product_Variable();
	$parent->set_name( 'Homeboy Variable Import Parent ' . $run_id );
	$parent->set_slug( 'homeboy-variable-import-parent-' . $run_id );
	$parent->set_status( 'publish' );
	$parent->set_sku( 'homeboy-variable-parent-' . $run_id );

	$product_attributes = array();
	foreach ( $attribute_taxonomies as $attribute_taxonomy ) {
		$product_attribute = new WC_Product_Attribute();
		$product_attribute->set_id( $attribute_taxonomy['id'] );
		$product_attribute->set_name( $attribute_taxonomy['taxonomy'] );
		$product_attribute->set_options( wp_list_pluck( $attribute_taxonomy['terms'], 'id' ) );
		$product_attribute->set_visible( true );
		$product_attribute->set_variation( true );
		$product_attributes[] = $product_attribute;
	}
	$parent->set_attributes( $product_attributes );
	$parent->save();
	$parent_id = $parent->get_id();

	$counters = array(
		'product_transient_clears' => 0,
		'rest_product_inserts'     => 0,
		'new_products'             => 0,
		'updated_products'         => 0,
		'new_variations'           => 0,
		'updated_variations'       => 0,
		'variable_product_syncs'   => 0,
		'lookup_table_queries'     => 0,
		'added_post_meta'          => 0,
		'updated_post_meta'        => 0,
		'deleted_post_meta'        => 0,
		'save_post_product'        => 0,
		'save_post_product_variation' => 0,
		'clean_post_cache'         => 0,
	);
	$meta_hook_counts = array(
		'added'   => array(),
		'updated' => array(),
		'deleted' => array(),
	);
	$active_query_profile = null;
	$profile_query        = static function ( string $query ) use ( &$active_query_profile, $wpdb ): void {
		if ( null === $active_query_profile ) {
			return;
		}

		$operation = 'other';
		if ( preg_match( '/^\s*(SELECT|INSERT|UPDATE|DELETE|REPLACE)\b/i', $query, $operation_match ) ) {
			$operation = strtolower( $operation_match[1] );
		}

		$tables = array();
		if ( preg_match_all( '/(?:FROM|JOIN|INTO|UPDATE)\s+`?(' . preg_quote( $wpdb->prefix, '/' ) . '[a-zA-Z0-9_]+)`?/i', $query, $table_matches ) ) {
			$tables = array_unique( $table_matches[1] );
		}
		if ( empty( $tables ) ) {
			$tables = array( 'unknown' );
		}

		$active_query_profile['operations'][ $operation ] = ( $active_query_profile['operations'][ $operation ] ?? 0 ) + 1;
		foreach ( $tables as $table ) {
			$table_key = str_replace( $wpdb->prefix, '', $table );
			$active_query_profile['tables'][ $table_key ] = ( $active_query_profile['tables'][ $table_key ] ?? 0 ) + 1;
			$operation_table = $operation . ':' . $table_key;
			$active_query_profile['operation_tables'][ $operation_table ] = ( $active_query_profile['operation_tables'][ $operation_table ] ?? 0 ) + 1;
		}
		if ( preg_match_all( "/option_name\s*=\s*'([^']+)'/i", $query, $option_matches ) ) {
			foreach ( $option_matches[1] as $option_name ) {
				$active_query_profile['option_names'][ $option_name ] = ( $active_query_profile['option_names'][ $option_name ] ?? 0 ) + 1;
			}
		}
		if ( preg_match_all( "/meta_key\s*=\s*'([^']+)'/i", $query, $meta_matches ) ) {
			foreach ( $meta_matches[1] as $meta_key ) {
				$active_query_profile['meta_keys'][ $meta_key ] = ( $active_query_profile['meta_keys'][ $meta_key ] ?? 0 ) + 1;
			}
		}

		$meta_operation = '';
		$meta_key       = '';
		if ( preg_match( "/SELECT\s+meta_id\s+FROM\s+`?" . preg_quote( $wpdb->postmeta, '/' ) . "`?.*meta_key\s*=\s*'([^']+)'/i", $query, $meta_operation_match ) ) {
			$meta_operation = 'exists';
			$meta_key       = $meta_operation_match[1];
		} elseif ( preg_match( "/INSERT\s+INTO\s+`?" . preg_quote( $wpdb->postmeta, '/' ) . "`?.*VALUES\s*\([^,]+,\s*'([^']+)'/i", $query, $meta_operation_match ) ) {
			$meta_operation = 'insert';
			$meta_key       = $meta_operation_match[1];
		} elseif ( preg_match( "/UPDATE\s+`?" . preg_quote( $wpdb->postmeta, '/' ) . "`?.*meta_key\s*=\s*'([^']+)'/i", $query, $meta_operation_match ) ) {
			$meta_operation = 'update';
			$meta_key       = $meta_operation_match[1];
		}
		if ( $meta_operation && $meta_key ) {
			$meta_operation_key = $meta_operation . ':' . $meta_key;
			$active_query_profile['meta_key_operations'][ $meta_operation_key ] = ( $active_query_profile['meta_key_operations'][ $meta_operation_key ] ?? 0 ) + 1;
		}

		$category = 'other';
		if ( false !== strpos( $query, $wpdb->prefix . 'actionscheduler_' ) ) {
			$category = 'action_scheduler';
		} elseif ( false !== strpos( $query, 'lookup.sku' ) || false !== strpos( $query, '_sku' ) ) {
			$category = 'sku_lookup';
		} elseif ( false !== strpos( $query, $wpdb->prefix . 'wc_product_meta_lookup' ) ) {
			$category = 'lookup_table';
		} elseif ( preg_match( "/option_name\s*=\s*'_transient_/i", $query ) || preg_match( '/_transient_[a-zA-Z0-9_\-]+/', $query ) ) {
			$category = 'transient_option';
		} elseif ( 'postmeta' === str_replace( $wpdb->prefix, '', $tables[0] ?? '' ) && preg_match( '/SELECT\s+meta_id\s+FROM/i', $query ) ) {
			$category = 'meta_exists';
		} elseif ( 'postmeta' === str_replace( $wpdb->prefix, '', $tables[0] ?? '' ) && 'insert' === $operation ) {
			$category = 'meta_insert';
		} elseif ( 'postmeta' === str_replace( $wpdb->prefix, '', $tables[0] ?? '' ) && 'update' === $operation ) {
			$category = 'meta_update';
		} elseif ( 'postmeta' === str_replace( $wpdb->prefix, '', $tables[0] ?? '' ) ) {
			$category = 'meta_read';
		} elseif ( false !== strpos( $query, 'post_name' ) ) {
			$category = 'slug_lookup';
		} elseif ( false !== strpos( $query, $wpdb->prefix . 'terms' ) || false !== strpos( $query, $wpdb->prefix . 'term_taxonomy' ) || false !== strpos( $query, $wpdb->prefix . 'term_relationships' ) ) {
			$category = 'term_lookup';
		} elseif ( 'posts' === str_replace( $wpdb->prefix, '', $tables[0] ?? '' ) ) {
			$category = 'post_write_read';
		}
		$active_query_profile['categories'][ $category ] = ( $active_query_profile['categories'][ $category ] ?? 0 ) + 1;

		if ( 'action_scheduler' === $category ) {
			$table_key = str_replace( $wpdb->prefix, '', $tables[0] ?? '' );
			$active_query_profile['details'][ 'action_scheduler_' . $operation . '_' . $table_key ] = ( $active_query_profile['details'][ 'action_scheduler_' . $operation . '_' . $table_key ] ?? 0 ) + 1;
			if ( preg_match( '/SELECT\s+a\.action_id\s+FROM\s+`?' . preg_quote( $wpdb->prefix, '/' ) . 'actionscheduler_actions`?\s+a\s+WHERE.*\ba\.hook\s*=\s*/i', $query ) ) {
				$active_query_profile['details']['action_scheduler_duplicate_check'] = ( $active_query_profile['details']['action_scheduler_duplicate_check'] ?? 0 ) + 1;
			}
		} elseif ( 'term_lookup' === $category ) {
			if ( false !== strpos( $query, $wpdb->term_relationships ) ) {
				$active_query_profile['details']['term_relationship_join'] = ( $active_query_profile['details']['term_relationship_join'] ?? 0 ) + 1;
			} elseif ( false !== strpos( $query, 't.slug IN' ) ) {
				$active_query_profile['details']['term_slug_lookup'] = ( $active_query_profile['details']['term_slug_lookup'] ?? 0 ) + 1;
			} elseif ( false !== strpos( $query, 't.name IN' ) ) {
				$active_query_profile['details']['term_name_lookup'] = ( $active_query_profile['details']['term_name_lookup'] ?? 0 ) + 1;
			} else {
				$active_query_profile['details']['term_other_lookup'] = ( $active_query_profile['details']['term_other_lookup'] ?? 0 ) + 1;
			}
		} elseif ( 'slug_lookup' === $category ) {
			if ( preg_match( '/SELECT\s+post_name\s+FROM\s+`?' . preg_quote( $wpdb->posts, '/' ) . '`?/i', $query ) ) {
				$active_query_profile['details']['slug_post_name_collision_check'] = ( $active_query_profile['details']['slug_post_name_collision_check'] ?? 0 ) + 1;
			} elseif ( false !== strpos( $query, 'p.post_title' ) && false !== strpos( $query, 'p.post_content' ) ) {
				$active_query_profile['details']['slug_duplicate_post_lookup'] = ( $active_query_profile['details']['slug_duplicate_post_lookup'] ?? 0 ) + 1;
			} elseif ( false !== strpos( $query, 'wp_posts.post_name' ) ) {
				$active_query_profile['details']['slug_post_lookup'] = ( $active_query_profile['details']['slug_post_lookup'] ?? 0 ) + 1;
			} else {
				$active_query_profile['details']['slug_other_lookup'] = ( $active_query_profile['details']['slug_other_lookup'] ?? 0 ) + 1;
			}
		} elseif ( 'meta_read' === $category ) {
			if ( preg_match( '/SELECT\s+post_id,\s*meta_key,\s*meta_value\s+FROM\s+`?' . preg_quote( $wpdb->postmeta, '/' ) . '`?/i', $query ) ) {
				$active_query_profile['details']['meta_bulk_read'] = ( $active_query_profile['details']['meta_bulk_read'] ?? 0 ) + 1;
			} elseif ( preg_match( '/SELECT\s+meta_key\s+FROM\s+`?' . preg_quote( $wpdb->postmeta, '/' ) . '`?/i', $query ) ) {
				$active_query_profile['details']['meta_key_scan'] = ( $active_query_profile['details']['meta_key_scan'] ?? 0 ) + 1;
			} else {
				$active_query_profile['details']['meta_other_read'] = ( $active_query_profile['details']['meta_other_read'] ?? 0 ) + 1;
			}
		}

		$signature = preg_replace( '/\s+/', ' ', trim( $query ) );
		$signature = preg_replace( '/\b\d+\b/', '?', $signature );
		$signature = preg_replace( "/'[^']*'/", '?', $signature );
		$signature = preg_replace( '/"[^"]*"/', '?', $signature );
		$signature = substr( $signature, 0, 220 );
		$active_query_profile['signatures'][ $signature ] = ( $active_query_profile['signatures'][ $signature ] ?? 0 ) + 1;
	};
	$query_counter = static function ( string $query ) use ( &$counters, $wpdb, $profile_query ): string {
		if ( false !== strpos( $query, $wpdb->prefix . 'wc_product_meta_lookup' ) ) {
			++$counters['lookup_table_queries'];
		}
		$profile_query( $query );
		return $query;
	};
	$table_exists = static function ( string $table ) use ( $wpdb ): bool {
		return (string) $wpdb->get_var( $wpdb->prepare( 'SHOW TABLES LIKE %s', $table ) ) === $table;
	};
	$count_table_rows = static function ( string $table, string $where = '1=1' ) use ( $wpdb, $table_exists ): int {
		if ( ! $table_exists( $table ) ) {
			return 0;
		}
		return (int) $wpdb->get_var( "SELECT COUNT(*) FROM {$table} WHERE {$where}" ); // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared
	};
	$row_counts_before = array(
		'products_posts'          => $count_table_rows( $wpdb->posts, "post_type IN ('product','product_variation')" ),
		'postmeta'                => $count_table_rows( $wpdb->postmeta ),
		'term_relationships'      => $count_table_rows( $wpdb->term_relationships ),
		'wc_product_meta_lookup'  => $count_table_rows( $wpdb->prefix . 'wc_product_meta_lookup' ),
		'wc_product_attributes_lookup' => $count_table_rows( $wpdb->prefix . 'wc_product_attributes_lookup' ),
		'actionscheduler_actions' => $count_table_rows( $wpdb->prefix . 'actionscheduler_actions' ),
		'actionscheduler_logs'    => $count_table_rows( $wpdb->prefix . 'actionscheduler_logs' ),
	);
	add_filter( 'query', $query_counter );
	add_action( 'woocommerce_delete_product_transients', static function () use ( &$counters ): void { ++$counters['product_transient_clears']; } );
	add_action( 'woocommerce_rest_insert_product_object', static function () use ( &$counters ): void { ++$counters['rest_product_inserts']; } );
	add_action( 'woocommerce_new_product', static function () use ( &$counters ): void { ++$counters['new_products']; } );
	add_action( 'woocommerce_update_product', static function () use ( &$counters ): void { ++$counters['updated_products']; } );
	add_action( 'woocommerce_new_product_variation', static function () use ( &$counters ): void { ++$counters['new_variations']; } );
	add_action( 'woocommerce_update_product_variation', static function () use ( &$counters ): void { ++$counters['updated_variations']; } );
	add_action( 'woocommerce_variable_product_sync', static function () use ( &$counters ): void { ++$counters['variable_product_syncs']; } );
	add_action(
		'added_post_meta',
		static function ( $meta_id, $post_id, $meta_key ) use ( &$counters, &$meta_hook_counts ): void {
			++$counters['added_post_meta'];
			$meta_hook_counts['added'][ $meta_key ] = ( $meta_hook_counts['added'][ $meta_key ] ?? 0 ) + 1;
		},
		10,
		3
	);
	add_action(
		'updated_post_meta',
		static function ( $meta_id, $post_id, $meta_key ) use ( &$counters, &$meta_hook_counts ): void {
			++$counters['updated_post_meta'];
			$meta_hook_counts['updated'][ $meta_key ] = ( $meta_hook_counts['updated'][ $meta_key ] ?? 0 ) + 1;
		},
		10,
		3
	);
	add_action(
		'deleted_post_meta',
		static function ( $meta_ids, $post_id, $meta_key ) use ( &$counters, &$meta_hook_counts ): void {
			$counters['deleted_post_meta'] += is_array( $meta_ids ) ? count( $meta_ids ) : 1;
			$meta_hook_counts['deleted'][ $meta_key ] = ( $meta_hook_counts['deleted'][ $meta_key ] ?? 0 ) + ( is_array( $meta_ids ) ? count( $meta_ids ) : 1 );
		},
		10,
		3
	);
	add_action( 'save_post_product', static function () use ( &$counters ): void { ++$counters['save_post_product']; } );
	add_action( 'save_post_product_variation', static function () use ( &$counters ): void { ++$counters['save_post_product_variation']; } );
	add_action( 'clean_post_cache', static function () use ( &$counters ): void { ++$counters['clean_post_cache']; } );
	$count_pending_actions = static function (): int {
		if ( ! function_exists( 'as_get_scheduled_actions' ) || ! class_exists( 'ActionScheduler_Store' ) ) {
			return 0;
		}
		return count(
			as_get_scheduled_actions(
				array(
					'status'   => ActionScheduler_Store::STATUS_PENDING,
					'per_page' => 1000,
				)
			)
		);
	};
	$pending_action_count_before = $count_pending_actions();

	$dispatch_batch = static function ( string $route, array $payload ) use ( $wpdb, &$counters, &$meta_hook_counts, &$active_query_profile ): array {
		$counter_before       = $counters;
		$meta_hook_before     = $meta_hook_counts;
		$query_before         = (int) $wpdb->num_queries;
		$active_query_profile = array(
			'operations'       => array_fill_keys( array( 'select', 'insert', 'update', 'delete', 'replace', 'other' ), 0 ),
			'tables'           => array(),
			'operation_tables' => array(),
			'categories'       => array(),
			'details'          => array(),
			'option_names'     => array(),
			'meta_keys'        => array(),
			'meta_key_operations' => array(),
			'signatures'       => array(),
		);
		$request              = new WP_REST_Request( 'POST', $route );
		$request->set_header( 'Content-Type', 'application/json' );
		$request->set_body_params( $payload );
		$started  = microtime( true );
		$response = rest_get_server()->dispatch( $request );
		$elapsed  = ( microtime( true ) - $started ) * 1000;
		$query_profile = $active_query_profile;
		$active_query_profile = null;
		$data     = $response->get_data();
		$status   = (int) $response->get_status();

		if ( $status >= 400 ) {
			throw new RuntimeException( 'REST batch failed for ' . $route . ' with status ' . $status . ': ' . wp_json_encode( $data ) );
		}

		$counter_delta = array();
		foreach ( $counters as $key => $value ) {
			$counter_delta[ $key ] = (int) $value - (int) ( $counter_before[ $key ] ?? 0 );
		}
		$meta_hook_delta = array();
		foreach ( $meta_hook_counts as $operation => $meta_keys ) {
			$meta_hook_delta[ $operation ] = array();
			foreach ( $meta_keys as $meta_key => $count ) {
				$delta = (int) $count - (int) ( $meta_hook_before[ $operation ][ $meta_key ] ?? 0 );
				if ( 0 !== $delta ) {
					$meta_hook_delta[ $operation ][ $meta_key ] = $delta;
				}
			}
			arsort( $meta_hook_delta[ $operation ] );
			$meta_hook_delta[ $operation ] = array_slice( $meta_hook_delta[ $operation ], 0, 40, true );
		}

		arsort( $query_profile['tables'] );
		arsort( $query_profile['operation_tables'] );
		arsort( $query_profile['categories'] );
		arsort( $query_profile['details'] );
		arsort( $query_profile['option_names'] );
		arsort( $query_profile['meta_keys'] );
		arsort( $query_profile['meta_key_operations'] );
		arsort( $query_profile['signatures'] );
		$query_profile['tables']           = array_slice( $query_profile['tables'], 0, 20, true );
		$query_profile['operation_tables'] = array_slice( $query_profile['operation_tables'], 0, 30, true );
		$query_profile['categories']       = array_slice( $query_profile['categories'], 0, 30, true );
		$query_profile['details']          = array_slice( $query_profile['details'], 0, 60, true );
		$query_profile['option_names']     = array_slice( $query_profile['option_names'], 0, 30, true );
		$query_profile['meta_keys']        = array_slice( $query_profile['meta_keys'], 0, 30, true );
		$query_profile['meta_key_operations'] = array_slice( $query_profile['meta_key_operations'], 0, 40, true );
		$query_profile['signatures']       = array_slice( $query_profile['signatures'], 0, 20, true );

		return array(
			'route'         => $route,
			'status'        => $status,
			'elapsed_ms'    => $elapsed,
			'query_count'   => (int) $wpdb->num_queries - $query_before,
			'counter_delta' => $counter_delta,
			'meta_hook_delta' => $meta_hook_delta,
			'query_profile' => $query_profile,
			'data'          => $data,
		);
	};

	$simple_create = array();
	for ( $i = 0; $i < $batch_size; $i++ ) {
		$simple_create[] = array(
			'name'          => 'Homeboy REST Simple Product ' . $run_id . ' #' . ( $i + 1 ),
			'type'          => 'simple',
			'sku'           => 'homeboy-rest-simple-' . $run_id . '-' . ( $i + 1 ),
			'regular_price' => (string) ( 10 + $i ),
			'manage_stock'  => true,
			'stock_quantity' => 10 + $i,
		);
	}
	$simple_create_result = $dispatch_batch( '/wc/v3/products/batch', array( 'create' => $simple_create ) );
	$simple_ids           = wp_list_pluck( (array) ( $simple_create_result['data']['create'] ?? array() ), 'id' );

	$simple_update = array();
	foreach ( $simple_ids as $index => $product_id ) {
		$simple_update[] = array(
			'id'            => (int) $product_id,
			'regular_price' => (string) ( 20 + $index ),
			'stock_quantity' => 20 + $index,
		);
	}
	$simple_update_result = $dispatch_batch( '/wc/v3/products/batch', array( 'update' => $simple_update ) );

	$variation_create = array();
	for ( $i = 0; $i < $batch_size; $i++ ) {
		$variation_attributes = array();
		foreach ( $attribute_taxonomies as $attribute_index => $attribute_taxonomy ) {
			$term                   = $attribute_taxonomy['terms'][ ( $i + $attribute_index ) % count( $attribute_taxonomy['terms'] ) ];
			$variation_attributes[] = array(
				'id'     => $attribute_taxonomy['id'],
				'option' => $term['name'],
			);
		}
		$variation_create[] = array(
			'regular_price' => (string) ( 30 + $i ),
			'sku'           => 'homeboy-rest-variation-' . $run_id . '-' . ( $i + 1 ),
			'manage_stock'  => true,
			'stock_quantity' => 30 + $i,
			'attributes'    => $variation_attributes,
		);
	}
	$variation_route          = '/wc/v3/products/' . $parent_id . '/variations/batch';
	$variation_create_result = $dispatch_batch( $variation_route, array( 'create' => $variation_create ) );
	$variation_ids           = wp_list_pluck( (array) ( $variation_create_result['data']['create'] ?? array() ), 'id' );

	$variation_update = array();
	foreach ( $variation_ids as $index => $variation_id ) {
		$variation_update[] = array(
			'id'            => (int) $variation_id,
			'regular_price' => (string) ( 40 + $index ),
			'stock_quantity' => 40 + $index,
		);
	}
	$variation_update_result = $dispatch_batch( $variation_route, array( 'update' => $variation_update ) );

	remove_filter( 'query', $query_counter );
	remove_filter( 'woocommerce_rest_check_permissions', $allow_product_rest_writes, 10 );

	$count_response_errors = static function ( array $response_items ): int {
		$errors = 0;
		foreach ( $response_items as $item ) {
			if ( is_array( $item ) && isset( $item['code'], $item['message'] ) ) {
				++$errors;
			}
		}
		return $errors;
	};
	$count_duplicate_skus = static function ( array $skus ): int {
		$skus = array_filter( $skus, static fn( $sku ) => '' !== (string) $sku );
		return count( $skus ) - count( array_unique( $skus ) );
	};
	$count_missing_lookup_rows = static function ( array $product_ids ) use ( $wpdb ): int {
		$product_ids = array_values( array_filter( array_map( 'absint', $product_ids ) ) );
		if ( empty( $product_ids ) ) {
			return 0;
		}
		$placeholders = implode( ',', array_fill( 0, count( $product_ids ), '%d' ) );
		$found_ids     = $wpdb->get_col( $wpdb->prepare( "SELECT product_id FROM {$wpdb->prefix}wc_product_meta_lookup WHERE product_id IN ($placeholders)", $product_ids ) ); // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared
		return count( $product_ids ) - count( array_unique( array_map( 'intval', $found_ids ) ) );
	};
	$attribute_lookup_action_hook  = 'woocommerce_run_product_attribute_lookup_update_callback';
	$attribute_lookup_action_group = 'woocommerce-db-updates';
	$get_pending_attribute_lookup_actions = static function () use ( $wpdb, $table_exists, $attribute_lookup_action_hook, $attribute_lookup_action_group ): array {
		$actions_table = $wpdb->prefix . 'actionscheduler_actions';
		$groups_table  = $wpdb->prefix . 'actionscheduler_groups';
		if ( ! class_exists( 'ActionScheduler_Store' ) || ! $table_exists( $actions_table ) || ! $table_exists( $groups_table ) ) {
			return array();
		}

		$rows = $wpdb->get_results(
			$wpdb->prepare(
				"SELECT a.action_id, a.args, a.extended_args, a.status FROM {$actions_table} a INNER JOIN {$groups_table} g ON a.group_id = g.group_id WHERE a.hook = %s AND g.slug = %s AND a.status = %s", // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared
				$attribute_lookup_action_hook,
				$attribute_lookup_action_group,
				ActionScheduler_Store::STATUS_PENDING
			),
			ARRAY_A
		);

		foreach ( $rows as &$row ) {
			$args        = json_decode( (string) ( $row['extended_args'] ?: $row['args'] ), true );
			$row['args'] = is_array( $args ) ? array_values( $args ) : array();
		}
		unset( $row );

		return $rows;
	};
	$count_pending_attribute_lookup_actions = static function ( array $actions, array $product_ids, int $action ): int {
		$product_ids = array_map( 'intval', $product_ids );
		$count       = 0;
		foreach ( $actions as $scheduled_action ) {
			$args = $scheduled_action['args'] ?? array();
			if ( in_array( (int) ( $args[0] ?? 0 ), $product_ids, true ) && (int) ( $args[1] ?? 0 ) === $action ) {
				++$count;
			}
		}
		return $count;
	};
	$count_duplicate_attribute_lookup_actions = static function ( array $actions ): int {
		$seen       = array();
		$duplicates = 0;
		foreach ( $actions as $scheduled_action ) {
			$key = wp_json_encode( $scheduled_action['args'] ?? array() );
			if ( isset( $seen[ $key ] ) ) {
				++$duplicates;
			}
			$seen[ $key ] = true;
		}
		return $duplicates;
	};
	$filter_attribute_lookup_actions = static function ( array $actions, array $product_ids, array $action_types ): array {
		$product_ids  = array_map( 'intval', $product_ids );
		$action_types = array_map( 'intval', $action_types );
		return array_values(
			array_filter(
				$actions,
				static function ( array $scheduled_action ) use ( $product_ids, $action_types ): bool {
					$args = $scheduled_action['args'] ?? array();
					return in_array( (int) ( $args[0] ?? 0 ), $product_ids, true ) && in_array( (int) ( $args[1] ?? 0 ), $action_types, true );
				}
			)
		);
	};
	$count_postmeta_key_rows = static function ( array $product_ids, array $meta_keys ) use ( $wpdb ): array {
		$product_ids = array_values( array_filter( array_map( 'absint', $product_ids ) ) );
		$meta_keys   = array_values( array_unique( array_filter( array_map( 'strval', $meta_keys ) ) ) );
		$counts      = array_fill_keys( $meta_keys, 0 );
		if ( empty( $product_ids ) || empty( $meta_keys ) ) {
			return $counts;
		}

		$product_placeholders = implode( ',', array_fill( 0, count( $product_ids ), '%d' ) );
		$meta_placeholders    = implode( ',', array_fill( 0, count( $meta_keys ), '%s' ) );
		$rows                 = $wpdb->get_results(
			$wpdb->prepare(
				"SELECT meta_key, COUNT(*) AS row_count FROM {$wpdb->postmeta} WHERE post_id IN ($product_placeholders) AND meta_key IN ($meta_placeholders) GROUP BY meta_key", // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared
				array_merge( $product_ids, $meta_keys )
			),
			ARRAY_A
		);

		foreach ( $rows as $row ) {
			$counts[ (string) $row['meta_key'] ] = (int) $row['row_count'];
		}

		return $counts;
	};

	$variation_products = array_filter( array_map( 'wc_get_product', array_map( 'intval', $variation_ids ) ) );
	$simple_products    = array_filter( array_map( 'wc_get_product', array_map( 'intval', $simple_ids ) ) );
	$parent_after       = wc_get_product( $parent_id );
	$active_plugins    = array_values( array_map( 'strval', (array) get_option( 'active_plugins', array() ) ) );
	sort( $active_plugins );
	$expected_variation_prices = array();
	$expected_variation_stock  = array();
	foreach ( $variation_ids as $index => $variation_id ) {
		$expected_variation_prices[ (int) $variation_id ] = (string) ( 40 + $index );
		$expected_variation_stock[ (int) $variation_id ]  = 40 + $index;
	}
	$variation_price_mismatches = 0;
	$variation_stock_mismatches = 0;
	$variation_parent_mismatches = 0;
	$variation_attribute_empty_count = 0;
	$variation_required_meta_keys = array(
		'_sku',
		'_regular_price',
		'_price',
		'_manage_stock',
		'_stock',
		'_stock_status',
	);
	foreach ( $attribute_taxonomies as $attribute_taxonomy ) {
		$variation_required_meta_keys[] = 'attribute_' . $attribute_taxonomy['taxonomy'];
	}
	$variation_meta_key_rows = $count_postmeta_key_rows( $variation_ids, $variation_required_meta_keys );
	$variation_meta_key_missing_counts = array();
	foreach ( $variation_required_meta_keys as $meta_key ) {
		$variation_meta_key_missing_counts[ $meta_key ] = max( 0, count( $variation_ids ) - (int) ( $variation_meta_key_rows[ $meta_key ] ?? 0 ) );
	}
	$variation_required_meta_missing_total = array_sum( $variation_meta_key_missing_counts );
	$expected_attribute_lookup_rows        = array();
	foreach ( $variation_ids as $index => $variation_id ) {
		foreach ( $attribute_taxonomies as $attribute_index => $attribute_taxonomy ) {
			$term = $attribute_taxonomy['terms'][ ( $index + $attribute_index ) % count( $attribute_taxonomy['terms'] ) ];
			$expected_attribute_lookup_rows[] = array(
				'product_id'              => (int) $variation_id,
				'product_or_parent_id'    => (int) $parent_id,
				'taxonomy'                => $attribute_taxonomy['taxonomy'],
				'term_id'                 => (int) $term['id'],
				'is_variation_attribute'  => 1,
				'in_stock'                => 1,
			);
		}
	}
	$pending_attribute_lookup_actions = $get_pending_attribute_lookup_actions();
	$variation_attribute_lookup_actions = $filter_attribute_lookup_actions( $pending_attribute_lookup_actions, $variation_ids, array( 1, 2 ) );
	$attribute_lookup_variation_insert_actions = $count_pending_attribute_lookup_actions( $variation_attribute_lookup_actions, $variation_ids, 1 );
	$attribute_lookup_variation_stock_actions  = $count_pending_attribute_lookup_actions( $variation_attribute_lookup_actions, $variation_ids, 2 );
	$attribute_lookup_duplicate_actions        = $count_duplicate_attribute_lookup_actions( $variation_attribute_lookup_actions );
	$attribute_lookup_callbacks_executed       = 0;
	foreach ( $variation_attribute_lookup_actions as $scheduled_action ) {
		$args = $scheduled_action['args'] ?? array();
		if ( 2 === count( $args ) ) {
			do_action( $attribute_lookup_action_hook, (int) $args[0], (int) $args[1] );
			++$attribute_lookup_callbacks_executed;
		}
	}
	$pending_attribute_lookup_actions_after_callbacks = $get_pending_attribute_lookup_actions();
	$attribute_lookup_table = $wpdb->prefix . 'wc_product_attributes_lookup';
	$attribute_lookup_missing_rows = 0;
	foreach ( $expected_attribute_lookup_rows as $row ) {
		if ( ! $table_exists( $attribute_lookup_table ) ) {
			++$attribute_lookup_missing_rows;
			continue;
		}
		$found = (int) $wpdb->get_var(
			$wpdb->prepare(
				"SELECT COUNT(*) FROM {$attribute_lookup_table} WHERE product_id = %d AND product_or_parent_id = %d AND taxonomy = %s AND term_id = %d AND is_variation_attribute = %d AND in_stock = %d", // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared
				$row['product_id'],
				$row['product_or_parent_id'],
				$row['taxonomy'],
				$row['term_id'],
				$row['is_variation_attribute'],
				$row['in_stock']
			)
		);
		if ( 0 === $found ) {
			++$attribute_lookup_missing_rows;
		}
	}
	$attribute_lookup_variation_rows = 0;
	if ( $table_exists( $attribute_lookup_table ) && ! empty( $variation_ids ) ) {
		$placeholders = implode( ',', array_fill( 0, count( $variation_ids ), '%d' ) );
		$attribute_lookup_variation_rows = (int) $wpdb->get_var( $wpdb->prepare( "SELECT COUNT(*) FROM {$attribute_lookup_table} WHERE product_id IN ($placeholders)", array_map( 'intval', $variation_ids ) ) ); // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared
	}
	foreach ( $variation_products as $variation_product ) {
		$variation_id = $variation_product->get_id();
		if ( (string) $variation_product->get_regular_price() !== (string) ( $expected_variation_prices[ $variation_id ] ?? '' ) ) {
			++$variation_price_mismatches;
		}
		if ( (int) $variation_product->get_stock_quantity() !== (int) ( $expected_variation_stock[ $variation_id ] ?? -1 ) ) {
			++$variation_stock_mismatches;
		}
		if ( (int) $variation_product->get_parent_id() !== (int) $parent_id ) {
			++$variation_parent_mismatches;
		}
		if ( empty( array_filter( $variation_product->get_attributes() ) ) ) {
			++$variation_attribute_empty_count;
		}
	}

	$pending_action_count_after = $count_pending_actions();
	$row_counts_after = array(
		'products_posts'          => $count_table_rows( $wpdb->posts, "post_type IN ('product','product_variation')" ),
		'postmeta'                => $count_table_rows( $wpdb->postmeta ),
		'term_relationships'      => $count_table_rows( $wpdb->term_relationships ),
		'wc_product_meta_lookup'  => $count_table_rows( $wpdb->prefix . 'wc_product_meta_lookup' ),
		'wc_product_attributes_lookup' => $count_table_rows( $wpdb->prefix . 'wc_product_attributes_lookup' ),
		'actionscheduler_actions' => $count_table_rows( $wpdb->prefix . 'actionscheduler_actions' ),
		'actionscheduler_logs'    => $count_table_rows( $wpdb->prefix . 'actionscheduler_logs' ),
	);
	$row_count_deltas = array();
	foreach ( $row_counts_after as $key => $after_count ) {
		$row_count_deltas[ $key ] = (int) $after_count - (int) ( $row_counts_before[ $key ] ?? 0 );
	}

	$invariant_failures = array();
	$record_invariant = static function ( string $name, bool $passed, array $context = array() ) use ( &$invariant_failures ): void {
		if ( ! $passed ) {
			$invariant_failures[] = array(
				'name'    => $name,
				'context' => $context,
			);
		}
	};
	$record_invariant( 'simple_create_response_has_no_errors', 0 === $count_response_errors( (array) ( $simple_create_result['data']['create'] ?? array() ) ) );
	$record_invariant( 'simple_update_response_has_no_errors', 0 === $count_response_errors( (array) ( $simple_update_result['data']['update'] ?? array() ) ) );
	$record_invariant( 'variation_create_response_has_no_errors', 0 === $count_response_errors( (array) ( $variation_create_result['data']['create'] ?? array() ) ) );
	$record_invariant( 'variation_update_response_has_no_errors', 0 === $count_response_errors( (array) ( $variation_update_result['data']['update'] ?? array() ) ) );
	$record_invariant( 'simple_created_count_matches_batch', count( $simple_ids ) === $batch_size, array( 'expected' => $batch_size, 'actual' => count( $simple_ids ) ) );
	$record_invariant( 'variation_created_count_matches_batch', count( $variation_ids ) === $batch_size, array( 'expected' => $batch_size, 'actual' => count( $variation_ids ) ) );
	$record_invariant( 'simple_loaded_count_matches_batch', count( $simple_products ) === $batch_size, array( 'expected' => $batch_size, 'actual' => count( $simple_products ) ) );
	$record_invariant( 'variation_loaded_count_matches_batch', count( $variation_products ) === $batch_size, array( 'expected' => $batch_size, 'actual' => count( $variation_products ) ) );
	$record_invariant( 'parent_child_count_matches_batch', ( $parent_after ? count( $parent_after->get_children() ) : 0 ) === $batch_size, array( 'expected' => $batch_size, 'actual' => $parent_after ? count( $parent_after->get_children() ) : 0 ) );
	$record_invariant( 'variation_parent_ids_match', 0 === $variation_parent_mismatches, array( 'mismatches' => $variation_parent_mismatches ) );
	$record_invariant( 'variation_prices_match_update_payload', 0 === $variation_price_mismatches, array( 'mismatches' => $variation_price_mismatches ) );
	$record_invariant( 'variation_stock_matches_update_payload', 0 === $variation_stock_mismatches, array( 'mismatches' => $variation_stock_mismatches ) );
	$record_invariant( 'variation_attributes_are_present', 0 === $variation_attribute_empty_count, array( 'empty_attribute_count' => $variation_attribute_empty_count ) );
	$record_invariant( 'variation_required_postmeta_rows_exist', 0 === $variation_required_meta_missing_total, array( 'missing_counts' => $variation_meta_key_missing_counts ) );
	$record_invariant( 'simple_skus_are_unique', 0 === $count_duplicate_skus( array_map( static fn( $product ) => $product->get_sku(), $simple_products ) ) );
	$record_invariant( 'variation_skus_are_unique', 0 === $count_duplicate_skus( array_map( static fn( $product ) => $product->get_sku(), $variation_products ) ) );
	$record_invariant( 'simple_lookup_rows_exist', 0 === $count_missing_lookup_rows( $simple_ids ) );
	$record_invariant( 'variation_lookup_rows_exist', 0 === $count_missing_lookup_rows( $variation_ids ) );
	$record_invariant( 'variation_attribute_lookup_rows_exist_after_callbacks', 0 === $attribute_lookup_missing_rows, array( 'missing_rows' => $attribute_lookup_missing_rows, 'expected_rows' => count( $expected_attribute_lookup_rows ), 'actual_variation_rows' => $attribute_lookup_variation_rows ) );

	$rows = array(
		'simple_create'    => $simple_create_result,
		'simple_update'    => $simple_update_result,
		'variation_create' => $variation_create_result,
		'variation_update' => $variation_update_result,
	);
	foreach ( $meta_hook_counts as &$meta_hook_group ) {
		arsort( $meta_hook_group );
		$meta_hook_group = array_slice( $meta_hook_group, 0, 40, true );
	}
	unset( $meta_hook_group );
	foreach ( $rows as &$row ) {
		unset( $row['data'] );
	}
	unset( $row );

	$profile_value = static function ( array $row, string $section, string $key ): int {
		return (int) ( $row['query_profile'][ $section ][ $key ] ?? 0 );
	};
	$parent_transient_option_names = array(
		'_transient_wc_product_children_' . $parent_id,
		'_transient_wc_var_prices_' . $parent_id,
		'_transient_wc_related_' . $parent_id,
		'_transient_wc_child_has_weight_' . $parent_id,
		'_transient_wc_child_has_dimensions_' . $parent_id,
	);
	$count_profile_keys = static function ( array $row, string $section, array $keys ): int {
		$total = 0;
		foreach ( $keys as $key ) {
			$total += (int) ( $row['query_profile'][ $section ][ $key ] ?? 0 );
		}
		return $total;
	};
	$variation_create_count = max( 1, (int) $variation_create_result['counter_delta']['new_variations'] );
	$variation_core_meta_keys = array(
		'_variation_description',
		'_sku',
		'_global_unique_id',
		'_regular_price',
		'_sale_price',
		'_sale_price_dates_from',
		'_sale_price_dates_to',
		'total_sales',
		'_tax_status',
		'_tax_class',
		'_manage_stock',
		'_backorders',
		'_stock',
		'_stock_status',
		'_low_stock_amount',
		'_weight',
		'_length',
		'_width',
		'_height',
	);
	$meta_operation_keys = static function ( string $operation, array $meta_keys ): array {
		return array_map(
			static function ( string $meta_key ) use ( $operation ): string {
				return $operation . ':' . $meta_key;
			},
			$meta_keys
		);
	};
	$meta_hook_value = static function ( array $row, string $operation, string $meta_key ): int {
		return (int) ( $row['meta_hook_delta'][ $operation ][ $meta_key ] ?? 0 );
	};

	$summary = array(
		'success_rate'                         => 1,
		'batch_size'                           => $batch_size,
		'attribute_count'                      => $attribute_count,
		'terms_per_attribute'                  => $terms_per_attr,
		'catalog_seed_products'                => $catalog_products,
		'catalog_seed_ms'                      => $catalog_seed_ms,
		'side_effect_active_plugin_count'      => count( $active_plugins ),
		'simple_create_ms'                     => (float) $simple_create_result['elapsed_ms'],
		'simple_update_ms'                     => (float) $simple_update_result['elapsed_ms'],
		'variation_create_ms'                  => (float) $variation_create_result['elapsed_ms'],
		'variation_update_ms'                  => (float) $variation_update_result['elapsed_ms'],
		'simple_create_queries'                => (int) $simple_create_result['query_count'],
		'simple_update_queries'                => (int) $simple_update_result['query_count'],
		'variation_create_queries'             => (int) $variation_create_result['query_count'],
		'variation_update_queries'             => (int) $variation_update_result['query_count'],
		'variation_create_queries_per_item'    => (float) $variation_create_result['query_count'] / $variation_create_count,
		'variation_create_transient_clears'    => (int) $variation_create_result['counter_delta']['product_transient_clears'],
		'variation_update_transient_clears'    => (int) $variation_update_result['counter_delta']['product_transient_clears'],
		'variation_create_parent_syncs'        => (int) $variation_create_result['counter_delta']['variable_product_syncs'],
		'variation_update_parent_syncs'        => (int) $variation_update_result['counter_delta']['variable_product_syncs'],
		'variation_create_lookup_table_queries' => (int) $variation_create_result['counter_delta']['lookup_table_queries'],
		'variation_update_lookup_table_queries' => (int) $variation_update_result['counter_delta']['lookup_table_queries'],
		'variation_create_profile_meta_exists_queries' => $profile_value( $variation_create_result, 'categories', 'meta_exists' ),
		'variation_create_profile_meta_read_queries' => $profile_value( $variation_create_result, 'categories', 'meta_read' ),
		'variation_create_profile_meta_insert_queries' => $profile_value( $variation_create_result, 'categories', 'meta_insert' ),
		'variation_create_profile_transient_option_queries' => $profile_value( $variation_create_result, 'categories', 'transient_option' ),
		'variation_create_profile_term_lookup_queries' => $profile_value( $variation_create_result, 'categories', 'term_lookup' ),
		'variation_create_profile_slug_lookup_queries' => $profile_value( $variation_create_result, 'categories', 'slug_lookup' ),
		'variation_create_profile_sku_lookup_queries' => $profile_value( $variation_create_result, 'categories', 'sku_lookup' ),
		'variation_create_profile_action_scheduler_queries' => $profile_value( $variation_create_result, 'categories', 'action_scheduler' ),
		'variation_create_profile_action_scheduler_select_actions_queries' => $profile_value( $variation_create_result, 'details', 'action_scheduler_select_actionscheduler_actions' ),
		'variation_create_profile_action_scheduler_select_groups_queries' => $profile_value( $variation_create_result, 'details', 'action_scheduler_select_actionscheduler_groups' ),
		'variation_create_profile_action_scheduler_insert_actions_queries' => $profile_value( $variation_create_result, 'details', 'action_scheduler_insert_actionscheduler_actions' ),
		'variation_create_profile_action_scheduler_insert_logs_queries' => $profile_value( $variation_create_result, 'details', 'action_scheduler_insert_actionscheduler_logs' ),
		'variation_create_profile_action_scheduler_duplicate_check_queries' => $profile_value( $variation_create_result, 'details', 'action_scheduler_duplicate_check' ),
		'variation_create_profile_lookup_table_queries' => $profile_value( $variation_create_result, 'categories', 'lookup_table' ),
		'variation_create_profile_term_relationship_join_queries' => $profile_value( $variation_create_result, 'details', 'term_relationship_join' ),
		'variation_create_profile_term_slug_lookup_queries' => $profile_value( $variation_create_result, 'details', 'term_slug_lookup' ),
		'variation_create_profile_term_name_lookup_queries' => $profile_value( $variation_create_result, 'details', 'term_name_lookup' ),
		'variation_create_profile_slug_post_name_collision_check_queries' => $profile_value( $variation_create_result, 'details', 'slug_post_name_collision_check' ),
		'variation_create_profile_slug_duplicate_post_lookup_queries' => $profile_value( $variation_create_result, 'details', 'slug_duplicate_post_lookup' ),
		'variation_create_profile_slug_post_lookup_queries' => $profile_value( $variation_create_result, 'details', 'slug_post_lookup' ),
		'variation_create_profile_meta_bulk_read_queries' => $profile_value( $variation_create_result, 'details', 'meta_bulk_read' ),
		'variation_create_profile_meta_key_scan_queries' => $profile_value( $variation_create_result, 'details', 'meta_key_scan' ),
		'variation_create_profile_select_options_queries' => $profile_value( $variation_create_result, 'operation_tables', 'select:options' ),
		'variation_create_profile_select_postmeta_queries' => $profile_value( $variation_create_result, 'operation_tables', 'select:postmeta' ),
		'variation_create_profile_insert_postmeta_queries' => $profile_value( $variation_create_result, 'operation_tables', 'insert:postmeta' ),
		'variation_create_profile_meta_exists_per_item' => (float) $profile_value( $variation_create_result, 'categories', 'meta_exists' ) / $variation_create_count,
		'variation_create_profile_meta_insert_per_item' => (float) $profile_value( $variation_create_result, 'categories', 'meta_insert' ) / $variation_create_count,
		'variation_create_profile_core_meta_exists_queries' => $count_profile_keys( $variation_create_result, 'meta_key_operations', $meta_operation_keys( 'exists', $variation_core_meta_keys ) ),
		'variation_create_profile_core_meta_insert_queries' => $count_profile_keys( $variation_create_result, 'meta_key_operations', $meta_operation_keys( 'insert', $variation_core_meta_keys ) ),
		'variation_create_profile_sku_meta_exists_queries' => $profile_value( $variation_create_result, 'meta_key_operations', 'exists:_sku' ),
		'variation_create_profile_sku_meta_insert_queries' => $profile_value( $variation_create_result, 'meta_key_operations', 'insert:_sku' ),
		'variation_create_profile_price_meta_exists_queries' => $count_profile_keys(
			$variation_create_result,
			'meta_key_operations',
			$meta_operation_keys(
				'exists',
				array(
					'_regular_price',
					'_sale_price',
					'_sale_price_dates_from',
					'_sale_price_dates_to',
				)
			)
		),
		'variation_create_profile_stock_meta_exists_queries' => $count_profile_keys(
			$variation_create_result,
			'meta_key_operations',
			$meta_operation_keys(
				'exists',
				array(
					'_manage_stock',
					'_backorders',
					'_stock',
					'_stock_status',
					'_low_stock_amount',
				)
			)
		),
		'variation_create_profile_fixed_transient_option_queries' => $count_profile_keys(
			$variation_create_result,
			'option_names',
			array(
				'_transient_wc_products_onsale',
				'_transient_wc_featured_products',
				'_transient_wc_outofstock_count',
				'_transient_wc_low_stock_count',
			)
		),
		'variation_create_profile_parent_transient_option_queries' => $count_profile_keys( $variation_create_result, 'option_names', $parent_transient_option_names ),
		'variation_create_hook_added_post_meta' => (int) $variation_create_result['counter_delta']['added_post_meta'],
		'variation_create_hook_updated_post_meta' => (int) $variation_create_result['counter_delta']['updated_post_meta'],
		'variation_create_hook_deleted_post_meta' => (int) $variation_create_result['counter_delta']['deleted_post_meta'],
		'variation_create_hook_added_sku_meta' => $meta_hook_value( $variation_create_result, 'added', '_sku' ),
		'variation_create_hook_added_regular_price_meta' => $meta_hook_value( $variation_create_result, 'added', '_regular_price' ),
		'variation_create_hook_added_price_meta' => $meta_hook_value( $variation_create_result, 'added', '_price' ),
		'variation_create_hook_added_manage_stock_meta' => $meta_hook_value( $variation_create_result, 'added', '_manage_stock' ),
		'variation_create_hook_added_stock_meta' => $meta_hook_value( $variation_create_result, 'added', '_stock' ),
		'variation_create_hook_added_stock_status_meta' => $meta_hook_value( $variation_create_result, 'added', '_stock_status' ),
		'variation_create_hook_save_post_product_variation' => (int) $variation_create_result['counter_delta']['save_post_product_variation'],
		'variation_create_hook_clean_post_cache' => (int) $variation_create_result['counter_delta']['clean_post_cache'],
		'variation_update_hook_added_post_meta' => (int) $variation_update_result['counter_delta']['added_post_meta'],
		'variation_update_hook_updated_post_meta' => (int) $variation_update_result['counter_delta']['updated_post_meta'],
		'variation_update_hook_deleted_post_meta' => (int) $variation_update_result['counter_delta']['deleted_post_meta'],
		'variation_update_hook_updated_regular_price_meta' => $meta_hook_value( $variation_update_result, 'updated', '_regular_price' ),
		'variation_update_hook_updated_price_meta' => $meta_hook_value( $variation_update_result, 'updated', '_price' ),
		'variation_update_hook_updated_stock_meta' => $meta_hook_value( $variation_update_result, 'updated', '_stock' ),
		'variation_update_hook_save_post_product_variation' => (int) $variation_update_result['counter_delta']['save_post_product_variation'],
		'variation_update_hook_clean_post_cache' => (int) $variation_update_result['counter_delta']['clean_post_cache'],
		'side_effect_variation_required_meta_missing_total' => $variation_required_meta_missing_total,
		'side_effect_variation_sku_meta_rows' => (int) ( $variation_meta_key_rows['_sku'] ?? 0 ),
		'side_effect_variation_regular_price_meta_rows' => (int) ( $variation_meta_key_rows['_regular_price'] ?? 0 ),
		'side_effect_variation_price_meta_rows' => (int) ( $variation_meta_key_rows['_price'] ?? 0 ),
		'side_effect_variation_manage_stock_meta_rows' => (int) ( $variation_meta_key_rows['_manage_stock'] ?? 0 ),
		'side_effect_variation_stock_meta_rows' => (int) ( $variation_meta_key_rows['_stock'] ?? 0 ),
		'side_effect_variation_stock_status_meta_rows' => (int) ( $variation_meta_key_rows['_stock_status'] ?? 0 ),
		'side_effect_attribute_lookup_expected_rows' => count( $expected_attribute_lookup_rows ),
		'side_effect_attribute_lookup_variation_rows_after_callbacks' => $attribute_lookup_variation_rows,
		'side_effect_attribute_lookup_missing_rows_after_callbacks' => $attribute_lookup_missing_rows,
		'side_effect_attribute_lookup_pending_actions' => count( $pending_attribute_lookup_actions ),
		'side_effect_attribute_lookup_variation_pending_actions' => count( $variation_attribute_lookup_actions ),
		'side_effect_attribute_lookup_pending_actions_after_callbacks' => count( $pending_attribute_lookup_actions_after_callbacks ),
		'side_effect_attribute_lookup_variation_insert_actions' => $attribute_lookup_variation_insert_actions,
		'side_effect_attribute_lookup_variation_stock_actions' => $attribute_lookup_variation_stock_actions,
		'side_effect_attribute_lookup_duplicate_actions' => $attribute_lookup_duplicate_actions,
		'side_effect_attribute_lookup_callbacks_executed' => $attribute_lookup_callbacks_executed,
		'side_effect_simple_create_response_errors' => $count_response_errors( (array) ( $simple_create_result['data']['create'] ?? array() ) ),
		'side_effect_simple_update_response_errors' => $count_response_errors( (array) ( $simple_update_result['data']['update'] ?? array() ) ),
		'side_effect_variation_create_response_errors' => $count_response_errors( (array) ( $variation_create_result['data']['create'] ?? array() ) ),
		'side_effect_variation_update_response_errors' => $count_response_errors( (array) ( $variation_update_result['data']['update'] ?? array() ) ),
		'side_effect_simple_created_count' => count( $simple_ids ),
		'side_effect_variation_created_count' => count( $variation_ids ),
		'side_effect_simple_loaded_count' => count( $simple_products ),
		'side_effect_variation_loaded_count' => count( $variation_products ),
		'side_effect_parent_child_count' => $parent_after ? count( $parent_after->get_children() ) : 0,
		'side_effect_variation_parent_mismatches' => $variation_parent_mismatches,
		'side_effect_variation_price_mismatches' => $variation_price_mismatches,
		'side_effect_variation_stock_mismatches' => $variation_stock_mismatches,
		'side_effect_variation_empty_attribute_count' => $variation_attribute_empty_count,
		'side_effect_simple_duplicate_skus' => $count_duplicate_skus( array_map( static fn( $product ) => $product->get_sku(), $simple_products ) ),
		'side_effect_variation_duplicate_skus' => $count_duplicate_skus( array_map( static fn( $product ) => $product->get_sku(), $variation_products ) ),
		'side_effect_simple_missing_lookup_rows' => $count_missing_lookup_rows( $simple_ids ),
		'side_effect_variation_missing_lookup_rows' => $count_missing_lookup_rows( $variation_ids ),
		'side_effect_pending_action_count_before' => $pending_action_count_before,
		'side_effect_pending_action_count_after' => $pending_action_count_after,
		'side_effect_pending_action_count_delta' => $pending_action_count_after - $pending_action_count_before,
		'side_effect_invariant_failure_count' => count( $invariant_failures ),
		'side_effect_products_posts_row_delta' => (int) ( $row_count_deltas['products_posts'] ?? 0 ),
		'side_effect_postmeta_row_delta' => (int) ( $row_count_deltas['postmeta'] ?? 0 ),
		'side_effect_term_relationships_row_delta' => (int) ( $row_count_deltas['term_relationships'] ?? 0 ),
		'side_effect_lookup_table_row_delta' => (int) ( $row_count_deltas['wc_product_meta_lookup'] ?? 0 ),
		'side_effect_attribute_lookup_table_row_delta' => (int) ( $row_count_deltas['wc_product_attributes_lookup'] ?? 0 ),
		'side_effect_actionscheduler_actions_row_delta' => (int) ( $row_count_deltas['actionscheduler_actions'] ?? 0 ),
		'side_effect_actionscheduler_logs_row_delta' => (int) ( $row_count_deltas['actionscheduler_logs'] ?? 0 ),
	);

	$artifact_path = '';
	$shared_state  = getenv( 'HOMEBOY_BENCH_SHARED_STATE' );
	if ( $shared_state ) {
		$artifact_dir = rtrim( $shared_state, '/' ) . '/rest-product-batch-import';
		wp_mkdir_p( $artifact_dir );
		$artifact_path = $artifact_dir . '/' . $run_id . '.json';
		file_put_contents(
			$artifact_path,
			wp_json_encode(
				array(
					'run_id'                => $run_id,
					'issues'                => $issues,
					'parent_product_id'     => $parent_id,
					'simple_product_ids'    => array_map( 'intval', $simple_ids ),
					'variation_ids'         => array_map( 'intval', $variation_ids ),
					'active_plugins'        => $active_plugins,
					'attribute_taxonomies'  => $attribute_taxonomies,
					'rows'                  => $rows,
					'metrics'               => $summary,
					'side_effects'          => array(
						'invariant_failures'                          => $invariant_failures,
						'meta_hook_counts'                            => $meta_hook_counts,
						'row_counts_before'                           => $row_counts_before,
						'row_counts_after'                            => $row_counts_after,
						'row_count_deltas'                            => $row_count_deltas,
						'attribute_lookup_actions'                    => $pending_attribute_lookup_actions,
						'variation_attribute_lookup_actions'          => $variation_attribute_lookup_actions,
						'attribute_lookup_actions_after_callbacks'    => $pending_attribute_lookup_actions_after_callbacks,
						'expected_attribute_lookup_rows'              => $expected_attribute_lookup_rows,
					),
				),
				JSON_PRETTY_PRINT
			) . "\n"
		);
	}

	return array(
		'metrics'   => $summary,
		'metadata'  => array(
			'runner'       => 'wp-codebox',
			'workload'     => 'rest-product-batch-import',
			'issues'       => $issues,
			'route'        => '/wc/v3/products/batch',
			'variation_route' => $variation_route,
		),
		'artifacts' => $artifact_path ? array( 'raw_result' => array( 'path' => $artifact_path, 'kind' => 'json' ) ) : array(),
	);
};
