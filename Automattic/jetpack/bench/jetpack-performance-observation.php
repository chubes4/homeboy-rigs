<?php
/**
 * Jetpack local performance observation.
 *
 * This observes bounded local REST dispatch and runtime metrics. Browser and
 * connected WordPress.com surfaces remain explicit follow-up classifications.
 */
return function (): array {
	$network_calls = array();
	$block_http    = static function ( $preempt, $args, $url ) use ( &$network_calls ) {
		$network_calls[] = esc_url_raw( $url );
		return new WP_Error( 'homeboy_jetpack_performance_network_blocked', 'Outbound HTTP is blocked by the Jetpack performance fixture.' );
	};
	add_filter( 'pre_http_request', $block_http, 10, 3 );

	$started = microtime( true );
	try {
		$request  = new WP_REST_Request( 'GET', '/jetpack/v4' );
		$response = rest_do_request( $request );
	} finally {
		remove_filter( 'pre_http_request', $block_http, 10 );
	}
	$duration_ms = round( ( microtime( true ) - $started ) * 1000, 3 );

	$observation = array(
		'rest' => array(
			'route'       => '/jetpack/v4',
			'status'      => $response->get_status(),
			'duration_ms' => $duration_ms,
		),
		'memory' => array(
			'usage_bytes' => memory_get_usage( true ),
			'peak_bytes'  => memory_get_peak_usage( true ),
		),
		'network' => array( 'allowed' => false, 'blocked_attempts' => $network_calls ),
		'unexecuted_surfaces' => array(
			array( 'surface' => 'browser_requests', 'reason' => 'separate_browser_workload_required' ),
			array( 'surface' => 'connected_wpcom', 'reason' => 'provisioned_connected_state_required' ),
		),
	);

	return array(
		'metrics'   => array( 'rest_duration_ms' => $duration_ms, 'blocked_http_attempts' => count( $network_calls ) ),
		'artifacts' => array( 'jetpack_performance_observation' => $observation ),
	);
};
