import path from 'node:path';

import { runBrowserCoverageTrace } from '../../../shared/wp-codebox/browser-coverage-trace.mjs';

const scenarioRoot = new URL( '../browser-scenarios/', import.meta.url ).pathname;

await runBrowserCoverageTrace( {
	componentId: 'wordpress',
	scenarioId: 'wordpress-core-browser-coverage',
	componentPath: process.env.HOMEBOY_COMPONENT_PATH,
	requiredFile: 'src/wp-includes/rest-api.php',
	wpVersion: process.env.HOMEBOY_WORDPRESS_CORE_BROWSER_COVERAGE_WP_VERSION || '7.0',
	assumptions: [
		'WP Codebox Playground supplies the WordPress runtime and logs in as admin through the blueprint login step.',
		'Admin screen readiness is captured at document/body level so request coverage is produced even if editor-specific selectors change.',
	],
	scenarios: [
		{ id: 'front_page', stepsFile: path.join( scenarioRoot, 'front_page.json' ) },
		{ id: 'post_editor', stepsFile: path.join( scenarioRoot, 'post_editor.json' ) },
		{ id: 'site_editor', stepsFile: path.join( scenarioRoot, 'site_editor.json' ) },
		{ id: 'media_library', stepsFile: path.join( scenarioRoot, 'media_library.json' ) },
	],
} );
