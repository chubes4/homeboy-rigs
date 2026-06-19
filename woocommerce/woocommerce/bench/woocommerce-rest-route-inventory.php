<?php
/**
 * WP Codebox-backed WooCommerce REST route inventory workload.
 *
 * Captures deterministic route coverage metadata without executing API requests.
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

	$run_id = 'woocommerce-rest-route-inventory-' . getmypid() . '-' . time();

	$server = rest_get_server();
	if ( class_exists( Automattic\WooCommerce\RestApi\Server::class ) ) {
		Automattic\WooCommerce\RestApi\Server::instance()->register_rest_routes();
	}

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
		if ( preg_match( '#^/wc/v\d+(?:/|$)#', $route ) ) {
			return 'wc_rest';
		}
		if ( preg_match( '#^/wc/store(?:/|$)#', $route ) ) {
			return 'wc_store';
		}
		if ( preg_match( '#^/wc-admin(?:/|$)#', $route ) ) {
			return 'wc_admin';
		}
		if ( preg_match( '#^/wc-analytics(?:/|$)#', $route ) ) {
			return 'wc_analytics';
		}

		return 0 === strpos( $route, '/wc/' ) ? 'wc_other' : 'non_woocommerce';
	};

	$route_inventory = array();
	$namespace_counts = array(
		'wc_rest'        => 0,
		'wc_store'       => 0,
		'wc_admin'       => 0,
		'wc_analytics'   => 0,
		'wc_other'       => 0,
		'non_woocommerce' => 0,
	);

	foreach ( $routes as $route => $handlers ) {
		$classification = $classify_route( $route );
		++$namespace_counts[ $classification ];

		if ( 'non_woocommerce' === $classification ) {
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

			$args = array();
			foreach ( (array) ( $handler['args'] ?? array() ) as $arg_name => $arg_schema ) {
				$args[] = array(
					'name'     => (string) $arg_name,
					'required' => is_array( $arg_schema ) && ! empty( $arg_schema['required'] ),
				);
			}
			usort(
				$args,
				static function ( array $a, array $b ): int {
					return strcmp( $a['name'], $b['name'] );
				}
			);

			$endpoints[] = array(
				'methods'  => $methods,
				'args'     => $args,
				'callback' => $summarize_callback( $handler['callback'] ),
			);
		}

		$route_inventory[] = array(
			'path'      => $route,
			'namespace' => $classification,
			'endpoints' => $endpoints,
		);
	}

	$woocommerce_route_count = $namespace_counts['wc_rest'] + $namespace_counts['wc_store'] + $namespace_counts['wc_admin'] + $namespace_counts['wc_analytics'] + $namespace_counts['wc_other'];
	$summary                 = array(
		'success_rate'               => 1,
		'total_route_count'          => count( $routes ),
		'woocommerce_route_count'    => $woocommerce_route_count,
		'wc_rest_route_count'        => $namespace_counts['wc_rest'],
		'wc_store_route_count'       => $namespace_counts['wc_store'],
		'wc_admin_route_count'       => $namespace_counts['wc_admin'],
		'wc_analytics_route_count'   => $namespace_counts['wc_analytics'],
		'wc_other_route_count'       => $namespace_counts['wc_other'],
		'total_elapsed_ms'           => ( microtime( true ) - $started ) * 1000,
	);

	$artifact_path = '';
	$shared_state  = getenv( 'HOMEBOY_BENCH_SHARED_STATE' );
	if ( $shared_state ) {
		$artifact_dir = rtrim( $shared_state, '/' ) . '/woocommerce-rest-route-inventory';
		wp_mkdir_p( $artifact_dir );
		$artifact_path = $artifact_dir . '/' . $run_id . '.json';
		file_put_contents(
			$artifact_path,
			wp_json_encode(
				array(
					'run_id'           => $run_id,
					'woocommerce_version' => defined( 'WC_VERSION' ) ? WC_VERSION : '',
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
			'runner'   => 'wp-codebox',
			'workload' => 'woocommerce-rest-route-inventory',
			'coverage_shape' => 'registered WooCommerce REST route inventory',
			'namespaces' => array( 'wc/v*', 'wc/store*', 'wc-admin', 'wc-analytics' ),
		),
		'artifacts' => $artifact_path ? array( 'route_inventory' => array( 'path' => $artifact_path, 'kind' => 'json' ) ) : array(),
	);
};
