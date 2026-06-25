<?php
/**
 * WP Codebox-backed WooCommerce generated safe REST request workload.
 *
 * Generates GET-only request cases from the live REST route inventory, executes the
 * bounded cases locally, and emits route coverage/gap artifacts for review.
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

	$template_functions = WP_PLUGIN_DIR . '/woocommerce/includes/wc-template-functions.php';
	if ( is_readable( $template_functions ) ) {
		require_once $template_functions;
	}

	$run_id = 'generated-rest-request-cases-' . getmypid() . '-' . time();
	$server = rest_get_server();
	if ( class_exists( Automattic\WooCommerce\RestApi\Server::class ) ) {
		Automattic\WooCommerce\RestApi\Server::instance()->register_rest_routes();
	}

	$routes = $server->get_routes();
	ksort( $routes );

	$classify_route = static function ( string $route ): string {
		if ( preg_match( '#^/wc/store(?:/|$)#', $route ) ) {
			return 'store_api';
		}
		if ( preg_match( '#^/wc/v\d+(?:/|$)#', $route ) ) {
			return 'wc_rest_api';
		}
		if ( preg_match( '#^/wc-admin(?:/|$)#', $route ) ) {
			return 'wc_admin_api';
		}
		if ( preg_match( '#^/wc-analytics(?:/|$)#', $route ) ) {
			return 'wc_analytics_api';
		}

		return 'outside_scope';
	};

	$expected_statuses = static function ( string $surface, string $route ): array {
		if ( 'store_api' === $surface ) {
			if ( preg_match( '#^/wc/store(?:/v\d+)?/(products|cart|checkout|product-categories|product-collection-data|product-reviews|products/)#', $route ) ) {
				return array( 200 );
			}

			return array( 200, 401, 403 );
		}

		return array( 200, 401, 403 );
	};

	$expected_outcome = static function ( string $surface, array $statuses ): string {
		if ( 'store_api' === $surface && array( 200 ) === $statuses ) {
			return 'public_read_success';
		}

		return 'bounded_read_or_auth_boundary';
	};

	$default_params = static function ( string $route ): array {
		if ( preg_match( '#/(products|orders|customers|coupons|reviews|reports|categories|tags|attributes)(?:/|$)#', $route ) ) {
			return array( 'per_page' => 1 );
		}

		return array();
	};

	$cases = array();
	$skipped = array();
	$namespace_counts = array(
		'store_api'        => array( 'routes' => 0, 'covered' => 0, 'skipped' => 0 ),
		'wc_rest_api'      => array( 'routes' => 0, 'covered' => 0, 'skipped' => 0 ),
		'wc_admin_api'     => array( 'routes' => 0, 'covered' => 0, 'skipped' => 0 ),
		'wc_analytics_api' => array( 'routes' => 0, 'covered' => 0, 'skipped' => 0 ),
	);

	foreach ( $routes as $route => $handlers ) {
		$surface = $classify_route( $route );
		if ( 'outside_scope' === $surface ) {
			continue;
		}

		++$namespace_counts[ $surface ]['routes'];

		if ( false !== strpos( $route, '(?P<' ) ) {
			++$namespace_counts[ $surface ]['skipped'];
			$skipped[] = array(
				'path'        => $route,
				'surface'     => $surface,
				'reason_code' => 'dynamic_path_parameter',
			);
			continue;
		}

		$allows_get = false;
		foreach ( $handlers as $handler ) {
			foreach ( (array) ( $handler['methods'] ?? array() ) as $method => $enabled ) {
				$method_name = is_string( $method ) ? $method : (string) $enabled;
				if ( 'GET' === strtoupper( $method_name ) && $enabled ) {
					$allows_get = true;
				}
			}
		}

		if ( ! $allows_get ) {
			++$namespace_counts[ $surface ]['skipped'];
			$skipped[] = array(
				'path'        => $route,
				'surface'     => $surface,
				'reason_code' => 'no_safe_read_method',
			);
			continue;
		}

		$statuses = $expected_statuses( $surface, $route );
		$cases[] = array(
			'id'                => sanitize_key( trim( str_replace( '/', '-', $route ), '-' ) ),
			'method'            => 'GET',
			'path'              => $route,
			'params'            => $default_params( $route ),
			'capture_response'  => true,
			'expected_statuses' => $statuses,
			'metadata'          => array(
				'surface'          => $surface,
				'expected_outcome' => $expected_outcome( $surface, $statuses ),
				'source'           => 'registered-rest-route-inventory',
			),
		);
		++$namespace_counts[ $surface ]['covered'];
	}

	$responses = array();
	foreach ( $cases as $case ) {
		$request = new WP_REST_Request( $case['method'], $case['path'] );
		foreach ( $case['params'] as $key => $value ) {
			$request->set_param( $key, $value );
		}

		$response = rest_do_request( $request );
		$status   = (int) $response->get_status();
		$responses[] = array(
			'id'              => $case['id'],
			'path'            => $case['path'],
			'method'          => $case['method'],
			'surface'         => $case['metadata']['surface'],
			'status'          => $status,
			'expected_status' => in_array( $status, $case['expected_statuses'], true ),
		);
	}

	$coverage_gap = array(
		'schema'        => 'homeboy-rigs/woocommerce-rest-route-coverage-gap/v1',
		'surface_type'  => 'rest',
		'expected'      => $namespace_counts,
		'covered'       => array_column( $cases, 'path' ),
		'gaps'          => $skipped,
		'status'        => empty( $skipped ) ? 'covered' : 'partial',
		'evidence_refs' => array( 'artifact:rest_request_cases' ),
	);

	$summary = array(
		'generated_case_count' => count( $cases ),
		'skipped_route_count'  => count( $skipped ),
		'response_count'       => count( $responses ),
		'namespace_counts'     => $namespace_counts,
		'total_elapsed_ms'     => ( microtime( true ) - $started ) * 1000,
	);

	$artifact_path = '';
	$shared_state  = getenv( 'WP_CODEBOX_BENCH_SHARED_STATE' );
	if ( $shared_state ) {
		$artifact_dir = rtrim( $shared_state, '/' ) . '/generated-rest-request-cases';
		wp_mkdir_p( $artifact_dir );
		$artifact_path = $artifact_dir . '/' . $run_id . '.json';
		file_put_contents(
			$artifact_path,
			wp_json_encode(
				array(
					'schema'              => 'homeboy/wordpress-rest-request-cases/v1',
					'run_id'              => $run_id,
					'woocommerce_version' => defined( 'WC_VERSION' ) ? WC_VERSION : '',
					'generation'          => array(
						'source'       => 'registered-rest-route-inventory',
						'safe_methods' => array( 'GET' ),
						'namespaces'    => array( 'wc/store*', 'wc/v*', 'wc-admin', 'wc-analytics' ),
					),
					'cases'               => $cases,
					'responses'           => $responses,
					'coverage_gap'        => $coverage_gap,
					'metrics'             => $summary,
				),
				JSON_PRETTY_PRINT
			) . "\n"
		);
	}

	return array(
		'metrics'   => $summary,
		'metadata'  => array(
			'runner'              => 'wp-codebox',
			'workload'            => 'generated-rest-request-cases',
			'coverage_shape'      => 'route-inventory-generated safe WooCommerce Store API, wc/v*, wc-admin, and wc-analytics GET request cases',
			'status_contract'     => array(
				'public_read_success'           => 'Expected 200 for read-only public Store API catalog/session routes.',
				'bounded_read_or_auth_boundary' => 'Expected 200, 401, or 403 for bounded GET cases depending on route permissions.',
			),
			'coverage_gap_schema' => 'homeboy-rigs/woocommerce-rest-route-coverage-gap/v1',
		),
		'artifacts' => $artifact_path ? array( 'rest_request_cases' => array( 'path' => $artifact_path, 'kind' => 'json' ) ) : array(),
	);
};
