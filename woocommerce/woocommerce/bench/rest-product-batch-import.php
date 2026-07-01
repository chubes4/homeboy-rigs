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

	$env_int = static function ( string $name, int $default ): int {
		$value = getenv( $name );
		return false === $value || '' === $value ? $default : (int) $value;
	};
	$batch_size       = max( 1, min( 100, $env_int( 'WC_REST_BATCH_IMPORT_ITEMS', 25 ) ) );
	$attribute_count  = max( 0, min( 10, $env_int( 'WC_REST_BATCH_IMPORT_ATTRIBUTES', 3 ) ) );
	$terms_per_attr   = max( 1, min( 50, $env_int( 'WC_REST_BATCH_IMPORT_TERMS_PER_ATTRIBUTE', 8 ) ) );
	$catalog_products = max( 0, min( 10000, $env_int( 'WC_REST_BATCH_IMPORT_CATALOG_PRODUCTS', 0 ) ) );
	$catalog_variations_per_product = max( 0, min( 100, $env_int( 'WC_REST_BATCH_IMPORT_CATALOG_VARIATIONS_PER_PRODUCT', 0 ) ) );
	$sku_shape        = (string) ( getenv( 'WC_REST_BATCH_IMPORT_SKU_SHAPE' ) ?: 'unique' );
	$slug_title_shape = (string) ( getenv( 'WC_REST_BATCH_IMPORT_SLUG_TITLE_SHAPE' ) ?: 'unique' );
	$term_mode        = (string) ( getenv( 'WC_REST_BATCH_IMPORT_TERM_MODE' ) ?: 'existing' );
	$allowed_sku_shapes = array( 'unique', 'prefix', 'catalog_duplicate_retry' );
	$allowed_slug_title_shapes = array( 'unique', 'prefix', 'collision' );
	$allowed_term_modes = array( 'existing', 'new', 'mixed' );
	if ( ! in_array( $sku_shape, $allowed_sku_shapes, true ) ) {
		$sku_shape = 'unique';
	}
	if ( ! in_array( $slug_title_shape, $allowed_slug_title_shapes, true ) ) {
		$slug_title_shape = 'unique';
	}
	if ( ! in_array( $term_mode, $allowed_term_modes, true ) ) {
		$term_mode = 'existing';
	}
	$image_mode       = strtolower( (string) ( getenv( 'WC_REST_BATCH_IMPORT_IMAGE_MODE' ) ?: 'none' ) );
	if ( ! in_array( $image_mode, array( 'none', 'existing_attachment', 'remote' ), true ) ) {
		throw new RuntimeException( 'Unsupported WC_REST_BATCH_IMPORT_IMAGE_MODE. Expected none, existing_attachment, or remote.' );
	}
	$image_count        = 'none' === $image_mode ? 0 : max( 1, min( 5, $env_int( 'WC_REST_BATCH_IMPORT_IMAGES_PER_PRODUCT', 1 ) ) );
	$gallery_count      = 'none' === $image_mode ? 0 : max( 0, min( 4, $env_int( 'WC_REST_BATCH_IMPORT_GALLERY_IMAGES_PER_PRODUCT', 0 ) ) );
	$remote_image_base  = rtrim( (string) ( getenv( 'WC_REST_BATCH_IMPORT_REMOTE_IMAGE_BASE' ) ?: '' ), '?' );
	if ( 'remote' === $image_mode && '' === $remote_image_base ) {
		throw new RuntimeException( 'Remote image import mode requires WC_REST_BATCH_IMPORT_REMOTE_IMAGE_BASE to point at a deterministic image endpoint.' );
	}
	$focus_phase      = (string) ( getenv( 'WC_REST_BATCH_IMPORT_FOCUS_PHASE' ) ?: 'variation_create' );
	$valid_focus_phases = array( 'simple_create', 'simple_update', 'grouped_create', 'variable_parent_create', 'variable_parent_update', 'variation_create', 'variation_update' );
	if ( ! in_array( $focus_phase, $valid_focus_phases, true ) ) {
		throw new RuntimeException( 'Invalid WC_REST_BATCH_IMPORT_FOCUS_PHASE: ' . $focus_phase );
	}
	$run_id           = 'woocommerce-rest-batch-import-' . getmypid() . '-' . time() . '-' . wp_generate_password( 6, false );
	$issues           = array(
		'https://github.com/woocommerce/woocommerce/issues/26029',
		'https://github.com/chubes4/homeboy-rigs/issues/247',
		'https://github.com/chubes4/homeboy-rigs/issues/248',
		'https://github.com/chubes4/homeboy-rigs/issues/227',
		'https://github.com/chubes4/homeboy-rigs/issues/228',
		'https://github.com/chubes4/homeboy-rigs/issues/229',
		'https://github.com/chubes4/homeboy-rigs/issues/245',
		'https://github.com/chubes4/homeboy-rigs/issues/246',
		'https://github.com/Extra-Chill/homeboy-extensions/issues/1298',
		'https://github.com/woocommerce/woocommerce/issues/65686',
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
	$product_term_pool = array();
	for ( $term_index = 1; $term_index <= max( 2, min( 10, $terms_per_attr ) ); $term_index++ ) {
		$term = wp_insert_term(
			'Homeboy Existing Catalog Term ' . $term_index . ' ' . $run_id,
			'product_cat',
			array( 'slug' => 'homeboy-existing-catalog-term-' . $term_index . '-' . $run_id )
		);
		if ( is_wp_error( $term ) ) {
			throw new RuntimeException( 'Failed to create product category pressure term: ' . $term->get_error_message() );
		}
		$product_term_pool[] = array(
			'id'   => (int) $term['term_id'],
			'name' => 'Homeboy Existing Catalog Term ' . $term_index . ' ' . $run_id,
		);
	}
	$make_product_attributes = static function () use ( $attribute_taxonomies ): array {
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
		return $product_attributes;
	};
	$sku_for = static function ( string $phase, int $index ) use ( $run_id, $sku_shape ): string {
		if ( 'prefix' === $sku_shape ) {
			return 'hb-prefix-heavy-' . $phase . '-' . $run_id . '-' . str_pad( (string) ( $index + 1 ), 6, '0', STR_PAD_LEFT );
		}
		return 'homeboy-rest-' . $phase . '-' . $run_id . '-' . ( $index + 1 );
	};
	$name_for = static function ( string $type, int $index ) use ( $run_id, $slug_title_shape ): string {
		if ( 'collision' === $slug_title_shape ) {
			return 'Homeboy REST Collision Product ' . $run_id;
		}
		if ( 'prefix' === $slug_title_shape ) {
			return 'Homeboy REST Shared Prefix Product ' . $run_id . ' ' . str_pad( (string) ( $index + 1 ), 6, '0', STR_PAD_LEFT );
		}
		return 'Homeboy REST ' . ucfirst( $type ) . ' Product ' . $run_id . ' #' . ( $index + 1 );
	};
	$slug_for = static function ( string $type, int $index ) use ( $run_id, $slug_title_shape ): string {
		if ( 'collision' === $slug_title_shape ) {
			return 'homeboy-rest-collision-' . $run_id;
		}
		if ( 'prefix' === $slug_title_shape ) {
			return 'homeboy-rest-shared-prefix-' . $run_id . '-' . str_pad( (string) ( $index + 1 ), 6, '0', STR_PAD_LEFT );
		}
		return 'homeboy-rest-' . $type . '-' . $run_id . '-' . ( $index + 1 );
	};
	$terms_for = static function ( int $index ) use ( $product_term_pool, $term_mode, $run_id ): array {
		if ( 'new' === $term_mode || ( 'mixed' === $term_mode && 1 === $index % 2 ) ) {
			return array(
				array(
					'name' => 'Homeboy New REST Term ' . $run_id . ' #' . ( $index + 1 ),
				),
			);
		}

		$term = $product_term_pool[ $index % count( $product_term_pool ) ];
		return array(
			array(
				'id' => (int) $term['id'],
			),
		);
	};

	$catalog_seed_started = microtime( true );
	$catalog_seed_variations = 0;
	$catalog_seed_skus       = array();
	for ( $i = 0; $i < $catalog_products; $i++ ) {
		$product = $catalog_variations_per_product > 0 ? new WC_Product_Variable() : new WC_Product_Simple();
		$product->set_name( 'Homeboy Existing Catalog Product ' . $run_id . ' #' . ( $i + 1 ) );
		$product->set_slug( 'homeboy-existing-catalog-' . $run_id . '-' . ( $i + 1 ) );
		$product->set_status( 'publish' );
		$product->set_sku( 'homeboy-existing-catalog-' . $run_id . '-' . ( $i + 1 ) );
		$product->set_regular_price( '10' );
		$product->set_price( '10' );
		$product->set_manage_stock( true );
		$product->set_stock_quantity( 10 );
		$product->set_stock_status( 'instock' );
		if ( $catalog_variations_per_product > 0 ) {
			$product->set_attributes( $make_product_attributes() );
		}
		$product->save();
		$catalog_seed_skus[] = $product->get_sku();
		if ( $catalog_variations_per_product > 0 ) {
			for ( $variation_index = 0; $variation_index < $catalog_variations_per_product; $variation_index++ ) {
				$variation = new WC_Product_Variation();
				$variation->set_parent_id( $product->get_id() );
				$variation->set_status( 'publish' );
				$variation->set_sku( 'homeboy-existing-catalog-' . $run_id . '-' . ( $i + 1 ) . '-variation-' . ( $variation_index + 1 ) );
				$variation->set_regular_price( '10' );
				$variation->set_price( '10' );
				$variation->set_manage_stock( true );
				$variation->set_stock_quantity( 10 );
				$variation->set_stock_status( 'instock' );
				$variation_attributes = array();
				foreach ( $attribute_taxonomies as $attribute_index => $attribute_taxonomy ) {
					$term = $attribute_taxonomy['terms'][ ( $variation_index + $attribute_index ) % count( $attribute_taxonomy['terms'] ) ];
					$variation_attributes[ $attribute_taxonomy['taxonomy'] ] = $term['slug'];
				}
				$variation->set_attributes( $variation_attributes );
				$variation->save();
				++$catalog_seed_variations;
			}
		}
	}
	$catalog_seed_ms = ( microtime( true ) - $catalog_seed_started ) * 1000;

	$variable_parent_attributes = array();
	foreach ( $attribute_taxonomies as $attribute_taxonomy ) {
		$variable_parent_attributes[] = array(
			'id'        => $attribute_taxonomy['id'],
			'visible'   => true,
			'variation' => true,
			'options'   => wp_list_pluck( $attribute_taxonomy['terms'], 'name' ),
		);
	}
	$parent_id = 0;

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
	$active_phase_profile = null;
	$active_phase_stack   = array();
	$profile_phase_current = static function () use ( &$active_phase_stack ): string {
		$active_phase = end( $active_phase_stack );
		return is_array( $active_phase ) ? (string) $active_phase['phase'] : 'outside_dispatch';
	};
	$profile_phase_enter = static function ( string $phase ) use ( &$active_phase_profile, &$active_phase_stack ): void {
		if ( null === $active_phase_profile ) {
			return;
		}

		$active_phase_stack[] = array(
			'phase'      => $phase,
			'started_at' => microtime( true ),
		);
		$active_phase_profile['spans'][ $phase ]['count'] = ( $active_phase_profile['spans'][ $phase ]['count'] ?? 0 ) + 1;
	};
	$profile_phase_exit = static function ( string $phase ) use ( &$active_phase_profile, &$active_phase_stack ): void {
		if ( null === $active_phase_profile ) {
			return;
		}

		$span = array_pop( $active_phase_stack );
		if ( ! is_array( $span ) || $phase !== (string) $span['phase'] ) {
			return;
		}

		$active_phase_profile['spans'][ $phase ]['elapsed_ms'] = ( $active_phase_profile['spans'][ $phase ]['elapsed_ms'] ?? 0 ) + ( ( microtime( true ) - (float) $span['started_at'] ) * 1000 );
	};
	$profile_phase_event = static function ( string $event ) use ( &$active_phase_profile, $profile_phase_current ): void {
		if ( null === $active_phase_profile ) {
			return;
		}

		$phase = $profile_phase_current();
		$active_phase_profile['events'][ $phase ][ $event ] = ( $active_phase_profile['events'][ $phase ][ $event ] ?? 0 ) + 1;
	};
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
	$profile_query        = static function ( string $query ) use ( &$active_query_profile, $wpdb, $profile_phase_current ): void {
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
		$profile_phase = $profile_phase_current();
		$active_query_profile['phase_queries'][ $profile_phase ] = ( $active_query_profile['phase_queries'][ $profile_phase ] ?? 0 ) + 1;
		foreach ( $tables as $table ) {
			$table_key = str_replace( $wpdb->prefix, '', $table );
			$active_query_profile['tables'][ $table_key ] = ( $active_query_profile['tables'][ $table_key ] ?? 0 ) + 1;
			$operation_table = $operation . ':' . $table_key;
			$active_query_profile['operation_tables'][ $operation_table ] = ( $active_query_profile['operation_tables'][ $operation_table ] ?? 0 ) + 1;
			$active_query_profile['phase_operation_tables'][ $profile_phase ][ $operation_table ] = ( $active_query_profile['phase_operation_tables'][ $profile_phase ][ $operation_table ] ?? 0 ) + 1;
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
		$active_query_profile['phase_categories'][ $profile_phase ][ $category ] = ( $active_query_profile['phase_categories'][ $profile_phase ][ $category ] ?? 0 ) + 1;

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
	$grouped_guardrail_meta_keys        = array( '_sku' );
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

	add_action( 'woocommerce_before_product_object_save', static function () use ( $profile_phase_enter ): void { $profile_phase_enter( 'product_save' ); }, 1 );
	add_action( 'woocommerce_after_product_object_save', static function () use ( $profile_phase_exit ): void { $profile_phase_exit( 'product_save' ); }, PHP_INT_MAX );
	add_action( 'woocommerce_delete_product_transients', static function () use ( &$counters, $profile_phase_event ): void { ++$counters['product_transient_clears']; $profile_phase_event( 'transient_invalidation' ); } );
	add_action( 'woocommerce_rest_insert_product_object', static function () use ( &$counters, $profile_phase_event ): void { ++$counters['rest_product_inserts']; $profile_phase_event( 'rest_insert_product_object' ); } );
	add_action( 'woocommerce_new_product', static function () use ( &$counters, $profile_phase_event ): void { ++$counters['new_products']; $profile_phase_event( 'new_product' ); } );
	add_action( 'woocommerce_update_product', static function () use ( &$counters, $profile_phase_event ): void { ++$counters['updated_products']; $profile_phase_event( 'update_product' ); } );
	add_action( 'woocommerce_new_product_variation', static function () use ( &$counters, $profile_phase_event ): void { ++$counters['new_variations']; $profile_phase_event( 'new_product_variation' ); } );
	add_action( 'woocommerce_update_product_variation', static function () use ( &$counters, $profile_phase_event ): void { ++$counters['updated_variations']; $profile_phase_event( 'update_product_variation' ); } );
	add_action( 'woocommerce_variable_product_sync', static function () use ( &$counters, $profile_phase_event ): void { ++$counters['variable_product_syncs']; $profile_phase_event( 'variable_product_sync' ); } );
	add_action(
		'added_post_meta',
		static function ( $meta_id, $post_id, $meta_key ) use ( &$counters, &$meta_hook_counts, $profile_phase_event ): void {
			++$counters['added_post_meta'];
			$meta_hook_counts['added'][ $meta_key ] = ( $meta_hook_counts['added'][ $meta_key ] ?? 0 ) + 1;
			$profile_phase_event( 'added_post_meta' );
		},
		10,
		3
	);
	add_action(
		'updated_post_meta',
		static function ( $meta_id, $post_id, $meta_key ) use ( &$counters, &$meta_hook_counts, $profile_phase_event ): void {
			++$counters['updated_post_meta'];
			$meta_hook_counts['updated'][ $meta_key ] = ( $meta_hook_counts['updated'][ $meta_key ] ?? 0 ) + 1;
			$profile_phase_event( 'updated_post_meta' );
		},
		10,
		3
	);
	add_action(
		'deleted_post_meta',
		static function ( $meta_ids, $post_id, $meta_key ) use ( &$counters, &$meta_hook_counts, $profile_phase_event ): void {
			$counters['deleted_post_meta'] += is_array( $meta_ids ) ? count( $meta_ids ) : 1;
			$meta_hook_counts['deleted'][ $meta_key ] = ( $meta_hook_counts['deleted'][ $meta_key ] ?? 0 ) + ( is_array( $meta_ids ) ? count( $meta_ids ) : 1 );
			$profile_phase_event( 'deleted_post_meta' );
		},
		10,
		3
	);
	add_action( 'save_post_product', static function () use ( &$counters, $profile_phase_event ): void { ++$counters['save_post_product']; $profile_phase_event( 'save_post_product' ); } );
	add_action( 'save_post_product_variation', static function () use ( &$counters, $profile_phase_event ): void { ++$counters['save_post_product_variation']; $profile_phase_event( 'save_post_product_variation' ); } );
	add_action( 'clean_post_cache', static function () use ( &$counters, $profile_phase_event ): void { ++$counters['clean_post_cache']; $profile_phase_event( 'clean_post_cache' ); } );
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

	$dispatch_batch = static function ( string $route, array $payload ) use ( $wpdb, &$counters, &$meta_hook_counts, &$active_query_profile, &$active_http_profile, &$active_phase_profile, &$active_phase_stack, $profile_phase_enter, $profile_phase_exit ): array {
		$counter_before       = $counters;
		$meta_hook_before     = $meta_hook_counts;
		$query_before         = (int) $wpdb->num_queries;
		$active_phase_stack   = array();
		$active_query_profile = array(
			'operations'       => array_fill_keys( array( 'select', 'insert', 'update', 'delete', 'replace', 'other' ), 0 ),
			'tables'           => array(),
			'operation_tables' => array(),
			'categories'       => array(),
			'details'          => array(),
			'option_names'     => array(),
			'meta_keys'        => array(),
			'meta_key_operations' => array(),
			'phase_queries'    => array(),
			'phase_categories' => array(),
			'phase_operation_tables' => array(),
			'signatures'       => array(),
		);
		$active_http_profile  = array(
			'request_count' => 0,
			'hosts'         => array(),
		);
		$active_phase_profile = array(
			'spans'  => array(),
			'events' => array(),
		);
		$request              = new WP_REST_Request( 'POST', $route );
		$request->set_header( 'Content-Type', 'application/json' );
		$request->set_body_params( $payload );
		$started  = microtime( true );
		$profile_phase_enter( 'rest_dispatch' );
		$response = rest_get_server()->dispatch( $request );
		$profile_phase_exit( 'rest_dispatch' );
		$elapsed  = ( microtime( true ) - $started ) * 1000;
		$query_profile = $active_query_profile;
		$http_profile  = $active_http_profile;
		$phase_profile = $active_phase_profile;
		$active_query_profile = null;
		$active_http_profile  = null;
		$active_phase_profile = null;
		$active_phase_stack   = array();
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
		arsort( $query_profile['phase_queries'] );
		arsort( $query_profile['signatures'] );
		arsort( $http_profile['hosts'] );
		foreach ( $query_profile['phase_categories'] as &$phase_categories ) {
			arsort( $phase_categories );
			$phase_categories = array_slice( $phase_categories, 0, 30, true );
		}
		unset( $phase_categories );
		foreach ( $query_profile['phase_operation_tables'] as &$phase_operation_tables ) {
			arsort( $phase_operation_tables );
			$phase_operation_tables = array_slice( $phase_operation_tables, 0, 30, true );
		}
		unset( $phase_operation_tables );
		$query_profile['tables']           = array_slice( $query_profile['tables'], 0, 20, true );
		$query_profile['operation_tables'] = array_slice( $query_profile['operation_tables'], 0, 30, true );
		$query_profile['categories']       = array_slice( $query_profile['categories'], 0, 30, true );
		$query_profile['details']          = array_slice( $query_profile['details'], 0, 60, true );
		$query_profile['option_names']     = array_slice( $query_profile['option_names'], 0, 30, true );
		$query_profile['meta_keys']        = array_slice( $query_profile['meta_keys'], 0, 30, true );
		$query_profile['meta_key_operations'] = array_slice( $query_profile['meta_key_operations'], 0, 40, true );
		$query_profile['phase_queries']    = array_slice( $query_profile['phase_queries'], 0, 20, true );
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
			'phase_profile' => $phase_profile,
			'http_profile'  => $http_profile,
			'data'          => $data,
		);
	};

	$product_attribute_payload = array();
	foreach ( $attribute_taxonomies as $attribute_taxonomy ) {
		$product_attribute_payload[] = array(
			'id'      => $attribute_taxonomy['id'],
			'visible' => true,
			'options' => wp_list_pluck( $attribute_taxonomy['terms'], 'name' ),
		);
	}

	$variable_parent_create_result = $dispatch_batch(
		'/wc/v3/products/batch',
		array(
			'create' => array(
				array(
					'name'       => 'Homeboy REST Variable Parent ' . $run_id,
					'type'       => 'variable',
					'sku'        => 'homeboy-rest-variable-parent-' . $run_id,
					'attributes' => $variable_parent_attributes,
				),
			),
		)
	);
	$variable_parent_ids           = wp_list_pluck( (array) ( $variable_parent_create_result['data']['create'] ?? array() ), 'id' );
	$parent_id                     = (int) ( $variable_parent_ids[0] ?? 0 );
	if ( ! $parent_id ) {
		throw new RuntimeException( 'REST variable parent product create did not return an ID: ' . wp_json_encode( $variable_parent_create_result['data'] ) );
	}
	$variable_parent_update_result = $dispatch_batch(
		'/wc/v3/products/batch',
		array(
			'update' => array(
				array(
					'id'          => $parent_id,
					'description' => 'Updated variable parent for REST batch import coverage ' . $run_id,
					'attributes'  => $variable_parent_attributes,
				),
			),
		)
	);

	$simple_create = array();
	for ( $i = 0; $i < $batch_size; $i++ ) {
		$product_payload = array(
			'name'          => $name_for( 'simple', $i ),
			'type'          => 'simple',
			'slug'          => $slug_for( 'simple', $i ),
			'sku'           => $sku_for( 'simple', $i ),
			'regular_price' => (string) ( 10 + $i ),
			'manage_stock'  => true,
			'stock_quantity' => 10 + $i,
			'categories'    => $terms_for( $i ),
		);
		if ( ! empty( $product_attribute_payload ) ) {
			$product_payload['attributes'] = $product_attribute_payload;
		}
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

	$grouped_create = array();
	for ( $i = 0; $i < $batch_size; $i++ ) {
		$grouped_create[] = array(
			'name'             => $name_for( 'grouped', $i ),
			'type'             => 'grouped',
			'slug'             => $slug_for( 'grouped', $i ),
			'sku'              => $sku_for( 'grouped', $i ),
			'grouped_products' => array_values( array_map( 'intval', $simple_ids ) ),
			'categories'       => $terms_for( $i ),
		);
	}
	$grouped_create_result = $dispatch_batch( '/wc/v3/products/batch', array( 'create' => $grouped_create ) );
	$grouped_ids           = wp_list_pluck( (array) ( $grouped_create_result['data']['create'] ?? array() ), 'id' );

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
			'sku'           => $sku_for( 'variation', $i ),
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

	$shutdown_deferral_probe = array(
		'enabled'                              => 0,
		'parent_id'                            => 0,
		'existing_variation_id'                => 0,
		'new_variation_id'                     => 0,
		'new_variation_price'                  => '66',
		'children_transient_warmed'            => 0,
		'children_transient_stale_before_shutdown' => 0,
		'product_sync_shutdown_priority'       => null,
		'deferrer_shutdown_priority'           => null,
		'simulated_order'                      => '',
		'parent_price_rows_after_shutdown'      => array(),
		'parent_price_includes_new_variation'   => 0,
	);
	if ( class_exists( Automattic\WooCommerce\Internal\Caches\ProductTransientsDeferrer::class ) ) {
		$shutdown_deferral_probe['enabled'] = 1;
		$probe_parent                       = new WC_Product_Variable();
		$probe_parent->set_name( 'Homeboy Shutdown Deferral Parent ' . $run_id );
		$probe_parent->set_sku( 'homeboy-shutdown-deferral-parent-' . $run_id );
		$probe_parent_id = (int) $probe_parent->save();

		$probe_existing_variation = new WC_Product_Variation();
		$probe_existing_variation->set_parent_id( $probe_parent_id );
		$probe_existing_variation->set_regular_price( '11' );
		$probe_existing_variation->set_status( 'publish' );
		$probe_existing_variation_id = (int) $probe_existing_variation->save();

		$probe_parent = wc_get_product( $probe_parent_id );
		if ( $probe_parent instanceof WC_Product_Variable ) {
			$probe_parent->get_visible_children();
		}

		$children_transient_name = 'wc_product_children_' . $probe_parent_id;
		$shutdown_deferral_probe['parent_id']                 = $probe_parent_id;
		$shutdown_deferral_probe['existing_variation_id']     = $probe_existing_variation_id;
		$shutdown_deferral_probe['children_transient_warmed'] = false === get_transient( $children_transient_name ) ? 0 : 1;

		$transients_deferrer = wc_get_container()->get( Automattic\WooCommerce\Internal\Caches\ProductTransientsDeferrer::class );
		$transients_deferrer->start_deferring();

		$probe_new_variation = new WC_Product_Variation();
		$probe_new_variation->set_parent_id( $probe_parent_id );
		$probe_new_variation->set_regular_price( $shutdown_deferral_probe['new_variation_price'] );
		$probe_new_variation->set_status( 'publish' );
		$probe_new_variation_id = (int) $probe_new_variation->save();

		$shutdown_deferral_probe['new_variation_id'] = $probe_new_variation_id;
		$shutdown_deferral_probe['children_transient_stale_before_shutdown'] = false === get_transient( $children_transient_name ) ? 0 : 1;
		$shutdown_deferral_probe['product_sync_shutdown_priority'] = has_action( 'shutdown', array( 'WC_Post_Data', 'do_deferred_product_sync' ) );
		$shutdown_deferral_probe['deferrer_shutdown_priority']     = has_action( 'shutdown', array( $transients_deferrer, 'handle_shutdown' ) );

		$product_sync_priority = false === $shutdown_deferral_probe['product_sync_shutdown_priority'] ? PHP_INT_MAX : (int) $shutdown_deferral_probe['product_sync_shutdown_priority'];
		$deferrer_priority     = false === $shutdown_deferral_probe['deferrer_shutdown_priority'] ? PHP_INT_MAX : (int) $shutdown_deferral_probe['deferrer_shutdown_priority'];
		if ( $deferrer_priority < $product_sync_priority ) {
			$shutdown_deferral_probe['simulated_order'] = 'deferrer_before_product_sync';
			$transients_deferrer->handle_shutdown();
			WC_Post_Data::do_deferred_product_sync();
		} else {
			$shutdown_deferral_probe['simulated_order'] = 'product_sync_before_deferrer';
			WC_Post_Data::do_deferred_product_sync();
			$transients_deferrer->handle_shutdown();
		}
		remove_action( 'shutdown', array( $transients_deferrer, 'handle_shutdown' ) );

		$parent_price_rows = array_map( 'strval', get_post_meta( $probe_parent_id, '_price', false ) );
		$shutdown_deferral_probe['parent_price_rows_after_shutdown']    = $parent_price_rows;
		$shutdown_deferral_probe['parent_price_includes_new_variation'] = in_array( $shutdown_deferral_probe['new_variation_price'], $parent_price_rows, true ) ? 1 : 0;
	}

	$retry_duplicate_sku_product_id       = (int) ( $simple_ids[0] ?? 0 );
	$retry_duplicate_sku                  = $retry_duplicate_sku_product_id ? $sku_for( 'simple', 0 ) : '';
	if ( 'catalog_duplicate_retry' === $sku_shape && ! empty( $catalog_seed_skus ) ) {
		$retry_duplicate_sku_product_id = (int) wc_get_product_id_by_sku( (string) $catalog_seed_skus[0] );
		$retry_duplicate_sku            = (string) $catalog_seed_skus[0];
	}
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
			if ( is_wp_error( $item ) || is_object( $item ) || ! is_array( $item ) || isset( $item['error'] ) || ! isset( $item['id'] ) || isset( $item['code'], $item['message'] ) ) {
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
		$meta_rows    = $wpdb->get_results(
			$wpdb->prepare(
				"SELECT post_id, meta_key, meta_value FROM {$wpdb->postmeta} WHERE post_id IN ($placeholders) ORDER BY post_id ASC, meta_key ASC, meta_id ASC", // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared
				$product_ids
			),
			ARRAY_A
		);
		$groups       = array();
		foreach ( $meta_rows as $row ) {
			$key = (int) $row['post_id'] . ':' . (string) $row['meta_key'];
			if ( ! isset( $groups[ $key ] ) ) {
				$groups[ $key ] = array(
					'post_id'     => (int) $row['post_id'],
					'meta_key'    => (string) $row['meta_key'],
					'values_seen' => array(),
				);
			}
			$groups[ $key ]['values_seen'][] = (string) $row['meta_value'];
		}

		$rows = array();
		foreach ( $groups as $group ) {
			$row_count = count( $group['values_seen'] );
			if ( $row_count > 1 ) {
				$rows[] = array(
					'post_id'     => $group['post_id'],
					'meta_key'    => $group['meta_key'],
					'row_count'   => $row_count,
					'values_seen' => implode( ' | ', $group['values_seen'] ),
				);
			}
		}

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

	$variation_products      = array_filter( array_map( 'wc_get_product', array_map( 'intval', $variation_ids ) ) );
	$simple_products         = array_filter( array_map( 'wc_get_product', array_map( 'intval', $simple_ids ) ) );
	$grouped_products        = array_filter( array_map( 'wc_get_product', array_map( 'intval', $grouped_ids ) ) );
	$variable_parent_product = wc_get_product( $parent_id );
	$parent_after            = $variable_parent_product;
	$active_plugins          = array_values( array_map( 'strval', (array) get_option( 'active_plugins', array() ) ) );
	sort( $active_plugins );
	$count_string_duplicates = static function ( array $values ): int {
		$values = array_values( array_filter( array_map( 'strval', $values ), static fn( string $value ): bool => '' !== $value ) );
		return count( $values ) - count( array_unique( $values ) );
	};
	$requested_simple_slugs = array_map( static fn( array $payload ): string => (string) ( $payload['slug'] ?? '' ), $simple_create );
	$actual_simple_slugs    = array_map( static fn( $product ): string => $product instanceof WC_Product ? (string) $product->get_slug() : '', $simple_products );
	$requested_new_term_count = 0;
	$requested_existing_term_count = 0;
	foreach ( $simple_create as $payload ) {
		foreach ( (array) ( $payload['categories'] ?? array() ) as $category ) {
			if ( isset( $category['id'] ) ) {
				++$requested_existing_term_count;
			} else {
				++$requested_new_term_count;
			}
		}
	}
	$expected_simple_skus          = array();
	$expected_grouped_skus         = array();
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
		$expected_simple_skus[ (int) $simple_id ]          = $sku_for( 'simple', $index );
		$expected_simple_regular_price[ (int) $simple_id ] = (string) ( 20 + $index );
		$expected_simple_price[ (int) $simple_id ]         = (string) ( 20 + $index );
		$expected_simple_stock[ (int) $simple_id ]         = (string) ( 20 + $index );
		$expected_image_ids                                = $response_simple_images[ (int) $simple_id ] ?? array();
		$expected_simple_image_ids[ (int) $simple_id ]     = (int) ( $expected_image_ids[0] ?? 0 );
		$expected_simple_gallery_ids[ (int) $simple_id ]   = array_values( array_slice( array_map( 'intval', $expected_image_ids ), 1 ) );
	}
	foreach ( $grouped_ids as $index => $grouped_id ) {
		$expected_grouped_skus[ (int) $grouped_id ] = $sku_for( 'grouped', $index );
	}
	$expected_variation_prices = array();
	$expected_variation_stock  = array();
	$expected_variation_skus   = array();
	$expected_variation_image_ids = array();
	foreach ( $variation_ids as $index => $variation_id ) {
		$expected_variation_prices[ (int) $variation_id ] = (string) ( 40 + $index );
		$expected_variation_stock[ (int) $variation_id ]  = 40 + $index;
		$expected_variation_skus[ (int) $variation_id ]   = $sku_for( 'variation', $index );
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
	$grouped_sku_readback_mismatches = 0;
	$grouped_type_mismatches         = 0;
	$grouped_child_mismatches        = 0;
	$variation_stock_status_mismatches = 0;
	$variation_image_readback_mismatches = 0;
	$variable_parent_attribute_missing = 0;
	$variable_parent_type_mismatch     = ( $variable_parent_product instanceof WC_Product_Variable ) ? 0 : 1;
	if ( $variable_parent_product instanceof WC_Product_Variable ) {
		foreach ( $attribute_taxonomies as $attribute_taxonomy ) {
			$attributes = $variable_parent_product->get_attributes();
			if ( ! isset( $attributes[ $attribute_taxonomy['taxonomy'] ] ) ) {
				++$variable_parent_attribute_missing;
			}
		}
	}
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
	$expected_grouped_children = array_values( array_map( 'intval', $simple_ids ) );
	sort( $expected_grouped_children );
	foreach ( $grouped_products as $grouped_product ) {
		$grouped_id = $grouped_product->get_id();
		if ( ! $grouped_product instanceof WC_Product_Grouped ) {
			++$grouped_type_mismatches;
		}
		if ( (string) $grouped_product->get_sku() !== (string) ( $expected_grouped_skus[ $grouped_id ] ?? '' ) ) {
			++$grouped_sku_readback_mismatches;
		}
		$actual_children = array_values( array_map( 'intval', $grouped_product->get_children() ) );
		sort( $actual_children );
		if ( $actual_children !== $expected_grouped_children ) {
			++$grouped_child_mismatches;
		}
	}
	$simple_duplicate_meta_rows    = $get_duplicate_postmeta_rows( $simple_ids );
	$grouped_duplicate_meta_rows   = $get_duplicate_postmeta_rows( $grouped_ids );
	$variation_duplicate_meta_rows = $get_duplicate_postmeta_rows( $variation_ids );
	$simple_internal_duplicate_meta_row_count    = $count_duplicate_postmeta_rows_for_keys( $simple_duplicate_meta_rows, $internal_guardrail_meta_keys );
	$grouped_internal_duplicate_meta_row_count   = $count_duplicate_postmeta_rows_for_keys( $grouped_duplicate_meta_rows, $grouped_guardrail_meta_keys );
	$variation_internal_duplicate_meta_row_count = $count_duplicate_postmeta_rows_for_keys( $variation_duplicate_meta_rows, $internal_guardrail_meta_keys );
	$simple_sku_lookup_mismatches                = $count_sku_lookup_mismatches( $simple_ids, $expected_simple_skus );
	$grouped_sku_lookup_mismatches               = $count_sku_lookup_mismatches( $grouped_ids, $expected_grouped_skus );
	$variation_sku_lookup_mismatches             = $count_sku_lookup_mismatches( $variation_ids, $expected_variation_skus );
	$simple_adjacent_meta_missing_count          = $count_adjacent_meta_missing( $simple_ids, $internal_guardrail_meta_keys );
	$grouped_adjacent_meta_missing_count         = $count_adjacent_meta_missing( $grouped_ids, $grouped_guardrail_meta_keys );
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
	$record_invariant( 'variable_parent_create_response_has_no_errors', 0 === $count_response_errors( (array) ( $variable_parent_create_result['data']['create'] ?? array() ) ) );
	$record_invariant( 'variable_parent_update_response_has_no_errors', 0 === $count_response_errors( (array) ( $variable_parent_update_result['data']['update'] ?? array() ) ) );
	$record_invariant( 'simple_create_response_has_no_errors', 0 === $count_response_errors( (array) ( $simple_create_result['data']['create'] ?? array() ) ) );
	$record_invariant( 'simple_update_response_has_no_errors', 0 === $count_response_errors( (array) ( $simple_update_result['data']['update'] ?? array() ) ) );
	$record_invariant( 'grouped_create_response_has_no_errors', 0 === $count_response_errors( (array) ( $grouped_create_result['data']['create'] ?? array() ) ) );
	$record_invariant( 'variation_create_response_has_no_errors', 0 === $count_response_errors( (array) ( $variation_create_result['data']['create'] ?? array() ) ) );
	$record_invariant( 'variation_update_response_has_no_errors', 0 === $count_response_errors( (array) ( $variation_update_result['data']['update'] ?? array() ) ) );
	$record_invariant( 'variable_parent_created_count_matches_batch', count( $variable_parent_ids ) === 1, array( 'expected' => 1, 'actual' => count( $variable_parent_ids ) ) );
	$record_invariant( 'variable_parent_loaded_as_variable_product', 0 === $variable_parent_type_mismatch, array( 'product_id' => $parent_id ) );
	$record_invariant( 'variable_parent_attributes_match_payload', 0 === $variable_parent_attribute_missing, array( 'missing' => $variable_parent_attribute_missing ) );
	$record_invariant( 'simple_created_count_matches_batch', count( $simple_ids ) === $batch_size, array( 'expected' => $batch_size, 'actual' => count( $simple_ids ) ) );
	$record_invariant( 'grouped_created_count_matches_batch', count( $grouped_ids ) === $batch_size, array( 'expected' => $batch_size, 'actual' => count( $grouped_ids ) ) );
	$record_invariant( 'variation_created_count_matches_batch', count( $variation_ids ) === $batch_size, array( 'expected' => $batch_size, 'actual' => count( $variation_ids ) ) );
	$record_invariant( 'simple_loaded_count_matches_batch', count( $simple_products ) === $batch_size, array( 'expected' => $batch_size, 'actual' => count( $simple_products ) ) );
	$record_invariant( 'grouped_loaded_count_matches_batch', count( $grouped_products ) === $batch_size, array( 'expected' => $batch_size, 'actual' => count( $grouped_products ) ) );
	$record_invariant( 'variation_loaded_count_matches_batch', count( $variation_products ) === $batch_size, array( 'expected' => $batch_size, 'actual' => count( $variation_products ) ) );
	$record_invariant( 'grouped_products_load_as_grouped_type', 0 === $grouped_type_mismatches, array( 'mismatches' => $grouped_type_mismatches ) );
	$record_invariant( 'grouped_products_reference_created_simple_products', 0 === $grouped_child_mismatches, array( 'mismatches' => $grouped_child_mismatches, 'expected_children' => $expected_grouped_children ) );
	$record_invariant( 'parent_child_count_matches_batch', ( $parent_after ? count( $parent_after->get_children() ) : 0 ) === $batch_size, array( 'expected' => $batch_size, 'actual' => $parent_after ? count( $parent_after->get_children() ) : 0 ) );
	$record_invariant( 'variation_parent_ids_match', 0 === $variation_parent_mismatches, array( 'mismatches' => $variation_parent_mismatches ) );
	$record_invariant( 'variation_prices_match_update_payload', 0 === $variation_price_mismatches, array( 'mismatches' => $variation_price_mismatches ) );
	$record_invariant( 'variation_stock_matches_update_payload', 0 === $variation_stock_mismatches, array( 'mismatches' => $variation_stock_mismatches ) );
	$record_invariant( 'variation_manage_stock_readback_matches_payload_after_reentrant_save', 0 === $variation_manage_stock_mismatches, array( 'mismatches' => $variation_manage_stock_mismatches ) );
	$record_invariant( 'preexisting_simple_internal_meta_is_overwritten', 0 === array_sum( $simple_meta_value_mismatches ), array( 'mismatches' => $simple_meta_value_mismatches ) );
	$record_invariant( 'variation_internal_meta_values_are_canonical', 0 === array_sum( $variation_meta_value_mismatches ), array( 'mismatches' => $variation_meta_value_mismatches ) );
	$record_invariant( 'simple_sku_readback_matches_payload_after_reentrant_save', 0 === $simple_sku_readback_mismatches, array( 'mismatches' => $simple_sku_readback_mismatches ) );
	$record_invariant( 'grouped_sku_readback_matches_payload_after_reentrant_save', 0 === $grouped_sku_readback_mismatches, array( 'mismatches' => $grouped_sku_readback_mismatches ) );
	$record_invariant( 'variation_sku_readback_matches_payload', 0 === $variation_sku_readback_mismatches, array( 'mismatches' => $variation_sku_readback_mismatches ) );
	$record_invariant( 'simple_sku_lookup_resolves_created_product', 0 === $simple_sku_lookup_mismatches, array( 'mismatches' => $simple_sku_lookup_mismatches ) );
	$record_invariant( 'grouped_sku_lookup_resolves_created_product', 0 === $grouped_sku_lookup_mismatches, array( 'mismatches' => $grouped_sku_lookup_mismatches ) );
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
	$record_invariant( 'grouped_internal_meta_duplicate_rows_stay_bounded', 0 === $grouped_internal_duplicate_meta_row_count, array( 'duplicates' => $grouped_internal_duplicate_meta_row_count ) );
	$record_invariant( 'variation_internal_meta_duplicate_rows_stay_bounded', 0 === $variation_internal_duplicate_meta_row_count, array( 'duplicates' => $variation_internal_duplicate_meta_row_count ) );
	$record_invariant( 'third_party_adjacent_meta_hooks_fired', $third_party_adjacent_meta_writes > 0, array( 'writes' => $third_party_adjacent_meta_writes ) );
	$record_invariant( 'third_party_adjacent_meta_exists_for_simple_products', 0 === $simple_adjacent_meta_missing_count, array( 'missing' => $simple_adjacent_meta_missing_count ) );
	$record_invariant( 'third_party_adjacent_meta_exists_for_grouped_products', 0 === $grouped_adjacent_meta_missing_count, array( 'missing' => $grouped_adjacent_meta_missing_count ) );
	$record_invariant( 'third_party_adjacent_meta_exists_for_variations', 0 === $variation_adjacent_meta_missing_count, array( 'missing' => $variation_adjacent_meta_missing_count ) );
	$record_invariant( 'shared_product_data_store_was_reused', $shared_product_data_store_loads > 1, array( 'loads' => $shared_product_data_store_loads, 'class' => is_object( $shared_product_data_store ) ? get_class( $shared_product_data_store ) : '' ) );
	$record_invariant( 'shared_variation_data_store_was_reused', $shared_variation_data_store_loads > 1, array( 'loads' => $shared_variation_data_store_loads, 'class' => is_object( $shared_variation_data_store ) ? get_class( $shared_variation_data_store ) : '' ) );
	$record_invariant( 'variation_attributes_are_present', 0 === $variation_attribute_empty_count, array( 'empty_attribute_count' => $variation_attribute_empty_count ) );
	$record_invariant( 'variation_parent_children_include_all_created_variations', empty( $missing_parent_child_ids ), array( 'missing_child_ids' => $missing_parent_child_ids ) );
	$record_invariant( 'variation_posts_have_expected_parent', 0 === $variation_post_parent_mismatches, array( 'mismatches' => $variation_post_parent_mismatches ) );
	$record_invariant( 'variation_required_postmeta_rows_exist', 0 === $variation_required_meta_missing_total, array( 'missing_counts' => $variation_meta_key_missing_counts ) );
	$record_invariant( 'simple_skus_are_unique', 0 === $count_duplicate_skus( array_map( static fn( $product ) => $product->get_sku(), $simple_products ) ) );
	$record_invariant( 'grouped_skus_are_unique', 0 === $count_duplicate_skus( array_map( static fn( $product ) => $product->get_sku(), $grouped_products ) ) );
	$record_invariant( 'variation_skus_are_unique', 0 === $count_duplicate_skus( array_map( static fn( $product ) => $product->get_sku(), $variation_products ) ) );
	$record_invariant( 'simple_slugs_are_unique_after_collision_pressure', 0 === $count_string_duplicates( $actual_simple_slugs ), array( 'requested_duplicate_slugs' => $count_string_duplicates( $requested_simple_slugs ), 'actual_duplicate_slugs' => $count_string_duplicates( $actual_simple_slugs ) ) );
	$record_invariant( 'duplicate_sku_retry_returns_one_create_error', 1 === $count_response_errors( (array) ( $retry_duplicate_sku_result['data']['create'] ?? array() ) ), array( 'errors' => $count_response_errors( (array) ( $retry_duplicate_sku_result['data']['create'] ?? array() ) ) ) );
	$record_invariant( 'duplicate_sku_retry_does_not_multiply_internal_meta_rows', 0 === $retry_internal_meta_row_delta, array( 'before' => $retry_internal_meta_rows_before, 'after' => $retry_internal_meta_rows_after, 'delta' => $retry_internal_meta_row_delta ) );
	$record_invariant( 'simple_lookup_rows_exist', 0 === $count_missing_lookup_rows( $simple_ids ) );
	$record_invariant( 'grouped_lookup_rows_exist', 0 === $count_missing_lookup_rows( $grouped_ids ) );
	$record_invariant( 'variation_lookup_rows_exist', 0 === $count_missing_lookup_rows( $variation_ids ) );
	$record_invariant( 'variation_attribute_lookup_rows_exist_after_callbacks', 0 === $attribute_lookup_missing_rows, array( 'missing_rows' => $attribute_lookup_missing_rows, 'expected_rows' => count( $expected_attribute_lookup_rows ), 'actual_variation_rows' => $attribute_lookup_variation_rows ) );
	$record_invariant(
		'product_transients_deferrer_shutdown_flushes_before_parent_sync',
		0 === (int) $shutdown_deferral_probe['enabled'] || 1 === (int) $shutdown_deferral_probe['parent_price_includes_new_variation'],
		array(
			'parent_id'                      => (int) $shutdown_deferral_probe['parent_id'],
			'new_variation_id'               => (int) $shutdown_deferral_probe['new_variation_id'],
			'new_variation_price'            => (string) $shutdown_deferral_probe['new_variation_price'],
			'children_transient_warmed'      => (int) $shutdown_deferral_probe['children_transient_warmed'],
			'children_transient_stale_before_shutdown' => (int) $shutdown_deferral_probe['children_transient_stale_before_shutdown'],
			'product_sync_shutdown_priority' => $shutdown_deferral_probe['product_sync_shutdown_priority'],
			'deferrer_shutdown_priority'     => $shutdown_deferral_probe['deferrer_shutdown_priority'],
			'simulated_order'                => (string) $shutdown_deferral_probe['simulated_order'],
			'parent_price_rows_after_shutdown' => $shutdown_deferral_probe['parent_price_rows_after_shutdown'],
		)
	);

	$retry_duplicate_sku_create_items = array_values( (array) ( $retry_duplicate_sku_result['data']['create'] ?? array() ) );
	$summarize_response_item = static function ( $item ): array {
		if ( is_wp_error( $item ) ) {
			return array(
				'type'    => 'WP_Error',
				'code'    => $item->get_error_code(),
				'message' => $item->get_error_message(),
			);
		}
		if ( is_object( $item ) ) {
			return array(
				'type'  => get_class( $item ),
				'keys'  => array_slice( array_keys( get_object_vars( $item ) ), 0, 20 ),
			);
		}
		if ( is_array( $item ) ) {
			return array_filter(
				array(
					'type'    => 'array',
					'keys'    => array_slice( array_keys( $item ), 0, 20 ),
					'id'      => isset( $item['id'] ) ? (int) $item['id'] : null,
					'code'    => isset( $item['code'] ) ? (string) $item['code'] : null,
					'message' => isset( $item['message'] ) ? substr( (string) $item['message'], 0, 200 ) : null,
					'sku'     => isset( $item['sku'] ) ? substr( (string) $item['sku'], 0, 120 ) : null,
				),
				static fn( $value ) => null !== $value
			);
		}

		return array( 'type' => gettype( $item ) );
	};
	$retry_duplicate_sku_create_item_summaries = array_map( $summarize_response_item, $retry_duplicate_sku_create_items );
	$invariant_failure_names = array_values( array_map( static fn( array $failure ): string => (string) ( $failure['name'] ?? '' ), $invariant_failures ) );

	$rows = array(
		'variable_parent_create' => $variable_parent_create_result,
		'variable_parent_update' => $variable_parent_update_result,
		'simple_create'          => $simple_create_result,
		'simple_update'          => $simple_update_result,
		'grouped_create'         => $grouped_create_result,
		'variation_create'       => $variation_create_result,
		'variation_update'       => $variation_update_result,
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
	$phase_span_value = static function ( array $row, string $phase, string $key ): float {
		return (float) ( $row['phase_profile']['spans'][ $phase ][ $key ] ?? 0 );
	};
	$phase_query_value = static function ( array $row, string $phase ): int {
		return (int) ( $row['query_profile']['phase_queries'][ $phase ] ?? 0 );
	};
	$phase_category_value = static function ( array $row, string $phase, string $category ): int {
		return (int) ( $row['query_profile']['phase_categories'][ $phase ][ $category ] ?? 0 );
	};
	$phase_event_value = static function ( array $row, string $phase, string $event ): int {
		return (int) ( $row['phase_profile']['events'][ $phase ][ $event ] ?? 0 );
	};
	$profile_total = static function ( array $profile_rows, string $section, string $key ) use ( $profile_value ): int {
		$total = 0;
		foreach ( $profile_rows as $profile_row ) {
			$total += $profile_value( $profile_row, $section, $key );
		}
		return $total;
	};
	$profile_total_keys = static function ( array $profile_rows, string $section, array $keys ) use ( $profile_value ): int {
		$total = 0;
		foreach ( $profile_rows as $profile_row ) {
			foreach ( $keys as $key ) {
				$total += $profile_value( $profile_row, $section, $key );
			}
		}
		return $total;
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
	$simple_create_count          = max( 1, count( $simple_ids ) );
	$simple_update_count          = max( 1, count( $simple_update ) );
	$variable_parent_create_count = max( 1, count( $variable_parent_ids ) );
	$variable_parent_update_count = 1;
	$variation_create_count       = max( 1, (int) $variation_create_result['counter_delta']['new_variations'] );
	$grouped_create_count         = max( 1, count( $grouped_ids ) );
	$created_item_count           = max( 1, count( $simple_ids ) + count( $grouped_ids ) + count( $variation_ids ) );
	$lookup_pressure_rows   = array(
		$simple_create_result,
		$simple_update_result,
		$grouped_create_result,
		$variable_parent_create_result,
		$variable_parent_update_result,
		$variation_create_result,
		$variation_update_result,
		$retry_duplicate_sku_result,
	);
	$phase_results = array(
		'simple_create'           => $simple_create_result,
		'simple_update'           => $simple_update_result,
		'grouped_create'          => $grouped_create_result,
		'variable_parent_create'  => $variable_parent_create_result,
		'variable_parent_update'  => $variable_parent_update_result,
		'variation_create'        => $variation_create_result,
		'variation_update'        => $variation_update_result,
	);
	$phase_item_counts = array(
		'simple_create'           => $simple_create_count,
		'simple_update'           => $simple_update_count,
		'grouped_create'          => $grouped_create_count,
		'variable_parent_create'  => $variable_parent_create_count,
		'variable_parent_update'  => $variable_parent_update_count,
		'variation_create'        => max( 1, count( $variation_ids ) ),
		'variation_update'        => max( 1, count( $variation_update ) ),
	);
	$hotspot_operations = array(
		'variable_parent_create' => 'product-batch-create',
		'variable_parent_update' => 'product-batch-update',
		'simple_create'          => 'product-batch-create',
		'simple_update'          => 'product-batch-update',
		'grouped_create'         => 'product-batch-create',
		'variation_create'       => 'variation-batch-create',
		'variation_update'       => 'variation-batch-update',
		'duplicate_sku_retry'    => 'product-batch-create',
	);
	$build_hotspot_item = static function ( array $item ): array {
		return array_filter(
			$item,
			static fn( $value ): bool => null !== $value && array() !== $value
		);
	};
	$build_hotspots = static function () use ( $rows, $phase_item_counts, $hotspot_operations, $build_hotspot_item ): array {
		$items = array();
		foreach ( $rows as $phase => $row ) {
			$item_count = max( 1, (int) ( $phase_item_counts[ $phase ] ?? 1 ) );
			$operation  = (string) ( $hotspot_operations[ $phase ] ?? $phase );
			$items[]    = $build_hotspot_item(
				array(
					'name'                 => $phase,
					'category'             => 'phase',
					'phase'                => $phase,
					'operation'            => $operation,
					'count'                => $item_count,
					'duration_ms'          => (float) ( $row['elapsed_ms'] ?? 0 ),
					'duration_ms_per_item' => (float) ( $row['elapsed_ms'] ?? 0 ) / $item_count,
					'query_count'          => (int) ( $row['query_count'] ?? 0 ),
					'query_count_per_item' => (float) ( $row['query_count'] ?? 0 ) / $item_count,
					'value'                => (float) ( $row['elapsed_ms'] ?? 0 ),
					'value_unit'           => 'ms',
					'rank_basis'           => 'duration_ms',
				)
			);

			foreach ( (array) ( $row['query_profile']['categories'] ?? array() ) as $query_family => $count ) {
				$items[] = $build_hotspot_item(
					array(
						'name'                 => $phase . ':' . $query_family,
						'category'             => 'query-family',
						'phase'                => $phase,
						'operation'            => $operation,
						'query_family'         => (string) $query_family,
						'count'                => (int) $count,
						'count_per_item'       => (float) $count / $item_count,
						'value'                => (float) $count,
						'value_unit'           => 'queries',
						'rank_basis'           => 'count',
					)
				);
			}

			foreach ( (array) ( $row['query_profile']['operation_tables'] ?? array() ) as $operation_table => $count ) {
				$query_parts = explode( ':', (string) $operation_table, 2 );
				$items[]     = $build_hotspot_item(
					array(
						'name'                 => $phase . ':' . $operation_table,
						'category'             => 'operation',
						'phase'                => $phase,
						'operation'            => $operation,
						'query_operation'      => (string) ( $query_parts[0] ?? $operation_table ),
						'query_table'          => (string) ( $query_parts[1] ?? 'unknown' ),
						'count'                => (int) $count,
						'count_per_item'       => (float) $count / $item_count,
						'value'                => (float) $count,
						'value_unit'           => 'queries',
						'rank_basis'           => 'count',
					)
				);
			}

			foreach ( (array) ( $row['counter_delta'] ?? array() ) as $hook => $count ) {
				if ( 0 === (int) $count ) {
					continue;
				}
				$items[] = $build_hotspot_item(
					array(
						'name'                 => $phase . ':' . $hook,
						'category'             => 'hook',
						'phase'                => $phase,
						'operation'            => $operation,
						'hook'                 => (string) $hook,
						'count'                => (int) $count,
						'count_per_item'       => (float) $count / $item_count,
						'value'                => (float) $count,
						'value_unit'           => 'calls',
						'rank_basis'           => 'count',
					)
				);
			}

			foreach ( (array) ( $row['phase_profile']['spans'] ?? array() ) as $span_name => $span ) {
				$items[] = $build_hotspot_item(
					array(
						'name'                 => $phase . ':' . $span_name,
						'category'             => 'phase-span',
						'phase'                => $phase,
						'operation'            => $operation,
						'span'                 => (string) $span_name,
						'count'                => (int) ( $span['count'] ?? 0 ),
						'duration_ms'          => (float) ( $span['elapsed_ms'] ?? 0 ),
						'duration_ms_per_item' => (float) ( $span['elapsed_ms'] ?? 0 ) / $item_count,
						'value'                => (float) ( $span['elapsed_ms'] ?? 0 ),
						'value_unit'           => 'ms',
						'rank_basis'           => 'duration_ms',
					)
				);
			}
		}

		$max_by_category = array();
		foreach ( $items as $item ) {
			$category = (string) $item['category'];
			$max_by_category[ $category ] = max( (float) ( $max_by_category[ $category ] ?? 0 ), (float) ( $item['value'] ?? 0 ) );
		}
		usort(
			$items,
			static function ( array $left, array $right ): int {
				$category_compare = strcmp( (string) $left['category'], (string) $right['category'] );
				if ( 0 !== $category_compare ) {
					return $category_compare;
				}
				return (float) $right['value'] <=> (float) $left['value'];
			}
		);

		$ranks_by_category = array();
		foreach ( $items as &$item ) {
			$category = (string) $item['category'];
			$ranks_by_category[ $category ] = (int) ( $ranks_by_category[ $category ] ?? 0 ) + 1;
			$max_value = (float) ( $max_by_category[ $category ] ?? 0 );
			$item['rank'] = $ranks_by_category[ $category ];
			$item['relative_value'] = $max_value > 0 ? (float) $item['value'] / $max_value : 0;
		}
		unset( $item );

		return array(
			'schema'             => 'homeboy/fuzz-hotspots/v1',
			'ranking'            => array(
				'value_field'    => 'value',
				'relative_field' => 'relative_value',
				'rank_scope'     => 'category',
			),
			'categories'         => array_values( array_unique( array_column( $items, 'category' ) ) ),
			'items'              => $items,
		);
	};
	$hotspots       = $build_hotspots();
	$focused_result = $phase_results[ $focus_phase ];
	$focused_count  = $phase_item_counts[ $focus_phase ];
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
	$product_core_meta_keys = array(
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
		'_virtual',
		'_downloadable',
		'_product_version',
	);
	$product_phase_metrics = static function ( string $prefix, array $row, int $product_count ) use ( $profile_value, $count_profile_keys, $meta_operation_keys, $meta_hook_value, $product_core_meta_keys ): array {
		$product_count = max( 1, $product_count );
		return array(
			$prefix . '_queries_per_product' => (float) $row['query_count'] / $product_count,
			$prefix . '_new_products' => (int) $row['counter_delta']['new_products'],
			$prefix . '_updated_products' => (int) $row['counter_delta']['updated_products'],
			$prefix . '_rest_product_inserts' => (int) $row['counter_delta']['rest_product_inserts'],
			$prefix . '_transient_clears' => (int) $row['counter_delta']['product_transient_clears'],
			$prefix . '_lookup_table_queries' => (int) $row['counter_delta']['lookup_table_queries'],
			$prefix . '_profile_meta_exists_queries' => $profile_value( $row, 'categories', 'meta_exists' ),
			$prefix . '_profile_meta_read_queries' => $profile_value( $row, 'categories', 'meta_read' ),
			$prefix . '_profile_meta_insert_queries' => $profile_value( $row, 'categories', 'meta_insert' ),
			$prefix . '_profile_meta_update_queries' => $profile_value( $row, 'categories', 'meta_update' ),
			$prefix . '_profile_transient_option_queries' => $profile_value( $row, 'categories', 'transient_option' ),
			$prefix . '_profile_term_lookup_queries' => $profile_value( $row, 'categories', 'term_lookup' ),
			$prefix . '_profile_slug_lookup_queries' => $profile_value( $row, 'categories', 'slug_lookup' ),
			$prefix . '_profile_sku_lookup_queries' => $profile_value( $row, 'categories', 'sku_lookup' ),
			$prefix . '_profile_lookup_table_queries' => $profile_value( $row, 'categories', 'lookup_table' ),
			$prefix . '_profile_action_scheduler_queries' => $profile_value( $row, 'categories', 'action_scheduler' ),
			$prefix . '_profile_post_write_read_queries' => $profile_value( $row, 'categories', 'post_write_read' ),
			$prefix . '_profile_select_options_queries' => $profile_value( $row, 'operation_tables', 'select:options' ),
			$prefix . '_profile_select_posts_queries' => $profile_value( $row, 'operation_tables', 'select:posts' ),
			$prefix . '_profile_insert_posts_queries' => $profile_value( $row, 'operation_tables', 'insert:posts' ),
			$prefix . '_profile_update_posts_queries' => $profile_value( $row, 'operation_tables', 'update:posts' ),
			$prefix . '_profile_select_postmeta_queries' => $profile_value( $row, 'operation_tables', 'select:postmeta' ),
			$prefix . '_profile_insert_postmeta_queries' => $profile_value( $row, 'operation_tables', 'insert:postmeta' ),
			$prefix . '_profile_update_postmeta_queries' => $profile_value( $row, 'operation_tables', 'update:postmeta' ),
			$prefix . '_profile_term_relationship_join_queries' => $profile_value( $row, 'details', 'term_relationship_join' ),
			$prefix . '_profile_term_slug_lookup_queries' => $profile_value( $row, 'details', 'term_slug_lookup' ),
			$prefix . '_profile_term_name_lookup_queries' => $profile_value( $row, 'details', 'term_name_lookup' ),
			$prefix . '_profile_slug_post_name_collision_check_queries' => $profile_value( $row, 'details', 'slug_post_name_collision_check' ),
			$prefix . '_profile_slug_duplicate_post_lookup_queries' => $profile_value( $row, 'details', 'slug_duplicate_post_lookup' ),
			$prefix . '_profile_slug_post_lookup_queries' => $profile_value( $row, 'details', 'slug_post_lookup' ),
			$prefix . '_profile_meta_bulk_read_queries' => $profile_value( $row, 'details', 'meta_bulk_read' ),
			$prefix . '_profile_meta_key_scan_queries' => $profile_value( $row, 'details', 'meta_key_scan' ),
			$prefix . '_profile_meta_exists_per_product' => (float) $profile_value( $row, 'categories', 'meta_exists' ) / $product_count,
			$prefix . '_profile_meta_insert_per_product' => (float) $profile_value( $row, 'categories', 'meta_insert' ) / $product_count,
			$prefix . '_profile_meta_update_per_product' => (float) $profile_value( $row, 'categories', 'meta_update' ) / $product_count,
			$prefix . '_profile_core_meta_exists_queries' => $count_profile_keys( $row, 'meta_key_operations', $meta_operation_keys( 'exists', $product_core_meta_keys ) ),
			$prefix . '_profile_core_meta_insert_queries' => $count_profile_keys( $row, 'meta_key_operations', $meta_operation_keys( 'insert', $product_core_meta_keys ) ),
			$prefix . '_profile_core_meta_update_queries' => $count_profile_keys( $row, 'meta_key_operations', $meta_operation_keys( 'update', $product_core_meta_keys ) ),
			$prefix . '_profile_sku_meta_exists_queries' => $profile_value( $row, 'meta_key_operations', 'exists:_sku' ),
			$prefix . '_profile_sku_meta_insert_queries' => $profile_value( $row, 'meta_key_operations', 'insert:_sku' ),
			$prefix . '_profile_sku_meta_update_queries' => $profile_value( $row, 'meta_key_operations', 'update:_sku' ),
			$prefix . '_hook_added_post_meta' => (int) $row['counter_delta']['added_post_meta'],
			$prefix . '_hook_updated_post_meta' => (int) $row['counter_delta']['updated_post_meta'],
			$prefix . '_hook_deleted_post_meta' => (int) $row['counter_delta']['deleted_post_meta'],
			$prefix . '_hook_added_sku_meta' => $meta_hook_value( $row, 'added', '_sku' ),
			$prefix . '_hook_updated_sku_meta' => $meta_hook_value( $row, 'updated', '_sku' ),
			$prefix . '_hook_added_regular_price_meta' => $meta_hook_value( $row, 'added', '_regular_price' ),
			$prefix . '_hook_updated_regular_price_meta' => $meta_hook_value( $row, 'updated', '_regular_price' ),
			$prefix . '_hook_added_price_meta' => $meta_hook_value( $row, 'added', '_price' ),
			$prefix . '_hook_updated_price_meta' => $meta_hook_value( $row, 'updated', '_price' ),
			$prefix . '_hook_added_manage_stock_meta' => $meta_hook_value( $row, 'added', '_manage_stock' ),
			$prefix . '_hook_updated_manage_stock_meta' => $meta_hook_value( $row, 'updated', '_manage_stock' ),
			$prefix . '_hook_added_stock_meta' => $meta_hook_value( $row, 'added', '_stock' ),
			$prefix . '_hook_updated_stock_meta' => $meta_hook_value( $row, 'updated', '_stock' ),
			$prefix . '_hook_save_post_product' => (int) $row['counter_delta']['save_post_product'],
			$prefix . '_hook_clean_post_cache' => (int) $row['counter_delta']['clean_post_cache'],
		);
	};
	$http_request_count = static function ( array $row ): int {
		return (int) ( $row['http_profile']['request_count'] ?? 0 );
	};
	$simple_product_count    = max( 1, count( $simple_ids ) );
	$grouped_product_count   = max( 1, count( $grouped_ids ) );
	$variation_product_count = max( 1, count( $variation_ids ) );
	$media_rest_error_count  = $count_response_errors( (array) ( $simple_create_result['data']['create'] ?? array() ) )
		+ $count_response_errors( (array) ( $simple_update_result['data']['update'] ?? array() ) )
		+ $count_response_errors( (array) ( $grouped_create_result['data']['create'] ?? array() ) )
		+ $count_response_errors( (array) ( $variation_create_result['data']['create'] ?? array() ) )
		+ $count_response_errors( (array) ( $variation_update_result['data']['update'] ?? array() ) );

	$summary = array(
		'success_rate'                         => 1,
		'batch_size'                           => $batch_size,
		'attribute_count'                      => $attribute_count,
		'terms_per_attribute'                  => $terms_per_attr,
		'catalog_seed_products'                => $catalog_products,
		'catalog_seed_variations_per_product'  => $catalog_variations_per_product,
		'catalog_seed_variations'              => $catalog_seed_variations,
		'catalog_seed_ms'                      => $catalog_seed_ms,
		'matrix_focus_phase'                   => array_search( $focus_phase, $valid_focus_phases, true ) + 1,
		'focused_phase_ms'                     => (float) $focused_result['elapsed_ms'],
		'focused_phase_ms_per_item'            => (float) $focused_result['elapsed_ms'] / $focused_count,
		'focused_phase_queries'                => (int) $focused_result['query_count'],
		'focused_phase_queries_per_item'       => (float) $focused_result['query_count'] / $focused_count,
		'focused_phase_transient_clears'       => (int) $focused_result['counter_delta']['product_transient_clears'],
		'focused_phase_transient_clears_per_item' => (float) $focused_result['counter_delta']['product_transient_clears'] / $focused_count,
		'focused_phase_profile_meta_exists_queries' => $profile_value( $focused_result, 'categories', 'meta_exists' ),
		'focused_phase_profile_meta_read_queries' => $profile_value( $focused_result, 'categories', 'meta_read' ),
		'focused_phase_profile_meta_insert_queries' => $profile_value( $focused_result, 'categories', 'meta_insert' ),
		'focused_phase_profile_meta_update_queries' => $profile_value( $focused_result, 'categories', 'meta_update' ),
		'focused_phase_profile_term_lookup_queries' => $profile_value( $focused_result, 'categories', 'term_lookup' ),
		'focused_phase_profile_slug_lookup_queries' => $profile_value( $focused_result, 'categories', 'slug_lookup' ),
		'focused_phase_profile_sku_lookup_queries' => $profile_value( $focused_result, 'categories', 'sku_lookup' ),
		'focused_phase_profile_transient_option_queries' => $profile_value( $focused_result, 'categories', 'transient_option' ),
		'focused_phase_profile_lookup_table_queries' => $profile_value( $focused_result, 'categories', 'lookup_table' ),
		'focused_phase_profile_action_scheduler_queries' => $profile_value( $focused_result, 'categories', 'action_scheduler' ),
		'focused_phase_hook_added_post_meta'    => (int) $focused_result['counter_delta']['added_post_meta'],
		'focused_phase_hook_updated_post_meta'  => (int) $focused_result['counter_delta']['updated_post_meta'],
		'focused_phase_hook_deleted_post_meta'  => (int) $focused_result['counter_delta']['deleted_post_meta'],
		'focused_phase_hook_save_post_product'  => (int) $focused_result['counter_delta']['save_post_product'],
		'focused_phase_hook_save_post_product_variation' => (int) $focused_result['counter_delta']['save_post_product_variation'],
		'focused_phase_hook_clean_post_cache'   => (int) $focused_result['counter_delta']['clean_post_cache'],
		'simple_create_ms_per_item'             => (float) $simple_create_result['elapsed_ms'] / $phase_item_counts['simple_create'],
		'simple_update_ms_per_item'             => (float) $simple_update_result['elapsed_ms'] / $phase_item_counts['simple_update'],
		'grouped_create_ms_per_item'            => (float) $grouped_create_result['elapsed_ms'] / $phase_item_counts['grouped_create'],
		'variation_create_ms_per_item'          => (float) $variation_create_result['elapsed_ms'] / $phase_item_counts['variation_create'],
		'variation_update_ms_per_item'          => (float) $variation_update_result['elapsed_ms'] / $phase_item_counts['variation_update'],
		'simple_create_queries_per_item'        => (float) $simple_create_result['query_count'] / $phase_item_counts['simple_create'],
		'simple_update_queries_per_item'        => (float) $simple_update_result['query_count'] / $phase_item_counts['simple_update'],
		'grouped_create_queries_per_item'       => (float) $grouped_create_result['query_count'] / $phase_item_counts['grouped_create'],
		'media_image_mode'                     => $image_mode,
		'media_images_per_product'             => $image_count,
		'media_gallery_images_per_product'     => $gallery_count,
		'media_fixture_attachment_count'       => count( $media_attachment_ids ),
		'media_simple_create_ms_per_product'   => (float) $simple_create_result['elapsed_ms'] / $simple_product_count,
		'media_simple_update_ms_per_product'   => (float) $simple_update_result['elapsed_ms'] / $simple_product_count,
		'media_grouped_create_ms_per_product'  => (float) $grouped_create_result['elapsed_ms'] / $grouped_product_count,
		'media_variation_create_ms_per_product' => (float) $variation_create_result['elapsed_ms'] / $variation_product_count,
		'media_variation_update_ms_per_product' => (float) $variation_update_result['elapsed_ms'] / $variation_product_count,
		'media_simple_create_queries_per_product' => (float) $simple_create_result['query_count'] / $simple_product_count,
		'media_simple_update_queries_per_product' => (float) $simple_update_result['query_count'] / $simple_product_count,
		'media_grouped_create_queries_per_product' => (float) $grouped_create_result['query_count'] / $grouped_product_count,
		'media_variation_create_queries_per_product' => (float) $variation_create_result['query_count'] / $variation_product_count,
		'media_variation_update_queries_per_product' => (float) $variation_update_result['query_count'] / $variation_product_count,
		'media_http_request_count'             => $http_request_count( $simple_create_result ) + $http_request_count( $simple_update_result ) + $http_request_count( $grouped_create_result ) + $http_request_count( $variation_create_result ) + $http_request_count( $variation_update_result ),
		'media_simple_create_http_requests'    => $http_request_count( $simple_create_result ),
		'media_simple_update_http_requests'    => $http_request_count( $simple_update_result ),
		'media_grouped_create_http_requests'   => $http_request_count( $grouped_create_result ),
		'media_variation_create_http_requests' => $http_request_count( $variation_create_result ),
		'media_variation_update_http_requests' => $http_request_count( $variation_update_result ),
		'media_rest_error_count'               => $media_rest_error_count,
		'media_attachment_row_delta'           => (int) ( $row_count_deltas['attachment_posts'] ?? 0 ),
		'media_attachment_meta_row_delta'      => (int) ( $row_count_deltas['attachment_postmeta'] ?? 0 ),
		'media_simple_image_readback_mismatches' => $simple_image_readback_mismatches,
		'media_simple_gallery_readback_mismatches' => $simple_gallery_readback_mismatches,
		'media_variation_image_readback_mismatches' => $variation_image_readback_mismatches,
		'side_effect_active_plugin_count'      => count( $active_plugins ),
		'scenario_catalog_lookup_pressure'     => 1,
		'scenario_catalog_variation_density'   => $catalog_variations_per_product > 0 ? 1 : 0,
		'scenario_sku_shape_prefix'            => 'prefix' === $sku_shape ? 1 : 0,
		'scenario_sku_shape_catalog_duplicate_retry' => 'catalog_duplicate_retry' === $sku_shape ? 1 : 0,
		'scenario_slug_title_shape_prefix'     => 'prefix' === $slug_title_shape ? 1 : 0,
		'scenario_slug_title_shape_collision'  => 'collision' === $slug_title_shape ? 1 : 0,
		'scenario_term_mode_new'               => 'new' === $term_mode ? 1 : 0,
		'scenario_term_mode_mixed'             => 'mixed' === $term_mode ? 1 : 0,
		'scenario_reentrant_save_post_product' => 1,
		'scenario_grouped_product_create_guardrail' => 1,
		'scenario_shared_product_data_store'   => 1,
		'scenario_preexisting_internal_meta'   => 1,
		'scenario_third_party_meta_hooks'      => 1,
		'scenario_variation_parent_sync_guardrail' => 1,
		'scenario_duplicate_sku_retry'         => 1,
		'scenario_transient_deferrer_shutdown_order_guardrail' => (int) $shutdown_deferral_probe['enabled'],
		'variable_parent_create_ms'            => (float) $variable_parent_create_result['elapsed_ms'],
		'variable_parent_update_ms'            => (float) $variable_parent_update_result['elapsed_ms'],
		'simple_create_ms'                     => (float) $simple_create_result['elapsed_ms'],
		'simple_update_ms'                     => (float) $simple_update_result['elapsed_ms'],
		'grouped_create_ms'                    => (float) $grouped_create_result['elapsed_ms'],
		'variation_create_ms'                  => (float) $variation_create_result['elapsed_ms'],
		'variation_update_ms'                  => (float) $variation_update_result['elapsed_ms'],
		'duplicate_sku_retry_ms'               => (float) $retry_duplicate_sku_result['elapsed_ms'],
		'variable_parent_create_queries'       => (int) $variable_parent_create_result['query_count'],
		'variable_parent_update_queries'       => (int) $variable_parent_update_result['query_count'],
		'simple_create_queries'                => (int) $simple_create_result['query_count'],
		'simple_update_queries'                => (int) $simple_update_result['query_count'],
		'grouped_create_queries'               => (int) $grouped_create_result['query_count'],
		'variation_create_queries'             => (int) $variation_create_result['query_count'],
		'variation_update_queries'             => (int) $variation_update_result['query_count'],
		'duplicate_sku_retry_queries'          => (int) $retry_duplicate_sku_result['query_count'],
		'lookup_pressure_sku_lookup_queries'   => $profile_total( $lookup_pressure_rows, 'categories', 'sku_lookup' ),
		'lookup_pressure_slug_uniqueness_queries' => $profile_total( $lookup_pressure_rows, 'categories', 'slug_lookup' ),
		'lookup_pressure_product_lookup_table_queries' => $profile_total( $lookup_pressure_rows, 'categories', 'lookup_table' ),
		'lookup_pressure_term_relationship_queries' => $profile_total( $lookup_pressure_rows, 'categories', 'term_lookup' ),
		'lookup_pressure_post_postmeta_queries' => $profile_total( $lookup_pressure_rows, 'categories', 'post_write_read' ) + $profile_total_keys( $lookup_pressure_rows, 'categories', array( 'meta_exists', 'meta_read', 'meta_insert', 'meta_update' ) ),
		'lookup_pressure_postmeta_lookup_queries' => $profile_total_keys( $lookup_pressure_rows, 'categories', array( 'meta_exists', 'meta_read' ) ),
		'lookup_pressure_rest_errors'          => $count_response_errors( (array) ( $simple_create_result['data']['create'] ?? array() ) ) + $count_response_errors( (array) ( $simple_update_result['data']['update'] ?? array() ) ) + $count_response_errors( (array) ( $grouped_create_result['data']['create'] ?? array() ) ) + $count_response_errors( (array) ( $variation_create_result['data']['create'] ?? array() ) ) + $count_response_errors( (array) ( $variation_update_result['data']['update'] ?? array() ) ) + $count_response_errors( (array) ( $retry_duplicate_sku_result['data']['create'] ?? array() ) ),
		'grouped_create_profile_sku_lookup_queries' => $profile_value( $grouped_create_result, 'categories', 'sku_lookup' ),
		'grouped_create_profile_slug_lookup_queries' => $profile_value( $grouped_create_result, 'categories', 'slug_lookup' ),
		'grouped_create_profile_lookup_table_queries' => $profile_value( $grouped_create_result, 'categories', 'lookup_table' ),
		'grouped_create_profile_term_lookup_queries' => $profile_value( $grouped_create_result, 'categories', 'term_lookup' ),
		'grouped_create_profile_meta_exists_queries' => $profile_value( $grouped_create_result, 'categories', 'meta_exists' ),
		'grouped_create_profile_meta_read_queries' => $profile_value( $grouped_create_result, 'categories', 'meta_read' ),
		'grouped_create_profile_meta_insert_queries' => $profile_value( $grouped_create_result, 'categories', 'meta_insert' ),
		'grouped_create_profile_select_postmeta_queries' => $profile_value( $grouped_create_result, 'operation_tables', 'select:postmeta' ),
		'grouped_create_profile_insert_postmeta_queries' => $profile_value( $grouped_create_result, 'operation_tables', 'insert:postmeta' ),
		'grouped_create_profile_meta_key_scan_queries' => $profile_value( $grouped_create_result, 'details', 'meta_key_scan' ),
		'grouped_create_hook_added_post_meta' => (int) $grouped_create_result['counter_delta']['added_post_meta'],
		'grouped_create_hook_updated_post_meta' => (int) $grouped_create_result['counter_delta']['updated_post_meta'],
		'grouped_create_hook_deleted_post_meta' => (int) $grouped_create_result['counter_delta']['deleted_post_meta'],
		'grouped_create_hook_save_post_product' => (int) $grouped_create_result['counter_delta']['save_post_product'],
		'lookup_pressure_sku_lookup_queries_per_created_item' => (float) $profile_total( $lookup_pressure_rows, 'categories', 'sku_lookup' ) / $created_item_count,
		'lookup_pressure_slug_uniqueness_queries_per_created_item' => (float) $profile_total( $lookup_pressure_rows, 'categories', 'slug_lookup' ) / $created_item_count,
		'lookup_pressure_term_queries_per_created_item' => (float) $profile_total( $lookup_pressure_rows, 'categories', 'term_lookup' ) / $created_item_count,
		'simple_create_profile_sku_lookup_queries' => $profile_value( $simple_create_result, 'categories', 'sku_lookup' ),
		'simple_create_profile_slug_lookup_queries' => $profile_value( $simple_create_result, 'categories', 'slug_lookup' ),
		'simple_create_profile_lookup_table_queries' => $profile_value( $simple_create_result, 'categories', 'lookup_table' ),
		'simple_create_profile_term_lookup_queries' => $profile_value( $simple_create_result, 'categories', 'term_lookup' ),
		'simple_create_phase_rest_dispatch_ms' => $phase_span_value( $simple_create_result, 'rest_dispatch', 'elapsed_ms' ),
		'simple_create_phase_product_save_ms' => $phase_span_value( $simple_create_result, 'product_save', 'elapsed_ms' ),
		'simple_create_phase_product_save_count' => $phase_span_value( $simple_create_result, 'product_save', 'count' ),
		'simple_create_phase_rest_dispatch_queries' => $phase_query_value( $simple_create_result, 'rest_dispatch' ),
		'simple_create_phase_product_save_queries' => $phase_query_value( $simple_create_result, 'product_save' ),
		'simple_create_phase_product_save_meta_insert_queries' => $phase_category_value( $simple_create_result, 'product_save', 'meta_insert' ),
		'simple_create_phase_product_save_meta_update_queries' => $phase_category_value( $simple_create_result, 'product_save', 'meta_update' ),
		'simple_create_phase_product_save_meta_read_queries' => $phase_category_value( $simple_create_result, 'product_save', 'meta_read' ),
		'simple_create_phase_product_save_term_lookup_queries' => $phase_category_value( $simple_create_result, 'product_save', 'term_lookup' ),
		'simple_create_phase_product_save_lookup_table_queries' => $phase_category_value( $simple_create_result, 'product_save', 'lookup_table' ),
		'simple_create_phase_product_save_transient_option_queries' => $phase_category_value( $simple_create_result, 'product_save', 'transient_option' ),
		'simple_create_phase_product_save_transient_invalidations' => $phase_event_value( $simple_create_result, 'product_save', 'transient_invalidation' ),
		'simple_create_phase_product_save_clean_post_cache_events' => $phase_event_value( $simple_create_result, 'product_save', 'clean_post_cache' ),
		'simple_create_profile_select_posts_queries' => $profile_value( $simple_create_result, 'operation_tables', 'select:posts' ),
		'simple_create_profile_select_postmeta_queries' => $profile_value( $simple_create_result, 'operation_tables', 'select:postmeta' ),
		'simple_create_profile_insert_postmeta_queries' => $profile_value( $simple_create_result, 'operation_tables', 'insert:postmeta' ),
		'simple_create_profile_slug_post_name_collision_check_queries' => $profile_value( $simple_create_result, 'details', 'slug_post_name_collision_check' ),
		'simple_create_profile_term_relationship_join_queries' => $profile_value( $simple_create_result, 'details', 'term_relationship_join' ),
		'simple_create_profile_term_slug_lookup_queries' => $profile_value( $simple_create_result, 'details', 'term_slug_lookup' ),
		'simple_create_profile_term_name_lookup_queries' => $profile_value( $simple_create_result, 'details', 'term_name_lookup' ),
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
		'side_effect_variable_parent_create_response_errors' => $count_response_errors( (array) ( $variable_parent_create_result['data']['create'] ?? array() ) ),
		'side_effect_variable_parent_update_response_errors' => $count_response_errors( (array) ( $variable_parent_update_result['data']['update'] ?? array() ) ),
		'side_effect_simple_create_response_errors' => $count_response_errors( (array) ( $simple_create_result['data']['create'] ?? array() ) ),
		'side_effect_simple_update_response_errors' => $count_response_errors( (array) ( $simple_update_result['data']['update'] ?? array() ) ),
		'side_effect_grouped_create_response_errors' => $count_response_errors( (array) ( $grouped_create_result['data']['create'] ?? array() ) ),
		'side_effect_variation_create_response_errors' => $count_response_errors( (array) ( $variation_create_result['data']['create'] ?? array() ) ),
		'side_effect_variation_update_response_errors' => $count_response_errors( (array) ( $variation_update_result['data']['update'] ?? array() ) ),
		'side_effect_duplicate_sku_retry_response_errors' => $count_response_errors( (array) ( $retry_duplicate_sku_result['data']['create'] ?? array() ) ),
		'side_effect_duplicate_sku_retry_create_item_count' => count( $retry_duplicate_sku_create_items ),
		'side_effect_duplicate_sku_retry_create_item_has_id_count' => count( array_filter( $retry_duplicate_sku_create_items, static fn( $item ): bool => is_array( $item ) && isset( $item['id'] ) ) ),
		'side_effect_duplicate_sku_retry_create_item_summaries' => wp_json_encode( array_slice( $retry_duplicate_sku_create_item_summaries, 0, 5 ) ),
		'side_effect_invariant_failure_names' => implode( ',', $invariant_failure_names ),
		'side_effect_transient_deferrer_shutdown_probe_enabled' => (int) $shutdown_deferral_probe['enabled'],
		'side_effect_transient_deferrer_shutdown_product_sync_priority' => false === $shutdown_deferral_probe['product_sync_shutdown_priority'] ? -1 : (int) $shutdown_deferral_probe['product_sync_shutdown_priority'],
		'side_effect_transient_deferrer_shutdown_deferrer_priority' => false === $shutdown_deferral_probe['deferrer_shutdown_priority'] ? -1 : (int) $shutdown_deferral_probe['deferrer_shutdown_priority'],
		'side_effect_transient_deferrer_shutdown_order_product_sync_first' => 'product_sync_before_deferrer' === $shutdown_deferral_probe['simulated_order'] ? 1 : 0,
		'side_effect_transient_deferrer_shutdown_stale_children_before_shutdown' => (int) $shutdown_deferral_probe['children_transient_stale_before_shutdown'],
		'side_effect_transient_deferrer_shutdown_parent_price_includes_new_variation' => (int) $shutdown_deferral_probe['parent_price_includes_new_variation'],
		'side_effect_duplicate_sku_retry_internal_meta_row_delta' => $retry_internal_meta_row_delta,
		'side_effect_duplicate_sku_retry_internal_meta_rows_before' => $retry_internal_meta_rows_before,
		'side_effect_duplicate_sku_retry_internal_meta_rows_after' => $retry_internal_meta_rows_after,
		'side_effect_variable_parent_created_count' => count( $variable_parent_ids ),
		'side_effect_variable_parent_loaded_count' => $variable_parent_product instanceof WC_Product ? 1 : 0,
		'side_effect_variable_parent_type_mismatches' => $variable_parent_type_mismatch,
		'side_effect_variable_parent_attribute_missing_count' => $variable_parent_attribute_missing,
		'side_effect_simple_created_count' => count( $simple_ids ),
		'side_effect_grouped_created_count' => count( $grouped_ids ),
		'side_effect_variation_created_count' => count( $variation_ids ),
		'side_effect_simple_loaded_count' => count( $simple_products ),
		'side_effect_grouped_loaded_count' => count( $grouped_products ),
		'side_effect_variation_loaded_count' => count( $variation_products ),
		'side_effect_grouped_type_mismatches' => $grouped_type_mismatches,
		'side_effect_grouped_child_mismatches' => $grouped_child_mismatches,
		'side_effect_requested_existing_term_count' => $requested_existing_term_count,
		'side_effect_requested_new_term_count' => $requested_new_term_count,
		'side_effect_requested_simple_slug_duplicates' => $count_string_duplicates( $requested_simple_slugs ),
		'side_effect_actual_simple_slug_duplicates' => $count_string_duplicates( $actual_simple_slugs ),
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
		'side_effect_grouped_duplicate_meta_row_count' => count( $grouped_duplicate_meta_rows ),
		'side_effect_variation_duplicate_meta_row_count' => count( $variation_duplicate_meta_rows ),
		'side_effect_simple_internal_duplicate_meta_row_count' => $simple_internal_duplicate_meta_row_count,
		'side_effect_grouped_internal_duplicate_meta_row_count' => $grouped_internal_duplicate_meta_row_count,
		'side_effect_variation_internal_duplicate_meta_row_count' => $variation_internal_duplicate_meta_row_count,
		'side_effect_simple_internal_meta_value_mismatches' => array_sum( $simple_meta_value_mismatches ),
		'side_effect_variation_internal_meta_value_mismatches' => array_sum( $variation_meta_value_mismatches ),
		'side_effect_simple_sku_readback_mismatches' => $simple_sku_readback_mismatches,
		'side_effect_grouped_sku_readback_mismatches' => $grouped_sku_readback_mismatches,
		'side_effect_variation_sku_readback_mismatches' => $variation_sku_readback_mismatches,
		'side_effect_simple_sku_lookup_mismatches' => $simple_sku_lookup_mismatches,
		'side_effect_grouped_sku_lookup_mismatches' => $grouped_sku_lookup_mismatches,
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
		'side_effect_grouped_adjacent_meta_missing_count' => $grouped_adjacent_meta_missing_count,
		'side_effect_variation_adjacent_meta_missing_count' => $variation_adjacent_meta_missing_count,
		'side_effect_variation_empty_attribute_count' => $variation_attribute_empty_count,
		'side_effect_simple_duplicate_skus' => $count_duplicate_skus( array_map( static fn( $product ) => $product->get_sku(), $simple_products ) ),
		'side_effect_grouped_duplicate_skus' => $count_duplicate_skus( array_map( static fn( $product ) => $product->get_sku(), $grouped_products ) ),
		'side_effect_variation_duplicate_skus' => $count_duplicate_skus( array_map( static fn( $product ) => $product->get_sku(), $variation_products ) ),
		'side_effect_simple_missing_lookup_rows' => $count_missing_lookup_rows( $simple_ids ),
		'side_effect_grouped_missing_lookup_rows' => $count_missing_lookup_rows( $grouped_ids ),
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
	$summary = array_merge(
		$summary,
		$product_phase_metrics( 'simple_create', $simple_create_result, $simple_create_count ),
		$product_phase_metrics( 'simple_update', $simple_update_result, $simple_update_count ),
		$product_phase_metrics( 'grouped_create', $grouped_create_result, $grouped_create_count ),
		$product_phase_metrics( 'variable_parent_create', $variable_parent_create_result, $variable_parent_create_count ),
		$product_phase_metrics( 'variable_parent_update', $variable_parent_update_result, $variable_parent_update_count )
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
					'settings'              => array(
						'WC_REST_BATCH_IMPORT_ITEMS' => (string) $batch_size,
						'WC_REST_BATCH_IMPORT_ATTRIBUTES' => (string) $attribute_count,
						'WC_REST_BATCH_IMPORT_TERMS_PER_ATTRIBUTE' => (string) $terms_per_attr,
						'WC_REST_BATCH_IMPORT_CATALOG_PRODUCTS' => (string) $catalog_products,
						'WC_REST_BATCH_IMPORT_FOCUS_PHASE' => $focus_phase,
					),
					'scenario'              => array(
						'catalog_products'               => $catalog_products,
						'catalog_variations_per_product' => $catalog_variations_per_product,
						'sku_shape'                      => $sku_shape,
						'slug_title_shape'               => $slug_title_shape,
						'term_mode'                      => $term_mode,
					),
					'parent_product_id'     => $parent_id,
					'variable_parent_product_ids' => array_map( 'intval', $variable_parent_ids ),
					'simple_product_ids'    => array_map( 'intval', $simple_ids ),
					'grouped_product_ids'   => array_map( 'intval', $grouped_ids ),
					'variation_ids'         => array_map( 'intval', $variation_ids ),
					'active_plugins'        => $active_plugins,
					'attribute_taxonomies'  => $attribute_taxonomies,
					'rows'                  => $rows,
					'metrics'               => $summary,
					'hotspots'              => $hotspots,
					'side_effects'          => array(
						'invariant_failures'                          => $invariant_failures,
						'invariant_failure_names'                     => $invariant_failure_names,
						'duplicate_sku_retry_create_item_summaries'    => $retry_duplicate_sku_create_item_summaries,
						'media_image_mode'                             => $image_mode,
						'media_fixture_attachment_ids'                 => $media_attachment_ids,
						'expected_simple_image_ids'                    => $expected_simple_image_ids,
						'expected_simple_gallery_ids'                  => $expected_simple_gallery_ids,
						'expected_variation_image_ids'                 => $expected_variation_image_ids,
						'scenario_labels'                             => array(
							'variable_parent_product_batch_create_update',
							'grouped_product_batch_create',
							'catalog_size_lookup_pressure',
							'catalog_variation_density_pressure',
							'sku_shape_lookup_pressure',
							'slug_title_collision_pressure',
							'existing_vs_new_term_pressure',
							'reentrant_save_post_product_create_fanout',
							'reentrant_save_post_product_variation_create_fanout',
							'duplicate_meta_and_readback_correctness',
							'shared_product_and_variation_data_store_reuse',
							'preexisting_internal_meta_before_create_save_completes',
							'third_party_internal_meta_hook_adjacent_writes',
							'variation_parent_sync_under_reentrant_save',
							'duplicate_sku_retry_guardrail',
							'transient_deferrer_shutdown_order_guardrail',
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
						'grouped_duplicate_meta_rows'                  => $grouped_duplicate_meta_rows,
						'variation_duplicate_meta_rows'                => $variation_duplicate_meta_rows,
						'meta_hook_counts'                            => $meta_hook_counts,
						'row_counts_before'                           => $row_counts_before,
						'row_counts_after'                            => $row_counts_after,
						'row_count_deltas'                            => $row_count_deltas,
						'attribute_lookup_actions'                    => $pending_attribute_lookup_actions,
						'variation_attribute_lookup_actions'          => $variation_attribute_lookup_actions,
						'attribute_lookup_actions_after_callbacks'    => $pending_attribute_lookup_actions_after_callbacks,
						'expected_attribute_lookup_rows'              => $expected_attribute_lookup_rows,
						'transient_deferrer_shutdown_probe'           => $shutdown_deferral_probe,
					),
				),
				JSON_PRETTY_PRINT
			) . "\n"
		);
	}

	return array(
		'metrics'   => $summary,
		'hotspots'  => $hotspots,
		'metadata'  => array(
			'runner'       => 'wp-codebox',
			'workload'     => 'rest-product-batch-import',
			'focus_phase'  => $focus_phase,
			'issues'       => $issues,
			'route'        => '/wc/v3/products/batch',
			'variation_route' => $variation_route,
			'image_mode'   => $image_mode,
			'scenario'     => array(
				'catalog_products'               => $catalog_products,
				'catalog_variations_per_product' => $catalog_variations_per_product,
				'sku_shape'                      => $sku_shape,
				'slug_title_shape'               => $slug_title_shape,
				'term_mode'                      => $term_mode,
			),
		),
		'artifacts' => $artifact_path ? array( 'raw_result' => array( 'path' => $artifact_path, 'kind' => 'json' ) ) : array(),
	);
};
