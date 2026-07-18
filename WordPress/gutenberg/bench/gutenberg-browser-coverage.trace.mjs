import path from 'node:path';

import { runBrowserCoverageTrace } from '../shared/wp-codebox/browser-coverage-trace.mjs';

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
		extra_plugins: [
			{ source: componentPath, slug: 'gutenberg', pluginFile: 'gutenberg/gutenberg.php', activate: true },
		],
	},
	assumptions: [
		'The Gutenberg checkout is mounted as a plugin and activated before browser actions run.',
		'Editor route coverage uses stable admin URLs and document/body readiness to keep the workload executable across editor UI refactors.',
		'Frontend rendering coverage creates a disposable published page and only visits read-only public/editor URLs.',
	],
	setupCode: `<?php
$post_id = wp_insert_post(
	array(
		'post_title'   => 'Gutenberg fuzz rendering fixture',
		'post_name'    => 'gutenberg-fuzz-rendering-fixture',
		'post_status'  => 'publish',
		'post_type'    => 'page',
		'post_content' => '<!-- wp:paragraph --><p>Gutenberg fuzz rendering fixture.</p><!-- /wp:paragraph --><!-- wp:buttons --><div class="wp-block-buttons"><!-- wp:button --><div class="wp-block-button"><a class="wp-block-button__link wp-element-button">Fixture button</a></div><!-- /wp:button --></div><!-- /wp:buttons --><!-- wp:query {"queryId":1,"query":{"perPage":3,"pages":0,"offset":0,"postType":"post","order":"desc","orderBy":"date","author":"","search":"","exclude":[],"sticky":"","inherit":false}} --><div class="wp-block-query"><!-- wp:post-template --><!-- wp:post-title /--><!-- /wp:post-template --></div><!-- /wp:query --><!-- wp:latest-posts /-->',
	)
);
if ( is_wp_error( $post_id ) ) {
	throw new RuntimeException( $post_id->get_error_message() );
}
update_option( 'show_on_front', 'page' );
update_option( 'page_on_front', $post_id );
flush_rewrite_rules();
`,
	scenarios: [
		{ id: 'post_editor', stepsFile: path.join( scenarioRoot, 'post_editor.json' ) },
		{ id: 'site_editor', stepsFile: path.join( scenarioRoot, 'site_editor.json' ) },
		{ id: 'template_editor', stepsFile: path.join( scenarioRoot, 'template_editor.json' ) },
		{ id: 'patterns', stepsFile: path.join( scenarioRoot, 'patterns.json' ) },
		{ id: 'frontend_rendering', stepsFile: path.join( scenarioRoot, 'frontend_rendering.json' ) },
	],
} );
