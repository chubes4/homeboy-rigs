<?php
/**
 * WordPress core external HTTP guardrail coverage workload.
 */
return function (): array {
	if ( ! function_exists( 'wp_codebox_bench_run_external_http_guardrail_step' ) ) {
		throw new RuntimeException( 'WP Codebox external-http-guardrail bench primitive is not available.' );
	}

	wp_codebox_bench_run_external_http_guardrail_step(
		array(
			'type'             => 'external-http-guardrail',
			'action'           => 'install',
			'allowlistDomains' => array( 'api.wordpress.org' ),
			'blockNetwork'     => true,
			'metric-prefix'    => 'core_external_http_guardrail_install',
		)
	);

	wp_remote_get( 'https://api.wordpress.org/core/version-check/1.7/?channel=stable' );
	wp_remote_get( 'https://downloads.wordpress.org/release-check/guardrail-probe?token=synthetic' );

	$payload = wp_codebox_bench_run_external_http_guardrail_step(
		array(
			'type'          => 'external-http-guardrail',
			'action'        => 'collect',
			'metric-prefix' => 'core_external_http_guardrail',
			'sampleLimit'   => 20,
		)
	);
	$payload['metadata'] = array_merge(
		$payload['metadata'] ?? array(),
		array(
			'runner'         => 'wp-codebox',
			'workload'       => 'wordpress-core-external-http-guardrail',
			'coverage_shape' => 'core update and release-check external HTTP guardrail probes',
		)
	);
	return $payload;
};
