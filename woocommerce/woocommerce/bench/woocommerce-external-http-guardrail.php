<?php
/**
 * WooCommerce external HTTP guardrail coverage workload.
 */
return function (): array {
	if ( ! function_exists( 'wp_codebox_bench_run_external_http_guardrail_step' ) ) {
		throw new RuntimeException( 'WP Codebox external-http-guardrail bench primitive is not available.' );
	}

	wp_codebox_bench_run_external_http_guardrail_step(
		array(
			'type'             => 'external-http-guardrail',
			'action'           => 'install',
			'allowlistDomains' => array( 'woocommerce.com' ),
			'blockNetwork'     => true,
			'metric-prefix'    => 'woocommerce_external_http_guardrail_install',
		)
	);

	wp_remote_get( 'https://woocommerce.com/wp-json/wccom/marketplace/search?guardrail=1' );
	wp_remote_post( 'https://hooks.stripe.com/woocommerce/guardrail-probe', array( 'body' => array( 'event' => 'synthetic' ) ) );

	$payload = wp_codebox_bench_run_external_http_guardrail_step(
		array(
			'type'          => 'external-http-guardrail',
			'action'        => 'collect',
			'metric-prefix' => 'woocommerce_external_http_guardrail',
			'sampleLimit'   => 20,
		)
	);
	$payload['metadata'] = array_merge(
		$payload['metadata'] ?? array(),
		array(
			'runner'         => 'wp-codebox',
			'workload'       => 'woocommerce-external-http-guardrail',
			'coverage_shape' => 'marketplace and payment webhook external HTTP guardrail probes',
		)
	);
	return $payload;
};
