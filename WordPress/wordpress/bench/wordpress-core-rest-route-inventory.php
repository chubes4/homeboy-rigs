<?php
/**
 * WP Codebox-backed WordPress core REST route inventory workload.
 *
 * Captures registered core route metadata without executing routes.
 */
return function (): array {
	$started = microtime( true );
	$run_id = 'wordpress-core-rest-route-inventory-' . getmypid() . '-' . time();

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
		if ( preg_match( '#^/wp/v2/(posts|pages|media|types|taxonomies)(?:/|$)#', $route ) ) {
			return 'content';
		}
		if ( preg_match( '#^/wp/v2/(settings|themes|users)(?:/|$)#', $route ) || 0 === strpos( $route, '/wp-block-editor/v1/' ) ) {
			return 'editor_bootstrap';
		}
		if ( 0 === strpos( $route, '/oembed/' ) || 0 === strpos( $route, '/wp-site-health/v1/' ) ) {
			return 'diagnostics';
		}
		if ( 0 === strpos( $route, '/wp/v2/' ) ) {
			return 'core_other';
		}

		return 'non_core';
	};

	$route_inventory = array();
	$namespace_counts = array(
		'content'          => 0,
		'editor_bootstrap' => 0,
		'diagnostics'      => 0,
		'core_other'       => 0,
		'non_core'         => 0,
	);

	foreach ( $routes as $route => $handlers ) {
		$classification = $classify_route( $route );
		++$namespace_counts[ $classification ];

		if ( 'non_core' === $classification ) {
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

	$core_route_count = $namespace_counts['content'] + $namespace_counts['editor_bootstrap'] + $namespace_counts['diagnostics'] + $namespace_counts['core_other'];
	$summary = array(
		'success_rate'                      => 1,
		'total_route_count'                 => count( $routes ),
		'core_route_count'                  => $core_route_count,
		'core_content_route_count'          => $namespace_counts['content'],
		'core_editor_bootstrap_route_count' => $namespace_counts['editor_bootstrap'],
		'core_diagnostics_route_count'      => $namespace_counts['diagnostics'],
		'core_other_route_count'            => $namespace_counts['core_other'],
		'total_elapsed_ms'                  => ( microtime( true ) - $started ) * 1000,
	);

	$artifact_path = '';
	$shared_state = getenv( 'HOMEBOY_BENCH_SHARED_STATE' );
	if ( $shared_state ) {
		$artifact_dir = rtrim( $shared_state, '/' ) . '/wordpress-core-rest-route-inventory';
		wp_mkdir_p( $artifact_dir );
		$artifact_path = $artifact_dir . '/' . $run_id . '.json';
		file_put_contents(
			$artifact_path,
			wp_json_encode(
				array(
					'run_id'           => $run_id,
					'wordpress_version' => get_bloginfo( 'version' ),
					'namespace_counts' => $namespace_counts,
					'routes'           => $route_inventory,
					'metrics'          => $summary,
				),
				JSON_PRETTY_PRINT
			) . "\n"
		);
	}

	return array(
		'metrics'   => $summary,
		'metadata'  => array(
			'runner'         => 'wp-codebox',
			'workload'       => 'wordpress-core-rest-route-inventory',
			'coverage_shape' => 'registered WordPress core REST route inventory',
			'manifest'       => 'manifests/rest-route-coverage.json',
		),
		'artifacts' => $artifact_path ? array( 'route_inventory' => array( 'path' => $artifact_path, 'kind' => 'json' ) ) : array(),
	);
};
