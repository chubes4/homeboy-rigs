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
	assumptions: [
		'This workload exercises Jetpack admin routes with the plugin activated in WP Codebox.',
		'No WordPress.com OAuth fixture is provisioned here; connection-dependent screens are still executable and capture unauthenticated/connection-required request coverage.',
	],
	scenarios: [
		{ id: 'dashboard', stepsFile: path.join( scenarioRoot, 'dashboard.json' ) },
		{ id: 'connection', stepsFile: path.join( scenarioRoot, 'connection.json' ) },
		{ id: 'modules', stepsFile: path.join( scenarioRoot, 'modules.json' ) },
		{ id: 'settings', stepsFile: path.join( scenarioRoot, 'settings.json' ) },
	],
} );
