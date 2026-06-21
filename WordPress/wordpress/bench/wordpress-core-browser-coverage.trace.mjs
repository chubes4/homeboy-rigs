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
		'Coverage stays read-only in the browser: scenarios open list, editor shell, profile, media, and frontend pages without submitting forms or bulk actions.',
	],
	setupCode: `<?php
wp_insert_post( array( 'post_title' => 'Homeboy coverage post', 'post_status' => 'publish', 'post_content' => 'Coverage fixture post body.' ) );
wp_insert_post( array( 'post_title' => 'Homeboy coverage page', 'post_type' => 'page', 'post_status' => 'publish', 'post_content' => 'Coverage fixture page body.' ) );
if ( ! username_exists( 'homeboy_author' ) ) {
	wp_insert_user( array( 'user_login' => 'homeboy_author', 'user_pass' => wp_generate_password( 24, true ), 'user_email' => 'homeboy-author@example.test', 'role' => 'author' ) );
}
`,
	scenarios: [
		{ id: 'front_page', stepsFile: path.join( scenarioRoot, 'front_page.json' ) },
		{ id: 'posts_list', stepsFile: path.join( scenarioRoot, 'posts_list.json' ) },
		{ id: 'post_editor', stepsFile: path.join( scenarioRoot, 'post_editor.json' ) },
		{ id: 'pages_list', stepsFile: path.join( scenarioRoot, 'pages_list.json' ) },
		{ id: 'page_editor', stepsFile: path.join( scenarioRoot, 'page_editor.json' ) },
		{ id: 'site_editor', stepsFile: path.join( scenarioRoot, 'site_editor.json' ) },
		{ id: 'media_library', stepsFile: path.join( scenarioRoot, 'media_library.json' ) },
		{ id: 'media_new', stepsFile: path.join( scenarioRoot, 'media_new.json' ) },
		{ id: 'users_list', stepsFile: path.join( scenarioRoot, 'users_list.json' ) },
		{ id: 'profile', stepsFile: path.join( scenarioRoot, 'profile.json' ) },
	],
} );
