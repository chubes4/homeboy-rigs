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

	$run_id = 'woocommerce-checkout-gateway-compatibility-matrix-' . getmypid() . '-' . time() . '-' . wp_generate_password( 6, false );
	$issues = array(
		'https://github.com/woocommerce/woocommerce/issues/62659',
		'https://github.com/woocommerce/woocommerce/pull/65588',
		'https://github.com/woocommerce/woocommerce/pull/65588#pullrequestreview-4488383929',
		'https://github.com/chubes4/homeboy-rigs/issues/255',
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
			'label'          => 'Direct bank transfer (BACS)',
			'plugin'         => 'woocommerce-core',
			'entrypoint'     => '',
			'settings'       => array( 'enabled' => 'yes' ),
		),
		array(
			'profile'        => 'core_cheque',
			'gateway_id'     => 'cheque',
			'label'          => 'Check payments',
			'plugin'         => 'woocommerce-core',
			'entrypoint'     => '',
			'settings'       => array( 'enabled' => 'yes' ),
		),
		array(
			'profile'        => 'core_cod',
			'gateway_id'     => 'cod',
			'label'          => 'Cash on delivery',
			'plugin'         => 'woocommerce-core',
			'entrypoint'     => '',
			'settings'       => array(
				'enabled'            => 'yes',
				'enable_for_methods' => array(),
				'enable_for_virtual' => 'yes',
			),
		),
		array(
			'profile'        => 'plugin_stripe',
			'gateway_id'     => 'stripe',
			'label'          => 'WooCommerce Stripe Gateway',
			'plugin'         => 'woocommerce-gateway-stripe',
			'entrypoint'     => 'woocommerce-gateway-stripe/woocommerce-gateway-stripe.php',
			'settings'       => array(
				'enabled'  => 'yes',
				'testmode' => 'yes',
			),
		),
		array(
			'profile'        => 'plugin_paypal_payments',
			'gateway_id'     => 'ppcp-gateway',
			'label'          => 'WooCommerce PayPal Payments',
			'plugin'         => 'woocommerce-paypal-payments',
			'entrypoint'     => 'woocommerce-paypal-payments/woocommerce-paypal-payments.php',
			'settings'       => array( 'enabled' => 'yes' ),
		),
		array(
			'profile'        => 'plugin_woopayments',
			'gateway_id'     => 'woocommerce_payments',
			'label'          => 'WooPayments',
			'plugin'         => 'woocommerce-payments',
			'entrypoint'     => 'woocommerce-payments/woocommerce-payments.php',
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

	$ensure_gateway_profile = static function ( array $profile ): array {
		$entrypoint_path = $profile['entrypoint'] ? WP_PLUGIN_DIR . '/' . $profile['entrypoint'] : '';
		$install         = array(
			'plugin'          => $profile['plugin'],
			'entrypoint'      => $profile['entrypoint'],
			'entrypoint_path' => $entrypoint_path,
			'available'       => true,
			'activated'       => false,
			'version'         => null,
			'skip_reason'     => '',
		);

		if ( $profile['entrypoint'] ) {
			if ( ! file_exists( $entrypoint_path ) ) {
				$install['available']   = false;
				$install['skip_reason'] = 'Plugin entrypoint is not mounted in WP Codebox.';
				return $install;
			}

			if ( ! function_exists( 'is_plugin_active' ) || ! function_exists( 'activate_plugin' ) ) {
				require_once ABSPATH . 'wp-admin/includes/plugin.php';
			}

			if ( function_exists( 'is_plugin_active' ) && ! is_plugin_active( $profile['entrypoint'] ) ) {
				$result = activate_plugin( $profile['entrypoint'], '', false, true );
				if ( is_wp_error( $result ) ) {
					$install['available']   = false;
					$install['skip_reason'] = 'Plugin activation failed: ' . $result->get_error_message();
					return $install;
				}
				$install['activated'] = true;
			}

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

		$gateways = WC()->payment_gateways ? WC()->payment_gateways->payment_gateways() : array();
		if ( ! isset( $gateways[ $profile['gateway_id'] ] ) ) {
			$install['available']   = false;
			$install['skip_reason'] = 'Gateway id is not registered after activation/configuration.';
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
			'label'          => $profile['label'],
			'install'        => $install,
			'skipped'        => ! $install['available'],
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

	$summary = array(
		'success_rate'                       => 1,
		'gateway_profile_count'              => count( $results ),
		'gateway_profiles_available'         => $available_count,
		'gateway_plugin_profiles_available'  => $plugin_available_count,
		'gateway_profiles_skipped'           => count( $results ) - $available_count,
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
			'profiles' => array_map( static fn ( array $result ): string => $result['profile'], $results ),
		),
		'artifacts' => $artifact_path ? array( 'gateway_matrix' => array( 'path' => $artifact_path, 'kind' => 'json' ) ) : array(),
	);
};
