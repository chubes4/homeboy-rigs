<?php
/**
 * Jetpack local cron and sync-action fixture.
 *
 * Synthetic events remain local to the disposable site and are removed during
 * teardown; WordPress.com dispatch is never attempted.
 */
return function (): array {
	$hooks = array( 'jetpack_clean_nonces', 'jetpack_sync_cron', 'jetpack_sync_full_cron', 'jetpack_v2_heartbeat' );
	$scheduled = array();
	$network_calls = array();
	$block_http = static function ( $preempt, $args, $url ) use ( &$network_calls ) {
		$network_calls[] = esc_url_raw( $url );
		return new WP_Error( 'homeboy_jetpack_cron_network_blocked', 'Outbound HTTP is blocked by the Jetpack cron fixture.' );
	};
	add_filter( 'pre_http_request', $block_http, 10, 3 );
	try {
		foreach ( $hooks as $hook ) {
			if ( ! wp_next_scheduled( $hook, array( 'homeboy_fixture' ) ) ) {
				wp_schedule_single_event( time() + 300, $hook, array( 'homeboy_fixture' ) );
				$scheduled[] = $hook;
			}
		}
		$events = array_map( static function ( $hook ): array {
			return array( 'hook' => $hook, 'scheduled' => (bool) wp_next_scheduled( $hook, array( 'homeboy_fixture' ) ), 'connected_state' => 'provisioned_connected_state_required' );
		}, $hooks );
	} finally {
		foreach ( $scheduled as $hook ) {
			wp_clear_scheduled_hook( $hook, array( 'homeboy_fixture' ) );
		}
		remove_filter( 'pre_http_request', $block_http, 10 );
	}
	return array(
		'metrics' => array( 'cron_events' => count( $events ), 'scheduled_synthetic_events' => count( $scheduled ), 'blocked_http_attempts' => count( $network_calls ) ),
		'artifacts' => array( 'cron_sync_actions' => array( 'cron_events' => $events, 'sync_actions' => array( 'jetpack_sync_save_post', 'jetpack_sync_save_option', 'jetpack_sync_save_comment', 'jetpack_sync_save_user', 'jetpack_sync_module_toggle' ), 'remote_connection_dependent_behavior' => array( 'classification' => 'provisioned_connected_state_required', 'executed' => false ), 'network_calls' => array( 'allowed' => false, 'blocked_attempts' => $network_calls ), 'teardown' => array( 'synthetic_events_cleared' => true ) ) ),
	);
};
