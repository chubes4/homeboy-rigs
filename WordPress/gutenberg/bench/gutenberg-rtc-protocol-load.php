<?php
/**
 * WP Codebox-backed Gutenberg RTC protocol workload.
 *
 * Runs inside the disposable WordPress runtime owned by `wordpress.bench`.
 */
return function (): array {
	$client_count = max( 1, min( 5000, (int) ( getenv( 'GUTENBERG_RTC_CLIENTS' ) ?: 10 ) ) );
	$rounds       = max( 1, min( 100, (int) ( getenv( 'GUTENBERG_RTC_ROUNDS' ) ?: 3 ) ) );
	$batch_size   = max( 1, min( 50, (int) ( getenv( 'GUTENBERG_RTC_BATCH_SIZE' ) ?: 25 ) ) );
	$run_id       = 'gutenberg-rtc-codebox-' . getmypid() . '-' . time() . '-' . wp_generate_password( 6, false );

	if ( ! function_exists( 'rest_do_request' ) ) {
		throw new RuntimeException( 'WordPress REST API is not available.' );
	}

	wp_set_current_user( 1 );
	update_option( 'wp_collaboration_enabled', '1' );

	if ( ! class_exists( 'WP_HTTP_Polling_Sync_Server' ) ) {
		$collaboration_bootstrap = WP_PLUGIN_DIR . '/gutenberg/lib/compat/wordpress-7.0/collaboration.php';
		if ( ! file_exists( $collaboration_bootstrap ) ) {
			$collaboration_bootstrap = WP_PLUGIN_DIR . '/gutenberg/lib/compat/wordpress-7.1/collaboration.php';
		}
		if ( ! file_exists( $collaboration_bootstrap ) ) {
			throw new RuntimeException( 'Gutenberg collaboration bootstrap not found.' );
		}
		require_once $collaboration_bootstrap;
	}
	$GLOBALS['wp_rest_server'] = null;
	do_action( 'rest_api_init', rest_get_server() );

	$post_id = wp_insert_post(
		array(
			'post_type'   => 'post',
			'post_status' => 'draft',
			'post_title'  => 'Homeboy RTC Protocol Load ' . $run_id,
		),
		true
	);
	if ( is_wp_error( $post_id ) ) {
		throw new RuntimeException( $post_id->get_error_message() );
	}

	$room              = 'postType/post:' . (int) $post_id;
	$clients           = array();
	$latencies         = array();
	$statuses          = array();
	$response_rows     = array();
	$requests_total    = 0;
	$updates_sent      = 0;
	$updates_applied   = 0;
	$http_4xx          = 0;
	$http_5xx          = 0;
	$started           = microtime( true );

	for ( $i = 0; $i < $client_count; $i++ ) {
		$clients[] = array(
			'client_id' => $i + 1,
			'cursor'    => 0,
			'seen'      => array(),
		);
	}

	$dispatch = static function ( array $rooms ) use ( &$latencies, &$statuses, &$requests_total, &$http_4xx, &$http_5xx ): array {
		$request = new WP_REST_Request( 'POST', '/wp-sync/v1/updates' );
		$request->set_body_params( array( 'rooms' => $rooms ) );

		$before   = microtime( true );
		$response = rest_do_request( $request );
		$elapsed  = ( microtime( true ) - $before ) * 1000;
		$status   = is_wp_error( $response ) ? 500 : (int) $response->get_status();
		$data     = is_wp_error( $response ) ? array( 'error' => $response->get_error_message() ) : rest_get_server()->response_to_data( $response, false );

		$requests_total++;
		$latencies[]        = $elapsed;
		$statuses[ $status ] = ( $statuses[ $status ] ?? 0 ) + 1;
		if ( $status >= 400 && $status < 500 ) {
			$http_4xx++;
		}
		if ( $status >= 500 ) {
			$http_5xx++;
		}

		return array(
			'status'     => $status,
			'elapsed_ms' => $elapsed,
			'data'       => $data,
		);
	};

	for ( $round = 0; $round < $rounds; $round++ ) {
		for ( $offset = 0; $offset < $client_count; $offset += $batch_size ) {
			$batch = array_slice( $clients, $offset, $batch_size, true );
			$rooms = array();
			foreach ( $batch as $index => $client ) {
				$payload = base64_encode( 'client:' . $client['client_id'] . ':round:' . $round . ':run:' . $run_id );
				$clients[ $index ]['seen'][ sha1( $payload ) ] = true;
				$updates_sent++;
				$rooms[] = array(
					'after'     => $client['cursor'],
					'awareness' => array(
						'user'   => array( 'name' => 'RTC ' . $client['client_id'] ),
						'cursor' => array( 'round' => $round, 'offset' => $client['client_id'] ),
					),
					'client_id' => $client['client_id'],
					'room'      => $room,
					'updates'   => array(
						array(
							'data' => $payload,
							'type' => 'update',
						),
					),
				);
			}

			$result          = $dispatch( $rooms );
			$response_rows[] = array(
				'round'      => $round,
				'offset'     => $offset,
				'status'     => $result['status'],
				'elapsed_ms' => $result['elapsed_ms'],
				'room_count' => count( $rooms ),
			);
			if ( $result['status'] < 200 || $result['status'] >= 300 || empty( $result['data']['rooms'] ) || ! is_array( $result['data']['rooms'] ) ) {
				throw new RuntimeException( 'sync request failed with HTTP ' . $result['status'] );
			}

			foreach ( array_values( $batch ) as $batch_index => $client ) {
				$room_response = $result['data']['rooms'][ $batch_index ] ?? array();
				$client_index  = $offset + $batch_index;
				if ( isset( $room_response['end_cursor'] ) ) {
					$clients[ $client_index ]['cursor'] = (int) $room_response['end_cursor'];
				}
				foreach ( $room_response['updates'] ?? array() as $update ) {
					if ( isset( $update['data'] ) ) {
						$clients[ $client_index ]['seen'][ sha1( (string) $update['data'] ) ] = true;
						$updates_applied++;
					}
				}
			}
		}
	}

	for ( $offset = 0; $offset < $client_count; $offset += $batch_size ) {
		$batch = array_slice( $clients, $offset, $batch_size, true );
		$rooms = array();
		foreach ( $batch as $client ) {
			$rooms[] = array(
				'after'     => $client['cursor'],
				'awareness' => null,
				'client_id' => $client['client_id'],
				'room'      => $room,
				'updates'   => array(),
			);
		}
		$result = $dispatch( $rooms );
		if ( $result['status'] < 200 || $result['status'] >= 300 || empty( $result['data']['rooms'] ) || ! is_array( $result['data']['rooms'] ) ) {
			throw new RuntimeException( 'catch-up request failed with HTTP ' . $result['status'] );
		}
		foreach ( array_values( $batch ) as $batch_index => $client ) {
			$room_response = $result['data']['rooms'][ $batch_index ] ?? array();
			$client_index  = $offset + $batch_index;
			if ( isset( $room_response['end_cursor'] ) ) {
				$clients[ $client_index ]['cursor'] = (int) $room_response['end_cursor'];
			}
			foreach ( $room_response['updates'] ?? array() as $update ) {
				if ( isset( $update['data'] ) ) {
					$clients[ $client_index ]['seen'][ sha1( (string) $update['data'] ) ] = true;
					$updates_applied++;
				}
			}
		}
	}

	$elapsed_ms          = ( microtime( true ) - $started ) * 1000;
	$final_state_hashes  = array_map(
		static fn ( array $client ): string => sha1( implode( ',', array_keys( $client['seen'] ) ) ),
		$clients
	);
	$unique_state_hashes = count( array_unique( $final_state_hashes ) );
	// Opaque payload divergence is a stress signal, not a correctness failure.
	$baseline_hash       = $final_state_hashes[0] ?? '';
	$divergent_clients   = count(
		array_filter(
			$final_state_hashes,
			static fn ( string $state_hash ): bool => $state_hash !== $baseline_hash
		)
	);
	sort( $latencies, SORT_NUMERIC );
	$percentile = static function ( array $values, float $percentile ): float {
		if ( empty( $values ) ) {
			return 0.0;
		}
		$index = (int) floor( ( count( $values ) - 1 ) * $percentile );
		return (float) $values[ $index ];
	};

	$artifact_path = '';
	$shared_state  = getenv( 'HOMEBOY_BENCH_SHARED_STATE' );
	if ( $shared_state ) {
		$artifact_dir = rtrim( $shared_state, '/' ) . '/gutenberg-rtc-protocol-load';
		wp_mkdir_p( $artifact_dir );
		$artifact_path = $artifact_dir . '/' . $run_id . '.json';
		file_put_contents(
			$artifact_path,
			wp_json_encode(
				array(
					'run_id'        => $run_id,
					'post_id'       => (int) $post_id,
					'room'          => $room,
					'response_rows' => $response_rows,
					'statuses'      => $statuses,
				),
				JSON_PRETTY_PRINT
			) . "\n"
		);
	}

	return array(
		'metrics'   => array(
			'success_rate'              => 1,
			'client_count'              => $client_count,
			'rounds'                    => $rounds,
			'batch_size'                => $batch_size,
			'requests_total'            => $requests_total,
			'requests_per_second'       => $elapsed_ms > 0 ? $requests_total / ( $elapsed_ms / 1000 ) : 0,
			'updates_sent'              => $updates_sent,
			'updates_applied'           => $updates_applied,
			'sync_p50_ms'               => $percentile( $latencies, 0.50 ),
			'sync_p95_ms'               => $percentile( $latencies, 0.95 ),
			'sync_p99_ms'               => $percentile( $latencies, 0.99 ),
			'sync_max_ms'               => empty( $latencies ) ? 0 : max( $latencies ),
			'http_4xx_count'            => $http_4xx,
			'http_5xx_count'            => $http_5xx,
			'divergent_clients'         => $divergent_clients,
			'unique_final_state_hashes' => $unique_state_hashes,
			'total_elapsed_ms'          => $elapsed_ms,
		),
		'metadata'  => array(
			'runner'       => 'wp-codebox',
			'payload_mode' => 'opaque',
			'room'         => $room,
			'post_id'      => (int) $post_id,
		),
		'artifacts' => $artifact_path ? array( 'raw_result' => array( 'path' => $artifact_path, 'kind' => 'json' ) ) : array(),
	);
};
