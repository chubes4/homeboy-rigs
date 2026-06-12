import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify( execFile );

const packageRoot = process.env.HOMEBOY_COMPONENT_PATH;
const componentPluginPath = path.join( packageRoot || '', 'plugins/woocommerce' );
const woocommercePath = process.env.HOMEBOY_WOOCOMMERCE_CART_RACE_WOOCOMMERCE_PATH || process.env.HOMEBOY_SETTINGS_WOOCOMMERCE_CART_RACE_WOOCOMMERCE_PATH || ( existsSync( path.join( componentPluginPath, 'woocommerce.php' ) ) ? componentPluginPath : path.join( process.env.HOME || '', 'Developer/woocommerce/plugins/woocommerce' ) );
const componentId = process.env.HOMEBOY_COMPONENT_ID || 'woocommerce';
const scenarioId = process.env.HOMEBOY_TRACE_SCENARIO || 'cart-session-overwrite-race';
const resultsFile = process.env.HOMEBOY_TRACE_RESULTS_FILE;
const artifactDir = process.env.HOMEBOY_TRACE_ARTIFACT_DIR || path.join( tmpdir(), 'woocommerce-cart-session-overwrite-race-artifacts' );
const wpCodeboxBin = process.env.HOMEBOY_WP_CODEBOX_BIN || process.env.HOMEBOY_SETTINGS_WP_CODEBOX_BIN || path.join( process.env.HOME || '', 'Developer/wp-codebox/packages/cli/dist/index.js' );
const wpVersion = process.env.HOMEBOY_WOOCOMMERCE_CART_RACE_WP_VERSION || process.env.HOMEBOY_SETTINGS_WOOCOMMERCE_CART_RACE_WP_VERSION || '7.0';
const probeDuration = process.env.HOMEBOY_WOOCOMMERCE_CART_RACE_PROBE_DURATION || '8s';
const viewport = process.env.HOMEBOY_WOOCOMMERCE_CART_RACE_VIEWPORT || '1366x900';
const staleCartDelayMs = Number.parseInt( process.env.HOMEBOY_WOOCOMMERCE_CART_RACE_STALE_CART_DELAY_MS || '1200', 10 );
const addToCartDelayMs = Number.parseInt( process.env.HOMEBOY_WOOCOMMERCE_CART_RACE_ADD_TO_CART_DELAY_MS || '150', 10 );

if ( ! packageRoot ) {
	throw new Error( 'HOMEBOY_COMPONENT_PATH is required' );
}
if ( ! resultsFile ) {
	throw new Error( 'HOMEBOY_TRACE_RESULTS_FILE is required' );
}
if ( ! existsSync( path.join( woocommercePath, 'woocommerce.php' ) ) ) {
	throw new Error( `Missing WooCommerce plugin entrypoint at ${ woocommercePath }/woocommerce.php` );
}

await mkdir( artifactDir, { recursive: true } );
await mkdir( path.dirname( resultsFile ), { recursive: true } );

const workDir = await mkdtemp( path.join( tmpdir(), 'woocommerce-cart-session-overwrite-race.' ) );
const fixturePluginDir = path.join( workDir, 'woocommerce-cart-session-race-fixture' );
const setupFile = path.join( workDir, 'setup.php' );
const stateFile = path.join( workDir, 'fixture-state.json' );
const recipeFile = path.join( workDir, 'recipe.json' );
const outputFile = path.join( artifactDir, 'wp-codebox-output.json' );
const codeboxArtifacts = path.join( artifactDir, 'wp-codebox-artifacts' );
const metricsPath = path.join( artifactDir, 'cart-session-overwrite-race-metrics.json' );
const metadataPath = path.join( artifactDir, 'cart-session-overwrite-race-metadata.json' );
const startedAt = performance.now();
const timeline = [];

function timestampMs() {
	return Math.round( performance.now() - startedAt );
}

function event( source, name, data = {} ) {
	timeline.push( { t_ms: timestampMs(), source, event: name, data } );
}

function wpCodeboxCommand() {
	if ( wpCodeboxBin.endsWith( '.js' ) || wpCodeboxBin.endsWith( '.cjs' ) || wpCodeboxBin.endsWith( '.mjs' ) ) {
		return { command: 'node', args: [ wpCodeboxBin ] };
	}

	return { command: wpCodeboxBin, args: [] };
}

async function readJsonAsync( pathname ) {
	return existsSync( pathname ) ? JSON.parse( await readFile( pathname, 'utf8' ) ) : null;
}

async function readJsonl( pathname ) {
	if ( ! existsSync( pathname ) ) {
		return [];
	}

	const contents = await readFile( pathname, 'utf8' );
	return contents
		.trim()
		.split( '\n' )
		.filter( Boolean )
		.map( ( line ) => JSON.parse( line ) );
}

function relativeArtifactPath( pathname ) {
	return path.relative( artifactDir, pathname );
}

async function writeFixturePlugin() {
	await mkdir( fixturePluginDir, { recursive: true } );
	await writeFile(
		path.join( fixturePluginDir, 'woocommerce-cart-session-race-fixture.php' ),
		`<?php
/**
 * Plugin Name: WooCommerce Cart Session Race Fixture
 */

add_action(
	'template_redirect',
	function () {
		if ( ! function_exists( 'WC' ) ) {
			return;
		}

		if ( ! empty( $_GET['homeboy_cart_session_race_seed_session'] ) && WC()->session ) {
			WC()->session->set( 'homeboy_cart_session_race_seed', microtime( true ) );
			if ( method_exists( WC()->session, 'set_customer_session_cookie' ) ) {
				WC()->session->set_customer_session_cookie( true );
			}
			WC()->session->save_data();
		}

		if ( empty( $_GET['homeboy_cart_session_race_stale_cart'] ) || ! function_exists( 'wc_add_notice' ) ) {
			return;
		}

		if ( WC()->cart ) {
			WC()->cart->get_cart();
		}

		add_action(
			'shutdown',
			function () {
				if ( function_exists( 'wc_add_notice' ) ) {
					wc_add_notice( 'Homeboy cart page refresh dirtied the stale session snapshot.' );
				}

				$delay_ms = isset( $_GET['homeboy_cart_session_race_delay_ms'] ) ? max( 0, (int) $_GET['homeboy_cart_session_race_delay_ms'] ) : 1000;
				if ( $delay_ms > 0 ) {
					usleep( $delay_ms * 1000 );
				}
			},
			5
		);
	},
	1
);

add_action(
	'rest_api_init',
	function () {
		register_rest_route(
			'homeboy-cart-session-race/v1',
			'/seed-session',
			array(
				'methods'             => 'POST',
				'permission_callback' => '__return_true',
				'callback'            => function () {
					if ( ! function_exists( 'WC' ) || ! WC()->session ) {
						return new WP_Error( 'missing_woocommerce_session', 'WooCommerce session is not available.', array( 'status' => 500 ) );
					}

					WC()->session->set( 'homeboy_cart_session_race_seed', microtime( true ) );
					if ( method_exists( WC()->session, 'set_customer_session_cookie' ) ) {
						WC()->session->set_customer_session_cookie( true );
					}
					WC()->session->save_data();

					return rest_ensure_response( array( 'seeded' => true ) );
				},
			)
		);

		register_rest_route(
			'homeboy-cart-session-race/v1',
			'/fixture',
			array(
				'methods'             => 'GET',
				'permission_callback' => '__return_true',
				'callback'            => function () {
					return rest_ensure_response( (array) get_option( 'homeboy_cart_session_race_fixture', array() ) );
				},
			)
		);

		register_rest_route(
			'homeboy-cart-session-race/v1',
			'/session',
			array(
				'methods'             => 'GET',
				'permission_callback' => '__return_true',
				'callback'            => function () {
					global $wpdb;

					$cookie_name = '';
					$customer_id = '';
					foreach ( $_COOKIE as $name => $value ) {
						if ( 0 === strpos( $name, 'wp_woocommerce_session_' ) ) {
							$cookie_name = $name;
							$parts       = explode( '|', (string) $value );
							$customer_id = (string) ( $parts[0] ?? '' );
							break;
						}
					}

					$session = array();
					if ( $customer_id ) {
						$row = $wpdb->get_var(
							$wpdb->prepare(
								'SELECT session_value FROM %i WHERE session_key = %s',
								$wpdb->prefix . 'woocommerce_sessions',
								$customer_id
							)
						);
						$session = $row ? (array) maybe_unserialize( $row ) : array();
					}

					$cart    = isset( $session['cart'] ) ? maybe_unserialize( $session['cart'] ) : array();
					$notices = isset( $session['wc_notices'] ) ? maybe_unserialize( $session['wc_notices'] ) : array();

					return rest_ensure_response(
						array(
							'cookie_name'         => $cookie_name,
							'customer_id_present' => '' !== $customer_id,
							'session_keys'        => array_keys( $session ),
							'cart_item_count'     => is_array( $cart ) ? count( $cart ) : 0,
							'wc_notices_present'  => ! empty( $notices ),
						)
					);
				},
			)
		);
	}
);
`
	);
}

async function writeSetupFile() {
	await writeFile(
		setupFile,
		`<?php
if ( ! function_exists( 'WC' ) ) {
	throw new RuntimeException( 'WooCommerce is not loaded.' );
}

update_option( 'woocommerce_default_country', 'US:CA' );
update_option( 'woocommerce_currency', 'USD' );
update_option( 'woocommerce_prices_include_tax', 'no' );
update_option( 'woocommerce_calc_taxes', 'no' );
update_option( 'woocommerce_enable_guest_checkout', 'yes' );
update_option( 'woocommerce_cart_redirect_after_add', 'no' );

if ( class_exists( 'WC_Install' ) ) {
	WC_Install::create_pages();
}

$product = new WC_Product_Simple();
$product->set_name( 'Homeboy Cart Session Race Browser Product' );
$product->set_slug( 'homeboy-cart-session-race-browser-product' );
$product->set_status( 'publish' );
$product->set_sku( 'homeboy-cart-session-race-browser-product-' . wp_generate_password( 6, false ) );
$product->set_regular_price( '19.99' );
$product->set_price( '19.99' );
$product->set_virtual( true );
$product->set_manage_stock( false );
$product->set_stock_status( 'instock' );
$product->save();

$cart_page_id = wc_get_page_id( 'cart' );
if ( $cart_page_id <= 0 ) {
	$cart_page_id = wp_insert_post(
		array(
			'post_title'   => 'Cart',
			'post_name'    => 'cart',
			'post_type'    => 'page',
			'post_status'  => 'publish',
			'post_content' => '<!-- wp:shortcode -->[woocommerce_cart]<!-- /wp:shortcode -->',
		)
	);
	update_option( 'woocommerce_cart_page_id', $cart_page_id );
}

$fixture_state = array(
	'product_id'   => $product->get_id(),
	'product_url'  => wp_make_link_relative( get_permalink( $product->get_id() ) ),
	'cart_url'     => wp_make_link_relative( get_permalink( $cart_page_id ) ),
	'product_name' => $product->get_name(),
	'issue'        => 'https://github.com/woocommerce/woocommerce/issues/46483',
);

update_option( 'homeboy_cart_session_race_fixture', $fixture_state, false );

file_put_contents(
	'${ stateFile.replaceAll( "'", "'\\''" ) }',
	wp_json_encode( $fixture_state, JSON_PRETTY_PRINT ) . "\n"
);
`
	);
}

try {
	event( 'scenario', 'start', {
		component_path: packageRoot,
		woocommerce_path: woocommercePath,
		wp_version: wpVersion,
		issue: 'https://github.com/woocommerce/woocommerce/issues/46483',
		stale_cart_delay_ms: staleCartDelayMs,
		add_to_cart_delay_ms: addToCartDelayMs,
	} );

	await writeFixturePlugin();
	await writeSetupFile();

	const browserScript = `
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const seedSession = async () => {
	const response = await fetch('/wp-json/homeboy-cart-session-race/v1/seed-session', { method: 'POST', credentials: 'same-origin' });
	return response.json();
};
const readFixture = async () => {
	const response = await fetch('/wp-json/homeboy-cart-session-race/v1/fixture', { credentials: 'same-origin' });
	return response.json();
};
const readSession = async () => {
	const response = await fetch('/wp-json/homeboy-cart-session-race/v1/session', { credentials: 'same-origin' });
	return response.json();
};
const fixture = await readFixture();
const productUrl = fixture.product_url || window.location.pathname;
const cartUrl = fixture.cart_url || '/cart/';
const warmCartUrl = cartUrl + (cartUrl.includes('?') ? '&' : '?') + 'homeboy_cart_session_race_seed_session=1';
const staleCartUrl = cartUrl + (cartUrl.includes('?') ? '&' : '?') + 'homeboy_cart_session_race_stale_cart=1&homeboy_cart_session_race_delay_ms=${ staleCartDelayMs }';
const seed = await seedSession();
const warmCartResponse = await fetch(warmCartUrl, { credentials: 'same-origin' });
await warmCartResponse.text();
const before = await readSession();
const staleCartRequest = fetch(staleCartUrl, { credentials: 'same-origin' }).then(async (response) => ({
	status: response.status,
	url: response.url,
	text_sample: (await response.text()).slice(0, 500),
}));
await sleep(${ addToCartDelayMs });
const body = new URLSearchParams();
body.set('add-to-cart', String(fixture.product_id));
body.set('quantity', '1');
const addToCartResponse = await fetch(productUrl, {
	method: 'POST',
	credentials: 'same-origin',
	headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
	body,
});
const addToCartHtml = await addToCartResponse.text();
const afterAdd = await readSession();
const staleCart = await staleCartRequest;
const afterStaleSave = await readSession();
const cartResponse = await fetch(cartUrl, { credentials: 'same-origin' });
const cartHtml = await cartResponse.text();
const productName = fixture.product_name || 'Homeboy Cart Session Race Browser Product';
return {
	fixture,
	before,
	seed,
	warmCart: {
		status: warmCartResponse.status,
		url: warmCartResponse.url,
	},
	afterAdd,
	afterStaleSave,
	staleCart,
	addToCart: {
		status: addToCartResponse.status,
		url: addToCartResponse.url,
		hasProductName: addToCartHtml.includes(productName),
	},
	finalCart: {
		status: cartResponse.status,
		hasProductName: cartHtml.includes(productName),
		hasEmptyCartText: /cart is currently empty|your cart is currently empty/i.test(cartHtml),
	},
	overwriteReproduced: afterAdd.cart_item_count > 0 && afterStaleSave.cart_item_count === 0 && afterStaleSave.wc_notices_present === true,
};`;

	const recipe = {
		schema: 'wp-codebox/workspace-recipe/v1',
		runtime: {
			wp: wpVersion,
			blueprint: {
				steps: [
					{ step: 'activatePlugin', pluginPath: '/wordpress/wp-content/plugins/woocommerce/woocommerce.php' },
					{ step: 'activatePlugin', pluginPath: '/wordpress/wp-content/plugins/woocommerce-cart-session-race-fixture/woocommerce-cart-session-race-fixture.php' },
				],
			},
		},
		inputs: {
			extra_plugins: [
				{ source: woocommercePath, slug: 'woocommerce', pluginFile: 'woocommerce/woocommerce.php', activate: true },
				{ source: fixturePluginDir, slug: 'woocommerce-cart-session-race-fixture', pluginFile: 'woocommerce-cart-session-race-fixture/woocommerce-cart-session-race-fixture.php', activate: true },
			],
		},
		workflow: {
			steps: [
				{ command: 'wordpress.run-php', args: [ `code-file=${ setupFile }` ] },
				{
					command: 'wordpress.browser-probe',
					args: [
						'url=/?post_type=product&name=homeboy-cart-session-race-browser-product',
						'wait-for=load',
						`duration=${ probeDuration }`,
						`viewport=${ viewport }`,
						'capture=console,errors,screenshot,network,performance,memory,html',
						`script=${ browserScript }`,
					],
				},
			],
		},
		artifacts: { directory: codeboxArtifacts },
	};

	await writeFile( recipeFile, `${ JSON.stringify( recipe, null, 2 ) }\n` );

	event( 'wp_codebox', 'recipe.start', { recipe_file: recipeFile } );
	const { command, args } = wpCodeboxCommand();
	const result = await execFileAsync( command, [ ...args, 'recipe-run', '--recipe', recipeFile, '--artifacts', codeboxArtifacts, '--json' ], {
		maxBuffer: 1024 * 1024 * 50,
	} );
	await writeFile( outputFile, result.stdout );

	const output = JSON.parse( result.stdout );
	const bundleDir = output.artifacts?.directory;
	const browserDir = bundleDir ? path.join( bundleDir, 'files', 'browser' ) : '';
	const summaryPath = browserDir ? path.join( browserDir, 'summary.json' ) : '';
	const errorsPath = browserDir ? path.join( browserDir, 'errors.jsonl' ) : '';
	const networkPath = browserDir ? path.join( browserDir, 'network.jsonl' ) : '';
	const performancePath = browserDir ? path.join( browserDir, 'performance.json' ) : '';
	const summary = await readJsonAsync( summaryPath );
	const pageErrors = await readJsonl( errorsPath );
	const network = await readJsonl( networkPath );
	const scriptResult = summary?.summary?.scriptResult || summary?.scriptResult || {};

	event( 'browser', 'probe.ready', {
		final_url: summary?.summary?.finalUrl || summary?.finalUrl || null,
	} );

	const metrics = {
		issue: 'woocommerce/woocommerce#46483',
		overwrite_reproduced: scriptResult.overwriteReproduced === true,
		cart_item_count_before: scriptResult.before?.cart_item_count ?? null,
		cart_item_count_after_add_to_cart: scriptResult.afterAdd?.cart_item_count ?? null,
		cart_item_count_after_stale_save: scriptResult.afterStaleSave?.cart_item_count ?? null,
		wc_notices_present_after_stale_save: scriptResult.afterStaleSave?.wc_notices_present === true,
		final_cart_has_product_name: scriptResult.finalCart?.hasProductName === true,
		final_cart_has_empty_cart_text: scriptResult.finalCart?.hasEmptyCartText === true,
		add_to_cart_status: scriptResult.addToCart?.status ?? null,
		stale_cart_status: scriptResult.staleCart?.status ?? null,
		page_error_count: pageErrors.length,
		network_response_count: network.filter( ( entry ) => entry.type === 'response' ).length,
		browser_probe_duration_ms: summary?.durationMs ?? null,
	};

	await writeFile( metricsPath, `${ JSON.stringify( metrics, null, 2 ) }\n` );
	await writeFile(
		metadataPath,
		`${ JSON.stringify(
			{
				final_url: summary?.summary?.finalUrl || summary?.finalUrl || null,
				scenario: {
					id: scenarioId,
					description: 'Browser-level two-request WooCommerce cart session stale overwrite repro for woocommerce/woocommerce#46483.',
				},
				browser_script_result: scriptResult,
				page_errors_sample: pageErrors.slice( 0, 20 ),
			},
			null,
			2
		) }\n`
	);
	event( 'cart-session-overwrite-race', 'metrics.ready', metrics );

	const noPageErrors = pageErrors.length === 0;
	const pass = metrics.overwrite_reproduced && metrics.add_to_cart_status >= 200 && metrics.add_to_cart_status < 400 && metrics.stale_cart_status >= 200 && metrics.stale_cart_status < 400 && noPageErrors;
	const traceResult = {
		component_id: componentId,
		scenario_id: scenarioId,
		status: pass ? 'pass' : 'fail',
		summary: `Captured WooCommerce cart session overwrite race: after add-to-cart=${ metrics.cart_item_count_after_add_to_cart }, after stale cart save=${ metrics.cart_item_count_after_stale_save }, notices=${ metrics.wc_notices_present_after_stale_save }.` ,
		timeline,
		assertions: [
			{
				id: 'product-page-add-to-cart-saved-cart-item',
				status: metrics.cart_item_count_after_add_to_cart > 0 ? 'pass' : 'fail',
				message: `Product-page add-to-cart persisted ${ metrics.cart_item_count_after_add_to_cart } cart item(s).`,
			},
			{
				id: 'stale-cart-page-overwrote-session',
				status: metrics.overwrite_reproduced ? 'pass' : 'fail',
				message: `Stale cart page save left ${ metrics.cart_item_count_after_stale_save } cart item(s) and wc_notices_present=${ metrics.wc_notices_present_after_stale_save }.`,
			},
			{
				id: 'browser-page-errors-recorded',
				status: noPageErrors ? 'pass' : 'fail',
				message: `Recorded ${ pageErrors.length } page errors.`,
			},
		],
		artifacts: [
			{ label: 'WP Codebox output', path: relativeArtifactPath( outputFile ) },
			{ label: 'Cart session overwrite metrics', path: relativeArtifactPath( metricsPath ) },
			{ label: 'Cart session overwrite metadata', path: relativeArtifactPath( metadataPath ) },
			...( summaryPath && existsSync( summaryPath ) ? [ { label: 'Browser summary', path: relativeArtifactPath( summaryPath ) } ] : [] ),
			...( networkPath && existsSync( networkPath ) ? [ { label: 'Browser network log', path: relativeArtifactPath( networkPath ) } ] : [] ),
			...( performancePath && existsSync( performancePath ) ? [ { label: 'Browser performance', path: relativeArtifactPath( performancePath ) } ] : [] ),
		],
	};

	await writeFile( resultsFile, `${ JSON.stringify( traceResult, null, 2 ) }\n` );
	process.exitCode = pass ? 0 : 1;
} catch ( error ) {
	const traceResult = {
		component_id: componentId,
		scenario_id: scenarioId,
		status: 'fail',
		summary: error instanceof Error ? error.message : String( error ),
		timeline,
		assertions: [
			{
				id: 'trace-workload-completed',
				status: 'fail',
				message: error instanceof Error ? error.message : String( error ),
			},
		],
		artifacts: existsSync( outputFile ) ? [ { label: 'WP Codebox output', path: relativeArtifactPath( outputFile ) } ] : [],
	};

	await writeFile( resultsFile, `${ JSON.stringify( traceResult, null, 2 ) }\n` );
	throw error;
} finally {
	await rm( workDir, { recursive: true, force: true } );
}
