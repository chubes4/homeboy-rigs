import path from 'node:path';

import { runBrowserCoverageTrace } from '../../../shared/wp-codebox/browser-coverage-trace.mjs';

const componentPath = process.env.HOMEBOY_COMPONENT_PATH;
const scenarioRoot = new URL( '../browser-scenarios/', import.meta.url ).pathname;

await runBrowserCoverageTrace( {
	componentId: 'gutenberg',
	scenarioId: 'gutenberg-browser-coverage',
	componentPath,
	requiredFile: 'gutenberg.php',
	wpVersion: process.env.HOMEBOY_GUTENBERG_BROWSER_COVERAGE_WP_VERSION || '7.0',
	blueprintSteps: [
		{ step: 'activatePlugin', pluginPath: '/wordpress/wp-content/plugins/gutenberg/gutenberg.php' },
		{ step: 'login', username: 'admin', password: 'password' },
	],
	inputs: {
		extraPlugins: [
			{ source: componentPath, slug: 'gutenberg', pluginFile: 'gutenberg/gutenberg.php', activate: true },
		],
	},
	assumptions: [
		'The Gutenberg checkout is mounted as a plugin and activated before browser actions run.',
		'Editor route coverage uses stable admin URLs and document/body readiness to keep the workload executable across editor UI refactors.',
	],
	scenarios: [
		{ id: 'post_editor', stepsFile: path.join( scenarioRoot, 'post_editor.json' ) },
		{ id: 'site_editor', stepsFile: path.join( scenarioRoot, 'site_editor.json' ) },
		{ id: 'template_editor', stepsFile: path.join( scenarioRoot, 'template_editor.json' ) },
		{ id: 'patterns', stepsFile: path.join( scenarioRoot, 'patterns.json' ) },
	],
} );
