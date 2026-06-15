<?php
/**
 * Classify WooCommerce checkout gateway plugin profile readiness.
 *
 * Evidence links:
 * - https://github.com/chubes4/homeboy-rigs/issues/295
 * - https://github.com/chubes4/homeboy-rigs/issues/296
 * - https://github.com/Extra-Chill/homeboy-extensions/issues/1339
 */
return function (): array {
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
	if ( ! did_action( 'before_woocommerce_init' ) ) {
		do_action( 'before_woocommerce_init' );
	}
	if ( ! WC()->payment_gateways && class_exists( 'WC_Payment_Gateways' ) ) {
		WC()->payment_gateways = new WC_Payment_Gateways();
	}

	$run_id = 'woocommerce-checkout-gateway-profile-readiness-' . getmypid() . '-' . time() . '-' . wp_generate_password( 6, false );
	$issues = array(
		'https://github.com/chubes4/homeboy-rigs/issues/295',
		'https://github.com/chubes4/homeboy-rigs/issues/296',
		'https://github.com/Extra-Chill/homeboy-extensions/issues/1339',
	);

	$profiles = array(
		array(
			'profile'              => 'plugin_woopayments',
			'label'                => 'WooPayments',
			'plugin'               => 'woocommerce-payments',
			'dependency_slug'      => 'woocommerce-payments',
			'entrypoint'           => 'woocommerce-payments/woocommerce-payments.php',
			'source_env'           => array( 'WC_CHECKOUT_GATEWAY_MATRIX_WOOPAYMENTS_PATH' ),
			'prepared_env'         => array( 'WC_CHECKOUT_GATEWAY_MATRIX_WOOPAYMENTS_PREPARED_PATH' ),
			'expected_gateway_ids' => array( 'woocommerce_payments' ),
		),
		array(
			'profile'              => 'plugin_stripe',
			'label'                => 'WooCommerce Stripe Gateway',
			'plugin'               => 'woocommerce-gateway-stripe',
			'dependency_slug'      => 'woocommerce-gateway-stripe',
			'entrypoint'           => 'woocommerce-gateway-stripe/woocommerce-gateway-stripe.php',
			'source_env'           => array( 'WC_CHECKOUT_GATEWAY_MATRIX_STRIPE_PATH', 'HOMEBOY_WC_STRIPE_COMPONENT_PATH' ),
			'prepared_env'         => array( 'WC_CHECKOUT_GATEWAY_MATRIX_STRIPE_PREPARED_PATH' ),
			'expected_gateway_ids' => array( 'stripe' ),
		),
		array(
			'profile'              => 'plugin_paypal_payments',
			'label'                => 'WooCommerce PayPal Payments',
			'plugin'               => 'woocommerce-paypal-payments',
			'dependency_slug'      => 'woocommerce-paypal-payments',
			'entrypoint'           => 'woocommerce-paypal-payments/woocommerce-paypal-payments.php',
			'source_env'           => array( 'WC_CHECKOUT_GATEWAY_MATRIX_PAYPAL_PAYMENTS_PATH' ),
			'prepared_env'         => array( 'WC_CHECKOUT_GATEWAY_MATRIX_PAYPAL_PAYMENTS_PREPARED_PATH' ),
			'expected_gateway_ids' => array( 'ppcp-gateway' ),
		),
		array(
			'profile'              => 'plugin_square',
			'label'                => 'WooCommerce Square',
			'plugin'               => 'woocommerce-square',
			'dependency_slug'      => 'woocommerce-square',
			'entrypoint'           => 'woocommerce-square/woocommerce-square.php',
			'source_env'           => array( 'WC_CHECKOUT_GATEWAY_MATRIX_SQUARE_PATH' ),
			'prepared_env'         => array( 'WC_CHECKOUT_GATEWAY_MATRIX_SQUARE_PREPARED_PATH' ),
			'expected_gateway_ids' => array( 'square_credit_card' ),
		),
		array(
			'profile'              => 'plugin_razorpay',
			'label'                => 'Razorpay for WooCommerce',
			'plugin'               => 'woo-razorpay',
			'dependency_slug'      => 'woo-razorpay',
			'entrypoint'           => 'woo-razorpay/woo-razorpay.php',
			'source_env'           => array( 'WC_CHECKOUT_GATEWAY_MATRIX_RAZORPAY_PATH' ),
			'prepared_env'         => array( 'WC_CHECKOUT_GATEWAY_MATRIX_RAZORPAY_PREPARED_PATH' ),
			'expected_gateway_ids' => array( 'razorpay' ),
		),
		array(
			'profile'              => 'plugin_mollie',
			'label'                => 'Mollie Payments for WooCommerce',
			'plugin'               => 'mollie-payments-for-woocommerce',
			'dependency_slug'      => 'mollie-payments-for-woocommerce',
			'entrypoint'           => 'mollie-payments-for-woocommerce/mollie-payments-for-woocommerce.php',
			'source_env'           => array( 'WC_CHECKOUT_GATEWAY_MATRIX_MOLLIE_PATH' ),
			'prepared_env'         => array( 'WC_CHECKOUT_GATEWAY_MATRIX_MOLLIE_PREPARED_PATH' ),
			'expected_gateway_ids' => array( 'mollie_wc_gateway_creditcard', 'mollie_wc_gateway_ideal', 'mollie_wc_gateway_paypal' ),
		),
		array(
			'profile'              => 'plugin_klarna',
			'label'                => 'Klarna for WooCommerce',
			'plugin'               => 'klarna-payments-for-woocommerce',
			'dependency_slug'      => 'klarna-payments-for-woocommerce',
			'entrypoint'           => 'klarna-payments-for-woocommerce/klarna-payments-for-woocommerce.php',
			'source_env'           => array( 'WC_CHECKOUT_GATEWAY_MATRIX_KLARNA_PATH' ),
			'prepared_env'         => array( 'WC_CHECKOUT_GATEWAY_MATRIX_KLARNA_PREPARED_PATH' ),
			'expected_gateway_ids' => array( 'klarna_payments', 'kco' ),
		),
	);

	$profile_filter = getenv( 'WC_CHECKOUT_GATEWAY_READINESS_PROFILES' );
	if ( false === $profile_filter || '' === trim( (string) $profile_filter ) ) {
		$profile_filter = getenv( 'WC_CHECKOUT_GATEWAY_MATRIX_PROFILES' );
	}
	if ( $profile_filter ) {
		$allowed  = array_filter( array_map( 'trim', explode( ',', $profile_filter ) ) );
		$profiles = array_values(
			array_filter(
				$profiles,
				static function ( array $profile ) use ( $allowed ): bool {
					return in_array( $profile['profile'], $allowed, true ) || in_array( $profile['dependency_slug'], $allowed, true );
				}
			)
		);
	}

	$get_first_env = static function ( array $names ): string {
		foreach ( $names as $name ) {
			$value = getenv( $name );
			if ( false !== $value && '' !== trim( (string) $value ) ) {
				return (string) $value;
			}
		}
		return '';
	};

	$get_git_revision = static function ( string $path ): ?string {
		if ( '' === $path || ! is_dir( $path ) || ! function_exists( 'shell_exec' ) ) {
			return null;
		}

		$revision = shell_exec( 'git -C ' . escapeshellarg( $path ) . ' rev-parse HEAD 2>/dev/null' );
		$revision = is_string( $revision ) ? trim( $revision ) : '';
		return '' !== $revision ? $revision : null;
	};

	$classify_profile = static function ( array $profile ) use ( $get_first_env, $get_git_revision ): array {
		$log_tail       = array();
		$source_path    = $get_first_env( $profile['source_env'] );
		$prepared_path  = $get_first_env( $profile['prepared_env'] );
		$entrypoint     = (string) $profile['entrypoint'];
		$entrypoint_path = WP_PLUGIN_DIR . '/' . $entrypoint;
		$mounted_dir    = WP_PLUGIN_DIR . '/' . $profile['plugin'];
		$result         = array(
			'profile'                => $profile['profile'],
			'label'                  => $profile['label'],
			'plugin'                 => $profile['plugin'],
			'dependency_slug'        => $profile['dependency_slug'],
			'plugin_source_path'     => $source_path,
			'plugin_source_revision' => $get_git_revision( $source_path ),
			'prepared_artifact_path' => $prepared_path,
			'entrypoint'             => $entrypoint,
			'entrypoint_path'        => $entrypoint_path,
			'mounted_plugin_dir'     => $mounted_dir,
			'activation'             => 'not_attempted',
			'expected_gateway_ids'   => $profile['expected_gateway_ids'],
			'registered_gateway_ids' => array(),
			'checkout_surface'       => 'woocommerce_checkout_payment_gateways',
			'status'                 => 'unknown',
			'reason'                 => '',
			'blocked_by'             => array(),
			'log_tail'               => array(),
		);

		try {
			if ( ! file_exists( $entrypoint_path ) ) {
				if ( '' === $source_path && '' === $prepared_path ) {
					$result['status']     = 'blocked_dependency_provider';
					$result['reason']     = 'Gateway plugin source/prepared artifact was not provided by the dependency provider.';
					$result['blocked_by'] = array(
						'https://github.com/chubes4/homeboy-rigs/issues/296',
						'https://github.com/Extra-Chill/homeboy-extensions/issues/1339',
					);
				} elseif ( '' !== $prepared_path && ! file_exists( $prepared_path ) ) {
					$result['status'] = 'build_failed';
					$result['reason'] = 'Prepared artifact path is configured but unavailable in the runtime.';
				} else {
					$result['status'] = 'missing_gateway';
					$result['reason'] = 'Configured plugin dependency did not mount the expected WordPress entrypoint.';
				}
				$log_tail[] = $result['reason'];
				$result['log_tail'] = array_slice( $log_tail, -10 );
				return $result;
			}

			if ( ! function_exists( 'is_plugin_active' ) || ! function_exists( 'activate_plugin' ) ) {
				require_once ABSPATH . 'wp-admin/includes/plugin.php';
			}

			if ( function_exists( 'is_plugin_active' ) && ! is_plugin_active( $entrypoint ) ) {
				$activation = activate_plugin( $entrypoint, '', false, true );
				if ( is_wp_error( $activation ) ) {
					$result['activation'] = 'failed';
					$result['status']     = 'fatal';
					$result['reason']     = $activation->get_error_message();
					$log_tail[]           = 'Activation failed: ' . $result['reason'];
					$result['log_tail']   = array_slice( $log_tail, -10 );
					return $result;
				}
				$log_tail[] = 'Plugin activated for readiness classification.';
			}

			$result['activation'] = function_exists( 'is_plugin_active' ) && is_plugin_active( $entrypoint ) ? 'active' : 'loaded';
			if ( WC()->payment_gateways && method_exists( WC()->payment_gateways, 'init' ) ) {
				WC()->payment_gateways->init();
			}

			$gateways                         = WC()->payment_gateways ? WC()->payment_gateways->payment_gateways() : array();
			$result['registered_gateway_ids'] = array_values(
				array_filter(
					$profile['expected_gateway_ids'],
					static function ( string $gateway_id ) use ( $gateways ): bool {
						return isset( $gateways[ $gateway_id ] );
					}
				)
			);

			if ( count( $result['registered_gateway_ids'] ) < 1 ) {
				$result['status'] = 'missing_gateway';
				$result['reason'] = 'Plugin loaded but none of the expected gateway IDs registered.';
			} else {
				$result['status'] = 'ready';
				$result['reason'] = 'Plugin activated and registered at least one expected checkout gateway.';
			}
			$log_tail[] = $result['reason'];
		} catch ( Throwable $exception ) {
			$result['status'] = 'fatal';
			$result['reason'] = $exception->getMessage();
			$log_tail[]       = 'Classification failed: ' . $exception->getMessage();
		}

		$result['log_tail'] = array_slice( $log_tail, -10 );
		return $result;
	};

	$results = array();
	foreach ( $profiles as $profile ) {
		$results[] = $classify_profile( $profile );
	}

	$summary = array(
		'success_rate'                                => 1,
		'gateway_profile_readiness_count'             => count( $results ),
		'gateway_profile_readiness_ready'             => count( array_filter( $results, static fn ( array $result ): bool => 'ready' === $result['status'] ) ),
		'gateway_profile_readiness_blocked_dependency_provider' => count( array_filter( $results, static fn ( array $result ): bool => 'blocked_dependency_provider' === $result['status'] ) ),
		'gateway_profile_readiness_failed'            => count( array_filter( $results, static fn ( array $result ): bool => ! in_array( $result['status'], array( 'ready', 'blocked_dependency_provider' ), true ) ) ),
	);

	$artifact = array(
		'run_id'   => $run_id,
		'issues'   => $issues,
		'profiles' => $results,
		'metrics'  => $summary,
	);

	$artifact_path = '';
	$shared_state  = getenv( 'HOMEBOY_BENCH_SHARED_STATE' );
	if ( $shared_state ) {
		$artifact_dir = rtrim( $shared_state, '/' ) . '/checkout-gateway-profile-readiness';
		wp_mkdir_p( $artifact_dir );
		$artifact_path = $artifact_dir . '/' . $run_id . '.json';
		file_put_contents( $artifact_path, wp_json_encode( $artifact, JSON_PRETTY_PRINT ) . "\n" );
	}

	return array(
		'metrics'   => $summary,
		'metadata'  => array(
			'runner'   => 'wp-codebox',
			'workload' => 'checkout-gateway-profile-readiness',
			'issues'   => $issues,
			'profiles' => array_map(
				static function ( array $result ): array {
					return array(
						'profile'                => $result['profile'],
						'dependency_slug'        => $result['dependency_slug'],
						'plugin_source_path'     => $result['plugin_source_path'],
						'plugin_source_revision' => $result['plugin_source_revision'],
						'prepared_artifact_path' => $result['prepared_artifact_path'],
						'activation'             => $result['activation'],
						'registered_gateway_ids' => $result['registered_gateway_ids'],
						'checkout_surface'       => $result['checkout_surface'],
						'status'                 => $result['status'],
						'reason'                 => $result['reason'],
						'log_tail'               => $result['log_tail'],
					);
				},
				$results
			),
		),
		'artifacts' => $artifact_path ? array( 'gateway_profile_readiness' => array( 'path' => $artifact_path, 'kind' => 'json' ) ) : array(),
	);
};
