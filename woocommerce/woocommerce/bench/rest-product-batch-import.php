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
	$image_mode       = strtolower( (string) ( getenv( 'WC_REST_BATCH_IMPORT_IMAGE_MODE' ) ?: 'none' ) );
	if ( ! in_array( $image_mode, array( 'none', 'existing_attachment', 'remote' ), true ) ) {
		throw new RuntimeException( 'Unsupported WC_REST_BATCH_IMPORT_IMAGE_MODE. Expected none, existing_attachment, or remote.' );
	}
	$image_count        = 'none' === $image_mode ? 0 : max( 1, min( 5, (int) ( getenv( 'WC_REST_BATCH_IMPORT_IMAGES_PER_PRODUCT' ) ?: 1 ) ) );
	$gallery_count      = 'none' === $image_mode ? 0 : max( 0, min( 4, (int) ( getenv( 'WC_REST_BATCH_IMPORT_GALLERY_IMAGES_PER_PRODUCT' ) ?: 0 ) ) );
	$remote_image_base  = rtrim( (string) ( getenv( 'WC_REST_BATCH_IMPORT_REMOTE_IMAGE_BASE' ) ?: '' ), '?' );
	if ( 'remote' === $image_mode && '' === $remote_image_base ) {
		throw new RuntimeException( 'Remote image import mode requires WC_REST_BATCH_IMPORT_REMOTE_IMAGE_BASE to point at a deterministic image endpoint.' );
	}
	$run_id           = 'woocommerce-rest-batch-import-' . getmypid() . '-' . time() . '-' . wp_generate_password( 6, false );
	$issues           = array(
		'https://github.com/woocommerce/woocommerce/issues/26029',
		'https://github.com/chubes4/homeboy-rigs/issues/247',
		'https://github.com/chubes4/homeboy-rigs/issues/227',
		'https://github.com/chubes4/homeboy-rigs/issues/228',
		'https://github.com/chubes4/homeboy-rigs/issues/229',
	);

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

	$media_attachment_ids = array();
	if ( 'existing_attachment' === $image_mode ) {
		require_once ABSPATH . 'wp-admin/includes/image.php';
		$total_attachment_fixtures = max( 1, $image_count + $gallery_count );
		$upload_dir                = wp_upload_dir();
		if ( ! empty( $upload_dir['error'] ) ) {
			throw new RuntimeException( 'Failed to prepare upload directory for REST image fixtures: ' . $upload_dir['error'] );
		}

		$png_bytes = base64_decode( 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=', true );
		if ( false === $png_bytes ) {
			throw new RuntimeException( 'Failed to decode deterministic image fixture.' );
		}

		for ( $fixture_index = 1; $fixture_index <= $total_attachment_fixtures; $fixture_index++ ) {
			$file_path = trailingslashit( $upload_dir['path'] ) . 'homeboy-rest-import-' . $run_id . '-' . $fixture_index . '.png';
			file_put_contents( $file_path, $png_bytes );

			$attachment_id = wp_insert_attachment(
				array(
					'post_mime_type' => 'image/png',
					'post_title'     => 'Homeboy REST Import Image ' . $fixture_index . ' ' . $run_id,
					'post_status'    => 'inherit',
				),
				$file_path
			);
			if ( is_wp_error( $attachment_id ) ) {
				throw new RuntimeException( 'Failed to create deterministic image attachment: ' . $attachment_id->get_error_message() );
			}

			$metadata = wp_generate_attachment_metadata( (int) $attachment_id, $file_path );
			wp_update_attachment_metadata( (int) $attachment_id, $metadata );
			$media_attachment_ids[] = (int) $attachment_id;
		}
	}

	$build_image_payloads = static function ( int $item_index ) use ( $image_mode, $image_count, $gallery_count, $media_attachment_ids, $remote_image_base, $run_id ): array {
		if ( 'none' === $image_mode ) {
			return array();
		}

		$payloads = array();
		$total    = max( 1, $image_count + $gallery_count );
		for ( $image_index = 0; $image_index < $total; $image_index++ ) {
			if ( 'existing_attachment' === $image_mode ) {
				$attachment_id = (int) ( $media_attachment_ids[ $image_index % count( $media_attachment_ids ) ] ?? 0 );
				if ( $attachment_id ) {
					$payloads[] = array( 'id' => $attachment_id );
				}
			} elseif ( 'remote' === $image_mode ) {
				$payloads[] = array(
					'src'  => add_query_arg(
						array(
							'homeboy_run'   => $run_id,
							'product_index' => $item_index,
							'image_index'   => $image_index,
						),
						$remote_image_base
					),
					'name' => 'Homeboy REST Import Remote Image ' . $item_index . '-' . $image_index,
				);
			}
		}

		return $payloads;
	};

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
	$active_http_profile  = null;
	$profile_http_request = static function ( $response, string $context, string $class, array $parsed_args, string $url ) use ( &$active_http_profile ): void {
		if ( null === $active_http_profile ) {
			return;
		}

		++$active_http_profile['request_count'];
		$host = (string) wp_parse_url( $url, PHP_URL_HOST );
		if ( '' === $host ) {
			$host = 'unknown';
		}
		$active_http_profile['hosts'][ $host ] = ( $active_http_profile['hosts'][ $host ] ?? 0 ) + 1;
	};
	add_action( 'http_api_debug', $profile_http_request, 10, 5 );
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
	$count_attachment_meta_rows = static function () use ( $wpdb ): int {
		return (int) $wpdb->get_var( "SELECT COUNT(*) FROM {$wpdb->postmeta} pm INNER JOIN {$wpdb->posts} p ON p.ID = pm.post_id WHERE p.post_type = 'attachment'" ); // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared
	};
	$row_counts_before = array(
		'products_posts'          => $count_table_rows( $wpdb->posts, "post_type IN ('product','product_variation')" ),
		'attachment_posts'        => $count_table_rows( $wpdb->posts, "post_type = 'attachment'" ),
		'postmeta'                => $count_table_rows( $wpdb->postmeta ),
		'attachment_postmeta'     => $count_attachment_meta_rows(),
		'term_relationships'      => $count_table_rows( $wpdb->term_relationships ),
		'wc_product_meta_lookup'  => $count_table_rows( $wpdb->prefix . 'wc_product_meta_lookup' ),
		'wc_product_attributes_lookup' => $count_table_rows( $wpdb->prefix . 'wc_product_attributes_lookup' ),
		'actionscheduler_actions' => $count_table_rows( $wpdb->prefix . 'actionscheduler_actions' ),
		'actionscheduler_logs'    => $count_table_rows( $wpdb->prefix . 'actionscheduler_logs' ),
	);
	add_filter( 'query', $query_counter );

	$reentrant_save_post_product_count   = 0;
	$reentrant_save_post_product_ids     = array();
	$reentrant_save_post_variation_count = 0;
	$reentrant_save_post_variation_ids   = array();
	$reentrant_save_post_product         = static function ( int $post_id ) use ( &$reentrant_save_post_product_count, &$reentrant_save_post_product_ids ): void {
		static $running = false;

		if ( $running || wp_is_post_revision( $post_id ) ) {
			return;
		}

		try {
			$running = true;
			$product = wc_get_product( $post_id );
			if ( $product instanceof WC_Product ) {
				$product->update_meta_data( '_homeboy_reentrant_save_post_synced', 'yes' );
				$product->save();
				++$reentrant_save_post_product_count;
				$reentrant_save_post_product_ids[] = (int) $post_id;
			}
		} finally {
			$running = false;
		}
	};
	$reentrant_save_post_variation       = static function ( int $post_id ) use ( &$reentrant_save_post_variation_count, &$reentrant_save_post_variation_ids ): void {
		static $running = false;

		if ( $running || wp_is_post_revision( $post_id ) ) {
			return;
		}

		try {
			$running = true;
			$variation = wc_get_product( $post_id );
			if ( $variation instanceof WC_Product_Variation ) {
				$variation->update_meta_data( '_homeboy_reentrant_save_post_variation_synced', 'yes' );
				$variation->save();
				++$reentrant_save_post_variation_count;
				$reentrant_save_post_variation_ids[] = (int) $post_id;
			}
		} finally {
			$running = false;
		}
	};
	add_action( 'save_post_product', $reentrant_save_post_product, 10, 1 );
	add_action( 'save_post_product_variation', $reentrant_save_post_variation, 10, 1 );

	$internal_guardrail_meta_keys       = array( '_stock', '_manage_stock', '_stock_status', '_regular_price', '_price', '_sku' );
	$preexisting_internal_meta_writes   = 0;
	$preexisting_internal_meta_post_ids = array();
	$preexisting_internal_meta_seed     = static function ( int $post_id ) use ( $run_id, &$preexisting_internal_meta_writes, &$preexisting_internal_meta_post_ids ): void {
		static $seeded_post_ids = array();

		if ( isset( $seeded_post_ids[ $post_id ] ) || wp_is_post_revision( $post_id ) ) {
			return;
		}

		$seeded_post_ids[ $post_id ] = true;
		$stale_values                = array(
			'_stock'         => '9999',
			'_manage_stock'  => 'no',
			'_stock_status'  => 'outofstock',
			'_regular_price' => '9999',
			'_price'         => '9999',
			'_sku'           => 'homeboy-preexisting-stale-' . $run_id . '-' . $post_id,
		);

		foreach ( $stale_values as $meta_key => $meta_value ) {
			update_post_meta( $post_id, $meta_key, $meta_value );
			++$preexisting_internal_meta_writes;
		}
		$preexisting_internal_meta_post_ids[] = $post_id;
	};
	add_action( 'save_post_product', $preexisting_internal_meta_seed, 5, 1 );

	$third_party_adjacent_meta_writes = 0;
	$third_party_adjacent_meta_keys   = array();
	$third_party_internal_meta_reactor = static function ( $meta_id, $post_id, $meta_key ) use ( $run_id, $internal_guardrail_meta_keys, &$third_party_adjacent_meta_writes, &$third_party_adjacent_meta_keys ): void {
		static $running = false;

		if ( $running || ! in_array( (string) $meta_key, $internal_guardrail_meta_keys, true ) ) {
			return;
		}

		$post_type = get_post_type( (int) $post_id );
		if ( ! in_array( $post_type, array( 'product', 'product_variation' ), true ) ) {
			return;
		}

		try {
			$running      = true;
			$adjacent_key = '_homeboy_adjacent_' . ltrim( (string) $meta_key, '_' );
			update_post_meta( (int) $post_id, $adjacent_key, 'observed-' . $run_id );
			++$third_party_adjacent_meta_writes;
			$third_party_adjacent_meta_keys[ $adjacent_key ] = ( $third_party_adjacent_meta_keys[ $adjacent_key ] ?? 0 ) + 1;
		} finally {
			$running = false;
		}
	};
	add_action( 'added_post_meta', $third_party_internal_meta_reactor, 20, 3 );
	add_action( 'updated_post_meta', $third_party_internal_meta_reactor, 20, 3 );

	$shared_product_data_store            = null;
	$shared_variation_data_store          = null;
	$shared_product_data_store_loads      = 0;
	$shared_variation_data_store_loads    = 0;
	$shared_product_data_store_filter     = static function ( $store ) use ( &$shared_product_data_store, &$shared_product_data_store_loads ) {
		if ( null === $shared_product_data_store ) {
			$shared_product_data_store = is_object( $store ) ? $store : new $store();
		}
		++$shared_product_data_store_loads;
		return $shared_product_data_store;
	};
	$shared_variation_data_store_filter   = static function ( $store ) use ( &$shared_variation_data_store, &$shared_variation_data_store_loads ) {
		if ( null === $shared_variation_data_store ) {
			$shared_variation_data_store = is_object( $store ) ? $store : new $store();
		}
		++$shared_variation_data_store_loads;
		return $shared_variation_data_store;
	};
	add_filter( 'woocommerce_product_data_store', $shared_product_data_store_filter );
	add_filter( 'woocommerce_product-variation_data_store', $shared_variation_data_store_filter );

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

	$dispatch_batch = static function ( string $route, array $payload ) use ( $wpdb, &$counters, &$meta_hook_counts, &$active_query_profile, &$active_http_profile ): array {
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
		$active_http_profile  = array(
			'request_count' => 0,
			'hosts'         => array(),
		);
		$request              = new WP_REST_Request( 'POST', $route );
		$request->set_header( 'Content-Type', 'application/json' );
		$request->set_body_params( $payload );
		$started  = microtime( true );
		$response = rest_get_server()->dispatch( $request );
		$elapsed  = ( microtime( true ) - $started ) * 1000;
		$query_profile = $active_query_profile;
		$http_profile  = $active_http_profile;
		$active_query_profile = null;
		$active_http_profile  = null;
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
		arsort( $http_profile['hosts'] );
		$query_profile['tables']           = array_slice( $query_profile['tables'], 0, 20, true );
		$query_profile['operation_tables'] = array_slice( $query_profile['operation_tables'], 0, 30, true );
		$query_profile['categories']       = array_slice( $query_profile['categories'], 0, 30, true );
		$query_profile['details']          = array_slice( $query_profile['details'], 0, 60, true );
		$query_profile['option_names']     = array_slice( $query_profile['option_names'], 0, 30, true );
		$query_profile['meta_keys']        = array_slice( $query_profile['meta_keys'], 0, 30, true );
		$query_profile['meta_key_operations'] = array_slice( $query_profile['meta_key_operations'], 0, 40, true );
		$query_profile['signatures']       = array_slice( $query_profile['signatures'], 0, 20, true );
		$http_profile['hosts']            = array_slice( $http_profile['hosts'], 0, 10, true );

		return array(
			'route'         => $route,
			'status'        => $status,
			'elapsed_ms'    => $elapsed,
			'query_count'   => (int) $wpdb->num_queries - $query_before,
			'counter_delta' => $counter_delta,
			'meta_hook_delta' => $meta_hook_delta,
			'query_profile' => $query_profile,
			'http_profile'  => $http_profile,
			'data'          => $data,
		);
	};

	$simple_create = array();
	for ( $i = 0; $i < $batch_size; $i++ ) {
		$product_payload = array(
			'name'          => 'Homeboy REST Simple Product ' . $run_id . ' #' . ( $i + 1 ),
			'type'          => 'simple',
			'sku'           => 'homeboy-rest-simple-' . $run_id . '-' . ( $i + 1 ),
			'regular_price' => (string) ( 10 + $i ),
			'manage_stock'  => true,
			'stock_quantity' => 10 + $i,
		);
		$product_images = $build_image_payloads( $i + 1 );
		if ( ! empty( $product_images ) ) {
			$product_payload['images'] = $product_images;
		}
		$simple_create[] = $product_payload;
	}
	$simple_create_result = $dispatch_batch( '/wc/v3/products/batch', array( 'create' => $simple_create ) );
	$simple_ids           = wp_list_pluck( (array) ( $simple_create_result['data']['create'] ?? array() ), 'id' );

	$simple_update = array();
	foreach ( $simple_ids as $index => $product_id ) {
		$product_payload = array(
			'id'            => (int) $product_id,
			'regular_price' => (string) ( 20 + $index ),
			'stock_quantity' => 20 + $index,
		);
		$product_images = $build_image_payloads( $index + 1 );
		if ( ! empty( $product_images ) ) {
			$product_payload['images'] = $product_images;
		}
		$simple_update[] = $product_payload;
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
		$variation_payload = array(
			'regular_price' => (string) ( 30 + $i ),
			'sku'           => 'homeboy-rest-variation-' . $run_id . '-' . ( $i + 1 ),
			'manage_stock'  => true,
			'stock_quantity' => 30 + $i,
			'attributes'    => $variation_attributes,
		);
		$variation_images = $build_image_payloads( $i + 1 );
		if ( ! empty( $variation_images ) ) {
			$variation_payload['image'] = $variation_images[0];
		}
		$variation_create[] = $variation_payload;
	}
	$variation_route          = '/wc/v3/products/' . $parent_id . '/variations/batch';
	$variation_create_result = $dispatch_batch( $variation_route, array( 'create' => $variation_create ) );
	$variation_ids           = wp_list_pluck( (array) ( $variation_create_result['data']['create'] ?? array() ), 'id' );

	$variation_update = array();
	foreach ( $variation_ids as $index => $variation_id ) {
		$variation_payload = array(
			'id'            => (int) $variation_id,
			'regular_price' => (string) ( 40 + $index ),
			'stock_quantity' => 40 + $index,
		);
		$variation_images = $build_image_payloads( $index + 1 );
		if ( ! empty( $variation_images ) ) {
			$variation_payload['image'] = $variation_images[0];
		}
		$variation_update[] = $variation_payload;
	}
	$variation_update_result = $dispatch_batch( $variation_route, array( 'update' => $variation_update ) );

	$retry_duplicate_sku_product_id       = (int) ( $simple_ids[0] ?? 0 );
	$retry_duplicate_sku                  = $retry_duplicate_sku_product_id ? 'homeboy-rest-simple-' . $run_id . '-1' : '';
	$count_retry_product_internal_rows    = static function () use ( $wpdb, &$retry_duplicate_sku_product_id, &$internal_guardrail_meta_keys ): int {
		if ( ! $retry_duplicate_sku_product_id ) {
			return 0;
		}
		$placeholders = implode( ',', array_fill( 0, count( $internal_guardrail_meta_keys ), '%s' ) );
		return (int) $wpdb->get_var(
			$wpdb->prepare(
				"SELECT COUNT(*) FROM {$wpdb->postmeta} WHERE post_id = %d AND meta_key IN ($placeholders)", // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared
				array_merge( array( $retry_duplicate_sku_product_id ), $internal_guardrail_meta_keys )
			)
		);
	};
	$retry_internal_meta_rows_before      = $count_retry_product_internal_rows();
	$retry_duplicate_sku_result           = $dispatch_batch(
		'/wc/v3/products/batch',
		array(
			'create' => array(
				array(
					'name'          => 'Homeboy Duplicate SKU Retry ' . $run_id,
					'type'          => 'simple',
					'sku'           => $retry_duplicate_sku,
					'regular_price' => '55',
					'manage_stock'  => true,
					'stock_quantity' => 55,
				),
			),
		)
	);
	$retry_internal_meta_rows_after       = $count_retry_product_internal_rows();
	$retry_internal_meta_row_delta        = $retry_internal_meta_rows_after - $retry_internal_meta_rows_before;

	remove_filter( 'query', $query_counter );
	remove_action( 'http_api_debug', $profile_http_request, 10 );
	remove_filter( 'woocommerce_rest_check_permissions', $allow_product_rest_writes, 10 );
	remove_action( 'save_post_product', $reentrant_save_post_product, 10 );
	remove_action( 'save_post_product_variation', $reentrant_save_post_variation, 10 );
	remove_action( 'save_post_product', $preexisting_internal_meta_seed, 5 );
	remove_action( 'added_post_meta', $third_party_internal_meta_reactor, 20 );
	remove_action( 'updated_post_meta', $third_party_internal_meta_reactor, 20 );
	remove_filter( 'woocommerce_product_data_store', $shared_product_data_store_filter );
	remove_filter( 'woocommerce_product-variation_data_store', $shared_variation_data_store_filter );

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
	$get_duplicate_postmeta_rows = static function ( array $product_ids ) use ( $wpdb ): array {
		$product_ids = array_values( array_filter( array_map( 'absint', $product_ids ) ) );
		if ( empty( $product_ids ) ) {
			return array();
		}

		$placeholders = implode( ',', array_fill( 0, count( $product_ids ), '%d' ) );
		$rows         = $wpdb->get_results(
			$wpdb->prepare(
				"SELECT post_id, meta_key, COUNT(*) AS row_count, GROUP_CONCAT(meta_value ORDER BY meta_id SEPARATOR ' | ') AS values_seen FROM {$wpdb->postmeta} WHERE post_id IN ($placeholders) GROUP BY post_id, meta_key HAVING row_count > 1 ORDER BY post_id ASC, meta_key ASC", // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared
				$product_ids
			),
			ARRAY_A
		);

		return array_map(
			static function ( array $row ): array {
				return array(
					'post_id'     => (int) $row['post_id'],
					'meta_key'    => (string) $row['meta_key'],
					'row_count'   => (int) $row['row_count'],
					'values_seen' => (string) $row['values_seen'],
				);
			},
			$rows
		);
	};
	$count_duplicate_postmeta_rows_for_keys = static function ( array $duplicate_rows, array $meta_keys ): int {
		$meta_keys = array_flip( array_map( 'strval', $meta_keys ) );
		$count     = 0;
		foreach ( $duplicate_rows as $row ) {
			if ( isset( $meta_keys[ (string) ( $row['meta_key'] ?? '' ) ] ) ) {
				++$count;
			}
		}
		return $count;
	};
	$count_meta_value_mismatches = static function ( array $product_ids, string $meta_key, callable $expected_value ) use ( $wpdb ): int {
		$mismatches = 0;
		foreach ( array_values( array_map( 'intval', $product_ids ) ) as $index => $product_id ) {
			$values   = $wpdb->get_col( $wpdb->prepare( "SELECT meta_value FROM {$wpdb->postmeta} WHERE post_id = %d AND meta_key = %s ORDER BY meta_id ASC", $product_id, $meta_key ) ); // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared
			$expected = (string) $expected_value( $product_id, $index );
			if ( 1 !== count( $values ) || (string) $values[0] !== $expected ) {
				++$mismatches;
			}
		}
		return $mismatches;
	};
	$count_adjacent_meta_missing = static function ( array $product_ids, array $meta_keys ) use ( $wpdb ): int {
		$missing = 0;
		foreach ( array_values( array_map( 'intval', $product_ids ) ) as $product_id ) {
			foreach ( $meta_keys as $meta_key ) {
				$adjacent_key = '_homeboy_adjacent_' . ltrim( (string) $meta_key, '_' );
				if ( 0 === (int) $wpdb->get_var( $wpdb->prepare( "SELECT COUNT(*) FROM {$wpdb->postmeta} WHERE post_id = %d AND meta_key = %s", $product_id, $adjacent_key ) ) ) { // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared
					++$missing;
				}
			}
		}
		return $missing;
	};
	$count_sku_lookup_mismatches = static function ( array $product_ids, array $expected_skus ): int {
		$mismatches = 0;
		foreach ( array_values( array_map( 'intval', $product_ids ) ) as $index => $product_id ) {
			$expected_sku = (string) ( $expected_skus[ $product_id ] ?? '' );
			if ( '' === $expected_sku || (int) wc_get_product_id_by_sku( $expected_sku ) !== (int) $product_id ) {
				++$mismatches;
			}
		}
		return $mismatches;
	};

	$variation_products = array_filter( array_map( 'wc_get_product', array_map( 'intval', $variation_ids ) ) );
	$simple_products    = array_filter( array_map( 'wc_get_product', array_map( 'intval', $simple_ids ) ) );
	$parent_after       = wc_get_product( $parent_id );
	$active_plugins    = array_values( array_map( 'strval', (array) get_option( 'active_plugins', array() ) ) );
	sort( $active_plugins );
	$expected_simple_skus          = array();
	$expected_simple_regular_price = array();
	$expected_simple_price         = array();
	$expected_simple_stock         = array();
	$expected_simple_image_ids     = array();
	$expected_simple_gallery_ids   = array();
	$get_response_product_images   = static function ( array $items ): array {
		$images_by_product = array();
		foreach ( $items as $item ) {
			if ( empty( $item['id'] ) || empty( $item['images'] ) || ! is_array( $item['images'] ) ) {
				continue;
			}
			$images_by_product[ (int) $item['id'] ] = array_values(
				array_filter(
					array_map(
						static fn( $image ) => (int) ( is_array( $image ) ? ( $image['id'] ?? 0 ) : 0 ),
						$item['images']
					)
				)
			);
		}
		return $images_by_product;
	};
	$get_response_variation_images = static function ( array $items ): array {
		$images_by_variation = array();
		foreach ( $items as $item ) {
			if ( empty( $item['id'] ) || empty( $item['image'] ) || ! is_array( $item['image'] ) ) {
				continue;
			}
			$images_by_variation[ (int) $item['id'] ] = (int) ( $item['image']['id'] ?? 0 );
		}
		return $images_by_variation;
	};
	$response_simple_images        = $get_response_product_images( (array) ( $simple_update_result['data']['update'] ?? array() ) );
	$response_variation_images     = $get_response_variation_images( (array) ( $variation_update_result['data']['update'] ?? array() ) );
	foreach ( $simple_ids as $index => $simple_id ) {
		$expected_simple_skus[ (int) $simple_id ]          = 'homeboy-rest-simple-' . $run_id . '-' . ( $index + 1 );
		$expected_simple_regular_price[ (int) $simple_id ] = (string) ( 20 + $index );
		$expected_simple_price[ (int) $simple_id ]         = (string) ( 20 + $index );
		$expected_simple_stock[ (int) $simple_id ]         = (string) ( 20 + $index );
		$expected_image_ids                                = $response_simple_images[ (int) $simple_id ] ?? array();
		$expected_simple_image_ids[ (int) $simple_id ]     = (int) ( $expected_image_ids[0] ?? 0 );
		$expected_simple_gallery_ids[ (int) $simple_id ]   = array_values( array_slice( array_map( 'intval', $expected_image_ids ), 1 ) );
	}
	$expected_variation_prices = array();
	$expected_variation_stock  = array();
	$expected_variation_skus   = array();
	$expected_variation_image_ids = array();
	foreach ( $variation_ids as $index => $variation_id ) {
		$expected_variation_prices[ (int) $variation_id ] = (string) ( 40 + $index );
		$expected_variation_stock[ (int) $variation_id ]  = 40 + $index;
		$expected_variation_skus[ (int) $variation_id ]   = 'homeboy-rest-variation-' . $run_id . '-' . ( $index + 1 );
		$expected_variation_image_ids[ (int) $variation_id ] = (int) ( $response_variation_images[ (int) $variation_id ] ?? 0 );
	}
	$variation_price_mismatches        = 0;
	$variation_stock_mismatches        = 0;
	$variation_manage_stock_mismatches = 0;
	$variation_parent_mismatches       = 0;
	$variation_attribute_empty_count   = 0;
	$simple_manage_stock_mismatches    = 0;
	$simple_stock_mismatches           = 0;
	$simple_sku_readback_mismatches    = 0;
	$simple_regular_price_mismatches = 0;
	$simple_price_mismatches        = 0;
	$simple_stock_status_mismatches = 0;
	$simple_image_readback_mismatches = 0;
	$simple_gallery_readback_mismatches = 0;
	$variation_sku_readback_mismatches = 0;
	$variation_stock_status_mismatches = 0;
	$variation_image_readback_mismatches = 0;
	$simple_ids_int                    = array_map( 'intval', $simple_ids );
	foreach ( $simple_products as $simple_product ) {
		$simple_id    = $simple_product->get_id();
		$simple_index = array_search( $simple_id, $simple_ids_int, true );
		if ( (string) $simple_product->get_sku() !== (string) ( $expected_simple_skus[ $simple_id ] ?? '' ) ) {
			++$simple_sku_readback_mismatches;
		}
		if ( (string) $simple_product->get_regular_price() !== (string) ( $expected_simple_regular_price[ $simple_id ] ?? '' ) ) {
			++$simple_regular_price_mismatches;
		}
		if ( (string) $simple_product->get_price() !== (string) ( $expected_simple_price[ $simple_id ] ?? '' ) ) {
			++$simple_price_mismatches;
		}
		if ( true !== $simple_product->get_manage_stock() ) {
			++$simple_manage_stock_mismatches;
		}
		if ( false === $simple_index || (int) $simple_product->get_stock_quantity() !== 20 + (int) $simple_index ) {
			++$simple_stock_mismatches;
		}
		if ( 'instock' !== (string) $simple_product->get_stock_status() ) {
			++$simple_stock_status_mismatches;
		}
		if ( 'none' !== $image_mode ) {
			if ( (int) $simple_product->get_image_id() !== (int) ( $expected_simple_image_ids[ $simple_id ] ?? 0 ) ) {
				++$simple_image_readback_mismatches;
			}
			$expected_gallery_ids = array_map( 'intval', $expected_simple_gallery_ids[ $simple_id ] ?? array() );
			$actual_gallery_ids   = array_map( 'intval', $simple_product->get_gallery_image_ids() );
			sort( $expected_gallery_ids );
			sort( $actual_gallery_ids );
			if ( $expected_gallery_ids !== $actual_gallery_ids ) {
				++$simple_gallery_readback_mismatches;
			}
		}
	}
	$simple_duplicate_meta_rows    = $get_duplicate_postmeta_rows( $simple_ids );
	$variation_duplicate_meta_rows = $get_duplicate_postmeta_rows( $variation_ids );
	$simple_internal_duplicate_meta_row_count    = $count_duplicate_postmeta_rows_for_keys( $simple_duplicate_meta_rows, $internal_guardrail_meta_keys );
	$variation_internal_duplicate_meta_row_count = $count_duplicate_postmeta_rows_for_keys( $variation_duplicate_meta_rows, $internal_guardrail_meta_keys );
	$simple_sku_lookup_mismatches                = $count_sku_lookup_mismatches( $simple_ids, $expected_simple_skus );
	$variation_sku_lookup_mismatches             = $count_sku_lookup_mismatches( $variation_ids, $expected_variation_skus );
	$simple_adjacent_meta_missing_count          = $count_adjacent_meta_missing( $simple_ids, $internal_guardrail_meta_keys );
	$variation_adjacent_meta_missing_count       = $count_adjacent_meta_missing( $variation_ids, $internal_guardrail_meta_keys );
	$simple_meta_value_mismatches                = array(
		'_sku'           => $count_meta_value_mismatches( $simple_ids, '_sku', static fn( int $product_id ) => (string) ( $expected_simple_skus[ $product_id ] ?? '' ) ),
		'_regular_price' => $count_meta_value_mismatches( $simple_ids, '_regular_price', static fn( int $product_id ) => (string) ( $expected_simple_regular_price[ $product_id ] ?? '' ) ),
		'_price'         => $count_meta_value_mismatches( $simple_ids, '_price', static fn( int $product_id ) => (string) ( $expected_simple_price[ $product_id ] ?? '' ) ),
		'_manage_stock'  => $count_meta_value_mismatches( $simple_ids, '_manage_stock', static fn() => 'yes' ),
		'_stock'         => $count_meta_value_mismatches( $simple_ids, '_stock', static fn( int $product_id ) => (string) ( $expected_simple_stock[ $product_id ] ?? '' ) ),
		'_stock_status'  => $count_meta_value_mismatches( $simple_ids, '_stock_status', static fn() => 'instock' ),
	);
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
		if ( (string) $variation_product->get_sku() !== (string) ( $expected_variation_skus[ $variation_id ] ?? '' ) ) {
			++$variation_sku_readback_mismatches;
		}
		if ( (string) $variation_product->get_regular_price() !== (string) ( $expected_variation_prices[ $variation_id ] ?? '' ) ) {
			++$variation_price_mismatches;
		}
		if ( true !== $variation_product->get_manage_stock() ) {
			++$variation_manage_stock_mismatches;
		}
		if ( (int) $variation_product->get_stock_quantity() !== (int) ( $expected_variation_stock[ $variation_id ] ?? -1 ) ) {
			++$variation_stock_mismatches;
		}
		if ( 'instock' !== (string) $variation_product->get_stock_status() ) {
			++$variation_stock_status_mismatches;
		}
		if ( (int) $variation_product->get_parent_id() !== (int) $parent_id ) {
			++$variation_parent_mismatches;
		}
		if ( 'none' !== $image_mode && (int) $variation_product->get_image_id() !== (int) ( $expected_variation_image_ids[ $variation_id ] ?? 0 ) ) {
			++$variation_image_readback_mismatches;
		}
		if ( empty( array_filter( $variation_product->get_attributes() ) ) ) {
			++$variation_attribute_empty_count;
		}
	}
	$parent_child_ids                  = $parent_after ? array_map( 'intval', $parent_after->get_children() ) : array();
	$missing_parent_child_ids          = array_values( array_diff( array_map( 'intval', $variation_ids ), $parent_child_ids ) );
	$variation_post_parent_mismatches  = 0;
	if ( ! empty( $variation_ids ) ) {
		$variation_placeholders = implode( ',', array_fill( 0, count( $variation_ids ), '%d' ) );
		$variation_post_parent_mismatches = (int) $wpdb->get_var(
			$wpdb->prepare(
				"SELECT COUNT(*) FROM {$wpdb->posts} WHERE ID IN ($variation_placeholders) AND post_parent != %d", // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared
				array_merge( array_map( 'intval', $variation_ids ), array( (int) $parent_id ) )
			)
		);
	}
	$variation_meta_value_mismatches = array(
		'_sku'           => $count_meta_value_mismatches( $variation_ids, '_sku', static fn( int $product_id ) => (string) ( $expected_variation_skus[ $product_id ] ?? '' ) ),
		'_regular_price' => $count_meta_value_mismatches( $variation_ids, '_regular_price', static fn( int $product_id ) => (string) ( $expected_variation_prices[ $product_id ] ?? '' ) ),
		'_price'         => $count_meta_value_mismatches( $variation_ids, '_price', static fn( int $product_id ) => (string) ( $expected_variation_prices[ $product_id ] ?? '' ) ),
		'_manage_stock'  => $count_meta_value_mismatches( $variation_ids, '_manage_stock', static fn() => 'yes' ),
		'_stock'         => $count_meta_value_mismatches( $variation_ids, '_stock', static fn( int $product_id ) => (string) ( $expected_variation_stock[ $product_id ] ?? '' ) ),
		'_stock_status'  => $count_meta_value_mismatches( $variation_ids, '_stock_status', static fn() => 'instock' ),
	);

	$pending_action_count_after = $count_pending_actions();
	$row_counts_after = array(
		'products_posts'          => $count_table_rows( $wpdb->posts, "post_type IN ('product','product_variation')" ),
		'attachment_posts'        => $count_table_rows( $wpdb->posts, "post_type = 'attachment'" ),
		'postmeta'                => $count_table_rows( $wpdb->postmeta ),
		'attachment_postmeta'     => $count_attachment_meta_rows(),
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
	$record_invariant( 'variation_manage_stock_readback_matches_payload_after_reentrant_save', 0 === $variation_manage_stock_mismatches, array( 'mismatches' => $variation_manage_stock_mismatches ) );
	$record_invariant( 'preexisting_simple_internal_meta_is_overwritten', 0 === array_sum( $simple_meta_value_mismatches ), array( 'mismatches' => $simple_meta_value_mismatches ) );
	$record_invariant( 'variation_internal_meta_values_are_canonical', 0 === array_sum( $variation_meta_value_mismatches ), array( 'mismatches' => $variation_meta_value_mismatches ) );
	$record_invariant( 'simple_sku_readback_matches_payload_after_reentrant_save', 0 === $simple_sku_readback_mismatches, array( 'mismatches' => $simple_sku_readback_mismatches ) );
	$record_invariant( 'variation_sku_readback_matches_payload', 0 === $variation_sku_readback_mismatches, array( 'mismatches' => $variation_sku_readback_mismatches ) );
	$record_invariant( 'simple_sku_lookup_resolves_created_product', 0 === $simple_sku_lookup_mismatches, array( 'mismatches' => $simple_sku_lookup_mismatches ) );
	$record_invariant( 'variation_sku_lookup_resolves_created_variation', 0 === $variation_sku_lookup_mismatches, array( 'mismatches' => $variation_sku_lookup_mismatches ) );
	$record_invariant( 'simple_product_image_readback_matches_rest_response', 'none' === $image_mode || 0 === $simple_image_readback_mismatches, array( 'mismatches' => $simple_image_readback_mismatches, 'mode' => $image_mode ) );
	$record_invariant( 'simple_product_gallery_readback_matches_rest_response', 'none' === $image_mode || 0 === $simple_gallery_readback_mismatches, array( 'mismatches' => $simple_gallery_readback_mismatches, 'mode' => $image_mode ) );
	$record_invariant( 'variation_image_readback_matches_rest_response', 'none' === $image_mode || 0 === $variation_image_readback_mismatches, array( 'mismatches' => $variation_image_readback_mismatches, 'mode' => $image_mode ) );
	$record_invariant( 'simple_manage_stock_readback_matches_payload_after_reentrant_save', 0 === $simple_manage_stock_mismatches, array( 'mismatches' => $simple_manage_stock_mismatches ) );
	$record_invariant( 'simple_stock_readback_matches_payload_after_reentrant_save', 0 === $simple_stock_mismatches, array( 'mismatches' => $simple_stock_mismatches ) );
	$record_invariant( 'simple_stock_status_readback_matches_payload_after_reentrant_save', 0 === $simple_stock_status_mismatches, array( 'mismatches' => $simple_stock_status_mismatches ) );
	$record_invariant( 'variation_manage_stock_readback_matches_payload', 0 === $variation_manage_stock_mismatches, array( 'mismatches' => $variation_manage_stock_mismatches ) );
	$record_invariant( 'variation_stock_status_readback_matches_payload', 0 === $variation_stock_status_mismatches, array( 'mismatches' => $variation_stock_status_mismatches ) );
	$record_invariant( 'simple_create_has_no_duplicate_meta_rows_after_reentrant_save', empty( $simple_duplicate_meta_rows ), array( 'duplicates' => array_slice( $simple_duplicate_meta_rows, 0, 20 ) ) );
	$record_invariant( 'variation_create_has_no_duplicate_meta_rows', empty( $variation_duplicate_meta_rows ), array( 'duplicates' => array_slice( $variation_duplicate_meta_rows, 0, 20 ) ) );
	$record_invariant( 'simple_internal_meta_duplicate_rows_stay_bounded', 0 === $simple_internal_duplicate_meta_row_count, array( 'duplicates' => $simple_internal_duplicate_meta_row_count ) );
	$record_invariant( 'variation_internal_meta_duplicate_rows_stay_bounded', 0 === $variation_internal_duplicate_meta_row_count, array( 'duplicates' => $variation_internal_duplicate_meta_row_count ) );
	$record_invariant( 'third_party_adjacent_meta_hooks_fired', $third_party_adjacent_meta_writes > 0, array( 'writes' => $third_party_adjacent_meta_writes ) );
	$record_invariant( 'third_party_adjacent_meta_exists_for_simple_products', 0 === $simple_adjacent_meta_missing_count, array( 'missing' => $simple_adjacent_meta_missing_count ) );
	$record_invariant( 'third_party_adjacent_meta_exists_for_variations', 0 === $variation_adjacent_meta_missing_count, array( 'missing' => $variation_adjacent_meta_missing_count ) );
	$record_invariant( 'shared_product_data_store_was_reused', $shared_product_data_store_loads > 1, array( 'loads' => $shared_product_data_store_loads, 'class' => is_object( $shared_product_data_store ) ? get_class( $shared_product_data_store ) : '' ) );
	$record_invariant( 'shared_variation_data_store_was_reused', $shared_variation_data_store_loads > 1, array( 'loads' => $shared_variation_data_store_loads, 'class' => is_object( $shared_variation_data_store ) ? get_class( $shared_variation_data_store ) : '' ) );
	$record_invariant( 'variation_attributes_are_present', 0 === $variation_attribute_empty_count, array( 'empty_attribute_count' => $variation_attribute_empty_count ) );
	$record_invariant( 'variation_parent_children_include_all_created_variations', empty( $missing_parent_child_ids ), array( 'missing_child_ids' => $missing_parent_child_ids ) );
	$record_invariant( 'variation_posts_have_expected_parent', 0 === $variation_post_parent_mismatches, array( 'mismatches' => $variation_post_parent_mismatches ) );
	$record_invariant( 'variation_required_postmeta_rows_exist', 0 === $variation_required_meta_missing_total, array( 'missing_counts' => $variation_meta_key_missing_counts ) );
	$record_invariant( 'simple_skus_are_unique', 0 === $count_duplicate_skus( array_map( static fn( $product ) => $product->get_sku(), $simple_products ) ) );
	$record_invariant( 'variation_skus_are_unique', 0 === $count_duplicate_skus( array_map( static fn( $product ) => $product->get_sku(), $variation_products ) ) );
	$record_invariant( 'duplicate_sku_retry_returns_one_create_error', 1 === $count_response_errors( (array) ( $retry_duplicate_sku_result['data']['create'] ?? array() ) ), array( 'errors' => $count_response_errors( (array) ( $retry_duplicate_sku_result['data']['create'] ?? array() ) ) ) );
	$record_invariant( 'duplicate_sku_retry_does_not_multiply_internal_meta_rows', 0 === $retry_internal_meta_row_delta, array( 'before' => $retry_internal_meta_rows_before, 'after' => $retry_internal_meta_rows_after, 'delta' => $retry_internal_meta_row_delta ) );
	$record_invariant( 'simple_lookup_rows_exist', 0 === $count_missing_lookup_rows( $simple_ids ) );
	$record_invariant( 'variation_lookup_rows_exist', 0 === $count_missing_lookup_rows( $variation_ids ) );
	$record_invariant( 'variation_attribute_lookup_rows_exist_after_callbacks', 0 === $attribute_lookup_missing_rows, array( 'missing_rows' => $attribute_lookup_missing_rows, 'expected_rows' => count( $expected_attribute_lookup_rows ), 'actual_variation_rows' => $attribute_lookup_variation_rows ) );

	$rows = array(
		'simple_create'    => $simple_create_result,
		'simple_update'    => $simple_update_result,
		'variation_create' => $variation_create_result,
		'variation_update' => $variation_update_result,
		'duplicate_sku_retry' => $retry_duplicate_sku_result,
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
	$http_request_count = static function ( array $row ): int {
		return (int) ( $row['http_profile']['request_count'] ?? 0 );
	};
	$simple_product_count    = max( 1, count( $simple_ids ) );
	$variation_product_count = max( 1, count( $variation_ids ) );
	$media_rest_error_count  = $count_response_errors( (array) ( $simple_create_result['data']['create'] ?? array() ) )
		+ $count_response_errors( (array) ( $simple_update_result['data']['update'] ?? array() ) )
		+ $count_response_errors( (array) ( $variation_create_result['data']['create'] ?? array() ) )
		+ $count_response_errors( (array) ( $variation_update_result['data']['update'] ?? array() ) );

	$summary = array(
		'success_rate'                         => 1,
		'batch_size'                           => $batch_size,
		'attribute_count'                      => $attribute_count,
		'terms_per_attribute'                  => $terms_per_attr,
		'catalog_seed_products'                => $catalog_products,
		'catalog_seed_ms'                      => $catalog_seed_ms,
		'media_image_mode'                     => $image_mode,
		'media_images_per_product'             => $image_count,
		'media_gallery_images_per_product'     => $gallery_count,
		'media_fixture_attachment_count'       => count( $media_attachment_ids ),
		'media_simple_create_ms_per_product'   => (float) $simple_create_result['elapsed_ms'] / $simple_product_count,
		'media_simple_update_ms_per_product'   => (float) $simple_update_result['elapsed_ms'] / $simple_product_count,
		'media_variation_create_ms_per_product' => (float) $variation_create_result['elapsed_ms'] / $variation_product_count,
		'media_variation_update_ms_per_product' => (float) $variation_update_result['elapsed_ms'] / $variation_product_count,
		'media_simple_create_queries_per_product' => (float) $simple_create_result['query_count'] / $simple_product_count,
		'media_simple_update_queries_per_product' => (float) $simple_update_result['query_count'] / $simple_product_count,
		'media_variation_create_queries_per_product' => (float) $variation_create_result['query_count'] / $variation_product_count,
		'media_variation_update_queries_per_product' => (float) $variation_update_result['query_count'] / $variation_product_count,
		'media_http_request_count'             => $http_request_count( $simple_create_result ) + $http_request_count( $simple_update_result ) + $http_request_count( $variation_create_result ) + $http_request_count( $variation_update_result ),
		'media_simple_create_http_requests'    => $http_request_count( $simple_create_result ),
		'media_simple_update_http_requests'    => $http_request_count( $simple_update_result ),
		'media_variation_create_http_requests' => $http_request_count( $variation_create_result ),
		'media_variation_update_http_requests' => $http_request_count( $variation_update_result ),
		'media_rest_error_count'               => $media_rest_error_count,
		'media_attachment_row_delta'           => (int) ( $row_count_deltas['attachment_posts'] ?? 0 ),
		'media_attachment_meta_row_delta'      => (int) ( $row_count_deltas['attachment_postmeta'] ?? 0 ),
		'media_simple_image_readback_mismatches' => $simple_image_readback_mismatches,
		'media_simple_gallery_readback_mismatches' => $simple_gallery_readback_mismatches,
		'media_variation_image_readback_mismatches' => $variation_image_readback_mismatches,
		'side_effect_active_plugin_count'      => count( $active_plugins ),
		'scenario_reentrant_save_post_product' => 1,
		'scenario_shared_product_data_store'   => 1,
		'scenario_preexisting_internal_meta'   => 1,
		'scenario_third_party_meta_hooks'      => 1,
		'scenario_variation_parent_sync_guardrail' => 1,
		'scenario_duplicate_sku_retry'         => 1,
		'simple_create_ms'                     => (float) $simple_create_result['elapsed_ms'],
		'simple_update_ms'                     => (float) $simple_update_result['elapsed_ms'],
		'variation_create_ms'                  => (float) $variation_create_result['elapsed_ms'],
		'variation_update_ms'                  => (float) $variation_update_result['elapsed_ms'],
		'duplicate_sku_retry_ms'               => (float) $retry_duplicate_sku_result['elapsed_ms'],
		'simple_create_queries'                => (int) $simple_create_result['query_count'],
		'simple_update_queries'                => (int) $simple_update_result['query_count'],
		'variation_create_queries'             => (int) $variation_create_result['query_count'],
		'variation_update_queries'             => (int) $variation_update_result['query_count'],
		'duplicate_sku_retry_queries'          => (int) $retry_duplicate_sku_result['query_count'],
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
		'side_effect_duplicate_sku_retry_response_errors' => $count_response_errors( (array) ( $retry_duplicate_sku_result['data']['create'] ?? array() ) ),
		'side_effect_duplicate_sku_retry_internal_meta_row_delta' => $retry_internal_meta_row_delta,
		'side_effect_duplicate_sku_retry_internal_meta_rows_before' => $retry_internal_meta_rows_before,
		'side_effect_duplicate_sku_retry_internal_meta_rows_after' => $retry_internal_meta_rows_after,
		'side_effect_simple_created_count' => count( $simple_ids ),
		'side_effect_variation_created_count' => count( $variation_ids ),
		'side_effect_simple_loaded_count' => count( $simple_products ),
		'side_effect_variation_loaded_count' => count( $variation_products ),
		'side_effect_preexisting_internal_meta_writes' => $preexisting_internal_meta_writes,
		'side_effect_preexisting_internal_meta_products' => count( array_unique( $preexisting_internal_meta_post_ids ) ),
		'side_effect_third_party_adjacent_meta_writes' => $third_party_adjacent_meta_writes,
		'side_effect_third_party_adjacent_meta_key_count' => count( $third_party_adjacent_meta_keys ),
		'side_effect_reentrant_save_post_product_count' => $reentrant_save_post_product_count,
		'side_effect_reentrant_save_post_product_unique_count' => count( array_unique( $reentrant_save_post_product_ids ) ),
		'side_effect_reentrant_save_post_product_variation_count' => $reentrant_save_post_variation_count,
		'side_effect_reentrant_save_post_product_variation_unique_count' => count( array_unique( $reentrant_save_post_variation_ids ) ),
		'side_effect_shared_product_data_store_loads' => $shared_product_data_store_loads,
		'side_effect_shared_variation_data_store_loads' => $shared_variation_data_store_loads,
		'side_effect_simple_duplicate_meta_row_count' => count( $simple_duplicate_meta_rows ),
		'side_effect_variation_duplicate_meta_row_count' => count( $variation_duplicate_meta_rows ),
		'side_effect_simple_internal_duplicate_meta_row_count' => $simple_internal_duplicate_meta_row_count,
		'side_effect_variation_internal_duplicate_meta_row_count' => $variation_internal_duplicate_meta_row_count,
		'side_effect_simple_internal_meta_value_mismatches' => array_sum( $simple_meta_value_mismatches ),
		'side_effect_variation_internal_meta_value_mismatches' => array_sum( $variation_meta_value_mismatches ),
		'side_effect_simple_sku_readback_mismatches' => $simple_sku_readback_mismatches,
		'side_effect_variation_sku_readback_mismatches' => $variation_sku_readback_mismatches,
		'side_effect_simple_sku_lookup_mismatches' => $simple_sku_lookup_mismatches,
		'side_effect_variation_sku_lookup_mismatches' => $variation_sku_lookup_mismatches,
		'side_effect_simple_manage_stock_readback_mismatches' => $simple_manage_stock_mismatches,
		'side_effect_simple_stock_readback_mismatches' => $simple_stock_mismatches,
		'side_effect_variation_manage_stock_readback_mismatches' => $variation_manage_stock_mismatches,
		'side_effect_simple_stock_status_readback_mismatches' => $simple_stock_status_mismatches,
		'side_effect_parent_child_count' => $parent_after ? count( $parent_after->get_children() ) : 0,
		'side_effect_parent_missing_child_count' => count( $missing_parent_child_ids ),
		'side_effect_variation_post_parent_mismatches' => $variation_post_parent_mismatches,
		'side_effect_variation_parent_mismatches' => $variation_parent_mismatches,
		'side_effect_variation_price_mismatches' => $variation_price_mismatches,
		'side_effect_variation_manage_stock_mismatches' => $variation_manage_stock_mismatches,
		'side_effect_variation_stock_mismatches' => $variation_stock_mismatches,
		'side_effect_variation_stock_status_mismatches' => $variation_stock_status_mismatches,
		'side_effect_simple_adjacent_meta_missing_count' => $simple_adjacent_meta_missing_count,
		'side_effect_variation_adjacent_meta_missing_count' => $variation_adjacent_meta_missing_count,
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
		'side_effect_attachment_posts_row_delta' => (int) ( $row_count_deltas['attachment_posts'] ?? 0 ),
		'side_effect_postmeta_row_delta' => (int) ( $row_count_deltas['postmeta'] ?? 0 ),
		'side_effect_attachment_postmeta_row_delta' => (int) ( $row_count_deltas['attachment_postmeta'] ?? 0 ),
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
						'media_image_mode'                             => $image_mode,
						'media_fixture_attachment_ids'                 => $media_attachment_ids,
						'expected_simple_image_ids'                    => $expected_simple_image_ids,
						'expected_simple_gallery_ids'                  => $expected_simple_gallery_ids,
						'expected_variation_image_ids'                 => $expected_variation_image_ids,
						'scenario_labels'                             => array(
							'reentrant_save_post_product_create_fanout',
							'reentrant_save_post_product_variation_create_fanout',
							'duplicate_meta_and_readback_correctness',
							'shared_product_and_variation_data_store_reuse',
							'preexisting_internal_meta_before_create_save_completes',
							'third_party_internal_meta_hook_adjacent_writes',
							'variation_parent_sync_under_reentrant_save',
							'duplicate_sku_retry_guardrail',
							'opt_in_media_image_readback_guardrail',
						),
						'reentrant_save_post_product_ids'              => array_values( array_unique( $reentrant_save_post_product_ids ) ),
						'reentrant_save_post_product_variation_ids'    => array_values( array_unique( $reentrant_save_post_variation_ids ) ),
						'preexisting_internal_meta_post_ids'           => array_values( array_unique( array_map( 'intval', $preexisting_internal_meta_post_ids ) ) ),
						'third_party_adjacent_meta_keys'               => $third_party_adjacent_meta_keys,
						'simple_meta_value_mismatches'                 => $simple_meta_value_mismatches,
						'variation_meta_value_mismatches'              => $variation_meta_value_mismatches,
						'missing_parent_child_ids'                     => $missing_parent_child_ids,
						'simple_duplicate_meta_rows'                   => $simple_duplicate_meta_rows,
						'variation_duplicate_meta_rows'                => $variation_duplicate_meta_rows,
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
			'image_mode'   => $image_mode,
		),
		'artifacts' => $artifact_path ? array( 'raw_result' => array( 'path' => $artifact_path, 'kind' => 'json' ) ) : array(),
	);
};
