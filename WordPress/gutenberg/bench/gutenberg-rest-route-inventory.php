<?php
/**
 * WP Codebox-backed Gutenberg REST route inventory workload.
 *
 * Captures registered Gutenberg-facing route metadata without executing routes.
 */
return function (): array {
	$started = microtime( true );

	$gutenberg_entrypoint = WP_PLUGIN_DIR . '/gutenberg/gutenberg.php';
	if ( file_exists( $gutenberg_entrypoint ) && ! defined( 'GUTENBERG_VERSION' ) ) {
		require_once $gutenberg_entrypoint;
	}

	$run_id = 'gutenberg-rest-route-inventory-' . getmypid() . '-' . time();
	$server = rest_get_server();
	$routes = $server->get_routes();
	ksort( $routes );

	$summarize_callback = static function ( $callback ): string {
		if ( is_string( $callback ) ) {
			return $callback;
		}
		if ( $callback instanceof Closure ) {
			return 'Closure';
		}
		if ( is_array( $callback ) && 2 === count( $callback ) ) {
			$target = is_object( $callback[0] ) ? get_class( $callback[0] ) : (string) $callback[0];
			return $target . '::' . (string) $callback[1];
		}
		if ( is_object( $callback ) && method_exists( $callback, '__invoke' ) ) {
			return get_class( $callback ) . '::__invoke';
		}

		return gettype( $callback );
	};

	$classify_route = static function ( string $route ): string {
		$editor_prefixes = array(
			'/wp/v2/block-patterns',
			'/wp/v2/global-styles',
			'/wp/v2/navigation',
			'/wp/v2/templates',
			'/wp/v2/template-parts',
		);
		foreach ( $editor_prefixes as $prefix ) {
			if ( 0 === strpos( $route, $prefix ) ) {
				return 'editor_data';
			}
		}
		if ( 0 === strpos( $route, '/wp/v2/block-directory' ) || 0 === strpos( $route, '/wp/v2/block-renderer' ) ) {
			return 'dynamic_rendering';
		}
		if ( 0 === strpos( $route, '/__experimental' ) ) {
			return 'experimental';
		}

		return 'non_gutenberg';
	};

	$route_inventory = array();
	$namespace_counts = array(
		'editor_data'       => 0,
		'dynamic_rendering' => 0,
		'experimental'      => 0,
		'non_gutenberg'     => 0,
	);

	foreach ( $routes as $route => $handlers ) {
		$classification = $classify_route( $route );
		++$namespace_counts[ $classification ];

		if ( 'non_gutenberg' === $classification ) {
			continue;
		}

		$endpoints = array();
		foreach ( $handlers as $handler ) {
			if ( ! is_array( $handler ) || empty( $handler['callback'] ) ) {
				continue;
			}

			$methods = array();
			foreach ( (array) ( $handler['methods'] ?? array() ) as $method => $enabled ) {
				if ( is_string( $method ) && $enabled ) {
					$methods[] = $method;
				} elseif ( is_string( $enabled ) ) {
					$methods[] = $enabled;
				}
			}
			sort( $methods );

			$endpoints[] = array(
				'methods'  => $methods,
				'callback' => $summarize_callback( $handler['callback'] ),
			);
		}

		$route_inventory[] = array(
			'path'      => $route,
			'namespace' => $classification,
			'endpoints' => $endpoints,
		);
	}

	$gutenberg_route_count = $namespace_counts['editor_data'] + $namespace_counts['dynamic_rendering'] + $namespace_counts['experimental'];
	$summary = array(
		'success_rate'                  => 1,
		'total_route_count'             => count( $routes ),
		'gutenberg_route_count'         => $gutenberg_route_count,
		'gutenberg_editor_route_count'  => $namespace_counts['editor_data'],
		'gutenberg_dynamic_route_count' => $namespace_counts['dynamic_rendering'],
		'gutenberg_experimental_count'  => $namespace_counts['experimental'],
		'total_elapsed_ms'              => ( microtime( true ) - $started ) * 1000,
	);

	$artifact_path = '';
	$shared_state = getenv( 'HOMEBOY_BENCH_SHARED_STATE' );
	if ( $shared_state ) {
		$artifact_dir = rtrim( $shared_state, '/' ) . '/gutenberg-rest-route-inventory';
		wp_mkdir_p( $artifact_dir );
		$artifact_path = $artifact_dir . '/' . $run_id . '.json';
		file_put_contents(
			$artifact_path,
			wp_json_encode(
				array(
					'run_id'             => $run_id,
					'gutenberg_version'  => defined( 'GUTENBERG_VERSION' ) ? GUTENBERG_VERSION : '',
					'namespace_counts'   => $namespace_counts,
					'routes'             => $route_inventory,
					'metrics'            => $summary,
				),
				JSON_PRETTY_PRINT
			) . "\n"
		);
	}

	return array(
		'metrics'   => $summary,
		'metadata'  => array(
			'runner'         => 'wp-codebox',
			'workload'       => 'gutenberg-rest-route-inventory',
			'coverage_shape' => 'registered Gutenberg-facing REST route inventory',
			'manifest'       => 'manifests/rest-route-coverage.json',
		),
		'artifacts' => $artifact_path ? array( 'route_inventory' => array( 'path' => $artifact_path, 'kind' => 'json' ) ) : array(),
	);
};
