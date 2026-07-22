import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { wpCodeboxBrowserArtifacts } from '../shared/wp-codebox/artifacts.mjs';
import { runWpCodeboxRecipe } from '../shared/wp-codebox/recipe.mjs';

const componentPath = process.env.HOMEBOY_COMPONENT_PATH;
const resultsFile = process.env.HOMEBOY_TRACE_RESULTS_FILE;
const artifactDir = process.env.HOMEBOY_TRACE_ARTIFACT_DIR || path.join( tmpdir(), 'gutenberg-notes-cas-atomicity-artifacts' );
const wpVersion = process.env.HOMEBOY_GUTENBERG_NOTES_WP_VERSION || '7.0';

if ( ! componentPath || ! resultsFile ) {
	throw new Error( 'HOMEBOY_COMPONENT_PATH and HOMEBOY_TRACE_RESULTS_FILE are required' );
}

const workDir = await mkdtemp( path.join( tmpdir(), 'gutenberg-notes-cas-atomicity.' ) );
const fixturePluginDir = path.join( workDir, 'gutenberg-notes-cas-atomicity-fixture' );
const recipeFile = path.join( workDir, 'recipe.json' );
const outputFile = path.join( artifactDir, 'wp-codebox-output.json' );
const codeboxArtifacts = path.join( artifactDir, 'wp-codebox-artifacts' );
const startedAt = performance.now();
const timeline = [];
const event = ( source, name, data = {} ) => timeline.push( {
	t_ms: Math.round( performance.now() - startedAt ),
	source,
	event: name,
	data,
} );
const readJson = async ( file ) => existsSync( file ) ? JSON.parse( await readFile( file, 'utf8' ) ) : null;

function actorExpression( actor ) {
	return `
const actor = ${ JSON.stringify( actor ) };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const waitFor = async (predicate, label, timeout = 30000) => {
	const deadline = performance.now() + timeout;
	while (performance.now() < deadline) {
		const value = await predicate();
		if (value) return value;
		await sleep(50);
	}
	throw new Error(actor + ' timed out waiting for ' + label);
};
await waitFor(() => window.wp?.apiFetch, 'authenticated REST client');
const request = (path, options = {}) => window.wp.apiFetch({
	path,
	...options,
	headers: { 'X-Homeboy-CAS-Actor': actor, ...(options.headers || {}) },
});
const readState = () => request('/homeboy-gutenberg-notes/v1/cas-state');
const state = await readState();
	await request('/wp-sync/v1/save-entity', {
	method: 'POST',
	data: {
		room: 'postType/post:' + state.post_id,
		expected_content: state.initial_content,
		content: state.first_content,
		doc: 'homeboy-doc-writer-a',
	},
});
const finalState = await readState();
if (![200, 409].includes(finalState.nested_writer_status)) throw new Error('nested writer failed: ' + JSON.stringify(finalState.nested_writer_result));
const writerAPair = finalState.content === state.first_content && finalState.doc === 'homeboy-doc-writer-a';
const writerBPair = finalState.content === state.second_content && finalState.doc === 'homeboy-doc-writer-b';
if (!writerAPair && !writerBPair) {
	throw new Error(actor + ' observed torn content/CRDT pair: content=' + finalState.content + '; doc=' + finalState.doc);
}
return true;`;
}

try {
	await mkdir( fixturePluginDir, { recursive: true } );
	await mkdir( artifactDir, { recursive: true } );
	await mkdir( path.dirname( resultsFile ), { recursive: true } );
	await writeFile( path.join( fixturePluginDir, 'fixture.php' ), `<?php
/** Plugin Name: Gutenberg Notes CAS Atomicity Fixture */
function homeboy_notes_cas_content( $version ) {
	$metadata = 'initial' === $version ? '' : ( 'first' === $version ? ' {"metadata":{"noteId":[101]}}' : ' {"metadata":{"noteId":[101,202]}}' );
	$label = 'initial' === $version ? 'Atomicity initial.' : ( 'first' === $version ? 'Atomicity writer A.' : 'Atomicity writer B.' );
	return '<!-- wp:paragraph' . $metadata . ' --><p>' . $label . '</p><!-- /wp:paragraph -->';
}
function homeboy_notes_cas_post_id() {
	$post = get_page_by_path( 'homeboy-notes-cas-atomicity', OBJECT, 'post' );
	if ( $post ) return (int) $post->ID;
	$post_id = (int) wp_insert_post( array(
		'post_type' => 'post', 'post_status' => 'draft', 'post_title' => 'Note CAS Atomicity',
		'post_name' => 'homeboy-notes-cas-atomicity', 'post_content' => homeboy_notes_cas_content( 'initial' ), 'post_author' => 1,
	) );
	update_post_meta( $post_id, '_crdt_document', 'homeboy-doc-initial' );
	return $post_id;
}
add_action( 'init', function () {
	update_option( 'wp_collaboration_enabled', '1' );
	if ( ! username_exists( 'notes-cas-writer-b' ) ) {
		wp_insert_user( array(
			'user_login' => 'notes-cas-writer-b',
			'user_pass' => wp_generate_password( 24 ),
			'user_email' => 'notes-cas-writer-b@example.test',
			'role' => 'editor',
		) );
	}
	homeboy_notes_cas_post_id();
} );
add_action( 'admin_enqueue_scripts', function () {
	wp_enqueue_script( 'wp-api-fetch' );
	wp_add_inline_script( 'wp-api-fetch', 'window.wp.apiFetch.use( window.wp.apiFetch.createNonceMiddleware( ' . wp_json_encode( wp_create_nonce( 'wp_rest' ) ) . ' ) );', 'after' );
} );
add_filter( 'update_post_metadata', function ( $check, $object_id, $meta_key ) {
	if ( '_crdt_document' !== $meta_key || homeboy_notes_cas_post_id() !== (int) $object_id || 'writer-a' !== ( $_SERVER['HTTP_X_HOMEBOY_CAS_ACTOR'] ?? '' ) || ! empty( $GLOBALS['homeboy_notes_nested_writer'] ) ) return $check;
	update_option( 'homeboy_notes_writer_a_blocked', 1, false );
	$GLOBALS['homeboy_notes_nested_writer'] = true;
	$previous_user = get_current_user_id();
	$writer_b = get_user_by( 'login', 'notes-cas-writer-b' );
	wp_set_current_user( $writer_b ? $writer_b->ID : 0 );
	$request = new WP_REST_Request( 'POST', '/wp-sync/v1/save-entity' );
	$request->set_body_params( array(
		'room' => 'postType/post:' . $object_id,
		'expected_content' => homeboy_notes_cas_content( 'first' ),
		'content' => homeboy_notes_cas_content( 'second' ),
		'doc' => 'homeboy-doc-writer-b',
	) );
	$response = rest_do_request( $request );
	update_option( 'homeboy_notes_nested_writer_status', $response->get_status(), false );
	update_option( 'homeboy_notes_nested_writer_result', $response->get_data(), false );
	wp_set_current_user( $previous_user );
	unset( $GLOBALS['homeboy_notes_nested_writer'] );
	return $check;
}, 10, 3 );
add_action( 'rest_api_init', function () {
	register_rest_route( 'homeboy-gutenberg-notes/v1', '/cas-state', array(
		'methods' => 'GET',
		'permission_callback' => function () { return current_user_can( 'edit_posts' ); },
		'callback' => function () {
			$post_id = homeboy_notes_cas_post_id();
			return rest_ensure_response( array(
				'post_id' => $post_id,
				'initial_content' => homeboy_notes_cas_content( 'initial' ),
				'first_content' => homeboy_notes_cas_content( 'first' ),
				'second_content' => homeboy_notes_cas_content( 'second' ),
				'content' => get_post_field( 'post_content', $post_id, 'raw' ),
				'doc' => get_post_meta( $post_id, '_crdt_document', true ),
				'writer_a_blocked' => (bool) get_option( 'homeboy_notes_writer_a_blocked' ),
				'nested_writer_status' => (int) get_option( 'homeboy_notes_nested_writer_status' ),
				'nested_writer_result' => get_option( 'homeboy_notes_nested_writer_result' ),
			) );
		},
	) );
} );
add_action( 'admin_init', function () {
	global $pagenow;
	if ( empty( $_GET['homeboy_notes_cas_atomicity'] ) || 'post.php' === $pagenow ) return;
	wp_safe_redirect( add_query_arg( array( 'post' => homeboy_notes_cas_post_id(), 'action' => 'edit', 'homeboy_notes_cas_atomicity' => 1 ), admin_url( 'post.php' ) ) );
	exit;
} );
` );

	const fixtureUsers = [
		{ name: 'writer-a', username: 'notes-cas-writer-a', role: 'editor' },
		{ name: 'writer-b', username: 'notes-cas-writer-b', role: 'editor' },
	];
	const userSessions = fixtureUsers.map( ( user ) => ( { name: `${ user.name }-session`, user: user.name } ) );
	const browserActors = [ { name: 'writer-a', userSession: 'writer-a-session' } ];
	const scenario = {
		schema: 'wp-codebox/browser-multi-actor-scenario/v1',
		url: '/wp-admin/?homeboy_notes_cas_atomicity=1',
		seed: process.env.HOMEBOY_SEED || 'gutenberg-79020-cas-atomicity',
		stepTimeoutMs: 120000,
		actors: browserActors,
		actions: browserActors.map( ( actor ) => ( { id: `${ actor.name }-conditional-save`, actor: actor.name, step: { kind: 'evaluate', expression: actorExpression( actor.name ) } } ) ),
	};
	const recipe = {
		schema: 'wp-codebox/workspace-recipe/v1',
		runtime: { wp: wpVersion, blueprint: { steps: [
			{ step: 'activatePlugin', pluginPath: '/wordpress/wp-content/plugins/gutenberg/gutenberg.php' },
			{ step: 'activatePlugin', pluginPath: '/wordpress/wp-content/plugins/gutenberg-notes-cas-atomicity-fixture/fixture.php' },
		] } },
		inputs: {
			extra_plugins: [
				{ source: componentPath, slug: 'gutenberg', pluginFile: 'gutenberg/gutenberg.php', activate: true },
				{ source: fixturePluginDir, slug: 'gutenberg-notes-cas-atomicity-fixture', pluginFile: 'gutenberg-notes-cas-atomicity-fixture/fixture.php', activate: true },
			],
			fixtureUsers,
			userSessions,
			browserActors,
		},
		workflow: { steps: [ { command: 'wordpress.browser-scenario', args: [ `scenario-json=${ JSON.stringify( scenario ) }` ] } ] },
		artifacts: { directory: codeboxArtifacts },
	};

	event( 'scenario', 'start', { actor_count: 2, component_path: componentPath, issue: 'https://github.com/WordPress/gutenberg/pull/79020' } );
	await writeFile( recipeFile, `${ JSON.stringify( recipe, null, 2 ) }\n` );
	const result = await runWpCodeboxRecipe( { recipeFile, artifactsDir: codeboxArtifacts, outputFile, event } );
	const output = JSON.parse( result.stdout );
	const files = wpCodeboxBrowserArtifacts( output, [ 'multi-actor-scenario-summary.json', 'multi-actor-events.json', 'multi-actor-network.json', 'multi-actor-replay.json' ] );
	const summary = await readJson( files[ 'multi-actor-scenario-summary.json' ] );
	const finalState = summary?.scenario?.finalState || 'failed';
	const observedActors = Object.keys( summary?.actors || {} );
	const pass = finalState === 'completed' && observedActors.length === 1;
	await writeFile( resultsFile, `${ JSON.stringify( {
		component_id: process.env.HOMEBOY_COMPONENT_ID || 'gutenberg',
		scenario_id: 'notes-cas-atomicity',
		status: pass ? 'pass' : 'fail',
		summary: `${ observedActors.length } conditional writers completed with final state ${ finalState }.`,
		timeline,
		assertions: [ { id: 'content-crdt-atomicity', status: pass ? 'pass' : 'fail', message: `Final content and CRDT snapshot came from the same winning writer=${ pass }.` } ],
		artifacts: [
			{ label: 'WP Codebox output', path: path.relative( artifactDir, outputFile ) },
			...Object.entries( files ).filter( ( [ , file ] ) => file && existsSync( file ) ).map( ( [ label, file ] ) => ( { label, path: path.relative( artifactDir, file ) } ) ),
		],
	}, null, 2 ) }\n` );
	process.exitCode = pass ? 0 : 1;
} catch ( error ) {
	await mkdir( path.dirname( resultsFile ), { recursive: true } );
	await writeFile( resultsFile, `${ JSON.stringify( { component_id: process.env.HOMEBOY_COMPONENT_ID || 'gutenberg', scenario_id: 'notes-cas-atomicity', status: 'fail', summary: error instanceof Error ? error.message : String( error ), timeline, assertions: [ { id: 'content-crdt-atomicity', status: 'fail', message: error instanceof Error ? error.message : String( error ) } ], artifacts: existsSync( outputFile ) ? [ { label: 'WP Codebox output', path: path.relative( artifactDir, outputFile ) } ] : [] }, null, 2 ) }\n` );
	throw error;
} finally {
	await rm( workDir, { recursive: true, force: true } );
}
