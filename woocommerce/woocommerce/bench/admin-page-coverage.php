<?php
/**
 * Bounded authenticated wp-admin/Woo admin page coverage workload.
 *
 * Enumerates registered admin menu/submenu URLs, skips known unsafe actions, and
 * visits the remaining GET pages through the disposable WP Codebox HTTP runtime.
 */
return function (): array {
	$started = microtime( true );

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

	$admin_asset_registries = array_merge(
		glob( WP_PLUGIN_DIR . '/woocommerce/assets/client/admin/wp-admin-scripts/*.asset.php' ) ?: array(),
		glob( WP_PLUGIN_DIR . '/woocommerce/assets/client/admin/wp-admin-scripts/*.min.asset.php' ) ?: array()
	);
	if ( empty( $admin_asset_registries ) ) {
		throw new RuntimeException( 'WooCommerce admin asset registries are missing; build WooCommerce admin assets before running admin page coverage.' );
	}
	$run_id     = 'woocommerce-admin-page-coverage-' . getmypid() . '-' . time();
	$token      = wp_generate_password( 24, false, false );
	$limit      = max( 1, min( 100, (int) ( getenv( 'WC_ADMIN_PAGE_COVERAGE_LIMIT' ) ?: 50 ) ) );
	$timeout    = max( 5, min( 30, (int) ( getenv( 'WC_ADMIN_PAGE_COVERAGE_TIMEOUT' ) ?: 15 ) ) );
	$log_option = 'homeboy_admin_page_coverage_' . md5( $run_id );
	$mu_plugin  = trailingslashit( WPMU_PLUGIN_DIR ) . 'homeboy-admin-page-coverage.php';

	wp_mkdir_p( WPMU_PLUGIN_DIR );
	file_put_contents(
		$mu_plugin,
		'<?php
add_action( "muplugins_loaded", function () {
    $token = isset( $_GET["homeboy_admin_page_coverage_token"] ) ? sanitize_text_field( wp_unslash( $_GET["homeboy_admin_page_coverage_token"] ) ) : "";
    $expected = get_option( "' . esc_js( $log_option ) . '_expected", "" );
    if ( "" === $token || ! hash_equals( (string) $expected, $token ) ) {
        return;
    }
    $GLOBALS["homeboy_admin_page_coverage_observed_errors"] = array();
    set_error_handler(
        static function ( $severity, $message, $file, $line ) {
            $GLOBALS["homeboy_admin_page_coverage_observed_errors"][] = array(
                "severity" => $severity,
                "message"  => (string) $message,
                "file"     => basename( (string) $file ),
                "line"     => (int) $line,
            );
            return false;
        }
    );
} );
add_action( "shutdown", function () {
    global $wpdb;
    $token = isset( $_GET["homeboy_admin_page_coverage_token"] ) ? sanitize_text_field( wp_unslash( $_GET["homeboy_admin_page_coverage_token"] ) ) : "";
    $expected = get_option( "' . esc_js( $log_option ) . '_expected", "" );
    if ( "" === $token || ! hash_equals( (string) $expected, $token ) ) {
        return;
    }
    $records = get_option( "' . esc_js( $log_option ) . '", array() );
    if ( ! is_array( $records ) ) {
        $records = array();
    }
    $records[] = array(
        "path"        => isset( $_SERVER["REQUEST_URI"] ) ? (string) $_SERVER["REQUEST_URI"] : "",
        "query_count" => isset( $wpdb ) ? (int) $wpdb->num_queries : null,
        "query_shapes" => defined( "SAVEQUERIES" ) && SAVEQUERIES && isset( $wpdb->queries ) ? array_slice( array_map( static function ( $query ) { return preg_replace( "/\\s+/", " ", (string) $query[0] ); }, $wpdb->queries ), 0, 25 ) : array(),
        "php_errors"  => isset( $GLOBALS["homeboy_admin_page_coverage_observed_errors"] ) ? $GLOBALS["homeboy_admin_page_coverage_observed_errors"] : array(),
        "last_error"  => error_get_last(),
        "elapsed_ms"  => timer_stop( 0, 3 ) * 1000,
    );
    update_option( "' . esc_js( $log_option ) . '", $records, false );
}, PHP_INT_MAX );
'
	);
	update_option( $log_option . '_expected', $token, false );

	$admin_user_id = get_current_user_id();
	if ( ! $admin_user_id || ! user_can( $admin_user_id, 'manage_options' ) ) {
		$admin_user_id = 1;
	}
	wp_set_current_user( $admin_user_id );

	if ( ! get_role( 'shop_manager' ) && function_exists( 'wc_create_roles' ) ) {
		wc_create_roles();
	}
	$shop_manager_id = username_exists( 'homeboy_shop_manager' );
	if ( ! $shop_manager_id && get_role( 'shop_manager' ) ) {
		$shop_manager_id = wp_insert_user(
			array(
				'user_login' => 'homeboy_shop_manager',
				'user_pass'  => wp_generate_password( 24, true ),
				'user_email' => 'homeboy-shop-manager@example.test',
				'role'       => 'shop_manager',
			)
		);
	}

	$build_cookie_header = static function ( int $user_id ): string {
		$user = get_user_by( 'id', $user_id );
		if ( ! $user ) {
			return '';
		}
		$expiration = time() + HOUR_IN_SECONDS;
		$scheme     = is_ssl() ? 'secure_auth' : 'auth';
		$auth_name  = is_ssl() ? SECURE_AUTH_COOKIE : AUTH_COOKIE;
		return $auth_name . '=' . wp_generate_auth_cookie( $user_id, $expiration, $scheme ) . '; ' . LOGGED_IN_COOKIE . '=' . wp_generate_auth_cookie( $user_id, $expiration, 'logged_in' );
	};

	$normalize_admin_url = static function ( string $page ): string {
		if ( preg_match( '#^https?://#', $page ) ) {
			return $page;
		}
		if ( false !== strpos( $page, '.php' ) ) {
			return admin_url( ltrim( $page, '/' ) );
		}
		return admin_url( 'admin.php?page=' . rawurlencode( $page ) );
	};

	$safe_skip_reason_codes = array(
		'creation_install_update_or_export_screen',
		'unsafe_query_arg_action',
		'unsafe_query_arg_action2',
		'unsafe_query_arg_delete',
		'unsafe_query_arg_trash',
		'unsafe_query_arg_untrash',
		'unsafe_query_arg_activate',
		'unsafe_query_arg_deactivate',
		'setup_or_onboarding_screen',
		'role_unavailable',
		'permission_boundary',
	);
	$role_expectations = array(
		'administrator' => array(
			'user_role'             => 'administrator',
			'expected_safe_statuses' => array( 200, 301, 302 ),
			'boundary'              => 'administrator should reach every enumerated safe GET target in this workload unless the target itself redirects.',
		),
		'shop_manager'  => array(
			'user_role'             => 'shop_manager',
			'expected_safe_statuses' => array( 200, 301, 302, 403 ),
			'boundary'              => 'shop manager 403 responses are expected only when the target capability is unavailable to shop_manager and are classified as permission_boundary skips.',
		),
	);
	$enumeration_contract = array(
		'schema'                 => 'homeboy-rigs/woocommerce-admin-page-enumeration-contract/v1',
		'sources'                => array( 'global $menu', 'global $submenu' ),
		'methods'                => array( 'GET' ),
		'roles'                  => $role_expectations,
		'skip_reason_codes'      => $safe_skip_reason_codes,
		'destructive_reason_codes' => array(
			'creation_install_update_or_export_screen',
			'unsafe_query_arg_action',
			'unsafe_query_arg_action2',
			'unsafe_query_arg_delete',
			'unsafe_query_arg_trash',
			'unsafe_query_arg_untrash',
			'unsafe_query_arg_activate',
			'unsafe_query_arg_deactivate',
		),
		'artifact_expectations'  => array(
			'schema'       => 'homeboy-rigs/woocommerce-admin-page-coverage/v1',
			'shared_state' => 'woocommerce-admin-page-coverage/<run_id>.json',
		'required'     => array( 'contract', 'targets', 'visits', 'skipped', 'request_logs', 'query_attribution', 'metrics' ),
		),
	);

	$unsafe_reasons = static function ( string $url ): array {
		$parts = wp_parse_url( $url );
		$path  = isset( $parts['path'] ) ? basename( $parts['path'] ) : '';
		parse_str( $parts['query'] ?? '', $query );
		$reasons = array();
		if ( in_array( $path, array( 'post-new.php', 'plugin-install.php', 'update-core.php', 'import.php', 'export.php', 'theme-install.php' ), true ) ) {
			$reasons[] = 'creation_install_update_or_export_screen';
		}
		foreach ( array( 'action', 'action2', 'delete', 'trash', 'untrash', 'activate', 'deactivate' ) as $key ) {
			if ( isset( $query[ $key ] ) ) {
				$reasons[] = 'unsafe_query_arg_' . $key;
			}
		}
		if ( isset( $query['page'] ) && preg_match( '/(setup|onboarding|wizard)/i', (string) $query['page'] ) ) {
			$reasons[] = 'setup_or_onboarding_screen';
		}
		return array_values( array_unique( $reasons ) );
	};

	global $menu, $submenu;
	require_once ABSPATH . 'wp-admin/includes/admin.php';
	if ( file_exists( ABSPATH . 'wp-admin/menu.php' ) ) {
		require ABSPATH . 'wp-admin/menu.php';
	} elseif ( ! did_action( 'admin_menu' ) ) {
		do_action( 'admin_menu', '' );
	}
	if ( ! is_array( $menu ) ) {
		$menu = array();
	}
	if ( ! is_array( $submenu ) ) {
		$submenu = array();
	}

	$candidates = array();
	$add_candidate = static function ( string $source, array $item ) use ( &$candidates, $normalize_admin_url ): void {
		$page = isset( $item[2] ) ? (string) $item[2] : '';
		if ( '' === $page || false !== strpos( $page, 'separator' ) ) {
			return;
		}
		$url = $normalize_admin_url( $page );
		$candidates[ $url ] = array(
			'label'      => isset( $item[0] ) ? wp_strip_all_tags( (string) $item[0] ) : '',
			'capability' => isset( $item[1] ) ? (string) $item[1] : '',
			'source'     => $source,
			'page'       => $page,
			'url'        => $url,
		);
	};
	foreach ( $menu as $item ) {
		$add_candidate( 'menu', (array) $item );
	}
	foreach ( $submenu as $parent => $items ) {
		foreach ( (array) $items as $item ) {
			$add_candidate( 'submenu:' . (string) $parent, (array) $item );
		}
	}

	$targets = array();
	$skipped = array();
	foreach ( $candidates as $candidate ) {
		$reasons = $unsafe_reasons( $candidate['url'] );
		if ( $reasons ) {
			$skipped[] = array_merge( $candidate, array( 'reasons' => $reasons ) );
			continue;
		}
		$targets[] = $candidate;
		if ( count( $targets ) >= $limit ) {
			break;
		}
	}

	$roles = array(
		'administrator' => array( 'user_id' => (int) $admin_user_id, 'cookie' => $build_cookie_header( (int) $admin_user_id ) ),
	);
	if ( $shop_manager_id && ! is_wp_error( $shop_manager_id ) ) {
		$roles['shop_manager'] = array( 'user_id' => (int) $shop_manager_id, 'cookie' => $build_cookie_header( (int) $shop_manager_id ) );
	} else {
		$skipped[] = array( 'source' => 'role', 'page' => 'shop_manager', 'url' => '', 'label' => 'Shop manager', 'reasons' => array( 'role_unavailable' ) );
	}

	$visits = array();
	foreach ( $roles as $role => $role_data ) {
		foreach ( $targets as $target ) {
			$url = add_query_arg( 'homeboy_admin_page_coverage_token', $token, $target['url'] );
			$before = microtime( true );
			$response = wp_remote_get(
				$url,
				array(
					'timeout'     => $timeout,
					'redirection' => 3,
					'headers'     => array( 'Cookie' => $role_data['cookie'] ),
				)
			);
			$elapsed = ( microtime( true ) - $before ) * 1000;
			if ( is_wp_error( $response ) ) {
				$visits[] = array_merge( $target, array( 'role' => $role, 'status' => 'error', 'error' => $response->get_error_message(), 'elapsed_ms' => $elapsed ) );
				continue;
			}
			$status_code = (int) wp_remote_retrieve_response_code( $response );
			$visit       = array_merge(
				$target,
				array(
					'role'        => $role,
					'status'      => 'visited',
					'status_code' => $status_code,
					'final_url'   => wp_remote_retrieve_header( $response, 'x-redirect-by' ) ? wp_remote_retrieve_header( $response, 'location' ) : '',
					'elapsed_ms'  => $elapsed,
				)
			);
			if ( 403 === $status_code && 'shop_manager' === $role && isset( $target['capability'] ) && '' !== $target['capability'] && ! user_can( (int) $role_data['user_id'], (string) $target['capability'] ) ) {
				$visit['status'] = 'skipped';
				$visit['reasons'] = array( 'permission_boundary' );
			}
			$visits[] = $visit;
		}
	}

	$request_logs = get_option( $log_option, array() );
	if ( ! is_array( $request_logs ) ) {
		$request_logs = array();
	}

	$normalize_query_shape = static function ( string $query ): string {
		$query = preg_replace( '#/\*.*?\*/#s', ' ', $query );
		$query = preg_replace( "/'(?:''|[^'])*'/", '?', (string) $query );
		$query = preg_replace( '/"(?:""|[^"])*"/', '?', (string) $query );
		$query = preg_replace( '/\b0x[0-9a-f]+\b/i', '?', (string) $query );
		$query = preg_replace( '/\b\d+(?:\.\d+)?\b/', '?', (string) $query );
		$query = preg_replace( '/\s+/', ' ', (string) $query );
		return strtolower( trim( (string) $query ) );
	};

	$query_family = static function ( string $query_shape ): string {
		$shape = str_replace( '`', '', strtolower( $query_shape ) );
		if ( preg_match( '/^select\b.*?\bfrom\s+([a-z0-9_]+)/', $shape, $matches ) ) {
			return 'select:' . $matches[1];
		}
		if ( preg_match( '/^(insert|replace)\s+into\s+([a-z0-9_]+)/', $shape, $matches ) ) {
			return $matches[1] . ':' . $matches[2];
		}
		if ( preg_match( '/^update\s+([a-z0-9_]+)/', $shape, $matches ) ) {
			return 'update:' . $matches[1];
		}
		if ( preg_match( '/^delete\s+from\s+([a-z0-9_]+)/', $shape, $matches ) ) {
			return 'delete:' . $matches[1];
		}
		if ( preg_match( '/^([a-z]+)/', $shape, $matches ) ) {
			return $matches[1] . ':other';
		}
		return 'unknown:other';
	};

	$top_counts = static function ( array $counts, string $field, int $limit = 10 ): array {
		arsort( $counts );
		$rows = array();
		foreach ( $counts as $value => $count ) {
			$rows[] = array( $field => (string) $value, 'count' => (int) $count );
			if ( count( $rows ) >= $limit ) {
				break;
			}
		}
		return $rows;
	};

	$query_shape_counts  = array();
	$query_family_counts = array();
	$query_sample_count  = 0;
	foreach ( $request_logs as $record ) {
		foreach ( (array) ( $record['query_shapes'] ?? array() ) as $query ) {
			$shape = $normalize_query_shape( (string) $query );
			if ( '' === $shape ) {
				continue;
			}
			$family = $query_family( $shape );
			$query_shape_counts[ $shape ]  = ( $query_shape_counts[ $shape ] ?? 0 ) + 1;
			$query_family_counts[ $family ] = ( $query_family_counts[ $family ] ?? 0 ) + 1;
			++$query_sample_count;
		}
	}
	$query_attribution = array(
		'schema'                   => 'homeboy-rigs/woocommerce-admin-query-attribution/v1',
		'sample_source'            => 'request_logs.query_shapes',
		'sample_limit_per_request' => 25,
		'sample_count'             => $query_sample_count,
		'top_query_shapes'         => $top_counts( $query_shape_counts, 'shape' ),
		'top_query_families'       => $top_counts( $query_family_counts, 'family' ),
	);
	@unlink( $mu_plugin );
	delete_option( $log_option );
	delete_option( $log_option . '_expected' );

	$status_counts             = array_count_values( array_map( static fn( array $visit ): string => (string) $visit['status'], $visits ) );
	$measured_visits           = array_filter( $visits, static fn( array $visit ): bool => 'skipped' !== (string) $visit['status'] );
	$http_errors               = array_filter( $measured_visits, static fn( array $visit ): bool => isset( $visit['status_code'] ) && (int) $visit['status_code'] >= 400 );
	$permission_boundary_skips = array_filter( $visits, static fn( array $visit ): bool => 'skipped' === (string) $visit['status'] && in_array( 'permission_boundary', (array) ( $visit['reasons'] ?? array() ), true ) );
	$status_code_counts        = array_count_values( array_map( 'strval', array_filter( array_column( $visits, 'status_code' ), 'is_numeric' ) ) );
	$skip_reason_counts        = array();
	foreach ( array_merge( $skipped, $visits ) as $row ) {
		foreach ( (array) ( $row['reasons'] ?? array() ) as $reason ) {
			$skip_reason_counts[ (string) $reason ] = ( $skip_reason_counts[ (string) $reason ] ?? 0 ) + 1;
		}
	}
	$php_errors                = 0;
	$query_counts              = array();
	$top_query_count_pages     = array();
	$php_error_summaries       = array();
	$php_fatal_summaries       = array();
	foreach ( $request_logs as $record ) {
		foreach ( (array) ( $record['php_errors'] ?? array() ) as $error ) {
			$php_errors++;
			$php_error_summaries[] = array(
				'path'     => (string) ( $record['path'] ?? '' ),
				'severity' => (int) ( $error['severity'] ?? 0 ),
				'message'  => (string) ( $error['message'] ?? '' ),
				'file'     => (string) ( $error['file'] ?? '' ),
				'line'     => (int) ( $error['line'] ?? 0 ),
			);
		}
		$last_error = (array) ( $record['last_error'] ?? array() );
		if ( $last_error && in_array( (int) ( $last_error['type'] ?? 0 ), array( E_ERROR, E_PARSE, E_CORE_ERROR, E_COMPILE_ERROR, E_USER_ERROR, E_RECOVERABLE_ERROR ), true ) ) {
			$php_fatal_summaries[] = array(
				'path'    => (string) ( $record['path'] ?? '' ),
				'type'    => (int) ( $last_error['type'] ?? 0 ),
				'message' => (string) ( $last_error['message'] ?? '' ),
				'file'    => isset( $last_error['file'] ) ? basename( (string) $last_error['file'] ) : '',
				'line'    => (int) ( $last_error['line'] ?? 0 ),
			);
		}
		if ( isset( $record['query_count'] ) ) {
			$query_count             = (int) $record['query_count'];
			$query_counts[]          = $query_count;
			$top_query_count_pages[] = array(
				'path'            => (string) ( $record['path'] ?? '' ),
				'query_count'     => $query_count,
				'elapsed_ms'      => isset( $record['elapsed_ms'] ) ? (float) $record['elapsed_ms'] : null,
				'php_error_count' => count( (array) ( $record['php_errors'] ?? array() ) ),
			);
		}
	}
	$top_slow_visited_pages = array_map(
		static fn( array $visit ): array => array(
			'label'      => (string) ( $visit['label'] ?? '' ),
			'page'       => (string) ( $visit['page'] ?? '' ),
			'role'       => (string) ( $visit['role'] ?? '' ),
			'status'     => (string) ( $visit['status'] ?? '' ),
			'elapsed_ms' => isset( $visit['elapsed_ms'] ) ? (float) $visit['elapsed_ms'] : null,
		),
		$visits
	);
	usort( $top_slow_visited_pages, static fn( array $left, array $right ): int => ( $right['elapsed_ms'] ?? 0 ) <=> ( $left['elapsed_ms'] ?? 0 ) );
	usort( $top_query_count_pages, static fn( array $left, array $right ): int => $right['query_count'] <=> $left['query_count'] );
	$summary = array(
		'success_rate'              => count( $measured_visits ) > 0 ? ( count( $measured_visits ) - count( $http_errors ) - ( $status_counts['error'] ?? 0 ) ) / count( $measured_visits ) : 0,
		'total_elapsed_ms'          => ( microtime( true ) - $started ) * 1000,
		'enumerated_admin_url_count' => count( $candidates ),
		'visited_admin_url_count'    => count( $targets ),
		'total_visit_count'          => count( $visits ),
		'skipped_unsafe_count'       => count( $skipped ),
		'skipped_permission_count'   => count( $permission_boundary_skips ),
		'http_error_count'           => count( $http_errors ),
		'request_error_count'        => $status_counts['error'] ?? 0,
		'php_error_notice_count'     => $php_errors,
		'max_query_count'            => $query_counts ? max( $query_counts ) : null,
		'avg_query_count'             => $query_counts ? array_sum( $query_counts ) / count( $query_counts ) : null,
		'top_slow_visited_pages'      => array_slice( $top_slow_visited_pages, 0, 5 ),
		'top_query_count_pages'       => array_slice( $top_query_count_pages, 0, 5 ),
		'status_code_counts'          => $status_code_counts,
		'permission_skip_count'       => count( $permission_boundary_skips ),
		'php_error_summaries'         => array_slice( $php_error_summaries, 0, 10 ),
		'php_fatal_summaries'         => array_slice( $php_fatal_summaries, 0, 10 ),
		'query_shape_sample_count'    => $query_attribution['sample_count'],
		'distinct_query_shape_count'  => count( $query_shape_counts ),
		'distinct_query_family_count' => count( $query_family_counts ),
		'top_query_shape_count'       => isset( $query_attribution['top_query_shapes'][0]['count'] ) ? $query_attribution['top_query_shapes'][0]['count'] : 0,
		'top_query_family_count'      => isset( $query_attribution['top_query_families'][0]['count'] ) ? $query_attribution['top_query_families'][0]['count'] : 0,
		'top_query_shapes'            => $query_attribution['top_query_shapes'],
		'top_query_families'          => $query_attribution['top_query_families'],
		'skip_reason_counts'          => $skip_reason_counts,
		'admin_page_contract_schema'  => $enumeration_contract['schema'],
		'artifact_contract_schema'    => $enumeration_contract['artifact_expectations']['schema'],
	);

	$artifact_path = '';
	$shared_state  = getenv( 'HOMEBOY_BENCH_SHARED_STATE' );
	if ( $shared_state ) {
		$artifact_dir = rtrim( $shared_state, '/' ) . '/woocommerce-admin-page-coverage';
		wp_mkdir_p( $artifact_dir );
		$artifact_path = $artifact_dir . '/' . $run_id . '.json';
		file_put_contents(
			$artifact_path,
			wp_json_encode(
				array(
					'schema'              => $enumeration_contract['artifact_expectations']['schema'],
					'run_id'              => $run_id,
					'woocommerce_version' => defined( 'WC_VERSION' ) ? WC_VERSION : '',
					'contract'            => $enumeration_contract,
					'limit'               => $limit,
					'targets'             => $targets,
					'visits'              => $visits,
					'skipped'             => $skipped,
					'request_logs'        => $request_logs,
					'query_attribution'  => $query_attribution,
					'metrics'             => $summary,
				),
				JSON_PRETTY_PRINT
			) . "\n"
		);
	}

	return array(
		'metrics'   => $summary,
		'metadata'  => array(
			'runner'         => 'wp-codebox',
			'workload'       => 'admin-page-coverage',
			'coverage_shape' => 'bounded authenticated wp-admin and Woo admin menu/submenu GET coverage',
			'contract'       => $enumeration_contract,
			'roles'          => array_keys( $roles ),
			'limit'          => $limit,
			'query_attribution' => $query_attribution,
		),
		'artifacts' => $artifact_path ? array( 'admin_page_coverage' => array( 'path' => $artifact_path, 'kind' => 'json' ) ) : array(),
	);
};
