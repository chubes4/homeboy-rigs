<?php
/**
 * WP Codebox-backed Jetpack REST route inventory workload.
 *
 * Captures registered Jetpack route metadata without executing routes.
 */
return function (): array {
	$started = microtime( true );

	$jetpack_entrypoint = WP_PLUGIN_DIR . '/jetpack/jetpack.php';
	if ( file_exists( $jetpack_entrypoint ) && ! defined( 'JETPACK__VERSION' ) ) {
		require_once $jetpack_entrypoint;
	}

	$run_id = 'jetpack-rest-route-inventory-' . getmypid() . '-' . time();
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
		if ( 0 === strpos( $route, '/jetpack/v4/connection' ) ) {
			return 'connection';
		}
		if ( 0 === strpos( $route, '/jetpack/v4/modules' ) || 0 === strpos( $route, '/jetpack/v4/settings' ) ) {
			return 'module_settings';
		}
		if ( 0 === strpos( $route, '/jetpack/v4/site' ) || 0 === strpos( $route, '/wpcom/v2/' ) ) {
			return 'site_data';
		}
		if ( 0 === strpos( $route, '/jetpack/v4/' ) ) {
			return 'jetpack_other';
		}

		return 'non_jetpack';
	};

	$route_inventory = array();
	$namespace_counts = array(
		'connection'      => 0,
		'module_settings' => 0,
		'site_data'       => 0,
		'jetpack_other'   => 0,
		'non_jetpack'     => 0,
	);

	foreach ( $routes as $route => $handlers ) {
		$classification = $classify_route( $route );
		++$namespace_counts[ $classification ];

		if ( 'non_jetpack' === $classification ) {
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

	$jetpack_route_count = $namespace_counts['connection'] + $namespace_counts['module_settings'] + $namespace_counts['site_data'] + $namespace_counts['jetpack_other'];
	$summary = array(
		'success_rate'                         => 1,
		'total_route_count'                    => count( $routes ),
		'jetpack_route_count'                  => $jetpack_route_count,
		'jetpack_connection_route_count'       => $namespace_counts['connection'],
		'jetpack_module_settings_route_count'  => $namespace_counts['module_settings'],
		'jetpack_site_data_route_count'        => $namespace_counts['site_data'],
		'jetpack_other_route_count'            => $namespace_counts['jetpack_other'],
		'total_elapsed_ms'                     => ( microtime( true ) - $started ) * 1000,
	);

	$artifact_path = '';
	$shared_state = getenv( 'HOMEBOY_BENCH_SHARED_STATE' );
	if ( $shared_state ) {
		$artifact_dir = rtrim( $shared_state, '/' ) . '/jetpack-rest-route-inventory';
		wp_mkdir_p( $artifact_dir );
		$artifact_path = $artifact_dir . '/' . $run_id . '.json';
		file_put_contents(
			$artifact_path,
			wp_json_encode(
				array(
					'run_id'           => $run_id,
					'jetpack_version'  => defined( 'JETPACK__VERSION' ) ? JETPACK__VERSION : '',
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
			'workload'       => 'jetpack-rest-route-inventory',
			'coverage_shape' => 'registered Jetpack REST route inventory',
			'manifest'       => 'manifests/rest-route-coverage.json',
		),
		'artifacts' => $artifact_path ? array( 'route_inventory' => array( 'path' => $artifact_path, 'kind' => 'json' ) ) : array(),
	);
};
