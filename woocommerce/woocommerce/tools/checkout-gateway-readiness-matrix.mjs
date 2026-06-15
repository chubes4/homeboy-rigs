#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const profiles = [
	{
		profile: 'plugin_woopayments',
		slug: 'woocommerce-payments',
		dependency: 'woocommerce-payments',
		plugin_file: 'woocommerce-payments/woocommerce-payments.php',
	},
	{
		profile: 'plugin_stripe',
		slug: 'woocommerce-gateway-stripe',
		dependency: 'woocommerce-gateway-stripe',
		plugin_file: 'woocommerce-gateway-stripe/woocommerce-gateway-stripe.php',
	},
	{
		profile: 'plugin_paypal_payments',
		slug: 'woocommerce-paypal-payments',
		dependency: 'woocommerce-paypal-payments',
		plugin_file: 'woocommerce-paypal-payments/woocommerce-paypal-payments.php',
	},
	{
		profile: 'plugin_square',
		slug: 'woocommerce-square',
		dependency: 'woocommerce-square',
		plugin_file: 'woocommerce-square/woocommerce-square.php',
		bootstrap_steps: [
			{
				command: 'wordpress.run-php',
				args: [
					"code=update_option( 'active_plugins', array_values( array_unique( array_merge( (array) get_option( 'active_plugins', array() ), array( 'woocommerce/woocommerce.php', 'woocommerce-square/woocommerce-square.php' ) ) ) ) ); update_option( 'wc_square_settings', array( 'enabled' => 'yes', 'environment' => 'sandbox', 'sandbox_application_id' => 'sandbox-app-id', 'sandbox_access_token' => 'sandbox-token', 'location_id' => 'sandbox-location', 'create_customer' => 'no' ) ); update_option( 'woocommerce_square_credit_card_settings', array( 'enabled' => 'yes', 'enable_digital_wallets' => 'no' ) ); update_option( 'woocommerce_square_cash_app_pay_settings', array( 'enabled' => 'no' ) ); if ( function_exists( 'wc_square' ) && is_object( wc_square() ) && method_exists( wc_square(), 'init_plugin' ) && ! wc_square()->get_settings_handler() ) { wc_square()->init_plugin(); }",
				],
			},
		],
	},
	{
		profile: 'plugin_razorpay',
		slug: 'woo-razorpay',
		dependency: 'woo-razorpay',
		plugin_file: 'woo-razorpay/woo-razorpay.php',
	},
	{
		profile: 'plugin_mollie',
		slug: 'mollie-payments-for-woocommerce',
		dependency: 'mollie-payments-for-woocommerce',
		plugin_file: 'mollie-payments-for-woocommerce/mollie-payments-for-woocommerce.php',
		bootstrap_steps: [
			{
				command: 'wordpress.run-php',
				args: [
					"code=update_option( 'active_plugins', array_values( array_unique( array_merge( (array) get_option( 'active_plugins', array() ), array( 'woocommerce/woocommerce.php', 'mollie-payments-for-woocommerce/mollie-payments-for-woocommerce.php' ) ) ) ) ); update_option( 'mollie-payments-for-woocommerce_test_mode_enabled', 'yes' ); update_option( 'mollie-payments-for-woocommerce_test_api_key', 'test_123456789012345678901234567890' ); update_option( 'mollie_wc_gateway_creditcard_settings', array( 'enabled' => 'yes' ) ); update_option( 'mollie_wc_gateway_ideal_settings', array( 'enabled' => 'yes' ) ); update_option( 'mollie_wc_gateway_paypal_settings', array( 'enabled' => 'yes' ) ); $methods = array( array( 'id' => 'creditcard', 'status' => 'activated', 'description' => 'Credit card', 'image' => new stdClass() ), array( 'id' => 'ideal', 'status' => 'activated', 'description' => 'iDEAL', 'image' => new stdClass() ), array( 'id' => 'paypal', 'status' => 'activated', 'description' => 'PayPal', 'image' => new stdClass() ) ); set_transient( 'mollie-wc-' . md5( http_build_query( array( 'locale' => get_locale() ) ) ), $methods, HOUR_IN_SECONDS ); set_transient( 'mollie-wc-' . md5( http_build_query( array( 'mode' => 'test', 'api' => 'methods' ) ) ), $methods, HOUR_IN_SECONDS );",
				],
			},
		],
	},
	{
		profile: 'plugin_klarna',
		slug: 'klarna-payments-for-woocommerce',
		dependency: 'klarna-payments-for-woocommerce',
		plugin_file: 'klarna-payments-for-woocommerce/klarna-payments-for-woocommerce.php',
	},
];

function parseArgs(argv) {
	const options = {
		runner: '',
		rig: 'woocommerce-performance',
		path: '',
		sharedState: '/tmp/woocommerce-gateway-profile-readiness',
		output: 'artifacts/checkout-gateway-readiness-matrix.json',
		profiles: profiles.map((entry) => entry.profile),
	};

	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		const readValue = () => {
			const value = argv[index + 1];
			if (!value) {
				throw new Error(`${arg} requires a value`);
			}
			index += 1;
			return value;
		};

		if (arg === '--runner') {
			options.runner = readValue();
		} else if (arg === '--rig') {
			options.rig = readValue();
		} else if (arg === '--path') {
			options.path = readValue();
		} else if (arg === '--shared-state') {
			options.sharedState = readValue();
		} else if (arg === '--output') {
			options.output = readValue();
		} else if (arg === '--profiles') {
			options.profiles = readValue().split(',').map((profile) => profile.trim()).filter(Boolean);
		} else if (arg === '--help' || arg === '-h') {
			usage();
			process.exit(0);
		} else {
			throw new Error(`Unknown argument: ${arg}`);
		}
	}

	if (!options.path) {
		throw new Error('--path is required');
	}

	return options;
}

function usage() {
	console.log(`Usage: node tools/checkout-gateway-readiness-matrix.mjs --path <woocommerce-plugin-path> [options]

Options:
  --runner <id>          Homeboy Lab runner id.
  --rig <id>             Homeboy rig id. Default: woocommerce-performance.
  --shared-state <path>  Shared state prefix. Default: /tmp/woocommerce-gateway-profile-readiness.
  --profiles <csv>       Profile keys to run. Default: all plugin profiles.
  --output <path>        Aggregate JSON output path.

Environment:
  HOMEBOY_BIN            Homeboy executable path. Default: homeboy.
`);
}

function extractFatal(output) {
	const fatalMatch = output.match(/Fatal error:\s*(.*?)\n/i);
	if (fatalMatch) {
		return fatalMatch[1].replace(/<[^>]+>/g, '').trim();
	}

	const errorMatch = output.match(/Error:\s*(.*?)\n/i);
	return errorMatch ? errorMatch[1].replace(/<[^>]+>/g, '').trim() : '';
}

function extractRunId(output) {
	const hintMatch = output.match(/Persisted benchmark run ID:\s*([a-f0-9-]+)/i);
	if (hintMatch) {
		return hintMatch[1];
	}

	const jsonMatch = output.match(/"id"\s*:\s*"([a-f0-9-]{36})"/);
	return jsonMatch ? jsonMatch[1] : '';
}

function extractWorkloadStatus(output, profile) {
	const profilePattern = new RegExp(`"profile"\\s*:\\s*"${profile.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"[\\s\\S]{0,2000}?"status"\\s*:\\s*"([^"]+)"`);
	const match = output.match(profilePattern);
	return match ? match[1] : '';
}

function classifyStatus(exitCode, fatal, workloadStatus) {
	if (exitCode === 0) {
		return workloadStatus || 'passed';
	}

	if (fatal) {
		return 'fatal';
	}

	return 'build_failed';
}

function isPassingStatus(status) {
	return status === 'ready' || status === 'passed';
}

function runProfile(options, profile) {
	const homeboyBin = process.env.HOMEBOY_BIN || 'homeboy';
	const dependency = {
		source_type: 'wp.org',
		slug: profile.slug,
		dependency: profile.dependency,
		plugin_file: profile.plugin_file,
		profiles: [profile.profile],
		profile_env: 'WC_CHECKOUT_GATEWAY_MATRIX_PROFILES',
	};

	const args = [
		'bench',
		'--rig',
		options.rig,
		'--scenario',
		'checkout-gateway-profile-readiness',
		'--iterations',
		'1',
		'--path',
		options.path,
		'--shared-state',
		`${options.sharedState}-${profile.profile}`,
		'--setting-json',
		`bench_env=${JSON.stringify({ WC_CHECKOUT_GATEWAY_MATRIX_PROFILES: profile.profile })}`,
		'--setting-json',
		`validation_dependencies=${JSON.stringify([dependency])}`,
	];

	if (profile.bootstrap_steps) {
		args.push('--setting-json', `wp_codebox_bootstrap_steps=${JSON.stringify(profile.bootstrap_steps)}`);
	}

	if (options.runner) {
		args.splice(1, 0, '--runner', options.runner);
	}

	const result = spawnSync(homeboyBin, args, { encoding: 'utf8' });
	const output = `${result.stdout || ''}\n${result.stderr || ''}`;
	const fatal = result.status === 0 ? '' : extractFatal(output);
	const workloadStatus = extractWorkloadStatus(output, profile.profile);
	const status = classifyStatus(result.status, fatal, workloadStatus);

	return {
		profile: profile.profile,
		dependency: profile.dependency,
		plugin_file: profile.plugin_file,
		status,
		exit_code: result.status,
		run_id: extractRunId(output),
		fatal,
		workload_status: workloadStatus,
		output_tail: output.split('\n').slice(-80),
	};
}

const options = parseArgs(process.argv.slice(2));
const selectedProfiles = profiles.filter((profile) => options.profiles.includes(profile.profile));
const results = [];

for (const profile of selectedProfiles) {
	console.log(`[gateway-readiness] ${profile.profile}`);
	const result = runProfile(options, profile);
	results.push(result);
	console.log(`[gateway-readiness] ${profile.profile}: ${result.status}${result.run_id ? ` (${result.run_id})` : ''}`);
}

const artifact = {
	schema: 'homeboy-rigs/woocommerce-gateway-readiness-matrix/v1',
	generated_at: new Date().toISOString(),
	runner: options.runner || 'local',
	rig: options.rig,
	homeboy_bin: process.env.HOMEBOY_BIN || 'homeboy',
	component_path: options.path,
	profiles: results,
	summary: {
		total: results.length,
		ready: results.filter((result) => result.status === 'ready').length,
		passed: results.filter((result) => result.status === 'passed').length,
		fatal: results.filter((result) => result.status === 'fatal').length,
		build_failed: results.filter((result) => result.status === 'build_failed').length,
	},
};

mkdirSync(dirname(resolve(options.output)), { recursive: true });
writeFileSync(options.output, `${JSON.stringify(artifact, null, 2)}\n`);
console.log(`[gateway-readiness] wrote ${options.output}`);

process.exitCode = results.some((result) => !isPassingStatus(result.status)) ? 1 : 0;
