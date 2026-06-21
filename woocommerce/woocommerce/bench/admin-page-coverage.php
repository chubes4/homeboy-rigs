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
			'label'  => isset( $item[0] ) ? wp_strip_all_tags( (string) $item[0] ) : '',
			'source' => $source,
			'page'   => $page,
			'url'    => $url,
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
		'admin' => array( 'user_id' => (int) $admin_user_id, 'cookie' => $build_cookie_header( (int) $admin_user_id ) ),
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
			$visits[] = array_merge(
				$target,
				array(
					'role'        => $role,
					'status'      => 'visited',
					'status_code' => wp_remote_retrieve_response_code( $response ),
					'final_url'   => wp_remote_retrieve_header( $response, 'x-redirect-by' ) ? wp_remote_retrieve_header( $response, 'location' ) : '',
					'elapsed_ms'  => $elapsed,
				)
			);
		}
	}

	$request_logs = get_option( $log_option, array() );
	if ( ! is_array( $request_logs ) ) {
		$request_logs = array();
	}
	@unlink( $mu_plugin );
	delete_option( $log_option );
	delete_option( $log_option . '_expected' );

	$status_counts = array_count_values( array_map( static fn( array $visit ): string => (string) $visit['status'], $visits ) );
	$http_errors   = array_filter( $visits, static fn( array $visit ): bool => isset( $visit['status_code'] ) && (int) $visit['status_code'] >= 400 );
	$php_errors    = 0;
	$query_counts  = array();
	foreach ( $request_logs as $record ) {
		$php_errors += count( (array) ( $record['php_errors'] ?? array() ) );
		if ( isset( $record['query_count'] ) ) {
			$query_counts[] = (int) $record['query_count'];
		}
	}

	$summary = array(
		'success_rate'              => count( $visits ) > 0 ? ( count( $visits ) - count( $http_errors ) - ( $status_counts['error'] ?? 0 ) ) / count( $visits ) : 0,
		'total_elapsed_ms'          => ( microtime( true ) - $started ) * 1000,
		'enumerated_admin_url_count' => count( $candidates ),
		'visited_admin_url_count'    => count( $targets ),
		'total_visit_count'          => count( $visits ),
		'skipped_unsafe_count'       => count( $skipped ),
		'http_error_count'           => count( $http_errors ),
		'request_error_count'        => $status_counts['error'] ?? 0,
		'php_error_notice_count'     => $php_errors,
		'max_query_count'            => $query_counts ? max( $query_counts ) : null,
		'avg_query_count'            => $query_counts ? array_sum( $query_counts ) / count( $query_counts ) : null,
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
					'run_id'              => $run_id,
					'woocommerce_version' => defined( 'WC_VERSION' ) ? WC_VERSION : '',
					'limit'               => $limit,
					'targets'             => $targets,
					'visits'              => $visits,
					'skipped'             => $skipped,
					'request_logs'        => $request_logs,
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
			'roles'          => array_keys( $roles ),
			'limit'          => $limit,
		),
		'artifacts' => $artifact_path ? array( 'admin_page_coverage' => array( 'path' => $artifact_path, 'kind' => 'json' ) ) : array(),
	);
};
