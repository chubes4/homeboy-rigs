import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { wpCodeboxBrowserArtifacts } from '../shared/wp-codebox/artifacts.mjs';
import { runWpCodeboxRecipe } from '../shared/wp-codebox/recipe.mjs';

const componentPath = process.env.HOMEBOY_COMPONENT_PATH;
const resultsFile = process.env.HOMEBOY_TRACE_RESULTS_FILE;
const artifactDir = process.env.HOMEBOY_TRACE_ARTIFACT_DIR || path.join( tmpdir(), 'gutenberg-notes-multi-author-artifacts' );
const wpVersion = process.env.HOMEBOY_GUTENBERG_NOTES_WP_VERSION || '7.0';
const actorCount = 12;

if ( ! componentPath || ! resultsFile ) {
	throw new Error( 'HOMEBOY_COMPONENT_PATH and HOMEBOY_TRACE_RESULTS_FILE are required' );
}

const workDir = await mkdtemp( path.join( tmpdir(), 'gutenberg-notes-multi-author.' ) );
const fixturePluginDir = path.join( workDir, 'gutenberg-notes-multi-author-fixture' );
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
const actorName = ( index ) => `author-${ String( index + 1 ).padStart( 2, '0' ) }`;

function actorExpression( index ) {
	const actor = actorName( index );
	const targetText = `Multi-author anchor ${ String( index + 1 ).padStart( 2, '0' ) }.`;
	const noteText = `Multi-author note ${ String( index + 1 ).padStart( 2, '0' ) }.`;
	return `
const actor = ${ JSON.stringify( actor ) };
const actorIndex = ${ index };
const targetText = ${ JSON.stringify( targetText ) };
const noteText = ${ JSON.stringify( noteText ) };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const waitFor = async (predicate, label, timeout = 30000) => {
	const deadline = performance.now() + timeout;
	while (performance.now() < deadline) {
		const value = await predicate();
		if (value) return value;
		await sleep(100);
	}
	throw new Error(actor + ' timed out waiting for ' + label);
};
await waitFor(() => document.body?.classList.contains('block-editor-page'), 'editor shell');
await waitFor(() => window.wp?.data?.select('core/block-editor')?.getBlocks?.().length === ${ actorCount }, 'twelve saved blocks');
const editorSelect = window.wp.data.select('core/editor');
const postId = editorSelect.getCurrentPostId();
const blockSelect = window.wp.data.select('core/block-editor');
const blockDispatch = window.wp.data.dispatch('core/block-editor');
const initialBlocks = blockSelect.getBlocks();
const target = initialBlocks.find((block) => String(block.attributes?.content || '').includes(targetText));
if (!target) throw new Error(actor + ' could not find ' + targetText);

if (actorIndex === 8) {
	blockDispatch.updateBlockAttributes(initialBlocks[0].clientId, { content: actor + ' unrelated dirty text' });
}
if (actorIndex === 9) {
	blockDispatch.insertBlock(window.wp.blocks.createBlock('core/paragraph', { content: actor + ' unsaved structural edit' }), 0);
}

const coreDispatch = window.wp.data.dispatch('core');
const rootNote = await coreDispatch.saveEntityRecord('root', 'comment', {
	post: postId,
	content: noteText,
	type: 'note',
	status: 'hold',
	parent: 0,
}, { throwOnError: true });
const liveTarget = blockSelect.getBlock(target.clientId);
blockDispatch.updateBlockAttributes(target.clientId, {
	metadata: { ...liveTarget.attributes.metadata, noteId: [rootNote.id] },
});
const { unlock } = window.wp.privateApis.__dangerousOptInToUnstableAPIsOnlyForCoreModules(
	'I acknowledge private features are not for use in themes or plugins and doing so will break in the next version of WordPress.',
	'@wordpress/core-data'
);
const persist = unlock(window.wp.data.dispatch('core')).persistEntityBlockAttributes;
const persistAttachment = (attributes) => persist('postType', editorSelect.getCurrentPostType(), postId, {
	record: editorSelect.getCurrentPost(),
	blockPath: [actorIndex],
	isMatch: (candidate) => candidate.name === target.name && String(candidate.attributes?.content || '').includes(targetText),
	matchCount: 1,
	matchIndex: 0,
	blockCount: blockSelect.getBlocks().length,
	blockName: target.name,
	attributes,
});
if (!await persistAttachment((savedAttributes) => ({
	metadata: { ...savedAttributes.metadata, noteId: [...new Set([...(Array.isArray(savedAttributes.metadata?.noteId) ? savedAttributes.metadata.noteId : []), rootNote.id])] },
}))) {
	throw new Error(actor + ' targeted attachment persistence returned false');
}

const reachBarrier = async (stage) => {
	const response = await fetch('/wp-json/homeboy-gutenberg-notes/v1/barrier', {
		method: 'POST',
		credentials: 'include',
		headers: { 'Content-Type': 'application/json', 'X-WP-Nonce': window.wpApiSettings?.nonce || '' },
		body: JSON.stringify({ actor, stage }),
	});
	if (!response.ok) throw new Error(actor + ' barrier POST failed: HTTP ' + response.status);
	await waitFor(async () => {
		const state = await fetch('/wp-json/homeboy-gutenberg-notes/v1/barrier?stage=' + encodeURIComponent(stage), {
			credentials: 'include',
			headers: { 'X-WP-Nonce': window.wpApiSettings?.nonce || '' },
		}).then((result) => result.json());
		return state.count === ${ actorCount };
	}, stage + ' barrier', 45000);
};

await reachBarrier('attachments');
if (actorIndex === 9) {
	await coreDispatch.saveEntityRecord('root', 'comment', { id: rootNote.id, status: 'approved' }, { throwOnError: true });
	await coreDispatch.saveEntityRecord('root', 'comment', { post: postId, content: '', type: 'note', status: 'approved', parent: rootNote.id, meta: { _wp_note_status: 'resolved' } }, { throwOnError: true });
	await coreDispatch.saveEntityRecord('root', 'comment', { id: rootNote.id, status: 'hold' }, { throwOnError: true });
	await coreDispatch.saveEntityRecord('root', 'comment', { post: postId, content: 'Reopened by ' + actor, type: 'note', status: 'hold', parent: rootNote.id, meta: { _wp_note_status: 'reopen' } }, { throwOnError: true });
}
if (actorIndex === 10) {
	await coreDispatch.saveEntityRecord('root', 'comment', { post: postId, content: 'Reply from ' + actor, type: 'note', status: 'hold', parent: rootNote.id }, { throwOnError: true });
}
if (actorIndex === 11) {
	await coreDispatch.deleteEntityRecord('root', 'comment', rootNote.id, undefined, { throwOnError: true });
	if (!await persistAttachment((savedAttributes) => ({
		metadata: { ...savedAttributes.metadata, noteId: (Array.isArray(savedAttributes.metadata?.noteId) ? savedAttributes.metadata.noteId : []).filter((id) => Number(id) !== Number(rootNote.id)) },
	}))) {
		throw new Error(actor + ' targeted deletion persistence returned false');
	}
}
await reachBarrier('lifecycle');
await sleep(1500);

const post = await window.wp.apiFetch({ path: '/wp/v2/posts/' + postId + '?context=edit&_fields=id,content,meta' });
const comments = await window.wp.apiFetch({ path: '/wp/v2/comments?post=' + postId + '&type=note&status=all&per_page=100&context=edit' });
const persistedBlocks = window.wp.blocks.parse(post.content?.raw || post.content?.rendered || '');
const rootNotes = comments.filter((comment) => Number(comment.parent) === 0);
for (let noteIndex = 0; noteIndex < ${ actorCount - 1 }; noteIndex++) {
	const expectedText = 'Multi-author note ' + String(noteIndex + 1).padStart(2, '0') + '.';
	const expectedAnchor = 'Multi-author anchor ' + String(noteIndex + 1).padStart(2, '0') + '.';
	const note = rootNotes.find((comment) => String(comment.content?.raw || comment.content?.rendered || '').includes(expectedText));
	const block = persistedBlocks.find((candidate) => String(candidate.attributes?.content || '').includes(expectedAnchor));
	const ids = Array.isArray(block?.attributes?.metadata?.noteId) ? block.attributes.metadata.noteId.map(Number) : [];
	if (!note || !ids.includes(Number(note.id))) {
		throw new Error(actor + ' observed missing attachment for ' + expectedText + '; root notes=' + rootNotes.length + '; attached=' + ids.join(','));
	}
}
const deletedAnchor = persistedBlocks.find((candidate) => String(candidate.attributes?.content || '').includes('Multi-author anchor 12.'));
if ((deletedAnchor?.attributes?.metadata?.noteId || []).length !== 0) throw new Error(actor + ' observed deleted note attachment');
if (String(post.content?.raw || '').includes('unrelated dirty text') || String(post.content?.raw || '').includes('unsaved structural edit')) throw new Error(actor + ' observed unrelated dirty state persisted');
if (!comments.some((comment) => String(comment.meta?._wp_note_status || '') === 'resolved')) throw new Error(actor + ' did not observe resolve history');
if (!comments.some((comment) => String(comment.meta?._wp_note_status || '') === 'reopen')) throw new Error(actor + ' did not observe reopen history');
if (!comments.some((comment) => String(comment.content?.raw || comment.content?.rendered || '').includes('Reply from author-11'))) throw new Error(actor + ' did not observe reply history');
return true;`;
}

try {
	await mkdir( fixturePluginDir, { recursive: true } );
	await mkdir( artifactDir, { recursive: true } );
	await mkdir( path.dirname( resultsFile ), { recursive: true } );
	await writeFile( path.join( fixturePluginDir, 'fixture.php' ), `<?php
/** Plugin Name: Gutenberg Notes Multi-Author Fixture */
function homeboy_notes_multi_author_post_id() {
	$post = get_page_by_path( 'homeboy-notes-multi-author', OBJECT, 'post' );
	if ( $post ) return (int) $post->ID;
	$content = array();
	for ( $index = 1; $index <= ${ actorCount }; $index++ ) {
		$content[] = '<!-- wp:paragraph --><p>Multi-author anchor ' . str_pad( (string) $index, 2, '0', STR_PAD_LEFT ) . '.</p><!-- /wp:paragraph -->';
	}
	return (int) wp_insert_post( array( 'post_type' => 'post', 'post_status' => 'draft', 'post_title' => 'Multi-Author Note Convergence', 'post_name' => 'homeboy-notes-multi-author', 'post_content' => implode( "\n\n", $content ), 'post_author' => 1 ) );
}
add_action( 'init', function () {
	update_option( 'wp_collaboration_enabled', '1' );
	$supports = get_all_post_type_supports( 'post' );
	$editor_supports = array( 'notes' => true );
	if ( is_array( $supports['editor'] ) && isset( $supports['editor'][0] ) && is_array( $supports['editor'][0] ) ) $editor_supports = array_merge( $editor_supports, $supports['editor'][0] );
	add_post_type_support( 'post', 'editor', $editor_supports );
	homeboy_notes_multi_author_post_id();
} );
add_action( 'rest_api_init', function () {
	register_rest_route( 'homeboy-gutenberg-notes/v1', '/barrier', array(
		array( 'methods' => 'POST', 'permission_callback' => function () { return current_user_can( 'edit_posts' ); }, 'callback' => function ( WP_REST_Request $request ) {
			$actor = sanitize_key( $request->get_param( 'actor' ) );
			$stage = sanitize_key( $request->get_param( 'stage' ) );
			if ( ! $actor || ! in_array( $stage, array( 'attachments', 'lifecycle' ), true ) ) return new WP_Error( 'invalid_barrier', 'Invalid barrier input.', array( 'status' => 400 ) );
			update_option( 'homeboy_notes_barrier_' . $stage . '_' . $actor, 1, false );
			return rest_ensure_response( array( 'arrived' => true ) );
		} ),
		array( 'methods' => 'GET', 'permission_callback' => function () { return current_user_can( 'edit_posts' ); }, 'callback' => function ( WP_REST_Request $request ) {
			$stage = sanitize_key( $request->get_param( 'stage' ) );
			$count = 0;
			for ( $index = 1; $index <= ${ actorCount }; $index++ ) $count += (int) (bool) get_option( 'homeboy_notes_barrier_' . $stage . '_author-' . str_pad( (string) $index, 2, '0', STR_PAD_LEFT ) );
			return rest_ensure_response( array( 'count' => $count ) );
		} ),
	) );
} );
add_action( 'admin_init', function () {
	global $pagenow;
	if ( empty( $_GET['homeboy_notes_multi_author'] ) || 'post.php' === $pagenow ) return;
	wp_safe_redirect( add_query_arg( array( 'post' => homeboy_notes_multi_author_post_id(), 'action' => 'edit', 'homeboy_notes_multi_author' => 1 ), admin_url( 'post.php' ) ) );
	exit;
} );
` );

	const fixtureUsers = Array.from( { length: actorCount }, ( _, index ) => ( { name: actorName( index ), username: `notes-${ actorName( index ) }`, role: 'editor' } ) );
	const userSessions = fixtureUsers.map( ( user ) => ( { name: `${ user.name }-session`, user: user.name } ) );
	const browserActors = fixtureUsers.map( ( user ) => ( { name: user.name, userSession: `${ user.name }-session` } ) );
	const scenario = {
		schema: 'wp-codebox/browser-multi-actor-scenario/v1',
		url: '/wp-admin/?homeboy_notes_multi_author=1',
		seed: process.env.HOMEBOY_SEED || 'gutenberg-79020-twelve-authors',
		stepTimeoutMs: 120000,
		actors: browserActors,
		actions: browserActors.map( ( actor, index ) => ( { id: `${ actor.name }-lifecycle`, actor: actor.name, step: { kind: 'evaluate', expression: actorExpression( index ) } } ) ),
	};
	const recipe = {
		schema: 'wp-codebox/workspace-recipe/v1',
		runtime: { wp: wpVersion, blueprint: { steps: [
			{ step: 'activatePlugin', pluginPath: '/wordpress/wp-content/plugins/gutenberg/gutenberg.php' },
			{ step: 'activatePlugin', pluginPath: '/wordpress/wp-content/plugins/gutenberg-notes-multi-author-fixture/fixture.php' },
		] } },
		inputs: {
			extra_plugins: [
				{ source: componentPath, slug: 'gutenberg', pluginFile: 'gutenberg/gutenberg.php', activate: true },
				{ source: fixturePluginDir, slug: 'gutenberg-notes-multi-author-fixture', pluginFile: 'gutenberg-notes-multi-author-fixture/fixture.php', activate: true },
			],
			fixtureUsers,
			userSessions,
			browserActors,
		},
		workflow: { steps: [ { command: 'wordpress.browser-scenario', args: [ `scenario-json=${ JSON.stringify( scenario ) }` ] } ] },
		artifacts: { directory: codeboxArtifacts },
	};

	event( 'scenario', 'start', { actor_count: actorCount, component_path: componentPath, issue: 'https://github.com/WordPress/gutenberg/pull/79020' } );
	await writeFile( recipeFile, `${ JSON.stringify( recipe, null, 2 ) }\n` );
	const result = await runWpCodeboxRecipe( { recipeFile, artifactsDir: codeboxArtifacts, outputFile, event } );
	const output = JSON.parse( result.stdout );
	const files = wpCodeboxBrowserArtifacts( output, [ 'multi-actor-scenario-summary.json', 'multi-actor-events.json', 'multi-actor-network.json', 'multi-actor-replay.json' ] );
	const summary = await readJson( files[ 'multi-actor-scenario-summary.json' ] );
	const finalState = summary?.scenario?.finalState || 'failed';
	const observedActors = Object.keys( summary?.actors || {} );
	const pass = finalState === 'completed' && observedActors.length === actorCount;
	const traceResult = {
		component_id: process.env.HOMEBOY_COMPONENT_ID || 'gutenberg',
		scenario_id: 'notes-multi-author-convergence',
		status: pass ? 'pass' : 'fail',
		summary: `${ observedActors.length } independently authenticated actors completed with final state ${ finalState }.` ,
		timeline,
		assertions: [
			{ id: 'twelve-authenticated-authors', status: observedActors.length === actorCount ? 'pass' : 'fail', message: `Captured ${ observedActors.length } actor evidence records.` },
			{ id: 'cross-session-note-convergence', status: finalState === 'completed' ? 'pass' : 'fail', message: `Every actor observed the same persisted attachments and lifecycle history=${ finalState === 'completed' }.` },
		],
		artifacts: [
			{ label: 'WP Codebox output', path: path.relative( artifactDir, outputFile ) },
			...Object.entries( files ).filter( ( [ , file ] ) => file && existsSync( file ) ).map( ( [ label, file ] ) => ( { label, path: path.relative( artifactDir, file ) } ) ),
		],
	};
	await writeFile( resultsFile, `${ JSON.stringify( traceResult, null, 2 ) }\n` );
	process.exitCode = pass ? 0 : 1;
} catch ( error ) {
	await mkdir( path.dirname( resultsFile ), { recursive: true } );
	await writeFile( resultsFile, `${ JSON.stringify( { component_id: process.env.HOMEBOY_COMPONENT_ID || 'gutenberg', scenario_id: 'notes-multi-author-convergence', status: 'fail', summary: error instanceof Error ? error.message : String( error ), timeline, assertions: [ { id: 'trace-workload-completed', status: 'fail', message: error instanceof Error ? error.message : String( error ) } ], artifacts: existsSync( outputFile ) ? [ { label: 'WP Codebox output', path: path.relative( artifactDir, outputFile ) } ] : [] }, null, 2 ) }\n` );
	throw error;
} finally {
	await rm( workDir, { recursive: true, force: true } );
}
