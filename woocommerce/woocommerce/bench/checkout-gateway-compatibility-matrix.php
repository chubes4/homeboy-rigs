<?php
/**
 * WP Codebox-backed WooCommerce checkout gateway compatibility matrix.
 *
 * Evidence links:
 * - https://github.com/woocommerce/woocommerce/issues/62659
 * - https://github.com/woocommerce/woocommerce/pull/65588
 * - https://github.com/woocommerce/woocommerce/pull/65588#pullrequestreview-4488383929
 * - https://github.com/chubes4/homeboy-rigs/issues/255
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
	if ( ! function_exists( 'wc_load_cart' ) ) {
		throw new RuntimeException( 'WooCommerce cart loader is not available.' );
	}
	if ( ! did_action( 'before_woocommerce_init' ) ) {
		do_action( 'before_woocommerce_init' );
	}
	if ( ! WC()->countries && class_exists( 'WC_Countries' ) ) {
		WC()->countries = new WC_Countries();
	}
	if ( ! WC()->order_factory && class_exists( 'WC_Order_Factory' ) ) {
		WC()->order_factory = new WC_Order_Factory();
	}
	if ( ! WC()->payment_gateways && class_exists( 'WC_Payment_Gateways' ) ) {
		WC()->payment_gateways = new WC_Payment_Gateways();
	}
	if ( method_exists( WC(), 'mailer' ) ) {
		foreach ( WC()->mailer()->get_emails() as $email ) {
			if ( isset( $email->id ) ) {
				add_filter( 'woocommerce_email_enabled_' . $email->id, '__return_false', 999 );
			}
		}
	}

	$run_id = 'woocommerce-checkout-gateway-compatibility-matrix-' . getmypid() . '-' . time() . '-' . wp_generate_password( 6, false );
	$issues = array(
		'https://github.com/woocommerce/woocommerce/issues/62659',
		'https://github.com/woocommerce/woocommerce/pull/65588',
		'https://github.com/woocommerce/woocommerce/pull/65588#pullrequestreview-4488383929',
		'https://github.com/chubes4/homeboy-rigs/issues/255',
		'https://github.com/chubes4/homeboy-rigs/issues/295',
		'https://github.com/chubes4/homeboy-rigs/issues/296',
	);

	wp_set_current_user( 0 );
	update_option( 'woocommerce_default_country', 'US:CA' );
	update_option( 'woocommerce_currency', 'USD' );
	update_option( 'woocommerce_prices_include_tax', 'no' );
	update_option( 'woocommerce_calc_taxes', 'no' );
	update_option( 'woocommerce_enable_guest_checkout', 'yes' );
	update_option( 'woocommerce_checkout_phone_field', 'required' );

	if ( ! WC()->session ) {
		if ( method_exists( WC(), 'initialize_session' ) ) {
			WC()->initialize_session();
		} elseif ( class_exists( 'WC_Session_Handler' ) ) {
			WC()->session = new WC_Session_Handler();
			WC()->session->init();
		}
	}
	if ( WC()->session ) {
		WC()->session->set_customer_session_cookie( true );
	}

	wc_load_cart();
	if ( ! WC()->cart ) {
		throw new RuntimeException( 'WooCommerce cart failed to initialize.' );
	}

	$profiles = array(
		array(
			'profile'        => 'core_bacs',
			'gateway_id'     => 'bacs',
			'expected_gateway_ids' => array( 'bacs' ),
			'discovery_patterns' => array( '/^bacs$/' ),
			'label'          => 'Direct bank transfer (BACS)',
			'plugin'         => 'woocommerce-core',
			'dependency_slug' => 'woocommerce-core',
			'entrypoint'     => '',
			'checkout_surfaces' => array( 'classic' ),
			'credential_boundary' => 'none',
			'readiness_boundary' => 'ready',
			'settings'       => array( 'enabled' => 'yes' ),
		),
		array(
			'profile'        => 'core_cheque',
			'gateway_id'     => 'cheque',
			'expected_gateway_ids' => array( 'cheque' ),
			'discovery_patterns' => array( '/^cheque$/' ),
			'label'          => 'Check payments',
			'plugin'         => 'woocommerce-core',
			'dependency_slug' => 'woocommerce-core',
			'entrypoint'     => '',
			'checkout_surfaces' => array( 'classic' ),
			'credential_boundary' => 'none',
			'readiness_boundary' => 'ready',
			'settings'       => array( 'enabled' => 'yes' ),
		),
		array(
			'profile'        => 'core_cod',
			'gateway_id'     => 'cod',
			'expected_gateway_ids' => array( 'cod' ),
			'discovery_patterns' => array( '/^cod$/' ),
			'label'          => 'Cash on delivery',
			'plugin'         => 'woocommerce-core',
			'dependency_slug' => 'woocommerce-core',
			'entrypoint'     => '',
			'checkout_surfaces' => array( 'classic' ),
			'credential_boundary' => 'none',
			'readiness_boundary' => 'ready',
			'settings'       => array(
				'enabled'            => 'yes',
				'enable_for_methods' => array(),
				'enable_for_virtual' => 'yes',
			),
		),
		array(
			'profile'        => 'plugin_stripe',
			'gateway_id'     => 'stripe',
			'expected_gateway_ids' => array( 'stripe' ),
			'discovery_patterns' => array( '/^stripe(_|$)/', '/stripe/i' ),
			'label'          => 'WooCommerce Stripe Gateway',
			'plugin'         => 'woocommerce-gateway-stripe',
			'dependency'     => 'woocommerce-gateway-stripe',
			'entrypoint'     => 'woocommerce-gateway-stripe/woocommerce-gateway-stripe.php',
			'checkout_surfaces' => array( 'classic', 'blocks', 'hosted_fields', 'wallet/express' ),
			'credential_boundary' => 'test_api_keys_required',
			'dummy_config_valid' => false,
			'readiness_boundary' => 'blocked_credentials',
			'source_env'     => array( 'WC_CHECKOUT_GATEWAY_MATRIX_STRIPE_PATH', 'HOMEBOY_WC_STRIPE_COMPONENT_PATH' ),
			'prepared_env'   => array( 'WC_CHECKOUT_GATEWAY_MATRIX_STRIPE_PREPARED_PATH' ),
			'blocked_by'     => array(
				'https://github.com/chubes4/homeboy-rigs/issues/292',
				'https://github.com/Extra-Chill/homeboy-extensions/issues/1336',
			),
			'settings'       => array(
				'enabled'             => 'yes',
				'testmode'            => 'yes',
				'capture'             => 'yes',
				'payment_request'     => 'no',
				'test_publishable_key' => '',
				'test_secret_key'     => '',
			),
		),
		array(
			'profile'        => 'plugin_paypal_payments',
			'gateway_id'     => 'ppcp-gateway',
			'expected_gateway_ids' => array( 'ppcp-gateway' ),
			'discovery_patterns' => array( '/^ppcp-/', '/paypal/i' ),
			'label'          => 'WooCommerce PayPal Payments',
			'plugin'         => 'woocommerce-paypal-payments',
			'dependency'     => 'woocommerce-paypal-payments',
			'entrypoint'     => 'woocommerce-paypal-payments/woocommerce-paypal-payments.php',
			'checkout_surfaces' => array( 'classic', 'blocks', 'redirect', 'wallet/express', 'external_account' ),
			'credential_boundary' => 'paypal_sandbox_account_required',
			'dummy_config_valid' => false,
			'readiness_boundary' => 'blocked_external_account',
			'source_env'     => array( 'WC_CHECKOUT_GATEWAY_MATRIX_PAYPAL_PAYMENTS_PATH' ),
			'prepared_env'   => array( 'WC_CHECKOUT_GATEWAY_MATRIX_PAYPAL_PAYMENTS_PREPARED_PATH' ),
			'settings'       => array(
				'enabled' => 'yes',
				'test_mode' => 'yes',
			),
		),
		array(
			'profile'        => 'plugin_woopayments',
			'gateway_id'     => 'woocommerce_payments',
			'expected_gateway_ids' => array( 'woocommerce_payments' ),
			'discovery_patterns' => array( '/^woocommerce_payments$/' ),
			'label'          => 'WooPayments',
			'plugin'         => 'woocommerce-payments',
			'dependency'     => 'woocommerce-payments',
			'entrypoint'     => 'woocommerce-payments/woocommerce-payments.php',
			'checkout_surfaces' => array( 'classic', 'blocks', 'hosted_fields', 'wallet/express', 'external_account' ),
			'credential_boundary' => 'wpcom_connected_account_required',
			'dummy_config_valid' => false,
			'readiness_boundary' => 'blocked_external_account',
			'source_env'     => array( 'WC_CHECKOUT_GATEWAY_MATRIX_WOOPAYMENTS_PATH' ),
			'prepared_env'   => array( 'WC_CHECKOUT_GATEWAY_MATRIX_WOOPAYMENTS_PREPARED_PATH' ),
			'settings'       => array(
				'enabled'  => 'yes',
				'testmode' => 'yes',
			),
		),
		array(
			'profile'        => 'plugin_square',
			'gateway_id'     => 'square_credit_card',
			'expected_gateway_ids' => array( 'square_credit_card' ),
			'discovery_patterns' => array( '/^square/', '/square/i' ),
			'label'          => 'WooCommerce Square',
			'plugin'         => 'woocommerce-square',
			'dependency'     => 'woocommerce-square',
			'entrypoint'     => 'woocommerce-square/woocommerce-square.php',
			'checkout_surfaces' => array( 'classic', 'blocks', 'hosted_fields', 'external_account' ),
			'credential_boundary' => 'square_sandbox_account_location_required',
			'dummy_config_valid' => false,
			'readiness_boundary' => 'blocked_external_account',
			'source_env'     => array( 'WC_CHECKOUT_GATEWAY_MATRIX_SQUARE_PATH' ),
			'prepared_env'   => array( 'WC_CHECKOUT_GATEWAY_MATRIX_SQUARE_PREPARED_PATH' ),
			'settings'       => array(
				'enabled'          => 'yes',
				'environment'      => 'sandbox',
				'create_customer'  => 'no',
			),
		),
		array(
			'profile'        => 'plugin_razorpay',
			'gateway_id'     => 'razorpay',
			'expected_gateway_ids' => array( 'razorpay' ),
			'discovery_patterns' => array( '/razorpay/i' ),
			'label'          => 'Razorpay for WooCommerce',
			'plugin'         => 'woo-razorpay',
			'dependency'     => 'woo-razorpay',
			'entrypoint'     => 'woo-razorpay/woo-razorpay.php',
			'checkout_surfaces' => array( 'classic', 'redirect', 'hosted_fields' ),
			'credential_boundary' => 'test_key_id_and_secret_required',
			'dummy_config_valid' => false,
			'readiness_boundary' => 'blocked_credentials',
			'source_env'     => array( 'WC_CHECKOUT_GATEWAY_MATRIX_RAZORPAY_PATH' ),
			'prepared_env'   => array( 'WC_CHECKOUT_GATEWAY_MATRIX_RAZORPAY_PREPARED_PATH' ),
			'settings'       => array(
				'enabled'     => 'yes',
				'testmode'    => 'yes',
				'key_id'      => '',
				'key_secret'  => '',
			),
		),
		array(
			'profile'        => 'plugin_mollie',
			'gateway_id'     => 'mollie_wc_gateway_creditcard',
			'expected_gateway_ids' => array( 'mollie_wc_gateway_creditcard', 'mollie_wc_gateway_ideal', 'mollie_wc_gateway_paypal' ),
			'discovery_patterns' => array( '/^mollie_wc_gateway_/' ),
			'label'          => 'Mollie Payments for WooCommerce',
			'plugin'         => 'mollie-payments-for-woocommerce',
			'dependency'     => 'mollie-payments-for-woocommerce',
			'entrypoint'     => 'mollie-payments-for-woocommerce/mollie-payments-for-woocommerce.php',
			'checkout_surfaces' => array( 'classic', 'blocks', 'redirect', 'external_account' ),
			'credential_boundary' => 'mollie_test_api_key_required',
			'dummy_config_valid' => false,
			'readiness_boundary' => 'blocked_credentials',
			'source_env'     => array( 'WC_CHECKOUT_GATEWAY_MATRIX_MOLLIE_PATH' ),
			'prepared_env'   => array( 'WC_CHECKOUT_GATEWAY_MATRIX_MOLLIE_PREPARED_PATH' ),
			'settings'       => array(
				'enabled'      => 'yes',
				'test_mode'    => 'yes',
				'test_api_key' => '',
			),
		),
		array(
			'profile'        => 'plugin_klarna',
			'gateway_id'     => 'klarna_payments',
			'expected_gateway_ids' => array( 'klarna_payments', 'kco' ),
			'discovery_patterns' => array( '/klarna/i', '/^kco$/' ),
			'label'          => 'Klarna for WooCommerce',
			'plugin'         => 'klarna-payments-for-woocommerce',
			'dependency'     => 'klarna-payments-for-woocommerce',
			'entrypoint'     => 'klarna-payments-for-woocommerce/klarna-payments-for-woocommerce.php',
			'checkout_surfaces' => array( 'classic', 'blocks', 'redirect', 'external_account' ),
			'credential_boundary' => 'klarna_test_merchant_credentials_required',
			'dummy_config_valid' => false,
			'readiness_boundary' => 'blocked_external_account',
			'source_env'     => array( 'WC_CHECKOUT_GATEWAY_MATRIX_KLARNA_PATH' ),
			'prepared_env'   => array( 'WC_CHECKOUT_GATEWAY_MATRIX_KLARNA_PREPARED_PATH' ),
			'settings'       => array(
				'enabled'  => 'yes',
				'testmode' => 'yes',
			),
		),
	);

	$profile_filter = getenv( 'WC_CHECKOUT_GATEWAY_MATRIX_PROFILES' );
	if ( $profile_filter ) {
		$allowed  = array_filter( array_map( 'trim', explode( ',', $profile_filter ) ) );
		$profiles = array_values(
			array_filter(
				$profiles,
				static function ( array $profile ) use ( $allowed ): bool {
					return in_array( $profile['profile'], $allowed, true ) || in_array( $profile['gateway_id'], $allowed, true );
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

	$discover_gateway_ids = static function ( array $gateways, array $profile ): array {
		$ids      = array_keys( $gateways );
		$patterns = $profile['discovery_patterns'] ?? array();
		$matches  = array_values(
			array_filter(
				$ids,
				static function ( string $gateway_id ) use ( $patterns ): bool {
					foreach ( $patterns as $pattern ) {
						if ( preg_match( $pattern, $gateway_id ) ) {
							return true;
						}
					}
					return false;
				}
			)
		);

		return array(
			'all_gateway_ids'     => $ids,
			'matched_gateway_ids' => $matches,
			'patterns'            => $patterns,
		);
	};

	$ensure_gateway_profile = static function ( array $profile ) use ( $get_first_env, $get_git_revision, $discover_gateway_ids ): array {
		$entrypoint_path = $profile['entrypoint'] ? WP_PLUGIN_DIR . '/' . $profile['entrypoint'] : '';
		$source_path     = $profile['entrypoint'] ? $get_first_env( $profile['source_env'] ?? array() ) : '';
		$prepared_path   = $profile['entrypoint'] ? $get_first_env( $profile['prepared_env'] ?? array() ) : '';
		$mounted_dir     = $profile['entrypoint'] ? WP_PLUGIN_DIR . '/' . $profile['plugin'] : '';
		$install         = array(
			'plugin'                 => $profile['plugin'],
			'dependency'             => $profile['dependency'] ?? $profile['plugin'],
			'dependency_slug'        => $profile['dependency'] ?? $profile['plugin'],
			'entrypoint'             => $profile['entrypoint'],
			'entrypoint_path'        => $entrypoint_path,
			'source_env'             => $profile['source_env'] ?? array(),
			'source_path'            => $source_path,
			'source_git_revision'    => $get_git_revision( $source_path ),
			'prepared_env'           => $profile['prepared_env'] ?? array(),
			'prepared_artifact_path' => $prepared_path,
			'prepared_path'          => $prepared_path,
			'mounted_plugin_dir'     => $mounted_dir,
			'expected_gateway_ids'   => $profile['expected_gateway_ids'] ?? array( $profile['gateway_id'] ),
			'discovery_patterns'     => $profile['discovery_patterns'] ?? array(),
			'registered_gateway_ids' => array(),
			'discovered_gateway_ids' => array(),
			'all_gateway_ids'        => array(),
			'checkout_surfaces'      => $profile['checkout_surfaces'] ?? array( 'unknown' ),
			'credential_boundary'    => $profile['credential_boundary'] ?? 'unknown',
			'dummy_config_valid'     => (bool) ( $profile['dummy_config_valid'] ?? true ),
			'safe_settings'          => $profile['settings'] ?? array(),
			'readiness_boundary'     => $profile['readiness_boundary'] ?? 'ready',
			'blocked_by'             => $profile['blocked_by'] ?? array(),
			'available'              => true,
			'build_failed'           => false,
			'skipped'                => false,
			'blocked'                => false,
			'activated'              => false,
			'activation_status'      => $profile['entrypoint'] ? 'not_attempted' : 'core',
			'version'                => null,
			'status'                 => 'ready',
			'status_reason'          => '',
			'skip_reason'            => '',
			'build_failure_reason'   => '',
		);

		if ( $profile['entrypoint'] ) {
			if ( ! file_exists( $entrypoint_path ) ) {
				$install['available'] = false;
				$install['skipped']   = true;
				if ( '' !== $prepared_path && ! file_exists( $prepared_path ) ) {
					$install['status']               = 'build_failed';
					$install['build_failure_reason'] = 'Prepared artifact path is configured but unavailable in the runtime.';
					$install['build_failed']         = true;
					$install['skip_reason']          = $install['build_failure_reason'];
				} elseif ( '' === $source_path && '' === $prepared_path ) {
					$install['status']      = ! empty( $install['blocked_by'] ) ? 'blocked_dependency_provider' : 'missing_gateway';
					$install['skip_reason'] = 'Plugin dependency was not configured or mounted for this run.';
				} else {
					$install['status']      = ! empty( $install['blocked_by'] ) ? 'blocked_dependency_provider' : 'missing_gateway';
					$install['skip_reason'] = 'Configured plugin dependency did not mount the expected WordPress entrypoint.';
				}
				$install['status_reason']     = $install['skip_reason'];
				$install['activation_status'] = 'skipped';
				$install['blocked'] = ! empty( $install['blocked_by'] );
				return $install;
			}

			if ( ! function_exists( 'is_plugin_active' ) || ! function_exists( 'activate_plugin' ) ) {
				require_once ABSPATH . 'wp-admin/includes/plugin.php';
			}

			if ( function_exists( 'is_plugin_active' ) && ! is_plugin_active( $profile['entrypoint'] ) ) {
				$result = activate_plugin( $profile['entrypoint'], '', false, true );
				if ( is_wp_error( $result ) ) {
					$install['available']         = false;
					$install['skipped']           = true;
					$install['activation_status'] = 'failed';
					$install['status']            = 'fatal';
					$install['skip_reason']       = 'Plugin activation failed: ' . $result->get_error_message();
					$install['status_reason']     = $install['skip_reason'];
					return $install;
				}
				$install['activated'] = true;
			}
			$install['activation_status'] = function_exists( 'is_plugin_active' ) && is_plugin_active( $profile['entrypoint'] ) ? 'active' : 'loaded';

			if ( ! function_exists( 'get_plugin_data' ) ) {
				require_once ABSPATH . 'wp-admin/includes/plugin.php';
			}
			if ( function_exists( 'get_plugin_data' ) ) {
				$plugin_data        = get_plugin_data( $entrypoint_path, false, false );
				$install['version'] = $plugin_data['Version'] ?? null;
			}
		}

		$option_name = 'woocommerce_' . $profile['gateway_id'] . '_settings';
		$settings    = get_option( $option_name, array() );
		if ( ! is_array( $settings ) ) {
			$settings = array();
		}
		update_option( $option_name, array_merge( $settings, $profile['settings'] ) );

		if ( WC()->payment_gateways && method_exists( WC()->payment_gateways, 'init' ) ) {
			WC()->payment_gateways->init();
		}

		$gateways               = WC()->payment_gateways ? WC()->payment_gateways->payment_gateways() : array();
		$discovery              = $discover_gateway_ids( $gateways, $profile );
		$expected_gateway_ids   = $profile['expected_gateway_ids'] ?? array( $profile['gateway_id'] );
		$registered_gateway_ids = array_values(
			array_filter(
				$expected_gateway_ids,
				static function ( string $gateway_id ) use ( $gateways ): bool {
					return isset( $gateways[ $gateway_id ] );
				}
			)
		);
		$install['registered_gateway_ids'] = $registered_gateway_ids;
		$install['discovered_gateway_ids'] = $discovery['matched_gateway_ids'];
		$install['all_gateway_ids']        = $discovery['all_gateway_ids'];
		if ( ! isset( $gateways[ $profile['gateway_id'] ] ) ) {
			$install['available']     = false;
			$install['skipped']       = true;
			$install['status']        = 'missing_gateway';
			$install['skip_reason']   = 'Gateway id is not registered after activation/configuration.';
			$install['status_reason'] = $install['skip_reason'];
			return $install;
		}

		if ( 'ready' !== $install['readiness_boundary'] ) {
			$install['available']     = false;
			$install['skipped']       = true;
			$install['blocked']       = true;
			$install['status']        = $install['readiness_boundary'];
			$install['skip_reason']   = 'Gateway registered, but payment execution requires credentials or an external account boundary that this rig does not cross.';
			$install['status_reason'] = $install['skip_reason'];
		}

		return $install;
	};

	$prepare_cart = static function ( string $profile, string $flow ) use ( $run_id ): array {
		if ( WC()->session ) {
			WC()->session->__unset( 'order_awaiting_payment' );
		}
		WC()->cart->empty_cart();

		$product = new WC_Product_Simple();
		$product->set_name( 'Homeboy Gateway Matrix Product ' . $profile . ' ' . $flow . ' ' . $run_id );
		$product->set_slug( 'homeboy-gateway-matrix-' . sanitize_title( $profile . '-' . $flow . '-' . $run_id ) );
		$product->set_status( 'publish' );
		$product->set_sku( 'homeboy-gateway-matrix-' . sanitize_title( $profile . '-' . $flow . '-' . $run_id ) );
		$product->set_regular_price( '19.99' );
		$product->set_price( '19.99' );
		$product->set_virtual( true );
		$product->set_manage_stock( false );
		$product->set_stock_status( 'instock' );
		$product->save();

		WC()->cart->add_to_cart( $product->get_id(), 1 );
		if ( WC()->customer ) {
			WC()->customer->set_billing_first_name( 'Homeboy' );
			WC()->customer->set_billing_last_name( 'Gateway' );
			WC()->customer->set_billing_email( 'homeboy-' . sanitize_title( $profile . '-' . $flow . '-' . $run_id ) . '@example.com' );
			WC()->customer->set_billing_phone( '5555555555' );
			WC()->customer->set_billing_country( 'US' );
			WC()->customer->set_billing_state( 'CA' );
			WC()->customer->set_billing_postcode( '94107' );
			WC()->customer->set_billing_city( 'San Francisco' );
			WC()->customer->set_billing_address( '123 Gateway Way' );
			WC()->customer->save();
		}
		WC()->cart->calculate_totals();

		return array(
			'product_id' => $product->get_id(),
			'cart_hash'  => WC()->cart->get_cart_hash(),
			'email'      => 'homeboy-' . sanitize_title( $profile . '-' . $flow . '-' . $run_id ) . '@example.com',
		);
	};

	$get_checkout_data = static function ( string $gateway_id, string $email, string $profile, string $flow ) use ( $run_id ): array {
		return array(
			'billing_first_name'        => 'Homeboy',
			'billing_last_name'         => 'Gateway',
			'billing_company'           => '',
			'billing_country'           => 'US',
			'billing_address_1'         => '123 Gateway Way',
			'billing_address_2'         => '',
			'billing_city'              => 'San Francisco',
			'billing_state'             => 'CA',
			'billing_postcode'          => '94107',
			'billing_phone'             => '5555555555',
			'billing_email'             => $email,
			'shipping_first_name'       => 'Homeboy',
			'shipping_last_name'        => 'Gateway',
			'shipping_company'          => '',
			'shipping_country'          => 'US',
			'shipping_address_1'        => '123 Gateway Way',
			'shipping_address_2'        => '',
			'shipping_city'             => 'San Francisco',
			'shipping_state'            => 'CA',
			'shipping_postcode'         => '94107',
			'order_comments'            => 'Homeboy gateway matrix ' . $profile . ' ' . $flow . ' ' . $run_id,
			'payment_method'            => $gateway_id,
			'terms'                     => 1,
			'createaccount'             => 0,
			'ship_to_different_address' => 0,
		);
	};

	$snapshot = static function (): array {
		$order_awaiting_payment = WC()->session ? WC()->session->get( 'order_awaiting_payment' ) : null;
		return array(
			'cart_items'              => WC()->cart ? WC()->cart->get_cart_contents_count() : null,
			'cart_total'              => WC()->cart ? (float) WC()->cart->get_total( 'edit' ) : null,
			'cart_hash'               => WC()->cart ? WC()->cart->get_cart_hash() : null,
			'order_awaiting_payment'  => $order_awaiting_payment ? absint( $order_awaiting_payment ) : null,
		);
	};

	$create_order = static function ( array $data ): int {
		$order_id = WC()->checkout()->create_order( $data );
		if ( is_wp_error( $order_id ) ) {
			throw new RuntimeException( 'create_order failed: ' . $order_id->get_error_message() );
		}
		return absint( $order_id );
	};

	$write_order_awaiting_payment = static function ( int $order_id ) use ( &$order_awaiting_payment_write_count ): void {
		if ( WC()->session ) {
			WC()->session->set( 'order_awaiting_payment', $order_id );
			++$order_awaiting_payment_write_count;
			if ( method_exists( WC()->session, 'save_data' ) ) {
				WC()->session->save_data();
			}
		}
	};

	$results = array();
	foreach ( $profiles as $profile ) {
		$order_awaiting_payment_write_count = 0;
		$install                            = $ensure_gateway_profile( $profile );
		$result                             = array(
			'profile'        => $profile['profile'],
			'gateway_id'     => $profile['gateway_id'],
			'expected_gateway_ids' => $profile['expected_gateway_ids'] ?? array( $profile['gateway_id'] ),
			'discovery_patterns' => $profile['discovery_patterns'] ?? array(),
			'label'          => $profile['label'],
			'dependency_slug' => $profile['dependency'] ?? $profile['plugin'],
			'install'        => $install,
			'plugin_file'    => $profile['entrypoint'],
			'checkout_surfaces' => $install['checkout_surfaces'],
			'credential_boundary' => $install['credential_boundary'],
			'dummy_config_valid' => $install['dummy_config_valid'],
			'safe_settings' => $install['safe_settings'],
			'readiness_boundary' => $install['readiness_boundary'],
			'discovered_gateway_ids' => $install['discovered_gateway_ids'],
			'registered_gateway_ids' => $install['registered_gateway_ids'],
			'status'         => $install['status'],
			'status_reason'  => $install['status_reason'],
			'available'      => (bool) $install['available'],
			'build_failed'   => (bool) $install['build_failed'],
			'skipped'        => (bool) $install['skipped'],
			'blocked'        => (bool) $install['blocked'],
			'blocked_by'     => $install['blocked_by'],
			'skip_reason'    => $install['skip_reason'],
		);

		if ( ! $install['available'] ) {
			$results[] = $result;
			continue;
		}

		$gateways = WC()->payment_gateways ? WC()->payment_gateways->payment_gateways() : array();
		$gateway  = $gateways[ $profile['gateway_id'] ] ?? null;
		if ( ! $gateway || ! is_callable( array( $gateway, 'process_payment' ) ) ) {
			$result['skipped']     = true;
			$result['skip_reason'] = 'Gateway object is unavailable or cannot process payment.';
			$results[]             = $result;
			continue;
		}

		$duplicate_cart = $prepare_cart( $profile['profile'], 'duplicate' );
		$duplicate_data = $get_checkout_data( $profile['gateway_id'], $duplicate_cart['email'], $profile['profile'], 'duplicate' );
		$before         = microtime( true );
		$order_id_1     = $create_order( $duplicate_data );
		$after_first    = $snapshot();
		$order_id_2     = $create_order( $duplicate_data );
		$after_second   = $snapshot();
		$elapsed_ms     = ( microtime( true ) - $before ) * 1000;
		$order_ids      = array( $order_id_1, $order_id_2 );
		$unique_ids     = array_values( array_unique( $order_ids ) );
		$orders         = array_filter( array_map( 'wc_get_order', $order_ids ) );

		$success_cart = $prepare_cart( $profile['profile'], 'payment-success' );
		$success_data = $get_checkout_data( $profile['gateway_id'], $success_cart['email'], $profile['profile'], 'payment-success' );
		$success_order_id = $create_order( $success_data );
		$success_before   = $snapshot();
		$write_order_awaiting_payment( $success_order_id );
		$payment_started = microtime( true );
		try {
			$payment_result = $gateway->process_payment( $success_order_id );
			$payment_error  = '';
		} catch ( Throwable $exception ) {
			$payment_result = array( 'result' => 'exception' );
			$payment_error  = $exception->getMessage();
		}
		$payment_elapsed_ms = ( microtime( true ) - $payment_started ) * 1000;
		$success_after      = $snapshot();
		$success_order      = wc_get_order( $success_order_id );

		$failure_cart = $prepare_cart( $profile['profile'], 'payment-failure' );
		$failure_data = $get_checkout_data( $profile['gateway_id'], $failure_cart['email'], $profile['profile'], 'payment-failure' );
		$failure_order_id = $create_order( $failure_data );
		$failure_before   = $snapshot();
		$write_order_awaiting_payment( $failure_order_id );
		$failure_order = wc_get_order( $failure_order_id );
		if ( $failure_order ) {
			$failure_order->update_status( 'failed', 'Homeboy gateway matrix simulated failure.' );
		}
		$failure_after = $snapshot();

		$cancel_cart = $prepare_cart( $profile['profile'], 'payment-cancel' );
		$cancel_data = $get_checkout_data( $profile['gateway_id'], $cancel_cart['email'], $profile['profile'], 'payment-cancel' );
		$cancel_order_id = $create_order( $cancel_data );
		$cancel_before   = $snapshot();
		$write_order_awaiting_payment( $cancel_order_id );
		$cancel_order = wc_get_order( $cancel_order_id );
		if ( $cancel_order ) {
			$cancel_order->update_status( 'cancelled', 'Homeboy gateway matrix simulated cancellation.' );
		}
		$cancel_after = $snapshot();

		$redirect_url = is_array( $payment_result ) && isset( $payment_result['redirect'] ) ? (string) $payment_result['redirect'] : '';
		$order_received_url = $success_order ? $success_order->get_checkout_order_received_url() : '';

		$result['duplicate_flow'] = array(
			'order_create_attempts'              => 2,
			'order_ids'                           => $order_ids,
			'unique_order_ids'                    => $unique_ids,
			'unique_order_count'                  => count( $unique_ids ),
			'duplicate_order_count'               => max( 0, count( $unique_ids ) - 1 ),
			'duplicate_checkout_attempts'         => count( $order_ids ),
			'duplicate_reproduced'                => count( $unique_ids ) > 1,
			'reused_order_awaiting_payment_branch' => 1 === count( $unique_ids ),
			'elapsed_ms'                          => $elapsed_ms,
			'cart_after_duplicate_attempts'       => $after_second,
			'order_awaiting_payment_after_first'  => $after_first['order_awaiting_payment'],
			'order_awaiting_payment_after_second' => $after_second['order_awaiting_payment'],
			'same_cart_hash_order_count'          => count(
				array_filter(
					$orders,
					static function ( WC_Order $order ) use ( $duplicate_cart ): bool {
						return $order->get_cart_hash() === $duplicate_cart['cart_hash'];
					}
				)
			),
		);

		$result['payment_success_flow'] = array(
			'order_id'                => $success_order_id,
			'before'                  => $success_before,
			'after'                   => $success_after,
			'gateway_result'          => is_array( $payment_result ) ? ( $payment_result['result'] ?? 'missing' ) : gettype( $payment_result ),
			'gateway_error'           => $payment_error,
			'order_status'            => $success_order ? $success_order->get_status() : null,
			'cart_cleared'            => ( $success_before['cart_items'] ?? 0 ) > 0 && 0 === ( $success_after['cart_items'] ?? 0 ),
			'payment_elapsed_ms'      => $payment_elapsed_ms,
			'redirect_url'            => $redirect_url,
			'order_received_url'      => $order_received_url,
			'redirect_is_order_received' => $redirect_url && $order_received_url ? 0 === strpos( $redirect_url, strtok( $order_received_url, '?' ) ) : false,
		);

		$result['payment_failure_flow'] = array(
			'order_id'     => $failure_order_id,
			'before'       => $failure_before,
			'after'        => $failure_after,
			'order_status' => $failure_order ? $failure_order->get_status() : null,
			'cart_cleared' => ( $failure_before['cart_items'] ?? 0 ) > 0 && 0 === ( $failure_after['cart_items'] ?? 0 ),
		);

		$result['payment_cancel_flow'] = array(
			'order_id'     => $cancel_order_id,
			'before'       => $cancel_before,
			'after'        => $cancel_after,
			'order_status' => $cancel_order ? $cancel_order->get_status() : null,
			'cart_cleared' => ( $cancel_before['cart_items'] ?? 0 ) > 0 && 0 === ( $cancel_after['cart_items'] ?? 0 ),
		);

		$result['metrics'] = array(
			'available'                                  => 1,
			'order_awaiting_payment_writes'              => $order_awaiting_payment_write_count,
			'order_awaiting_payment_duplicate_branches'  => $result['duplicate_flow']['reused_order_awaiting_payment_branch'] ? 1 : 0,
			'duplicate_checkout_attempts'                => $result['duplicate_flow']['duplicate_checkout_attempts'],
			'duplicate_order_count'                      => $result['duplicate_flow']['duplicate_order_count'],
			'payment_success_cart_cleared'               => $result['payment_success_flow']['cart_cleared'] ? 1 : 0,
			'payment_failure_cart_cleared'               => $result['payment_failure_flow']['cart_cleared'] ? 1 : 0,
			'payment_cancel_cart_cleared'                => $result['payment_cancel_flow']['cart_cleared'] ? 1 : 0,
			'unexpected_cart_clearing'                   => ( $result['payment_failure_flow']['cart_cleared'] || $result['payment_cancel_flow']['cart_cleared'] ) ? 1 : 0,
			'payment_success_elapsed_ms'                 => $payment_elapsed_ms,
			'checkout_duplicate_elapsed_ms'              => $elapsed_ms,
			'redirect_url_present'                       => $redirect_url ? 1 : 0,
			'order_received_url_present'                 => $order_received_url ? 1 : 0,
		);

		$results[] = $result;
	}

	$available_count = count(
		array_filter(
			$results,
			static function ( array $result ): bool {
				return empty( $result['skipped'] );
			}
		)
	);
	$plugin_available_count = count(
		array_filter(
			$results,
			static function ( array $result ): bool {
				return empty( $result['skipped'] ) && 'woocommerce-core' !== ( $result['install']['plugin'] ?? '' );
			}
		)
	);
	$build_failed_count = count(
		array_filter(
			$results,
			static function ( array $result ): bool {
				return ! empty( $result['build_failed'] );
			}
		)
	);
	$blocked_count = count(
		array_filter(
			$results,
			static function ( array $result ): bool {
				return ! empty( $result['blocked'] );
			}
		)
	);

	$summary = array(
		'success_rate'                       => 1,
		'gateway_profile_count'              => count( $results ),
		'gateway_profiles_available'         => $available_count,
		'gateway_plugin_profiles_available'  => $plugin_available_count,
		'gateway_profiles_skipped'           => count( $results ) - $available_count,
		'gateway_profiles_build_failed'      => $build_failed_count,
		'gateway_profiles_blocked'           => $blocked_count,
		'duplicate_checkout_attempts'         => array_sum( array_map( static fn ( array $result ): int => (int) ( $result['metrics']['duplicate_checkout_attempts'] ?? 0 ), $results ) ),
		'duplicate_order_count'               => array_sum( array_map( static fn ( array $result ): int => (int) ( $result['metrics']['duplicate_order_count'] ?? 0 ), $results ) ),
		'order_awaiting_payment_writes'       => array_sum( array_map( static fn ( array $result ): int => (int) ( $result['metrics']['order_awaiting_payment_writes'] ?? 0 ), $results ) ),
		'order_awaiting_payment_branches'     => array_sum( array_map( static fn ( array $result ): int => (int) ( $result['metrics']['order_awaiting_payment_duplicate_branches'] ?? 0 ), $results ) ),
		'unexpected_cart_clearing_profiles'   => array_sum( array_map( static fn ( array $result ): int => (int) ( $result['metrics']['unexpected_cart_clearing'] ?? 0 ), $results ) ),
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
		$artifact_dir = rtrim( $shared_state, '/' ) . '/checkout-gateway-compatibility-matrix';
		wp_mkdir_p( $artifact_dir );
		$artifact_path = $artifact_dir . '/' . $run_id . '.json';
		file_put_contents( $artifact_path, wp_json_encode( $artifact, JSON_PRETTY_PRINT ) . "\n" );
	}

	return array(
		'metrics'   => $summary,
		'metadata'  => array(
			'runner'   => 'wp-codebox',
			'workload' => 'checkout-gateway-compatibility-matrix',
			'issues'   => $issues,
			'profiles' => array_map(
				static function ( array $result ): array {
					return array(
						'profile'              => $result['profile'],
						'gateway_id'           => $result['gateway_id'],
						'expected_gateway_ids' => $result['expected_gateway_ids'],
						'discovery_patterns'   => $result['discovery_patterns'],
						'discovered_gateway_ids' => $result['discovered_gateway_ids'],
						'registered_gateway_ids' => $result['registered_gateway_ids'],
						'dependency_slug'      => $result['dependency_slug'],
						'plugin_file'          => $result['plugin_file'],
						'checkout_surfaces'    => $result['checkout_surfaces'],
						'credential_boundary'  => $result['credential_boundary'],
						'dummy_config_valid'   => $result['dummy_config_valid'],
						'safe_settings'        => $result['safe_settings'],
						'readiness_boundary'   => $result['readiness_boundary'],
						'status'               => $result['status'],
						'status_reason'        => $result['status_reason'],
						'available'            => $result['available'],
						'build_failed'         => $result['build_failed'],
						'skipped'              => $result['skipped'],
						'blocked'              => $result['blocked'],
						'blocked_by'           => $result['blocked_by'],
					);
				},
				$results
			),
		),
		'artifacts' => $artifact_path ? array( 'gateway_matrix' => array( 'path' => $artifact_path, 'kind' => 'json' ) ) : array(),
	);
};
