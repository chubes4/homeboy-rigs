<?php
/**
 * Jetpack local sync-queue fixture.
 *
 * It records only synthetic action payload shapes. Remote dispatch is blocked,
 * and every option touched by the disposable fixture is restored before return.
 */
return function (): array {
	$option_names = array( 'jpsq_sync_checkout', 'jpsq_sync_started', 'jpsq_full_sync_started', 'jetpack_sync_settings_sync_wait_time', 'jetpack_sync_non_blocking', 'jetpack_sync_checksum' );
	$missing      = new stdClass();
	$snapshot     = array();
	$network_calls = array();
	$describe     = static function ( $value, $missing ): array {
		$present = $value !== $missing;
		return array( 'present' => $present, 'value_type' => $present ? gettype( $value ) : 'missing', 'value_hash' => $present ? hash( 'sha256', wp_json_encode( $value ) ) : null );
	};
	foreach ( $option_names as $option_name ) {
		$snapshot[ $option_name ] = get_option( $option_name, $missing );
	}
	$block_http = static function ( $preempt, $args, $url ) use ( &$network_calls ) {
		$network_calls[] = esc_url_raw( $url );
		return new WP_Error( 'homeboy_jetpack_sync_network_blocked', 'Outbound HTTP is blocked by the Jetpack sync fixture.' );
	};
	add_filter( 'pre_http_request', $block_http, 10, 3 );
	try {
		$actions = array( 'jetpack_sync_save_post', 'jetpack_sync_save_option', 'jetpack_sync_save_comment', 'jetpack_sync_save_user', 'jetpack_sync_module_toggle' );
		$action_rows = array();
		foreach ( $actions as $action ) {
			$payload       = array( 'object_id' => 0, 'fixture' => true, 'secret' => '[redacted]' );
			$action_rows[] = array(
				'action'          => $action,
				'callback_count'  => has_action( $action ) ? count( $GLOBALS['wp_filter'][ $action ]->callbacks ?? array() ) : 0,
				'payload_shape'   => array_keys( $payload ),
				'payload_hash'    => hash( 'sha256', wp_json_encode( $payload ) ),
				'remote_dispatch' => false,
			);
		}
		$before_after = array();
		foreach ( $option_names as $option_name ) {
			$before = get_option( $option_name, $missing );
			update_option( $option_name, array( 'homeboy_fixture' => true, 'value' => $option_name ) );
			$before_after[] = array( 'option' => $option_name, 'before' => $describe( $before, $missing ), 'after' => $describe( get_option( $option_name, $missing ), $missing ) );
		}
	} finally {
		remove_filter( 'pre_http_request', $block_http, 10 );
		foreach ( $snapshot as $option_name => $value ) {
			$value === $missing ? delete_option( $option_name ) : update_option( $option_name, $value );
		}
	}
	return array(
		'metrics' => array( 'synthetic_actions' => count( $action_rows ), 'queue_options' => count( $option_names ), 'blocked_http_attempts' => count( $network_calls ) ),
		'artifacts' => array( 'sync_queue_coverage' => array( 'actions' => $action_rows, 'queue_option_before_after_rows' => $before_after, 'remote_connection_dependent_behavior' => array( 'classification' => 'provisioned_connected_state_required', 'executed' => false ), 'network_calls' => array( 'allowed' => false, 'blocked_attempts' => $network_calls ), 'teardown' => array( 'options_restored' => true ) ) ),
	);
};
