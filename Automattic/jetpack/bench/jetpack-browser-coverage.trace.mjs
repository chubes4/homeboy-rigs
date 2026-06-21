import path from 'node:path';

import { runBrowserCoverageTrace } from '../../../shared/wp-codebox/browser-coverage-trace.mjs';

const componentPath = process.env.HOMEBOY_COMPONENT_PATH;
const scenarioRoot = new URL( '../browser-scenarios/', import.meta.url ).pathname;

await runBrowserCoverageTrace( {
	componentId: 'jetpack',
	scenarioId: 'jetpack-browser-coverage',
	componentPath,
	requiredFile: 'jetpack.php',
	wpVersion: process.env.HOMEBOY_JETPACK_BROWSER_COVERAGE_WP_VERSION || '7.0',
	blueprintSteps: [
		{ step: 'activatePlugin', pluginPath: '/wordpress/wp-content/plugins/jetpack/jetpack.php' },
		{ step: 'login', username: 'admin', password: 'password' },
	],
	inputs: {
		extraPlugins: [
			{ source: componentPath, slug: 'jetpack', pluginFile: 'jetpack/jetpack.php', activate: true },
		],
	},
	setupCode: `<?php
wp_insert_post(
	array(
		'ID'           => 1201,
		'post_title'   => 'Homeboy Jetpack Frontend Coverage',
		'post_name'    => 'homeboy-jetpack-frontend-coverage',
		'post_type'    => 'post',
		'post_status'  => 'publish',
		'post_content' => '<!-- wp:paragraph --><p>Fixture post for Jetpack frontend module request coverage.</p><!-- /wp:paragraph -->\n[gallery ids="1202"]\n[contact-form][contact-field label="Email" type="email" required="1"/][/contact-form]',
	)
);

wp_insert_post(
	array(
		'ID'           => 1203,
		'post_title'   => 'Homeboy Jetpack Frontend Coverage Page',
		'post_name'    => 'homeboy-jetpack-frontend-coverage-page',
		'post_type'    => 'page',
		'post_status'  => 'publish',
		'post_content' => '<!-- wp:paragraph --><p>Fixture page for Jetpack frontend module request coverage.</p><!-- /wp:paragraph -->',
	)
);

foreach ( array( 'shortcodes', 'contact-form', 'widget-visibility', 'related-posts', 'markdown', 'stats' ) as $module ) {
	if ( class_exists( 'Jetpack' ) && method_exists( 'Jetpack', 'activate_module' ) ) {
		Jetpack::activate_module( $module, false, false );
	}
}
`,
	assumptions: [
		'This workload exercises Jetpack admin routes with the plugin activated in WP Codebox.',
		'No WordPress.com OAuth fixture is provisioned here; connection-dependent screens are still executable and capture unauthenticated/connection-required request coverage.',
		'Public frontend scenarios use local fixture posts/pages and classify connection-required or external requests instead of using live WordPress.com credentials.',
	],
	scenarios: [
		{ id: 'dashboard', stepsFile: path.join( scenarioRoot, 'dashboard.json' ) },
		{ id: 'connection', stepsFile: path.join( scenarioRoot, 'connection.json' ) },
		{ id: 'modules', stepsFile: path.join( scenarioRoot, 'modules.json' ) },
		{ id: 'settings', stepsFile: path.join( scenarioRoot, 'settings.json' ) },
		{ id: 'public_post_modules', stepsFile: path.join( scenarioRoot, 'public_post_modules.json' ) },
		{ id: 'public_page_modules', stepsFile: path.join( scenarioRoot, 'public_page_modules.json' ) },
	],
} );
