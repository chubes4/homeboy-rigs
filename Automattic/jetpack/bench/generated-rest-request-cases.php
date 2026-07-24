<?php
/**
 * WP Codebox-backed Jetpack generated safe REST request workload.
 *
 * Executes the static GET-only Jetpack REST request case plan and emits request
 * results plus skip-reason artifacts for the stable workload evidence contract.
 */
return function (): array {
	$started = microtime( true );
	$run_id  = 'generated-rest-request-cases-' . getmypid() . '-' . time();

	$jetpack_entrypoint = WP_PLUGIN_DIR . '/jetpack/jetpack.php';
	if ( ! file_exists( $jetpack_entrypoint ) ) {
		throw new RuntimeException( 'Jetpack plugin entrypoint is not mounted.' );
	}

	if ( ! defined( 'JETPACK__PLUGIN_FILE' ) ) {
		require_once $jetpack_entrypoint;
	}
	if ( ! function_exists( 'is_plugin_active' ) ) {
		require_once ABSPATH . 'wp-admin/includes/plugin.php';
	}
	if ( ! is_plugin_active( 'jetpack/jetpack.php' ) ) {
		activate_plugin( 'jetpack/jetpack.php' );
	}

	$workload_path = __DIR__ . '/generated-rest-request-cases.workload.json';
	$workload_json = is_readable( $workload_path ) ? file_get_contents( $workload_path ) : jetpack_homeboy_generated_rest_request_cases_config();
	$workload      = json_decode( $workload_json, true );
	if ( ! is_array( $workload ) || ! isset( $workload['rest_request_cases'] ) || ! is_array( $workload['rest_request_cases'] ) ) {
		throw new RuntimeException( 'Jetpack generated REST workload config is invalid.' );
	}

	$server = rest_get_server();
	do_action( 'rest_api_init', $server );
	$routes = $server->get_routes();
	ksort( $routes );
	$jetpack_route_sample = array_slice(
		array_values(
			array_filter(
				array_keys( $routes ),
				static fn ( $route ) => str_starts_with( $route, '/jetpack/v4' ) || str_starts_with( $route, '/wpcom/v2' )
			)
		),
		0,
		20
	);

	$administrator_id = 0;
	$administrators   = get_users(
		array(
			'role'   => 'administrator',
			'number' => 1,
			'fields' => 'ID',
		)
	);
	if ( ! empty( $administrators ) ) {
		$administrator_id = (int) $administrators[0];
	}

	$responses    = array();
	$skip_reasons = array();
	$case_count   = 0;

	foreach ( $workload['rest_request_cases'] as $case ) {
		++$case_count;
		$case_id     = (string) ( $case['id'] ?? 'unnamed-case' );
		$path        = (string) ( $case['path'] ?? '' );
		$method      = strtoupper( (string) ( $case['method'] ?? 'GET' ) );
		$skip_reason = isset( $case['skip_reason'] ) ? (string) $case['skip_reason'] : '';

		if ( 'GET' !== $method ) {
			$skip_reasons[] = array(
				'id'          => $case_id,
				'path'        => $path,
				'reason_code' => 'no_safe_read_method',
			);
			continue;
		}

		if ( $skip_reason ) {
			$skip_reasons[] = array(
				'id'          => $case_id,
				'path'        => $path,
				'reason_code' => $skip_reason,
			);
			continue;
		}

		if ( ! isset( $routes[ $path ] ) ) {
			$skip_reasons[] = array(
				'id'          => $case_id,
				'path'        => $path,
				'reason_code' => 'route_absent',
			);
			continue;
		}

		$previous_user_id = get_current_user_id();
		if ( ! empty( $case['auth_required'] ) && $administrator_id > 0 ) {
			wp_set_current_user( $administrator_id );
		} else {
			wp_set_current_user( 0 );
		}

		$request = new WP_REST_Request( $method, $path );
		foreach ( (array) ( $case['params'] ?? array() ) as $key => $value ) {
			$request->set_param( $key, $value );
		}

		$response          = rest_do_request( $request );
		$status            = (int) $response->get_status();
		$expected_statuses = array_map( 'intval', (array) ( $case['expected_statuses'] ?? array() ) );
		$responses[]       = array(
			'id'               => $case_id,
			'path'             => $path,
			'method'           => $method,
			'persona'          => (string) ( $case['persona'] ?? '' ),
			'permission_class' => (string) ( $case['permission_class'] ?? '' ),
			'status'           => $status,
			'expected_status'  => in_array( $status, $expected_statuses, true ),
		);

		wp_set_current_user( $previous_user_id );
	}

	$summary = array(
		'generated_case_count' => $case_count,
		'response_count'       => count( $responses ),
		'skipped_case_count'   => count( $skip_reasons ),
		'available_route_count' => count( $routes ),
		'jetpack_route_sample' => $jetpack_route_sample,
		'skip_reasons'         => $skip_reasons,
		'total_elapsed_ms'     => ( microtime( true ) - $started ) * 1000,
	);

	$request_cases_payload = array(
		'schema'     => 'homeboy/wordpress-rest-request-cases/v1',
		'run_id'     => $run_id,
		'plugin'     => 'jetpack',
		'generation' => array(
			'source'       => 'static-generated-rest-request-cases.workload.json',
			'safe_methods' => array( 'GET' ),
			'namespaces'    => array( 'jetpack/v4', 'wpcom/v2' ),
		),
		'cases'      => $workload['rest_request_cases'],
		'responses'  => $responses,
		'metrics'    => $summary,
	);
	$skip_reasons_payload = array(
		'schema'       => 'homeboy/wordpress-rest-skip-reasons/v1',
		'run_id'       => $run_id,
		'plugin'       => 'jetpack',
		'skip_reasons' => $skip_reasons,
		'metrics'      => array( 'skipped_case_count' => count( $skip_reasons ) ),
	);

	$shared_state = getenv( 'WP_CODEBOX_BENCH_SHARED_STATE' );
	if ( $shared_state ) {
		$artifact_dir = rtrim( $shared_state, '/' ) . '/generated-rest-request-cases';
		wp_mkdir_p( $artifact_dir );

		$request_cases_path = $artifact_dir . '/rest_request_cases.json';
		file_put_contents(
			$request_cases_path,
			wp_json_encode( $request_cases_payload, JSON_PRETTY_PRINT ) . "\n"
		);

		$skip_reasons_path = $artifact_dir . '/rest_skip_reasons.json';
		file_put_contents(
			$skip_reasons_path,
			wp_json_encode( $skip_reasons_payload, JSON_PRETTY_PRINT ) . "\n"
		);
	}

	return array(
		'metrics'   => $summary,
		'metadata'  => array(
			'runner'              => 'wp-codebox',
			'workload'            => 'generated-rest-request-cases',
			'coverage_shape'      => 'static safe Jetpack jetpack/v4 and wpcom/v2 GET request cases with connected-service skips classified',
			'skip_reason_codes'   => $workload['metadata']['skip_reason_codes'] ?? array(),
			'real_wpcom_credentials_allowed' => false,
		),
		'artifacts' => array(
			'rest_request_cases' => $request_cases_payload,
			'rest_skip_reasons'  => $skip_reasons_payload,
		),
	);
};

function jetpack_homeboy_generated_rest_request_cases_config(): string {
	return <<<'JSON'
{
  "id": "generated-rest-request-cases",
  "source": "config",
  "rest_request_cases": [
    {
      "id": "jetpack-namespace-root",
      "method": "GET",
      "path": "/jetpack/v4",
      "capture-response": true,
      "permission_class": "public_route_index",
      "persona": "anonymous",
      "auth_required": false,
      "mutating": false,
      "expected_statuses": [200, 401, 403, 404]
    },
    {
      "id": "jetpack-options-backup",
      "method": "GET",
      "path": "/jetpack/v4/options/backup",
      "capture-response": true,
      "permission_class": "site_token_or_boundary_denial",
      "persona": "anonymous",
      "auth_required": false,
      "mutating": false,
      "params": { "name": "siteurl" },
      "expected_statuses": [200, 400, 401, 403, 404]
    },
    {
      "id": "jetpack-database-object-backup",
      "method": "GET",
      "path": "/jetpack/v4/database-object/backup",
      "capture-response": true,
      "permission_class": "site_token_or_boundary_denial",
      "persona": "anonymous",
      "auth_required": false,
      "mutating": false,
      "params": { "object_type": "woocommerce_attribute", "object_id": 1 },
      "expected_statuses": [200, 400, 401, 403, 404]
    },
    {
      "id": "jetpack-connection",
      "method": "GET",
      "path": "/jetpack/v4/connection",
      "capture-response": true,
      "permission_class": "connected_site_required",
      "persona": "connected-site-placeholder",
      "auth_required": true,
      "mutating": false,
      "skip_reason": "connected_required",
      "expected_statuses": [200, 401, 403, 404]
    },
    {
      "id": "jetpack-connection-status",
      "method": "GET",
      "path": "/jetpack/v4/connection/status",
      "capture-response": true,
      "permission_class": "connected_site_required",
      "persona": "connected-site-placeholder",
      "auth_required": true,
      "mutating": false,
      "skip_reason": "connected_required",
      "expected_statuses": [200, 401, 403, 404]
    },
    {
      "id": "wpcom-publicize-services",
      "method": "GET",
      "path": "/wpcom/v2/publicize/services",
      "capture-response": true,
      "permission_class": "public_read_or_wpcom_dependent",
      "persona": "anonymous",
      "auth_required": false,
      "mutating": false,
      "skip_reason": "wpcom_dependent",
      "expected_statuses": [200, 401, 403, 404]
    },
    {
      "id": "wpcom-site-settings",
      "method": "GET",
      "path": "/wpcom/v2/sites/example.wordpress.com/settings",
      "capture-response": true,
      "permission_class": "wpcom_dependent",
      "persona": "connected-site-placeholder",
      "auth_required": true,
      "mutating": false,
      "placeholder_parameters": { "site": "example.wordpress.com" },
      "skip_reason": "credential_unavailable",
      "expected_statuses": [401, 403, 404],
      "boundary": "No live WordPress.com credentials are supplied in the fixture; forbidden or skipped is expected."
    }
  ],
  "metadata": {
    "runner": "wp-codebox",
    "workload": "generated-rest-request-cases",
    "coverage_shape": "generated safe Jetpack REST request cases",
    "manifest": "manifests/rest-route-coverage.json",
    "method_allowlist": ["GET"],
    "mutating_methods_allowed": false,
    "real_wpcom_credentials_allowed": false,
    "personas": ["anonymous", "administrator", "connected-site-placeholder"],
    "skip_reason_codes": ["connected_required", "credential_unavailable", "route_absent", "wpcom_dependent"],
    "required_artifacts": ["rest_request_cases", "rest_skip_reasons"],
    "optional_artifacts": ["connected_site_response_samples", "wpcom_credentialed_response_samples"],
    "permission_classifications": ["public_route_index", "public_read_or_wpcom_dependent", "site_token_or_boundary_denial", "connected_site_required", "wpcom_dependent"]
  }
}
JSON;
}
