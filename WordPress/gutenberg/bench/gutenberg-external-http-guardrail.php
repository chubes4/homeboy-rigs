<?php
/**
 * Gutenberg external HTTP guardrail coverage workload.
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
			'metric-prefix'    => 'gutenberg_external_http_guardrail_install',
		)
	);

	wp_remote_get( 'https://api.wordpress.org/patterns/1.0/?locale=en_US' );
	wp_remote_get( 'https://patterns.wordpress.org/guardrail-probe?client=gutenberg' );

	$payload = wp_codebox_bench_run_external_http_guardrail_step(
		array(
			'type'          => 'external-http-guardrail',
			'action'        => 'collect',
			'metric-prefix' => 'gutenberg_external_http_guardrail',
			'sampleLimit'   => 20,
		)
	);
	$payload['metadata'] = array_merge(
		$payload['metadata'] ?? array(),
		array(
			'runner'         => 'wp-codebox',
			'workload'       => 'gutenberg-external-http-guardrail',
			'coverage_shape' => 'pattern directory and editor library external HTTP guardrail probes',
		)
	);
	return $payload;
};
