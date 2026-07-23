<?php
/**
 * Jetpack local module-state fixture.
 *
 * Exercises local module toggles and connection-owner health only. The HTTP
 * interceptor makes any accidental remote request fail inside the disposable
 * Codebox runtime.
 */
return function (): array {
	$option_names = array( 'jetpack_active_modules', 'jetpack_options', 'jetpack_private_options', 'jetpack_sync_settings' );
	$missing      = new stdClass();
	$snapshot     = array();
	$describe     = static function ( $value, $missing ): array {
		$present = $value !== $missing;
		return array(
			'present'     => $present,
			'value_hash'  => $present ? hash( 'sha256', wp_json_encode( $value ) ) : null,
			'value_type'  => $present ? gettype( $value ) : 'missing',
			'value_keys'  => $present && is_array( $value ) ? array_values( array_map( 'strval', array_keys( $value ) ) ) : array(),
			'value_count' => $present && is_countable( $value ) ? count( $value ) : null,
		);
	};
	$describe_setting_value = static function ( $option_name, $value ) {
		if ( 'jetpack_sync_settings' === $option_name ) {
			return $value;
		}
		if ( ! is_array( $value ) ) {
			return null;
		}
		return array(
			'id'              => $value['id'] ?? null,
			'master_user'     => $value['master_user'] ?? null,
			'blog_token'      => array_key_exists( 'blog_token', $value ) ? '[redacted]' : null,
			'user_token_count' => isset( $value['user_tokens'] ) && is_array( $value['user_tokens'] ) ? count( $value['user_tokens'] ) : 0,
		);
	};
	foreach ( $option_names as $option_name ) {
		$value                    = get_option( $option_name, $missing );
		$snapshot[ $option_name ] = array(
			'value'    => $value === $missing ? null : $value,
			'describe' => $describe( $value, $missing ),
		);
	}

	$previous_user_id = get_current_user_id();
	$owner_id         = 0;
	$network_calls    = array();
	$cleanup_errors   = array();
	$result           = array();
	$failure          = null;
	$manager          = new \Automattic\Jetpack\Connection\Manager( 'jetpack' );
	$modules          = new \Automattic\Jetpack\Modules();
	$block_http       = static function ( $preempt, $args, $url ) use ( &$network_calls ) {
		$network_calls[] = esc_url_raw( $url );
		return new WP_Error( 'homeboy_jetpack_module_state_network_blocked', 'Outbound HTTP is blocked by the local module-state fixture.' );
	};
	$register_fixture_modules = static function ( $available ): array {
		return array_values( array_unique( array_merge( $available, array( 'markdown', 'shortcodes', 'contact-form' ) ) ) );
	};

	add_filter( 'pre_http_request', $block_http, 10, 3 );
	add_filter( 'jetpack_get_available_standalone_modules', $register_fixture_modules );
	try {
		$owner_id = wp_insert_user(
			array(
				'user_login' => 'hb-jp-module-owner-' . substr( str_replace( '-', '', wp_generate_uuid4() ), 0, 16 ),
				'user_pass'  => wp_generate_password( 32, true, true ),
				'role'       => 'administrator',
			)
		);
		if ( is_wp_error( $owner_id ) ) {
			throw new RuntimeException( $owner_id->get_error_message() );
		}

		// Keep the fixture representative without using a real WordPress.com identity.
		$module_seed = array( 'markdown', 'shortcodes' );
		if ( ! $modules->update_active( $module_seed ) && $module_seed !== get_option( 'jetpack_active_modules', array() ) ) {
			throw new RuntimeException( 'Jetpack module-state fixture could not seed active modules.' );
		}
		Jetpack_Options::update_option( 'id', 6950001 );
		Jetpack_Options::update_option( 'blog_token', 'fixture.module-state.blog-token' );
		Jetpack_Options::update_option( 'master_user', $owner_id );
		Jetpack_Options::update_option( 'user_tokens', array( $owner_id => 'fixture.module-state.owner.' . $owner_id ) );
		update_option( 'jetpack_sync_settings', array( 'full_sync' => 'fixture-disabled', 'sent' => false ) );
		$manager->reset_connection_status();

		$fixture_before = array();
		foreach ( $option_names as $option_name ) {
			$fixture_before[ $option_name ] = $describe( get_option( $option_name, $missing ), $missing );
		}
		$module_before = get_option( 'jetpack_active_modules', array() );
		$settings_before = array();
		foreach ( array( 'jetpack_options', 'jetpack_private_options', 'jetpack_sync_settings' ) as $option_name ) {
			$value                         = get_option( $option_name, $missing );
			$settings_before[ $option_name ] = array_merge(
				$fixture_before[ $option_name ],
				array( 'value' => $describe_setting_value( $option_name, $value ) )
			);
		}
		$health_tests   = new \Automattic\Jetpack\Connection\Connection_Health_Tests();
		$healthy_result = $health_tests->run_test( 'test__master_user_can_manage_options' );

		$toggle_module = 'contact-form';
		$modules->activate( $toggle_module, false, false );
		$active_after_activation = $modules->is_active( $toggle_module );
		$modules->deactivate( $toggle_module );
		$active_after_deactivation = $modules->is_active( $toggle_module );
		$module_after = get_option( 'jetpack_active_modules', array() );

		$owner = get_userdata( $owner_id );
		if ( ! $owner instanceof WP_User ) {
			throw new RuntimeException( 'Jetpack module-state fixture owner could not be loaded.' );
		}
		$owner->set_role( 'subscriber' );
		$unhealthy_result = $health_tests->run_test( 'test__master_user_can_manage_options' );
		$settings_after = array();
		foreach ( array_keys( $settings_before ) as $option_name ) {
			$value                        = get_option( $option_name, $missing );
			$settings_after[ $option_name ] = array_merge(
				$describe( $value, $missing ),
				array( 'value' => $describe_setting_value( $option_name, $value ) )
			);
		}

		$result = array(
			'schema' => 'homeboy-rigs/jetpack-module-state-matrix/v1',
			'fixture' => array(
				'module_seed' => $module_seed,
				'placeholder_connection_owner_id' => $owner_id,
				'connection' => 'local-placeholder-only',
			),
			'module_state' => array(
				'before_value' => $module_before,
				'before_hash' => hash( 'sha256', wp_json_encode( $module_before ) ),
				'after_value' => $module_after,
				'after_hash' => hash( 'sha256', wp_json_encode( $module_after ) ),
				'toggle_module' => $toggle_module,
				'active_after_activation' => $active_after_activation,
				'active_after_deactivation' => $active_after_deactivation,
			),
			'settings_state' => array(
				'before' => $settings_before,
				'after' => $settings_after,
			),
			'owner_health' => array(
				'test' => 'test__master_user_can_manage_options',
				'before_role_drift_pass' => $healthy_result['pass'] ?? null,
				'after_role_drift_pass' => $unhealthy_result['pass'] ?? null,
			),
			'remote_connection_dependent_behavior' => array(
				'classification' => 'provisioned_connected_state_required',
				'executed' => false,
				'reason' => 'This workload uses placeholder-only local connection state and blocks all outbound HTTP.',
			),
			'network_calls' => array(
				'allowed' => false,
				'blocked_attempts' => $network_calls,
			),
		);
		$result['contract_checks'] = array(
			'module_activated' => true === $result['module_state']['active_after_activation'],
			'module_deactivated' => false === $result['module_state']['active_after_deactivation'],
			'module_state_restored' => $result['module_state']['before_value'] === $result['module_state']['after_value'],
			'owner_healthy_before_drift' => true === $result['owner_health']['before_role_drift_pass'],
			'owner_unhealthy_after_drift' => false === $result['owner_health']['after_role_drift_pass'],
			'no_outbound_http_attempts' => empty( $network_calls ),
		);
		if ( in_array( false, $result['contract_checks'], true ) ) {
			throw new RuntimeException( 'Jetpack module-state fixture contract checks failed: ' . wp_json_encode( $result['contract_checks'] ) );
		}
	} catch ( Throwable $error ) {
		$failure = $error;
	} finally {
		remove_filter( 'pre_http_request', $block_http, 10 );
		remove_filter( 'jetpack_get_available_standalone_modules', $register_fixture_modules );
		foreach ( $snapshot as $option_name => $entry ) {
			$restored = $entry['describe']['present']
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

		$restored = array();
		foreach ( $option_names as $option_name ) {
			$restored[ $option_name ] = $describe( get_option( $option_name, $missing ), $missing );
		}
		$result['cleanup'] = array(
			'options_restored' => $restored === array_map( static fn ( $entry ) => $entry['describe'], $snapshot ),
			'fixture_owner_deleted' => $owner_id <= 0 || ! get_user_by( 'id', $owner_id ),
			'errors' => $cleanup_errors,
			'after_restoration' => $restored,
		);
	}

	if ( $failure instanceof Throwable ) {
		throw $failure;
	}
	if ( ! empty( $cleanup_errors ) || empty( $result['cleanup']['options_restored'] ) || empty( $result['cleanup']['fixture_owner_deleted'] ) ) {
		throw new RuntimeException( 'Jetpack module-state fixture cleanup failed.' );
	}

	return array(
		'metrics' => array(
			'module_toggle_passed' => true,
			'owner_health_passed_before_drift' => true,
			'owner_health_failed_after_drift' => true,
			'cleanup_passed' => true,
		),
		'metadata' => array(
			'runner' => 'wp-codebox',
			'workload' => 'jetpack-module-state-matrix',
			'coverage_shape' => 'local module toggle, placeholder connection-owner health evaluation, state hashing, and restoration without outbound requests',
		),
		'artifacts' => array( 'module_state_matrix' => $result ),
		'result' => $result,
	);
};
