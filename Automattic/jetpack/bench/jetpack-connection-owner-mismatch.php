<?php
/**
 * Jetpack local connection-owner mismatch fixture.
 *
 * This models the stale local owner shape without contacting WordPress.com.
 */
return function (): array {
	$option_names = array( 'jetpack_options', 'jetpack_private_options', 'jetpack_active_modules' );
	$missing      = new stdClass();
	$snapshot     = array();
	foreach ( $option_names as $option_name ) {
		$value                    = get_option( $option_name, $missing );
		$snapshot[ $option_name ] = array(
			'present'    => $value !== $missing,
			'value'      => $value === $missing ? null : $value,
			'value_hash' => $value === $missing ? null : hash( 'sha256', wp_json_encode( $value ) ),
		);
	}

	$previous_user_id = get_current_user_id();
	$owner_id         = 0;
	$manager          = new \Automattic\Jetpack\Connection\Manager( 'jetpack' );
	$failure          = null;
	$cleanup_errors   = array();
	$result           = array();

	try {
		$owner_id = wp_insert_user(
			array(
				'user_login' => 'hb-jp-owner-' . substr( str_replace( '-', '', wp_generate_uuid4() ), 0, 20 ),
				'user_pass'  => wp_generate_password( 32, true, true ),
				'role'       => 'administrator',
			)
		);
		if ( is_wp_error( $owner_id ) ) {
			throw new RuntimeException( $owner_id->get_error_message() );
		}

		// Jetpack validates this local token shape before identifying the owner.
		Jetpack_Options::update_option( 'id', 11206186 );
		Jetpack_Options::update_option( 'blog_token', 'fixture.blog.token' );
		Jetpack_Options::update_option( 'master_user', $owner_id );
		Jetpack_Options::update_option( 'user_tokens', array( $owner_id => 'fixture.owner.' . $owner_id ) );
		$manager->reset_connection_status();

		$fixture_snapshot = array();
		foreach ( $option_names as $option_name ) {
			$value                           = get_option( $option_name, $missing );
			$fixture_snapshot[ $option_name ] = array(
				'present'    => $value !== $missing,
				'value_hash' => $value === $missing ? null : hash( 'sha256', wp_json_encode( $value ) ),
			);
		}
		$module_before  = get_option( 'jetpack_active_modules', array() );
		$health_tests   = new \Automattic\Jetpack\Connection\Connection_Health_Tests();
		$healthy_result = $health_tests->run_test( 'test__master_user_can_manage_options' );
		$owner          = get_userdata( $owner_id );
		if ( ! $owner instanceof WP_User ) {
			throw new RuntimeException( 'Jetpack connection-owner fixture user could not be loaded.' );
		}
		$owner->set_role( 'subscriber' );
		$drift_result = $health_tests->run_test( 'test__master_user_can_manage_options' );
		$module_after = get_option( 'jetpack_active_modules', array() );

		$result = array(
			'schema' => 'homeboy-rigs/jetpack-connection-owner-mismatch/v1',
			'anchor' => array(
				'github_issue' => 'https://github.com/chubes4/homeboy-rigs/issues/693',
				'zendesk_ticket' => '11206186',
			),
			'fixture' => array(
				'connection_owner_id' => $manager->get_connection_owner_id(),
				'owner_role_before_drift' => 'administrator',
				'owner_role_after_drift' => 'subscriber',
				'owner_lost_manage_options' => ! user_can( $owner_id, 'manage_options' ),
				'has_connected_owner' => $manager->has_connected_owner(),
				'is_user_connected'  => $manager->is_user_connected( $owner_id ),
				'is_site_connected'  => $manager->is_connected(),
			),
			'health' => array(
				'test' => 'test__master_user_can_manage_options',
				'before_drift_pass' => $healthy_result['pass'] ?? null,
				'after_drift_pass' => $drift_result['pass'] ?? null,
			),
			'module_state' => array(
				'before_hash' => hash( 'sha256', wp_json_encode( $module_before ) ),
				'after_hash'  => hash( 'sha256', wp_json_encode( $module_after ) ),
				'changed'     => $module_before !== $module_after,
			),
			'connection_option_snapshots' => array(
				'before_drift' => array_map(
					static fn ( $entry ) => array(
						'present'    => $entry['present'],
						'value_hash' => $entry['value_hash'],
					),
					$snapshot
				),
				'after_drift_and_health_evaluation' => $fixture_snapshot,
			),
			'network_calls' => array(
				'allowed' => false,
				'performed' => false,
			),
			'scope' => array(
				'local_proof' => 'connection owner capability drift does not mutate jetpack_active_modules',
				'remote_proof' => 'WPCOM JetpackConnectionHealthTest::test_test_rest_api_endpoint_with_user_token_if_blog_owner_doesnt_match_remote_connection_owner',
				'remote_diagnostic' => 'connection_owner_mismatch',
			),
		);
		if (
			$owner_id !== $result['fixture']['connection_owner_id'] ||
			! $result['fixture']['owner_lost_manage_options'] ||
			! $result['fixture']['has_connected_owner'] ||
			! $result['fixture']['is_user_connected'] ||
			! $result['fixture']['is_site_connected'] ||
			true !== $result['health']['before_drift_pass'] ||
			false !== $result['health']['after_drift_pass'] ||
			$result['module_state']['changed']
		) {
			throw new RuntimeException( 'Jetpack connection-owner mismatch fixture did not produce the expected local health state.' );
		}
	} catch ( Throwable $error ) {
		$failure = $error;
	} finally {
		foreach ( $snapshot as $option_name => $entry ) {
			$restored = $entry['present']
				? update_option( $option_name, $entry['value'] ) || get_option( $option_name ) === $entry['value']
				: delete_option( $option_name ) || get_option( $option_name, $missing ) === $missing;
			if ( ! $restored ) {
				$cleanup_errors[] = "option:$option_name";
			}
		}
		$manager->reset_connection_status();
		if ( ! function_exists( 'wp_delete_user' ) ) {
			require_once ABSPATH . 'wp-admin/includes/user.php';
		}
		if ( $owner_id > 0 && ! wp_delete_user( $owner_id ) ) {
			$cleanup_errors[] = 'fixture_owner';
		}
		wp_set_current_user( $previous_user_id );

		$after_snapshot = array();
		foreach ( $option_names as $option_name ) {
			$value                         = get_option( $option_name, $missing );
			$after_snapshot[ $option_name ] = array(
				'present'    => $value !== $missing,
				'value_hash' => $value === $missing ? null : hash( 'sha256', wp_json_encode( $value ) ),
			);
		}
		$result['cleanup'] = array(
			'options_restored' => $after_snapshot === array_map(
				static fn ( $entry ) => array(
					'present'    => $entry['present'],
					'value_hash' => $entry['value_hash'],
				),
				$snapshot
			),
			'fixture_owner_deleted' => $owner_id <= 0 || ! get_user_by( 'id', $owner_id ),
			'errors' => $cleanup_errors,
		);
		$result['connection_option_snapshots']['after_restoration'] = $after_snapshot;
	}

	if ( $failure instanceof Throwable ) {
		throw $failure;
	}
	if ( ! empty( $cleanup_errors ) || empty( $result['cleanup']['options_restored'] ) || empty( $result['cleanup']['fixture_owner_deleted'] ) ) {
		throw new RuntimeException( 'Jetpack connection-owner mismatch fixture cleanup failed.' );
	}

	return array(
		'metrics' => array(
			'health_passed_before_owner_drift' => true === $result['health']['before_drift_pass'],
			'health_failed_after_owner_drift' => false === $result['health']['after_drift_pass'],
			'module_state_changed' => $result['module_state']['changed'],
			'cleanup_passed' => true,
		),
		'metadata' => array(
			'runner' => 'wp-codebox',
			'workload' => 'jetpack-connection-owner-mismatch',
			'coverage_shape' => 'healthy local Jetpack connection owner downgraded to subscriber and evaluated without outbound requests',
		),
		'artifacts' => array(
			'connection_owner_mismatch' => $result,
		),
		'result' => $result,
	);
};
