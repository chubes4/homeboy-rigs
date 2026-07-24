<?php
/**
 * Jetpack disposable option-shape matrix.
 *
 * Every touched option is restored before returning, and values are represented
 * by type and hash so token-like data never enters the artifact.
 */
return function (): array {
	$option_names = array( 'jetpack_active_modules', 'jetpack_options', 'jetpack_private_options', 'jetpack_sync_settings', 'jpsq_sync_checkout' );
	$missing      = new stdClass();
	$snapshot     = array();
	$rows         = array();
	$describe     = static function ( $value, $missing ): array {
		$present = $value !== $missing;
		return array(
			'present'    => $present,
			'value_type' => $present ? gettype( $value ) : 'missing',
			'value_hash' => $present ? hash( 'sha256', wp_json_encode( $value ) ) : null,
		);
	};

	foreach ( $option_names as $option_name ) {
		$snapshot[ $option_name ] = get_option( $option_name, $missing );
	}

	try {
		foreach ( $option_names as $option_name ) {
			$before = get_option( $option_name, $missing );
			$fixture = array( 'homeboy_fixture' => true, 'option' => $option_name, 'secret' => '[redacted]' );
			update_option( $option_name, $fixture );
			$rows[] = array(
				'option' => $option_name,
				'before' => $describe( $before, $missing ),
				'after'  => $describe( get_option( $option_name, $missing ), $missing ),
			);
		}
	} finally {
		foreach ( $snapshot as $option_name => $value ) {
			$value === $missing ? delete_option( $option_name ) : update_option( $option_name, $value );
		}
	}

	$restored = true;
	foreach ( $snapshot as $option_name => $value ) {
		$restored = $restored && $describe( get_option( $option_name, $missing ), $missing ) === $describe( $value, $missing );
	}

	return array(
		'metrics'   => array( 'option_rows' => count( $rows ), 'restored' => $restored ? 1 : 0 ),
		'artifacts' => array(
			'options_matrix' => array(
				'rows'                                => $rows,
				'secret_values_recorded'              => false,
				'remote_connection_state'             => 'provisioned_connected_state_required',
				'remote_connection_behavior_executed' => false,
				'teardown'                            => array( 'options_restored' => $restored ),
			),
		),
	);
};
