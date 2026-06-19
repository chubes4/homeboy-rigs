import { existsSync } from 'node:fs';
import path from 'node:path';

import { runBrowserCoverageTrace } from '../../../shared/wp-codebox/browser-coverage-trace.mjs';

const packageRoot = process.env.HOMEBOY_COMPONENT_PATH;
const componentPluginPath = path.join( packageRoot || '', 'plugins/woocommerce' );
const woocommercePath = process.env.HOMEBOY_WOOCOMMERCE_BROWSER_COVERAGE_WOOCOMMERCE_PATH || ( existsSync( path.join( componentPluginPath, 'woocommerce.php' ) ) ? componentPluginPath : packageRoot );
const scenarioRoot = new URL( '../browser-scenarios/', import.meta.url ).pathname;

await runBrowserCoverageTrace( {
	componentId: 'woocommerce',
	scenarioId: 'woocommerce-browser-coverage',
	componentPath: woocommercePath,
	requiredFile: 'woocommerce.php',
	wpVersion: process.env.HOMEBOY_WOOCOMMERCE_BROWSER_COVERAGE_WP_VERSION || '7.0',
	blueprintSteps: [
		{ step: 'activatePlugin', pluginPath: '/wordpress/wp-content/plugins/woocommerce/woocommerce.php' },
		{ step: 'login', username: 'admin', password: 'password' },
	],
	inputs: {
		extra_plugins: [
			{ source: woocommercePath, slug: 'woocommerce', pluginFile: 'woocommerce/woocommerce.php', activate: true },
		],
	},
	setupCode: `<?php
if ( ! function_exists( 'WC' ) ) {
	throw new RuntimeException( 'WooCommerce is not loaded.' );
}

update_option( 'woocommerce_default_country', 'US:CA' );
update_option( 'woocommerce_currency', 'USD' );
update_option( 'woocommerce_prices_include_tax', 'no' );
update_option( 'woocommerce_calc_taxes', 'no' );
update_option( 'woocommerce_enable_guest_checkout', 'yes' );

if ( class_exists( 'WC_Install' ) ) {
	WC_Install::create_pages();
}

$product_id = 1001;
$existing = get_post( $product_id );
if ( ! $existing ) {
	wp_insert_post(
		array(
			'ID'           => $product_id,
			'post_title'   => 'Homeboy Browser Coverage Product',
			'post_name'    => 'homeboy-browser-coverage-product',
			'post_type'    => 'product',
			'post_status'  => 'publish',
			'post_content' => 'Fixture product for browser request coverage.',
		)
	);
}

$product = wc_get_product( $product_id );
if ( ! $product ) {
	$product = new WC_Product_Simple( $product_id );
}
$product->set_name( 'Homeboy Browser Coverage Product' );
$product->set_slug( 'homeboy-browser-coverage-product' );
$product->set_status( 'publish' );
$product->set_regular_price( '19.99' );
$product->set_price( '19.99' );
$product->set_virtual( true );
$product->set_manage_stock( false );
$product->set_stock_status( 'instock' );
$product->save();
`,
	assumptions: [
		'WooCommerce is mounted and activated as a WP Codebox plugin before setup runs.',
		'The fixture creates a simple virtual product with ID 1001 so cart and checkout URLs can be deterministic.',
		'Payment/shipping completion is out of scope for this request-coverage workload; checkout page bootstrap coverage is captured.',
	],
	scenarios: [
		{ id: 'shop', stepsFile: path.join( scenarioRoot, 'shop.json' ) },
		{ id: 'product', stepsFile: path.join( scenarioRoot, 'product.json' ) },
		{ id: 'cart', stepsFile: path.join( scenarioRoot, 'cart.json' ) },
		{ id: 'checkout', stepsFile: path.join( scenarioRoot, 'checkout.json' ) },
		{ id: 'orders_admin', stepsFile: path.join( scenarioRoot, 'orders_admin.json' ) },
		{ id: 'products_admin', stepsFile: path.join( scenarioRoot, 'products_admin.json' ) },
		{ id: 'analytics_admin', stepsFile: path.join( scenarioRoot, 'analytics_admin.json' ) },
	],
} );
