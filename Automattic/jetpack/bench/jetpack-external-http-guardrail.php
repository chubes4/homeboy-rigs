<?php
/**
 * Jetpack external HTTP guardrail coverage workload.
 */
return function (): array {
	if ( ! function_exists( 'wp_codebox_bench_run_external_http_guardrail_step' ) ) {
		throw new RuntimeException( 'WP Codebox external-http-guardrail bench primitive is not available.' );
	}

	wp_codebox_bench_run_external_http_guardrail_step(
		array(
			'type'             => 'external-http-guardrail',
			'action'           => 'install',
			'allowlistDomains' => array( 'public-api.wordpress.com' ),
			'blockNetwork'     => true,
			'metric-prefix'    => 'jetpack_external_http_guardrail_install',
		)
	);

	wp_remote_get( 'https://public-api.wordpress.com/rest/v1.1/sites/example.wordpress.com?guardrail=1' );
	wp_remote_post( 'https://jetpack.wordpress.com/guardrail-probe', array( 'body' => array( 'event' => 'synthetic' ) ) );

	$payload = wp_codebox_bench_run_external_http_guardrail_step(
		array(
			'type'          => 'external-http-guardrail',
			'action'        => 'collect',
			'metric-prefix' => 'jetpack_external_http_guardrail',
			'sampleLimit'   => 20,
		)
	);
	$payload['metadata'] = array_merge(
		$payload['metadata'] ?? array(),
		array(
			'runner'         => 'wp-codebox',
			'workload'       => 'jetpack-external-http-guardrail',
			'coverage_shape' => 'Jetpack connection and service API external HTTP guardrail probes',
		)
	);
	return $payload;
};
