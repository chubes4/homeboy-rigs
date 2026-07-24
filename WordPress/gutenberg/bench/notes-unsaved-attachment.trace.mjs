import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { wpCodeboxBrowserArtifacts } from '../shared/wp-codebox/artifacts.mjs';
import { runWpCodeboxRecipe } from '../shared/wp-codebox/recipe.mjs';

const componentPath = process.env.HOMEBOY_COMPONENT_PATH;
const componentId = process.env.HOMEBOY_COMPONENT_ID || 'gutenberg';
const scenarioId = process.env.HOMEBOY_TRACE_SCENARIO || 'notes-unsaved-attachment';
const resultsFile = process.env.HOMEBOY_TRACE_RESULTS_FILE;
const artifactDir = process.env.HOMEBOY_TRACE_ARTIFACT_DIR || path.join( tmpdir(), 'gutenberg-notes-unsaved-attachment-artifacts' );
const wpVersion = process.env.HOMEBOY_GUTENBERG_NOTES_WP_VERSION || process.env.HOMEBOY_SETTINGS_GUTENBERG_NOTES_WP_VERSION || '7.0';
const knownCases = new Set( [ 'orphan', 'saved-anchor', 'live-create', 'dirty-live-create', 'dirty-sibling-live-create', 'dirty-structural-live-create', 'nested-live-create', 'double-live-create', 'inline-range-live-create', 'no-saved-match', 'ambiguous-contentless', 'empty-saved-content', 'store-coherence', 'repair-sync-race', 'crdt-peer-lineage', 'repair-failure-recovery', 'concurrent-note-repairs', 'inline-pending-edit', 'matrix' ] );
const profileCase = process.env.HOMEBOY_TRACE_PROFILE || process.env.HOMEBOY_PROFILE || '';
const targetCase = process.env.HOMEBOY_GUTENBERG_NOTES_CASE || process.env.HOMEBOY_SETTINGS_GUTENBERG_NOTES_CASE || ( knownCases.has( profileCase ) ? profileCase : 'orphan' );
const probeDuration = process.env.HOMEBOY_GUTENBERG_NOTES_PROBE_DURATION || '12s';
const viewport = process.env.HOMEBOY_GUTENBERG_NOTES_VIEWPORT || '1366x900';
const readinessTimeoutMs = Number.parseInt( process.env.HOMEBOY_GUTENBERG_NOTES_READINESS_TIMEOUT_MS || '20000', 10 );

if ( ! componentPath ) {
	throw new Error( 'HOMEBOY_COMPONENT_PATH is required' );
}
if ( ! resultsFile ) {
	throw new Error( 'HOMEBOY_TRACE_RESULTS_FILE is required' );
}
if ( ! existsSync( path.join( componentPath, 'gutenberg.php' ) ) ) {
	throw new Error( `Missing Gutenberg plugin entrypoint at ${ componentPath }/gutenberg.php` );
}

await mkdir( artifactDir, { recursive: true } );
await mkdir( path.dirname( resultsFile ), { recursive: true } );

const workDir = await mkdtemp( path.join( tmpdir(), 'gutenberg-notes-unsaved-attachment.' ) );
const fixturePluginDir = path.join( workDir, 'gutenberg-notes-unsaved-attachment-fixture' );
const recipeFile = path.join( workDir, 'recipe.json' );
const outputFile = path.join( artifactDir, 'wp-codebox-output.json' );
const codeboxArtifacts = path.join( artifactDir, 'wp-codebox-artifacts' );
const metricsPath = path.join( artifactDir, 'notes-unsaved-attachment-metrics.json' );
const metadataPath = path.join( artifactDir, 'notes-unsaved-attachment-metadata.json' );
const startedAt = performance.now();
const timeline = [];

function timestampMs() {
	return Math.round( performance.now() - startedAt );
}

function event( source, name, data = {} ) {
	timeline.push( { t_ms: timestampMs(), source, event: name, data } );
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
		path.join( fixturePluginDir, 'gutenberg-notes-unsaved-attachment-fixture.php' ),
		`<?php
/**
 * Plugin Name: Gutenberg Notes Unsaved Attachment Fixture
 */

add_action(
	'init',
	function () {
		update_option( 'wp_collaboration_enabled', '1' );

		$supports        = get_all_post_type_supports( 'post' );
		$editor_supports = array( 'notes' => true );
		if ( is_array( $supports['editor'] ) && isset( $supports['editor'][0] ) && is_array( $supports['editor'][0] ) ) {
			$editor_supports = array_merge( $editor_supports, $supports['editor'][0] );
		}
		add_post_type_support( 'post', 'editor', $editor_supports );
	}
);

function homeboy_gutenberg_notes_content( $note_id = 0 ) {
	$metadata = $note_id ? ' {"metadata":{"noteId":[' . (int) $note_id . ']}}' : '';
	return '<!-- wp:paragraph' . $metadata . ' --><p>Homeboy note anchor target.</p><!-- /wp:paragraph -->';
}

function homeboy_gutenberg_notes_two_paragraph_content() {
	return '<!-- wp:paragraph --><p>Homeboy note anchor target.</p><!-- /wp:paragraph -->' . "\n\n" . '<!-- wp:paragraph --><p>Homeboy sibling text that must stay saved.</p><!-- /wp:paragraph -->';
}

function homeboy_gutenberg_notes_nested_content() {
	return '<!-- wp:group --><div class="wp-block-group"><!-- wp:paragraph --><p>Homeboy note anchor target.</p><!-- /wp:paragraph --></div><!-- /wp:group -->';
}

function homeboy_gutenberg_notes_contentless_siblings() {
	return '<!-- wp:separator --><hr class="wp-block-separator has-alpha-channel-opacity"/><!-- /wp:separator -->' . "\n\n" . '<!-- wp:separator --><hr class="wp-block-separator has-alpha-channel-opacity"/><!-- /wp:separator -->';
}

function homeboy_gutenberg_notes_create_note( $post_id, $content ) {
	$existing = get_comments(
		array(
			'post_id' => $post_id,
			'type'    => 'note',
			'number'  => 1,
			'status'  => 'all',
		)
	);
	if ( ! empty( $existing ) ) {
		return (int) $existing[0]->comment_ID;
	}

	return (int) wp_insert_comment(
		array(
			'comment_post_ID'      => $post_id,
			'comment_author'       => 'Homeboy',
			'comment_author_email' => 'homeboy@example.test',
			'comment_content'      => $content,
			'comment_type'         => 'note',
			'comment_approved'     => '0',
			'user_id'              => 1,
		)
	);
}

function homeboy_gutenberg_notes_create_post( $slug, $title ) {
	$existing = get_page_by_path( $slug, OBJECT, 'post' );
	if ( $existing ) {
		return (int) $existing->ID;
	}

	return (int) wp_insert_post(
		array(
			'post_type'    => 'post',
			'post_status'  => 'draft',
			'post_title'   => $title,
			'post_name'    => $slug,
			'post_content' => homeboy_gutenberg_notes_content(),
			'post_author'  => 1,
		)
	);
}

function homeboy_gutenberg_notes_create_post_with_content( $slug, $title, $content ) {
	$existing = get_page_by_path( $slug, OBJECT, 'post' );
	if ( $existing ) {
		return (int) $existing->ID;
	}

	return (int) wp_insert_post(
		array(
			'post_type'    => 'post',
			'post_status'  => 'draft',
			'post_title'   => $title,
			'post_name'    => $slug,
			'post_content' => $content,
			'post_author'  => 1,
		)
	);
}

function homeboy_gutenberg_notes_fixture_state() {
	if ( get_option( 'homeboy_gutenberg_notes_fixture_state' ) ) {
		return get_option( 'homeboy_gutenberg_notes_fixture_state' );
	}

	require_once ABSPATH . 'wp-admin/includes/post.php';

	$orphan_post_id = homeboy_gutenberg_notes_create_post( 'homeboy-notes-orphan', 'Homeboy Notes Orphan' );
	$orphan_note_id = homeboy_gutenberg_notes_create_note( $orphan_post_id, 'Homeboy orphan note' );

	$saved_post_id = homeboy_gutenberg_notes_create_post( 'homeboy-notes-saved-anchor', 'Homeboy Notes Saved Anchor' );
	$saved_note_id = homeboy_gutenberg_notes_create_note( $saved_post_id, 'Homeboy saved anchor note' );
	wp_update_post(
		array(
			'ID'           => $saved_post_id,
			'post_content' => homeboy_gutenberg_notes_content( $saved_note_id ),
		)
	);

	$live_post_id          = homeboy_gutenberg_notes_create_post( 'homeboy-notes-live-create', 'Homeboy Notes Live Create' );
	$dirty_live_post_id    = homeboy_gutenberg_notes_create_post( 'homeboy-notes-dirty-live-create', 'Homeboy Notes Dirty Live Create' );
	$dirty_sibling_post_id = homeboy_gutenberg_notes_create_post_with_content( 'homeboy-notes-dirty-sibling-live-create', 'Homeboy Notes Dirty Sibling Live Create', homeboy_gutenberg_notes_two_paragraph_content() );
	$dirty_structural_post_id = homeboy_gutenberg_notes_create_post_with_content( 'homeboy-notes-dirty-structural-live-create', 'Homeboy Notes Dirty Structural Live Create', homeboy_gutenberg_notes_two_paragraph_content() );
	$nested_live_post_id   = homeboy_gutenberg_notes_create_post_with_content( 'homeboy-notes-nested-live-create', 'Homeboy Notes Nested Live Create', homeboy_gutenberg_notes_nested_content() );
	$double_live_post_id   = homeboy_gutenberg_notes_create_post( 'homeboy-notes-double-live-create', 'Homeboy Notes Double Live Create' );
	$inline_range_live_post_id = homeboy_gutenberg_notes_create_post( 'homeboy-notes-inline-range-live-create', 'Homeboy Notes Inline Range Live Create' );
	$no_saved_match_post_id = homeboy_gutenberg_notes_create_post_with_content( 'homeboy-notes-no-saved-match', 'Homeboy Notes No Saved Match', homeboy_gutenberg_notes_two_paragraph_content() );
	$ambiguous_contentless_post_id = homeboy_gutenberg_notes_create_post_with_content( 'homeboy-notes-ambiguous-contentless', 'Homeboy Notes Ambiguous Contentless', homeboy_gutenberg_notes_contentless_siblings() );
	$empty_saved_content_post_id = homeboy_gutenberg_notes_create_post_with_content( 'homeboy-notes-empty-saved-content', 'Homeboy Notes Empty Saved Content', '' );
	$store_coherence_post_id = homeboy_gutenberg_notes_create_post( 'homeboy-notes-store-coherence', 'Homeboy Notes Store Coherence' );
	$repair_sync_race_post_id = homeboy_gutenberg_notes_create_post( 'homeboy-notes-repair-sync-race', 'Homeboy Notes Repair Sync Race' );
	$crdt_peer_lineage_post_id = homeboy_gutenberg_notes_create_post( 'homeboy-notes-crdt-peer-lineage', 'Homeboy Notes CRDT Peer Lineage' );
	$repair_failure_recovery_post_id = homeboy_gutenberg_notes_create_post( 'homeboy-notes-repair-failure-recovery', 'Homeboy Notes Repair Failure Recovery' );
	$concurrent_note_repairs_post_id = homeboy_gutenberg_notes_create_post( 'homeboy-notes-concurrent-note-repairs', 'Homeboy Notes Concurrent Repairs' );
	$inline_pending_edit_post_id = homeboy_gutenberg_notes_create_post( 'homeboy-notes-inline-pending-edit', 'Homeboy Notes Inline Pending Edit' );

	$state = array(
		'orphan' => array(
			'post_id' => $orphan_post_id,
			'note_id' => $orphan_note_id,
			'expected_orphan' => true,
		),
		'saved-anchor' => array(
			'post_id' => $saved_post_id,
			'note_id' => $saved_note_id,
			'expected_orphan' => false,
		),
		'live-create' => array(
			'post_id' => $live_post_id,
			'note_id' => 0,
			'expected_orphan' => false,
		),
		'dirty-live-create' => array(
			'post_id' => $dirty_live_post_id,
			'note_id' => 0,
			'expected_orphan' => false,
		),
		'dirty-sibling-live-create' => array(
			'post_id' => $dirty_sibling_post_id,
			'note_id' => 0,
			'expected_orphan' => false,
		),
		'dirty-structural-live-create' => array(
			'post_id' => $dirty_structural_post_id,
			'note_id' => 0,
			'expected_orphan' => false,
		),
		'nested-live-create' => array(
			'post_id' => $nested_live_post_id,
			'note_id' => 0,
			'expected_orphan' => false,
		),
		'double-live-create' => array(
			'post_id' => $double_live_post_id,
			'note_id' => 0,
			'expected_orphan' => false,
		),
		'inline-range-live-create' => array(
			'post_id' => $inline_range_live_post_id,
			'note_id' => 0,
			'expected_orphan' => false,
		),
		'no-saved-match' => array( 'post_id' => $no_saved_match_post_id, 'note_id' => 0, 'expected_orphan' => false ),
		'ambiguous-contentless' => array( 'post_id' => $ambiguous_contentless_post_id, 'note_id' => 0, 'expected_orphan' => false ),
		'empty-saved-content' => array( 'post_id' => $empty_saved_content_post_id, 'note_id' => 0, 'expected_orphan' => false ),
		'store-coherence' => array( 'post_id' => $store_coherence_post_id, 'note_id' => 0, 'expected_orphan' => false ),
		'repair-sync-race' => array( 'post_id' => $repair_sync_race_post_id, 'note_id' => 0, 'expected_orphan' => false ),
		'crdt-peer-lineage' => array( 'post_id' => $crdt_peer_lineage_post_id, 'note_id' => 0, 'expected_orphan' => false ),
		'repair-failure-recovery' => array( 'post_id' => $repair_failure_recovery_post_id, 'note_id' => 0, 'expected_orphan' => false ),
		'concurrent-note-repairs' => array( 'post_id' => $concurrent_note_repairs_post_id, 'note_id' => 0, 'expected_orphan' => false ),
		'inline-pending-edit' => array( 'post_id' => $inline_pending_edit_post_id, 'note_id' => 0, 'expected_orphan' => false ),
	);

	update_option( 'homeboy_gutenberg_notes_fixture_state', $state, false );
	return $state;
}

add_action( 'init', 'homeboy_gutenberg_notes_fixture_state', 20 );

add_action(
	'rest_api_init',
	function () {
		register_rest_route(
			'homeboy-gutenberg-notes/v1',
			'/state',
			array(
				'methods'             => 'GET',
				'permission_callback' => '__return_true',
				'callback'            => function () {
					return rest_ensure_response( homeboy_gutenberg_notes_fixture_state() );
				},
			)
		);
	}
);

add_action(
	'admin_init',
	function () {
		global $pagenow;

		if ( empty( $_GET['homeboy_notes_case'] ) ) {
			return;
		}
		if ( 'post.php' === $pagenow ) {
			return;
		}

		$case  = sanitize_key( wp_unslash( $_GET['homeboy_notes_case'] ) );
		$state = homeboy_gutenberg_notes_fixture_state();
		if ( empty( $state[ $case ]['post_id'] ) ) {
			return;
		}

		wp_safe_redirect(
			add_query_arg(
				array(
					'post'               => (int) $state[ $case ]['post_id'],
					'action'             => 'edit',
					'homeboy_notes_case' => $case,
				),
				admin_url( 'post.php' )
			)
		);
		exit;
	}
);
`
	);
}

const browserScript = `
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const readinessTimeoutMs = ${ readinessTimeoutMs };
const targetCase = ${ JSON.stringify( targetCase ) };
const seed = ${ JSON.stringify( process.env.HOMEBOY_SEED || '' ) };
const stateResponse = await fetch('/wp-json/homeboy-gutenberg-notes/v1/state', { credentials: 'include' });
const fixtureState = await stateResponse.json();
const currentCase = new URL(location.href).searchParams.get('homeboy_notes_case') || targetCase;
const observedRequests = [];
const actorTimeline = [];
const actorEvent = (actor, event, data = {}) => actorTimeline.push({ t_ms: Math.round(performance.now()), actor, event, data });
let releaseHeldRequest;
const heldRequest = new Promise((resolve) => { releaseHeldRequest = resolve; });
let heldRepairCount = 0;
let forcedRepairFailurePending = currentCase === 'repair-failure-recovery';
const originalFetch = window.fetch.bind(window);
window.fetch = async (input, init = {}) => {
	const request = input instanceof Request ? input : null;
	const url = request ? request.url : String(input);
	const method = (init.method || request?.method || 'GET').toUpperCase();
	const rawBody = typeof init.body === 'string' ? init.body : '';
	let payload = null;
	try { payload = rawBody ? JSON.parse(rawBody) : null; } catch (error) {}
	const route = url.includes('/wp-sync/v1/save-entity') ? 'entity-save' : url.includes('/wp-sync/v1/save') ? 'sync-save' : url.includes('/wp-json/wp/v2/posts/') ? 'post-rest' : url.includes('/wp-json/wp/v2/comments') ? 'comment-rest' : 'other';
	const payloadKeys = Object.keys(payload || {}).sort();
	const semantics = {
		has_crdt_document: typeof payload?.meta?._crdt_document === 'string' || typeof payload?.doc === 'string',
		has_metadata: JSON.stringify(payload || {}).includes('metadata'),
		has_content: Object.prototype.hasOwnProperty.call(payload || {}, 'content'),
		entity_id: String(payload?.room || '').split(':').at(-1),
		payload_keys: payloadKeys,
		is_targeted_repair: route === 'entity-save' && typeof payload?.content === 'string' && typeof payload?.expected_content === 'string' && typeof payload?.doc === 'string',
		is_full_editor_save: Object.prototype.hasOwnProperty.call(payload || {}, 'content') && typeof payload?.meta?._crdt_document !== 'string',
	};
	const raceDelay = currentCase === 'repair-sync-race' && (route === 'sync-save' || route === 'entity-save')
		? ((Array.from(seed || '0').reduce((total, character) => total + character.charCodeAt(0), 0) + (route === 'sync-save' ? 1 : 0)) % 2 ? 180 : 25)
		: 0;
	if (raceDelay) {
		actorEvent('parent', 'request-delayed', { route, delay_ms: raceDelay, seed });
		await sleep(raceDelay);
	}
	const holdConcurrentRepair = currentCase === 'concurrent-note-repairs' && semantics.is_targeted_repair && heldRepairCount++ === 0;
	const holdPendingComment = currentCase === 'inline-pending-edit' && route === 'comment-rest' && method === 'POST';
	if (holdConcurrentRepair || holdPendingComment) {
		actorEvent('parent', 'request-held', { route, semantics });
		await heldRequest;
		actorEvent('parent', 'request-released', { route, semantics });
	}
	actorEvent('parent', 'request-start', { route, method, semantics });
	try {
		if (forcedRepairFailurePending && semantics.is_targeted_repair) {
			forcedRepairFailurePending = false;
			const response = new Response(JSON.stringify({ code: 'forced_attachment_failure', message: 'Forced attachment repair failure.' }), { status: 500, headers: { 'Content-Type': 'application/json' } });
			observedRequests.push({ t_ms: Math.round(performance.now()), url, method, status: response.status, route, semantics, body: rawBody.slice(0, 500), forced_failure: true });
			actorEvent('parent', 'request-finish', { route, method, status: response.status, semantics, forced_failure: true });
			return response;
		}
		const response = await originalFetch(input, init);
		observedRequests.push({ t_ms: Math.round(performance.now()), url, method, status: response.status, route, semantics, body: rawBody.slice(0, 500) });
		actorEvent('parent', 'request-finish', { route, method, status: response.status, semantics });
		return response;
	} catch (error) {
		observedRequests.push({ t_ms: Math.round(performance.now()), url, method, status: 0, route, semantics, body: rawBody.slice(0, 500), error: String(error) });
		actorEvent('parent', 'request-fail', { route, method, error: String(error), semantics });
		throw error;
	}
};
const waitFor = async (predicate, label) => {
	const deadline = performance.now() + readinessTimeoutMs;
	while (performance.now() < deadline) {
		const value = await predicate();
		if (value) {
			return value;
		}
		await sleep(250);
	}
	throw new Error('Timed out waiting for ' + label);
};
const getEditorDocuments = () => {
	const documents = [ document ];
	for (let index = 0; index < documents.length; index++) {
		documents.push(...Array.from(documents[index].querySelectorAll('iframe')).map((iframe) => iframe.contentDocument).filter((frameDocument) => frameDocument && !documents.includes(frameDocument)));
	}
	return documents;
};
const findButtonByText = (text) => getEditorDocuments().flatMap((editorDocument) => Array.from(editorDocument.querySelectorAll('button'))).find((button) => (button.textContent || '').trim() === text);
const isVisible = (node) => {
	const rect = node?.getBoundingClientRect?.();
	return !!rect && rect.width > 0 && rect.height > 0;
};
const findMenuItemByText = (text) => getEditorDocuments().flatMap((editorDocument) => Array.from(editorDocument.querySelectorAll('[role="menuitem"], button'))).find((node) => (node.textContent || '').trim().startsWith(text) && isVisible(node));
const waitForAddNoteButton = async () => {
	try {
		return await waitFor(() => isVisible(findButtonByText('Add note')) && findButtonByText('Add note'), 'Add note button');
	} catch (error) {
		const buttons = getEditorDocuments().flatMap((editorDocument) => Array.from(editorDocument.querySelectorAll('button'))).filter(isVisible).map((button) => ({
			text: (button.textContent || '').trim(),
			ariaLabel: button.getAttribute('aria-label'),
			disabled: button.disabled,
		}));
		throw new Error(error.message + '; visible buttons=' + JSON.stringify(buttons.slice(-30)));
	}
};
const setFieldValue = (field, value) => {
	const ownerWindow = field.ownerDocument.defaultView;
	if (field.isContentEditable) {
		field.textContent = value;
		field.dispatchEvent(new ownerWindow.InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
		field.dispatchEvent(new ownerWindow.Event('change', { bubbles: true }));
		return;
	}
	const prototype = field instanceof ownerWindow.HTMLTextAreaElement ? ownerWindow.HTMLTextAreaElement.prototype : ownerWindow.HTMLInputElement.prototype;
	const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
	if (setter) {
		setter.call(field, value);
	} else {
		field.value = value;
	}
	field.dispatchEvent(new ownerWindow.InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
	field.dispatchEvent(new ownerWindow.Event('change', { bubbles: true }));
};
const flattenBlocks = (blocks) => blocks.flatMap((block) => [block, ...flattenBlocks(block.innerBlocks || [])]);
const getNoteFieldCandidates = () => getEditorDocuments().flatMap((editorDocument) => Array.from(editorDocument.querySelectorAll('textarea, input, [contenteditable], [role="textbox"]')));
const isAddNoteField = (field) => {
	const form = field.closest('form.editor-collab-sidebar-panel__note-form');
	return Boolean(form && Array.from(form.querySelectorAll('button[type="submit"]')).some((button) => isVisible(button) && (button.textContent || '').trim() === 'Add note'));
};
const findNewNoteField = () => getNoteFieldCandidates().find((field) => {
	return isVisible(field) && isAddNoteField(field);
});
const liveCreateCases = [ 'live-create', 'dirty-live-create', 'dirty-sibling-live-create', 'dirty-structural-live-create', 'nested-live-create', 'double-live-create' ];
const getBlockNoteIds = (targetWindow = window) => flattenBlocks(targetWindow.wp.data.select('core/block-editor').getBlocks()).flatMap((block) => {
	const noteId = block?.attributes?.metadata?.noteId;
	return Array.isArray(noteId) ? noteId : noteId ? [noteId] : [];
}).map((value) => Number(value)).filter((value) => Number.isFinite(value));
const getBlocksWithNoteId = (noteId, targetWindow = window) => flattenBlocks(targetWindow.wp.data.select('core/block-editor').getBlocks()).filter((block) => {
	const ids = block?.attributes?.metadata?.noteId;
	const noteIds = Array.isArray(ids) ? ids : ids ? [ids] : [];
	return noteIds.map((value) => Number(value)).includes(Number(noteId));
});
const getBlockText = (block) => {
	const content = block?.attributes?.content;
	return typeof content === 'string' ? content : content?.toString?.() || '';
};
const getCoreNoteMarkers = (targetWindow = window) => flattenBlocks(targetWindow.wp.data.select('core/block-editor').getBlocks()).flatMap((block) => {
	const value = targetWindow.wp.richText?.create?.({ html: getBlockText(block) });
	return (value?.formats || []).flatMap((formats) => (formats || []).filter((format) => format?.type === 'core/note').map((format) => ({ clientId: block.clientId, attributes: format.attributes || {} })));
});
const getAllBlockText = (targetWindow = window) => flattenBlocks(targetWindow.wp.data.select('core/block-editor').getBlocks()).map(getBlockText).join('\\n');
const getTargetBlock = (caseId, targetWindow = window) => {
	const blocks = targetWindow.wp.data.select('core/block-editor').getBlocks();
	if (caseId === 'ambiguous-contentless') return blocks[1];
	if (caseId === 'nested-live-create') {
		return flattenBlocks(blocks).find((block) => getBlockText(block).includes('Homeboy note anchor target'));
	}
	if (caseId === 'dirty-structural-live-create') {
		return flattenBlocks(blocks).find((block) => getBlockText(block).includes('Homeboy note anchor target'));
	}
	return blocks[0];
};
const getDirtyBlock = (caseId, targetWindow = window) => {
	const blocks = targetWindow.wp.data.select('core/block-editor').getBlocks();
	if (caseId === 'dirty-sibling-live-create') {
		return blocks[1];
	}
	return getTargetBlock(caseId, targetWindow);
};
const getPostContent = async (postId) => {
	if (window.wp?.apiFetch) {
		const post = await window.wp.apiFetch({ path: '/wp/v2/posts/' + encodeURIComponent(postId) + '?context=edit' });
		return post.content?.raw ?? post.content?.rendered ?? '';
	}
	const response = await fetch('/wp-json/wp/v2/posts/' + encodeURIComponent(postId), { credentials: 'include' });
	if (!response.ok) {
		throw new Error('Failed to fetch post: HTTP ' + response.status);
	}
	const post = await response.json();
	return post.content?.raw ?? post.content?.rendered ?? '';
};
const contentHasNoteId = (content, noteId) => {
	const noteIdIndex = content.indexOf('"noteId"');
	return noteIdIndex !== -1 && content.slice(noteIdIndex, noteIdIndex + 120).includes(String(noteId));
};
const waitForEditorReady = async (label) => {
	await waitFor(() => document.body && document.body.classList.contains('block-editor-page'), 'editor shell for ' + label);
	await waitFor(() => window.wp?.data?.select('core/block-editor')?.getBlocks, 'block editor data store for ' + label);
	await waitFor(() => window.wp.data.select('core/block-editor').getBlocks().length > 0 || label === 'empty-saved-content', 'editor blocks for ' + label);
};
const waitForFrameEditorReady = async (frameWindow, frameDocument, label) => {
	await waitFor(() => frameDocument.body && frameDocument.body.classList.contains('block-editor-page'), 'iframe editor shell for ' + label);
	await waitFor(() => frameWindow.wp?.data?.select('core/block-editor')?.getBlocks?.()[0], 'iframe block editor data store for ' + label);
};
const collectReloadedEditorState = async (caseId, postId, noteId, dirtyText) => {
	const iframe = document.createElement('iframe');
	iframe.style.position = 'fixed';
	iframe.style.left = '-10000px';
	iframe.style.top = '0';
	iframe.style.width = '1200px';
	iframe.style.height = '800px';
	document.body.appendChild(iframe);
	iframe.src = '/wp-admin/post.php?post=' + encodeURIComponent(postId) + '&action=edit&homeboy_notes_case=' + encodeURIComponent(caseId) + '&homeboy_reload_probe=1';
	await new Promise((resolve, reject) => {
		const timeout = setTimeout(() => reject(new Error('Timed out loading iframe editor for ' + caseId)), readinessTimeoutMs);
		iframe.addEventListener('load', () => {
			clearTimeout(timeout);
			resolve();
		}, { once: true });
	});
	const frameWindow = iframe.contentWindow;
	const frameDocument = iframe.contentDocument;
	await waitForFrameEditorReady(frameWindow, frameDocument, caseId);
	const reloadedBlockNoteIds = getBlockNoteIds(frameWindow);
	const reloadedNoteBlockTexts = getBlocksWithNoteId(noteId, frameWindow).map(getBlockText);
	const reloadedAttachmentBlock = getBlocksWithNoteId(noteId, frameWindow)[0] || null;
	const reloadedAttachmentIndex = flattenBlocks(frameWindow.wp.data.select('core/block-editor').getBlocks()).findIndex((block) => block.clientId === reloadedAttachmentBlock?.clientId);
	const reloadedCoreNoteMarkers = getCoreNoteMarkers(frameWindow).filter((marker) => marker.clientId === reloadedAttachmentBlock?.clientId && Number(marker.attributes?.['data-id']) === Number(noteId));
	const reloadedNoteEntity = await waitFor(() => frameWindow.wp.data.select('core')?.getEntityRecord?.('root', 'comment', Number(noteId)), 'reloaded note entity ' + noteId);
	const reloadedBlockText = getAllBlockText(frameWindow);
	return {
		reloadedBlockNoteIds,
		reloadedHasNoteId: reloadedBlockNoteIds.includes(Number(noteId)),
		reloadedNoteBlockTexts,
		reloadedNoteTargetsAnchor: reloadedNoteBlockTexts.some((text) => text.includes('Homeboy note anchor target')),
		reloadedAttachmentBlockClientId: reloadedAttachmentBlock?.clientId || null,
		reloadedAttachmentIndex,
		reloadedCoreNoteMarkers,
		reloadedHasCoreNoteMarker: reloadedCoreNoteMarkers.length > 0,
		reloadedNoteEntity: reloadedNoteEntity ? { id: reloadedNoteEntity.id, post: reloadedNoteEntity.post } : null,
		reloadedNoteEntityResolvesToAttachment: Number(reloadedNoteEntity?.id) === Number(noteId) && Number(reloadedNoteEntity?.post) === Number(postId) && !!reloadedAttachmentBlock,
		reloadedBlockText,
		reloadedHasDirtyText: reloadedBlockText.includes(dirtyText) || (frameDocument.body.textContent || '').includes(dirtyText),
	};
};
const openPeerEditor = async (caseId, postId) => {
	const iframe = document.createElement('iframe');
	iframe.style.cssText = 'position:fixed;left:-10000px;top:0;width:1200px;height:800px';
	document.body.appendChild(iframe);
	iframe.src = '/wp-admin/post.php?post=' + encodeURIComponent(postId) + '&action=edit&homeboy_notes_case=' + encodeURIComponent(caseId) + '&homeboy_peer=1';
	await new Promise((resolve, reject) => {
		const timeout = setTimeout(() => reject(new Error('Timed out loading peer editor for ' + caseId)), readinessTimeoutMs);
		iframe.addEventListener('load', () => { clearTimeout(timeout); resolve(); }, { once: true });
	});
	const peerWindow = iframe.contentWindow;
	await waitForFrameEditorReady(peerWindow, iframe.contentDocument, caseId);
	actorEvent('peer', 'editor-ready', { caseId, postId });
	return { iframe, peerWindow };
};
const readPeerState = (peerWindow, noteId) => {
	const blocks = flattenBlocks(peerWindow.wp.data.select('core/block-editor').getBlocks());
	return {
		blockCount: blocks.length,
		blockTexts: blocks.map(getBlockText),
		noteIds: getBlockNoteIds(peerWindow),
		attachmentCount: getBlocksWithNoteId(noteId, peerWindow).length,
	};
};
const collectPeerState = async (caseId, postId, noteId) => {
	const { iframe, peerWindow } = await openPeerEditor(caseId, postId);
	const state = readPeerState(peerWindow, noteId);
	iframe.remove();
	return state;
};
const collectBlockAttachment = async (caseId, item, noteId) => {
	await waitForEditorReady(caseId);
	const blockNoteIds = getBlockNoteIds();
	const blockHasNoteId = blockNoteIds.includes(Number(noteId));
	const notesButton = findButtonByText('All notes');
	if (notesButton && notesButton.getAttribute('aria-expanded') === 'false') {
		notesButton.click();
	}
	await waitFor(() => document.querySelector('[role="region"][aria-label="Editor settings"], .interface-interface-skeleton__sidebar'), 'editor settings for ' + caseId);
	await sleep(1000);
	const treeitems = Array.from(document.querySelectorAll('[role="treeitem"]')).map((node) => ({
		id: node.id || '',
		ariaLabel: node.getAttribute('aria-label') || '',
		text: (node.textContent || '').replace(/\s+/g, ' ').trim(),
	}));
	const targetThread = treeitems.find((thread) => thread.id === 'note-thread-' + noteId || thread.ariaLabel.includes('Homeboy') || thread.text.includes('Homeboy')) || null;
	const deletedNotices = Array.from(document.querySelectorAll('.editor-collab-sidebar-panel__deleted-block-notice')).map((node) => (node.textContent || '').trim());
	const bodyText = document.body.textContent || '';
	const hasDeletedNotice = deletedNotices.length > 0 || bodyText.includes('Original block deleted.');
	const logicalOrphan = !blockHasNoteId;
	return {
		caseId,
		postId: item.post_id,
		noteId,
		expectedOrphan: item.expected_orphan,
		blockNoteIds,
		blockHasNoteId,
		logicalOrphan,
		url: location.href,
		title: document.title,
		targetThread,
		treeitems,
		deletedNotices,
		hasDeletedNotice,
		passed: item.expected_orphan ? logicalOrphan : blockHasNoteId,
	};
};
const openAddNoteField = async (block) => {
	window.wp.data.dispatch('core/block-editor').selectBlock(block.clientId);
	const blockElement = document.querySelector('[data-block="' + block.clientId + '"]');
	blockElement?.scrollIntoView({ block: 'center' });
	blockElement?.focus();
	blockElement?.click();
	await sleep(250);
	for (const combo of [{ metaKey: true }, { ctrlKey: true }]) {
		(document.activeElement || document).dispatchEvent(new KeyboardEvent('keydown', { key: 'm', code: 'KeyM', altKey: true, bubbles: true, cancelable: true, ...combo }));
	}
		await sleep(500);
		const hasNewNoteSubmit = () => isVisible(findButtonByText('Add note'));
		if (!findNewNoteField() || !hasNewNoteSubmit()) {
			const toolbarButtons = getEditorDocuments().flatMap((editorDocument) => Array.from(editorDocument.querySelectorAll('.block-editor-block-toolbar button, .block-editor-block-contextual-toolbar button'))).filter(isVisible);
			const optionsButton = toolbarButtons.sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left).at(-1);
			if (!optionsButton) {
			throw new Error('Could not find block toolbar options button; toolbar buttons=' + toolbarButtons.map((button) => button.getAttribute('aria-label') || button.textContent || '').join(', '));
		}
		optionsButton.click();
		const addNoteMenuItem = await waitFor(() => findMenuItemByText('Add note'), 'Add note menu item');
		addNoteMenuItem.click();
	}
	try {
		return await waitFor(() => findNewNoteField(), 'new note textarea');
	} catch (error) {
		const candidates = getNoteFieldCandidates().filter(isVisible).map((field) => ({
			tag: field.tagName,
			placeholder: field.getAttribute('placeholder'),
			dataPlaceholder: field.getAttribute('data-placeholder'),
			ariaLabel: field.getAttribute('aria-label'),
			role: field.getAttribute('role'),
			className: field.className,
		}));
		throw new Error(error.message + '; visible editor fields=' + JSON.stringify(candidates.slice(0, 30)));
	}
};
const createNoteOnBlock = async (block, text) => {
	const beforeIds = new Set(getBlockNoteIds());
	const textarea = await openAddNoteField(block);
	textarea.focus();
	setFieldValue(textarea, text);
	await sleep(250);
	const addButton = await waitForAddNoteButton();
	addButton.click();
	await waitFor(() => document.body.textContent.includes(text), 'created live note thread ' + text);
	return waitFor(() => getBlockNoteIds().find((id) => !beforeIds.has(id)), 'new live note id in edited block metadata');
};
const createConcurrentNoteRepair = async (block, text) => {
	const coreDispatch = window.wp.data.dispatch('core');
	const editorSelect = window.wp.data.select('core/editor');
	const liveBlock = window.wp.data.select('core/block-editor').getBlock(block.clientId);
	const savedNote = await coreDispatch.saveEntityRecord('root', 'comment', {
		post: editorSelect.getCurrentPostId(),
		content: text,
		status: 'hold',
		type: 'note',
		parent: 0,
	}, { throwOnError: true });
	const existingIds = Array.isArray(liveBlock.attributes.metadata?.noteId) ? liveBlock.attributes.metadata.noteId : [liveBlock.attributes.metadata?.noteId].filter(Boolean);
	const noteIds = [...new Set([...existingIds, savedNote.id])];
	window.wp.data.dispatch('core/block-editor').updateBlockAttributes(liveBlock.clientId, { metadata: { ...liveBlock.attributes.metadata, noteId: noteIds } });
	const { unlock } = window.wp.privateApis.__dangerousOptInToUnstableAPIsOnlyForCoreModules(
		'I acknowledge private features are not for use in themes or plugins and doing so will break in the next version of WordPress.',
		'@wordpress/core-data'
	);
	const repair = unlock(window.wp.data.dispatch('core')).persistEntityBlockAttributes(
		'postType',
		editorSelect.getCurrentPostType(),
		editorSelect.getCurrentPostId(),
		{
			record: editorSelect.getCurrentPost(),
			blockPath: [0],
			isMatch: (candidate) => candidate.name === liveBlock.name && getBlockText(candidate) === getBlockText(liveBlock),
			matchCount: 1,
			matchIndex: 0,
			blockCount: 1,
			blockName: liveBlock.name,
			attributes: (savedAttributes) => {
				const savedIds = Array.isArray(savedAttributes.metadata?.noteId) ? savedAttributes.metadata.noteId : [savedAttributes.metadata?.noteId].filter(Boolean);
				return { metadata: { ...savedAttributes.metadata, noteId: [...new Set([...savedIds, ...noteIds])] } };
			},
		}
	);
	return { noteId: savedNote.id, repair };
};
const findRichTextEditable = (block) => {
	const selector = '[data-block="' + block.clientId + '"][contenteditable="true"], [data-block="' + block.clientId + '"] [contenteditable="true"]';
	return getEditorDocuments().map((editorDocument) => editorDocument.querySelector(selector)).find((editable) => editable?.textContent?.includes('note anchor'));
};
const selectRichTextRange = (editable) => {
	const text = 'note anchor';
	const editorDocument = editable.ownerDocument;
	const walker = editorDocument.createTreeWalker(editable, NodeFilter.SHOW_TEXT);
	let node;
	while ((node = walker.nextNode())) {
		const start = node.textContent.indexOf(text);
		if (start === -1) continue;
		editable.focus();
		const range = editorDocument.createRange();
		range.setStart(node, start);
		range.setEnd(node, start + text.length);
		const selection = editorDocument.defaultView.getSelection();
		selection.removeAllRanges();
		selection.addRange(range);
		editorDocument.dispatchEvent(new Event('selectionchange', { bubbles: true }));
		return selection.toString();
	}
	throw new Error('Could not select rich-text note anchor range');
};
const beginNoteOnRichTextRange = async (block, text) => {
	const beforeIds = new Set(getBlockNoteIds());
	const editable = await waitFor(() => findRichTextEditable(block), 'rich-text note anchor editable');
	if (selectRichTextRange(editable) !== 'note anchor') throw new Error('Rich-text range selection did not match note anchor');
	for (const combo of [{ metaKey: true }, { ctrlKey: true }]) {
		editable.dispatchEvent(new KeyboardEvent('keydown', { key: 'm', code: 'KeyM', altKey: true, bubbles: true, cancelable: true, ...combo }));
	}
	await sleep(500);
	if (!findNewNoteField()) {
		const toolbarButtons = getEditorDocuments().flatMap((editorDocument) => Array.from(editorDocument.querySelectorAll('.block-editor-block-toolbar button, .block-editor-block-contextual-toolbar button'))).filter(isVisible);
		const optionsButton = toolbarButtons.sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left).at(-1);
		if (!optionsButton) throw new Error('Could not find rich-text toolbar options button');
		optionsButton.click();
		const addNoteMenuItem = await waitFor(() => findMenuItemByText('Add note'), 'rich-text Add note menu item');
		addNoteMenuItem.click();
	}
	const textarea = await waitFor(() => findNewNoteField(), 'rich-text range note textarea');
	textarea.focus();
	setFieldValue(textarea, text);
	const addButton = await waitForAddNoteButton();
	addButton.click();
	return beforeIds;
};
const createNoteOnRichTextRange = async (block, text) => {
	const beforeIds = await beginNoteOnRichTextRange(block, text);
	await waitFor(() => document.body.textContent.includes(text), 'created rich-text range note thread ' + text);
	const noteId = await waitFor(() => getBlockNoteIds().find((id) => !beforeIds.has(id)), 'new rich-text range note id in block metadata');
	await waitFor(() => getCoreNoteMarkers().some((marker) => marker.clientId === block.clientId && Number(marker.attributes?.['data-id']) === Number(noteId)), 'core/note rich-text marker for note ' + noteId);
	return noteId;
};
const collectLiveCreateCase = async (caseId) => {
	const item = fixtureState[caseId];
	if (!item) {
		throw new Error('Missing fixture case ' + caseId);
	}
	const dirtyText = 'Homeboy dirty edit that must stay unsaved.';
	await waitForEditorReady(caseId);
	try {
		if (window.wp.data.select('core/preferences')?.get('core/edit-post', 'welcomeGuide')) {
			window.wp.data.dispatch('core/preferences').set('core/edit-post', 'welcomeGuide', false);
		}
	} catch (error) {}
	try {
		if (window.wp.data.select('core/edit-post')?.isFeatureActive?.('welcomeGuide')) {
			window.wp.data.dispatch('core/edit-post').toggleFeature('welcomeGuide');
		}
	} catch (error) {}
	await sleep(500);
	const block = await waitFor(() => getTargetBlock(caseId), 'target block for ' + caseId);
	if (caseId === 'dirty-live-create' || caseId === 'dirty-sibling-live-create') {
		const dirtyBlock = await waitFor(() => getDirtyBlock(caseId), 'dirty block for ' + caseId);
		window.wp.data.dispatch('core/block-editor').updateBlockAttributes(dirtyBlock.clientId, { content: dirtyText });
		await waitFor(() => window.wp.data.select('core/editor').isEditedPostDirty?.(), 'dirty editor state before note create');
	}
	if (caseId === 'dirty-structural-live-create') {
		const insertedBlock = window.wp.blocks.createBlock('core/paragraph', { content: dirtyText });
		window.wp.data.dispatch('core/block-editor').insertBlock(insertedBlock, 0);
		await waitFor(() => window.wp.data.select('core/editor').isEditedPostDirty?.(), 'dirty structural editor state before note create');
	}
	const noteIds = [];
	noteIds.push(await createNoteOnBlock(block, 'Homeboy live note'));
	if (caseId === 'double-live-create') {
		noteIds.push(await createNoteOnBlock(block, 'Homeboy second live note'));
	}
	const noteId = noteIds.at(-1);
	let saveSettled = false;
	try {
		await waitFor(() => {
			const editor = window.wp.data.select('core/editor');
			return !editor.isSavingPost?.() && !editor.isAutosavingPost?.() && !editor.isEditedPostDirty?.();
		}, 'post save after live note create');
		saveSettled = true;
	} catch (error) {}
	let persistedContent = await getPostContent(item.post_id);
	let persistedHasNoteId = contentHasNoteId(persistedContent, noteId);
	let persistedHasAllNoteIds = noteIds.every((id) => contentHasNoteId(persistedContent, id));
	let persistedHasDirtyText = persistedContent.includes(dirtyText);
	let persistedHasOriginalSiblingText = persistedContent.includes('Homeboy sibling text that must stay saved.');
	let repairSaveObserved = false;
	try {
		repairSaveObserved = await waitFor(() => observedRequests.some((request) => request.method === 'POST' && request.status >= 200 && request.status < 300 && request.semantics.is_targeted_repair && request.semantics.entity_id === String(item.post_id)), 'repair entity save after live note create');
	} catch (error) {}
	try {
		persistedHasNoteId = await waitFor(async () => {
			persistedContent = await getPostContent(item.post_id);
			persistedHasNoteId = contentHasNoteId(persistedContent, noteId);
			persistedHasDirtyText = persistedContent.includes(dirtyText);
			persistedHasOriginalSiblingText = persistedContent.includes('Homeboy sibling text that must stay saved.');
			persistedHasAllNoteIds = noteIds.every((id) => contentHasNoteId(persistedContent, id));
			return persistedHasAllNoteIds;
		}, 'persisted post_content noteId after live note create');
	} catch (error) {}
	const reloaded = await collectReloadedEditorState(caseId, item.post_id, noteId, dirtyText);
	const collected = await collectBlockAttachment(caseId, { ...item, note_id: noteId }, noteId);
	const reloadedHasAllNoteIds = noteIds.every((id) => reloaded.reloadedBlockNoteIds.includes(Number(id)));
	const dirtyCasePassed = ![ 'dirty-live-create', 'dirty-sibling-live-create', 'dirty-structural-live-create' ].includes(caseId) || (!persistedHasDirtyText && !reloaded.reloadedHasDirtyText);
	const siblingCasePassed = ![ 'dirty-sibling-live-create', 'dirty-structural-live-create' ].includes(caseId) || persistedHasOriginalSiblingText;
	const targetCasePassed = caseId !== 'dirty-structural-live-create' || reloaded.reloadedNoteTargetsAnchor;
	return {
		...collected,
		...reloaded,
		noteIds,
		repairSaveObserved,
		blockHasPersistedNoteId: persistedHasNoteId,
		persistedHasAllNoteIds,
		reloadedHasAllNoteIds,
		logicalOrphan: !reloaded.reloadedHasNoteId,
		passed: reloaded.reloadedHasNoteId && reloadedHasAllNoteIds && persistedHasAllNoteIds && repairSaveObserved && dirtyCasePassed && siblingCasePassed && targetCasePassed,
		saveSettled,
		persistedHasDirtyText,
		persistedHasOriginalSiblingText,
		persistedContentSample: persistedContent.slice(0, 500),
		observedRequests: observedRequests.filter((request) => request.url.includes('/wp-sync/v1/save') || request.url.includes('/wp-json/wp/v2/posts/')).slice(-20),
	};
};
const collectInlineRangeLiveCreateCase = async () => {
	const caseId = 'inline-range-live-create';
	const item = fixtureState[caseId];
	if (!item) throw new Error('Missing fixture case ' + caseId);
	await waitForEditorReady(caseId);
	try {
		if (window.wp.data.select('core/preferences')?.get('core/edit-post', 'welcomeGuide')) {
			window.wp.data.dispatch('core/preferences').set('core/edit-post', 'welcomeGuide', false);
		}
	} catch (error) {}
	try {
		if (window.wp.data.select('core/edit-post')?.isFeatureActive?.('welcomeGuide')) {
			window.wp.data.dispatch('core/edit-post').toggleFeature('welcomeGuide');
		}
	} catch (error) {}
	await sleep(500);
	const cleanPostBeforeCreate = !window.wp.data.select('core/editor').isEditedPostDirty?.();
	const block = await waitFor(() => getTargetBlock(caseId), 'rich-text range target block');
	const noteId = await createNoteOnRichTextRange(block, 'Homeboy inline range note');
	const targetedPersistenceObserved = await waitFor(() => observedRequests.some((request) => request.method === 'POST' && request.status >= 200 && request.status < 300 && request.semantics.is_targeted_repair && request.semantics.entity_id === String(item.post_id)), 'targeted note metadata persistence');
	const fullPostSaveObserved = observedRequests.some((request) => request.url.includes('/wp-json/wp/v2/posts/' + item.post_id) && request.method === 'POST' && request.semantics.is_full_editor_save);
	const reloaded = await collectReloadedEditorState(caseId, item.post_id, noteId, 'Homeboy dirty edit that must stay unsaved.');
	return {
		caseId,
		postId: item.post_id,
		noteId,
		cleanPostBeforeCreate,
		targetedPersistenceObserved,
		fullPostSaveObserved,
		...reloaded,
		logicalOrphan: !reloaded.reloadedHasNoteId,
		passed: cleanPostBeforeCreate && targetedPersistenceObserved && !fullPostSaveObserved && reloaded.reloadedHasNoteId && reloaded.reloadedHasCoreNoteMarker && reloaded.reloadedNoteEntityResolvesToAttachment,
		observedRequests: observedRequests.filter((request) => request.route === 'entity-save' || request.url.includes('/wp-json/wp/v2/posts/') || request.url.includes('/wp-json/wp/v2/comments')).slice(-20),
	};
};
const waitForPersistedNoteIds = async (postId, noteIds) => waitFor(async () => {
	const content = await getPostContent(postId);
	return noteIds.every((noteId) => contentHasNoteId(content, noteId));
}, 'persisted note IDs ' + noteIds.join(','));
const postRequests = (postId) => observedRequests.filter((request) => request.method === 'POST' && (request.url.includes('/wp-json/wp/v2/posts/' + postId) || (request.route === 'entity-save' && request.semantics.entity_id === String(postId))));
const collectNoSavedMatchCase = async () => {
	const caseId = 'no-saved-match';
	const item = fixtureState[caseId];
	await waitForEditorReady(caseId);
	const target = getTargetBlock(caseId);
	const liveOnlyText = 'Homeboy live target with no saved match.';
	window.wp.data.dispatch('core/block-editor').updateBlockAttributes(target.clientId, { content: liveOnlyText });
	await waitFor(() => getBlockText(getTargetBlock(caseId)) === liveOnlyText, 'live-only target mutation');
	const inserted = window.wp.blocks.createBlock('core/paragraph', { content: 'Homeboy live-only path shift.' });
	window.wp.data.dispatch('core/block-editor').insertBlock(inserted, 0);
	await waitFor(() => window.wp.data.select('core/block-editor').getBlocks()[1]?.clientId === target.clientId, 'live-only target path shift');
	const noteId = await createNoteOnBlock(target, 'Homeboy no saved match note');
	const reloaded = await collectReloadedEditorState(caseId, item.post_id, noteId, liveOnlyText);
	const wrongSavedBlockAttached = reloaded.reloadedHasNoteId;
	const fullPostSaveObserved = postRequests(item.post_id).some((request) => request.semantics.is_full_editor_save);
	return { caseId, postId: item.post_id, noteId, liveOnlyText, wrongSavedBlockAttached, fullPostSaveObserved, ...reloaded, logicalOrphan: !reloaded.reloadedHasNoteId, passed: !wrongSavedBlockAttached && !fullPostSaveObserved, actorTimeline: [...actorTimeline], observedRequests: postRequests(item.post_id) };
};
const collectAmbiguousContentlessCase = async () => {
	const caseId = 'ambiguous-contentless';
	const item = fixtureState[caseId];
	await waitForEditorReady(caseId);
	const blocksBefore = flattenBlocks(window.wp.data.select('core/block-editor').getBlocks());
	const target = getTargetBlock(caseId);
	if (blocksBefore.length !== 2 || target !== blocksBefore[1]) throw new Error('Contentless sibling fixture did not expose an exact second sibling target');
	const inserted = window.wp.blocks.createBlock('core/paragraph', { content: 'Homeboy unsaved path shift.' });
	window.wp.data.dispatch('core/block-editor').insertBlock(inserted, 0);
	await waitFor(() => window.wp.data.select('core/block-editor').getBlocks().length === 3, 'contentless sibling path shift');
	const noteId = await createNoteOnBlock(target, 'Homeboy second contentless sibling note');
	await waitForPersistedNoteIds(item.post_id, [noteId]);
	const reloaded = await collectReloadedEditorState(caseId, item.post_id, noteId, '');
	return { caseId, postId: item.post_id, noteId, intendedAttachmentIndex: 1, ...reloaded, passed: reloaded.reloadedAttachmentIndex === 1 && reloaded.reloadedHasNoteId, actorTimeline: [...actorTimeline], observedRequests: postRequests(item.post_id) };
};
const collectEmptySavedContentCase = async () => {
	const caseId = 'empty-saved-content';
	const item = fixtureState[caseId];
	await waitForEditorReady(caseId);
	const inserted = window.wp.blocks.createBlock('core/paragraph', { content: 'Homeboy unsaved empty-document target.' });
	window.wp.data.dispatch('core/block-editor').insertBlock(inserted, 0);
	await waitFor(() => getBlockText(getTargetBlock(caseId)).includes('empty-document target'), 'unsaved empty-document block');
	const noteId = await createNoteOnBlock(inserted, 'Homeboy empty saved content note');
	await sleep(1000);
	const persistedContent = await getPostContent(item.post_id);
	const fullPostSaveObserved = postRequests(item.post_id).some((request) => request.semantics.is_full_editor_save);
	const errorNotices = (window.wp.data.select('core/notices')?.getNotices?.() || []).filter((notice) => notice.status === 'error').map((notice) => notice.content || notice.id);
	const editorDirty = window.wp.data.select('core/editor').isEditedPostDirty?.();
	const expectedError = 'The note was added, but its block attachment could not be saved.';
	return { caseId, postId: item.post_id, noteId, persistedContent, fullPostSaveObserved, errorNotices, editorDirty, passed: persistedContent === '' && !fullPostSaveObserved && editorDirty === true && errorNotices.includes(expectedError), actorTimeline: [...actorTimeline], observedRequests: postRequests(item.post_id) };
};
const collectStoreCoherenceCase = async () => {
	const caseId = 'store-coherence';
	const item = fixtureState[caseId];
	await waitForEditorReady(caseId);
	const target = getTargetBlock(caseId);
	const firstNoteId = await createNoteOnBlock(target, 'Homeboy coherence first note');
	const blockStoreHasFirstNote = getBlocksWithNoteId(firstNoteId).some((block) => block.clientId === target.clientId);
	const editorContent = window.wp.data.select('core/editor').getEditedPostAttribute?.('content') || '';
	const editorStoreHasFirstNote = contentHasNoteId(editorContent, firstNoteId);
	const coreDataEntity = window.wp.data.select('core').getEditedEntityRecord?.('postType', 'post', item.post_id);
	const coreDataStoreHasFirstNote = contentHasNoteId(JSON.stringify(coreDataEntity || {}), firstNoteId);
	actorEvent('parent', 'stores-checked-before-dependent-operation', { firstNoteId, blockStoreHasFirstNote, editorStoreHasFirstNote, coreDataStoreHasFirstNote });
	const secondNoteId = await createNoteOnBlock(target, 'Homeboy coherence dependent note');
	await waitForPersistedNoteIds(item.post_id, [firstNoteId, secondNoteId]);
	const reloaded = await collectReloadedEditorState(caseId, item.post_id, secondNoteId, '');
	return { caseId, postId: item.post_id, noteIds: [firstNoteId, secondNoteId], blockStoreHasFirstNote, editorStoreHasFirstNote, coreDataStoreHasFirstNote, ...reloaded, passed: blockStoreHasFirstNote && editorStoreHasFirstNote && coreDataStoreHasFirstNote && reloaded.reloadedBlockNoteIds.includes(firstNoteId) && reloaded.reloadedBlockNoteIds.includes(secondNoteId), actorTimeline: [...actorTimeline], observedRequests: postRequests(item.post_id) };
};
const collectRepairSyncRaceCase = async () => {
	const caseId = 'repair-sync-race';
	const item = fixtureState[caseId];
	await waitForEditorReady(caseId);
	const target = getTargetBlock(caseId);
	const firstNoteId = await createNoteOnBlock(target, 'Homeboy race first note');
	const syncSave = window.wp.data.dispatch('core/editor').savePost();
	const secondNoteId = await createNoteOnBlock(target, 'Homeboy race second note');
	await syncSave;
	await waitForPersistedNoteIds(item.post_id, [firstNoteId, secondNoteId]);
	const reloaded = await collectReloadedEditorState(caseId, item.post_id, secondNoteId, '');
	const raceRequests = observedRequests.filter((request) => request.route === 'entity-save' || request.route === 'post-rest' || request.route === 'sync-save');
	const delayedRoutes = actorTimeline.filter((entry) => entry.event === 'request-delayed').map((entry) => entry.data.route);
	const targetedRepairs = raceRequests.filter((request) => request.method === 'POST' && request.semantics.is_targeted_repair);
	const competingEntitySaves = raceRequests.filter((request) => request.method === 'POST' && request.semantics.has_crdt_document && !request.semantics.is_targeted_repair);
	const exercisedRepairAndSave = targetedRepairs.length >= 2 && competingEntitySaves.length >= 1;
	return { caseId, postId: item.post_id, seed, noteIds: [firstNoteId, secondNoteId], delayedRoutes, exercisedRepairAndSave, raceRequests, ...reloaded, passed: exercisedRepairAndSave && reloaded.reloadedBlockNoteIds.includes(firstNoteId) && reloaded.reloadedBlockNoteIds.includes(secondNoteId), actorTimeline: [...actorTimeline] };
};
const collectCrdtPeerLineageCase = async () => {
	const caseId = 'crdt-peer-lineage';
	const item = fixtureState[caseId];
	await waitForEditorReady(caseId);
	const target = getTargetBlock(caseId);
	const parentBlockCount = flattenBlocks(window.wp.data.select('core/block-editor').getBlocks()).length;
	const parentText = getAllBlockText();
	actorEvent('parent', 'establish-persisted-lineage-start', {});
	await window.wp.data.dispatch('core/editor').savePost();
	await waitFor(() => !window.wp.data.select('core/editor').isSavingPost?.(), 'initial persisted CRDT lineage');
	actorEvent('parent', 'establish-persisted-lineage-finish', {});
	const { iframe, peerWindow } = await openPeerEditor(caseId, item.post_id);
	const noteId = await createNoteOnBlock(target, 'Homeboy CRDT peer lineage note');
	await waitForPersistedNoteIds(item.post_id, [noteId]);
	await waitFor(() => getBlockNoteIds(peerWindow).includes(noteId), 'peer convergence for note ' + noteId);
	await sleep(1000);
	const peer = readPeerState(peerWindow, noteId);
	iframe.remove();
	return { caseId, postId: item.post_id, noteId, parentBlockCount, parentText, peer, passed: peer.noteIds.includes(noteId) && peer.attachmentCount === 1 && peer.blockCount === parentBlockCount && peer.blockTexts.join('\\n') === parentText, actorTimeline: [...actorTimeline], observedRequests: observedRequests.filter((request) => request.route === 'post-rest' || request.route === 'sync-save') };
};
const collectRepairFailureRecoveryCase = async () => {
	const caseId = 'repair-failure-recovery';
	const item = fixtureState[caseId];
	await waitForEditorReady(caseId);
	const target = getTargetBlock(caseId);
	const firstNoteId = await createNoteOnBlock(target, 'Homeboy failed repair note');
	const surfacedFailure = await waitFor(() => (window.wp.data.select('core/notices')?.getNotices?.() || []).some((notice) => String(notice.content || '').includes('Forced attachment repair failure')), 'failed repair notice');
	const secondNoteId = await createNoteOnBlock(target, 'Homeboy repair recovery note');
	await waitForPersistedNoteIds(item.post_id, [firstNoteId, secondNoteId]);
	const reloaded = await collectReloadedEditorState(caseId, item.post_id, secondNoteId, '');
	const forcedFailure = postRequests(item.post_id).some((request) => request.forced_failure);
	return { caseId, postId: item.post_id, noteIds: [firstNoteId, secondNoteId], surfacedFailure: !!surfacedFailure, forcedFailure, ...reloaded, passed: !!surfacedFailure && forcedFailure && reloaded.reloadedBlockNoteIds.includes(firstNoteId) && reloaded.reloadedBlockNoteIds.includes(secondNoteId), actorTimeline: [...actorTimeline], observedRequests: postRequests(item.post_id) };
};
const collectConcurrentNoteRepairsCase = async () => {
	const caseId = 'concurrent-note-repairs';
	const item = fixtureState[caseId];
	await waitForEditorReady(caseId);
	const target = getTargetBlock(caseId);
	const firstNoteId = await createNoteOnBlock(target, 'Homeboy held repair note');
	await waitFor(() => actorTimeline.some((entry) => entry.event === 'request-held' && entry.data.route === 'entity-save'), 'first targeted repair hold');
	const secondCreation = await createConcurrentNoteRepair(target, 'Homeboy overlapping repair note');
	await waitFor(() => getBlockNoteIds().length === 2, 'second local note attachment while first repair is held');
	releaseHeldRequest();
	await secondCreation.repair;
	const secondNoteId = secondCreation.noteId;
	await waitForPersistedNoteIds(item.post_id, [firstNoteId, secondNoteId]);
	const reloaded = await collectReloadedEditorState(caseId, item.post_id, secondNoteId, '');
	const heldAndReleased = actorTimeline.some((entry) => entry.event === 'request-held') && actorTimeline.some((entry) => entry.event === 'request-released');
	return { caseId, postId: item.post_id, noteIds: [firstNoteId, secondNoteId], heldAndReleased, ...reloaded, passed: heldAndReleased && reloaded.reloadedBlockNoteIds.includes(firstNoteId) && reloaded.reloadedBlockNoteIds.includes(secondNoteId), actorTimeline: [...actorTimeline], observedRequests: postRequests(item.post_id) };
};
const collectInlinePendingEditCase = async () => {
	const caseId = 'inline-pending-edit';
	const item = fixtureState[caseId];
	await waitForEditorReady(caseId);
	const target = getTargetBlock(caseId);
	const noteText = 'Homeboy stale inline range note';
	await beginNoteOnRichTextRange(target, noteText);
	await waitFor(() => actorTimeline.some((entry) => entry.event === 'request-held' && entry.data.route === 'comment-rest'), 'pending note comment hold');
	const dirtyText = 'Homeboy text changed while note creation was pending.';
	window.wp.data.dispatch('core/block-editor').updateBlockAttributes(target.clientId, { content: dirtyText });
	await waitFor(() => getBlockText(getTargetBlock(caseId)) === dirtyText, 'pending inline dirty edit');
	releaseHeldRequest();
	const surfacedFailure = await waitFor(() => (window.wp.data.select('core/notices')?.getNotices?.() || []).some((notice) => String(notice.content || '').includes('selected text changed')), 'stale inline selection notice');
	const noteId = await waitFor(() => {
		const notes = window.wp.data.select('core').getEntityRecords('root', 'comment', { post: item.post_id, type: 'note', status: 'all', per_page: -1 }) || [];
		return notes.find((note) => String(note.content?.rendered || note.content?.raw || note.content || '').includes(noteText))?.id;
	}, 'created stale inline note entity');
	const persistedContent = await getPostContent(item.post_id);
	const reloaded = await collectReloadedEditorState(caseId, item.post_id, noteId, dirtyText);
	return { caseId, postId: item.post_id, noteId, dirtyText, surfacedFailure: !!surfacedFailure, persistedContent, ...reloaded, logicalOrphan: !reloaded.reloadedHasNoteId, passed: !!surfacedFailure && !contentHasNoteId(persistedContent, noteId) && !persistedContent.includes(dirtyText) && !reloaded.reloadedHasNoteId && !reloaded.reloadedHasCoreNoteMarker && !reloaded.reloadedHasDirtyText, actorTimeline: [...actorTimeline], observedRequests: observedRequests.filter((request) => request.route === 'comment-rest' || request.route === 'post-rest') };
};
const collectCase = async (caseId) => {
	const item = fixtureState[caseId];
	if (!item) {
		throw new Error('Missing fixture case ' + caseId);
	}
	if (liveCreateCases.includes(caseId)) {
		return collectLiveCreateCase(caseId);
	}
	if (caseId === 'inline-range-live-create') {
		return collectInlineRangeLiveCreateCase();
	}
	if (caseId === 'no-saved-match') return collectNoSavedMatchCase();
	if (caseId === 'ambiguous-contentless') return collectAmbiguousContentlessCase();
	if (caseId === 'empty-saved-content') return collectEmptySavedContentCase();
	if (caseId === 'store-coherence') return collectStoreCoherenceCase();
	if (caseId === 'repair-sync-race') return collectRepairSyncRaceCase();
	if (caseId === 'crdt-peer-lineage') return collectCrdtPeerLineageCase();
	if (caseId === 'repair-failure-recovery') return collectRepairFailureRecoveryCase();
	if (caseId === 'concurrent-note-repairs') return collectConcurrentNoteRepairsCase();
	if (caseId === 'inline-pending-edit') return collectInlinePendingEditCase();
	return collectBlockAttachment(caseId, item, Number(item.note_id));
};
const results = [await collectCase(currentCase)];
return {
	fixtureState,
	targetCase,
	currentCase,
	results,
	passed: results.every((result) => result.passed),
};`;

try {
	event( 'scenario', 'start', {
		component_path: componentPath,
		wp_version: wpVersion,
		target_case: targetCase,
		seed: process.env.HOMEBOY_SEED || null,
		issue: 'https://github.com/WordPress/gutenberg/issues/72717',
	} );

	await writeFixturePlugin();

	const recipe = {
		schema: 'wp-codebox/workspace-recipe/v1',
		runtime: {
			wp: wpVersion,
			blueprint: {
				steps: [
					{ step: 'activatePlugin', pluginPath: '/wordpress/wp-content/plugins/gutenberg/gutenberg.php' },
					{ step: 'activatePlugin', pluginPath: '/wordpress/wp-content/plugins/gutenberg-notes-unsaved-attachment-fixture/gutenberg-notes-unsaved-attachment-fixture.php' },
					{ step: 'login', username: 'admin', password: 'password' },
				],
			},
		},
		inputs: {
			extra_plugins: [
				{ source: componentPath, slug: 'gutenberg', pluginFile: 'gutenberg/gutenberg.php', activate: true },
				{ source: fixturePluginDir, slug: 'gutenberg-notes-unsaved-attachment-fixture', pluginFile: 'gutenberg-notes-unsaved-attachment-fixture/gutenberg-notes-unsaved-attachment-fixture.php', activate: true },
			],
		},
		workflow: {
			steps: [
				{
					command: 'wordpress.browser-probe',
					args: [
						`url=/wp-admin/?homeboy_notes_case=${ encodeURIComponent( targetCase === 'matrix' ? 'orphan' : targetCase ) }`,
						'wait-for=load',
						`duration=${ probeDuration }`,
						`viewport=${ viewport }`,
						'capture=console,errors,screenshot,network,performance,memory',
						`script=${ browserScript }`,
					],
				},
			],
		},
		artifacts: { directory: codeboxArtifacts },
	};

	await writeFile( recipeFile, `${ JSON.stringify( recipe, null, 2 ) }\n` );

	const result = await runWpCodeboxRecipe( {
		recipeFile,
		artifactsDir: codeboxArtifacts,
		outputFile,
		event,
	} );

	const output = JSON.parse( result.stdout );
	const browserArtifacts = wpCodeboxBrowserArtifacts( output, [ 'summary.json', 'errors.jsonl', 'network.jsonl', 'performance.json' ] );
	const summaryPath = browserArtifacts[ 'summary.json' ];
	const errorsPath = browserArtifacts[ 'errors.jsonl' ];
	const networkPath = browserArtifacts[ 'network.jsonl' ];
	const performancePath = browserArtifacts[ 'performance.json' ];
	const summary = await readJsonAsync( summaryPath );
	const pageErrors = await readJsonl( errorsPath );
	const network = await readJsonl( networkPath );
	const scriptResult = summary?.summary?.scriptResult || summary?.scriptResult || {};
	const caseResults = Array.isArray( scriptResult.results ) ? scriptResult.results : [];
	const pluginAssetResponses = network.filter( ( entry ) =>
		entry.type === 'response' && entry.status >= 200 && entry.status < 300 && entry.url?.includes( '/wp-content/plugins/gutenberg/build/' )
	);
	const coreDataPluginAssetLoaded = pluginAssetResponses.some( ( entry ) => entry.url.includes( '/core-data/' ) );
	const editorPluginAssetLoaded = pluginAssetResponses.some( ( entry ) => entry.url.includes( '/editor/' ) );

	event( 'browser', 'probe.ready', {
		final_url: summary?.summary?.finalUrl || summary?.finalUrl || null,
	} );

	const metrics = {
		issue: 'WordPress/gutenberg#72717',
		target_case: targetCase,
		case_count: caseResults.length,
		pass_count: caseResults.filter( ( item ) => item.passed ).length,
		fail_count: caseResults.filter( ( item ) => ! item.passed ).length,
		orphan_reproduced: caseResults.some( ( item ) => item.caseId === 'orphan' && item.logicalOrphan === true ),
		saved_anchor_attached: caseResults.some( ( item ) => item.caseId === 'saved-anchor' && item.blockHasNoteId === true ),
		gutenberg_plugin_asset_response_count: pluginAssetResponses.length,
		gutenberg_core_data_asset_loaded: coreDataPluginAssetLoaded,
		gutenberg_editor_asset_loaded: editorPluginAssetLoaded,
		gutenberg_plugin_assets_loaded: coreDataPluginAssetLoaded && editorPluginAssetLoaded,
		nested_live_create_attached: caseResults.some( ( item ) => item.caseId === 'nested-live-create' && item.reloadedHasNoteId === true ),
		dirty_sibling_preserved: caseResults.some( ( item ) => item.caseId === 'dirty-sibling-live-create' && item.persistedHasOriginalSiblingText === true && item.persistedHasDirtyText === false && item.reloadedHasDirtyText === false ),
		dirty_structural_targets_anchor: caseResults.some( ( item ) => item.caseId === 'dirty-structural-live-create' && item.reloadedNoteTargetsAnchor === true && item.persistedHasDirtyText === false && item.reloadedHasDirtyText === false ),
		double_live_create_attached: caseResults.some( ( item ) => item.caseId === 'double-live-create' && item.persistedHasAllNoteIds === true && item.reloadedHasAllNoteIds === true ),
		inline_range_note_persisted: caseResults.some( ( item ) => item.caseId === 'inline-range-live-create' && item.cleanPostBeforeCreate === true && item.targetedPersistenceObserved === true && item.fullPostSaveObserved === false && item.reloadedHasNoteId === true && item.reloadedHasCoreNoteMarker === true && item.reloadedNoteEntityResolvesToAttachment === true ),
		no_saved_match_avoids_wrong_sibling: caseResults.some( ( item ) => item.caseId === 'no-saved-match' && item.wrongSavedBlockAttached === false && item.fullPostSaveObserved === false ),
		ambiguous_contentless_targets_second_sibling: caseResults.some( ( item ) => item.caseId === 'ambiguous-contentless' && item.reloadedAttachmentIndex === 1 ),
		empty_saved_content_fails_closed: caseResults.some( ( item ) => item.caseId === 'empty-saved-content' && item.passed ),
		store_coherence_before_dependent_operation: caseResults.some( ( item ) => item.caseId === 'store-coherence' && item.blockStoreHasFirstNote === true && item.editorStoreHasFirstNote === true && item.coreDataStoreHasFirstNote === true ),
		repair_sync_race_converged: caseResults.some( ( item ) => item.caseId === 'repair-sync-race' && item.passed === true && item.exercisedRepairAndSave === true && item.delayedRoutes.includes( 'post-rest' ) ),
		crdt_peer_lineage_stable: caseResults.some( ( item ) => item.caseId === 'crdt-peer-lineage' && item.passed === true && item.peer.attachmentCount === 1 ),
		page_error_count: pageErrors.length,
		network_response_count: network.filter( ( entry ) => entry.type === 'response' ).length,
		sync_save_response_count: network.filter( ( entry ) => entry.type === 'response' && JSON.stringify( entry ).includes( '/wp-sync/v1/save' ) ).length,
		cases: caseResults,
	};

	await writeFile( metricsPath, `${ JSON.stringify( metrics, null, 2 ) }\n` );
	await writeFile(
		metadataPath,
		`${ JSON.stringify(
			{
				final_url: summary?.summary?.finalUrl || summary?.finalUrl || null,
				scenario: {
					id: scenarioId,
					description: 'Block Notes unsaved attachment repro for WordPress/gutenberg#72717.',
				},
				fixture_state: scriptResult.fixtureState || null,
				browser_script_result: scriptResult,
				page_errors_sample: pageErrors.slice( 0, 20 ),
			},
			null,
			2
		) }\n`
	);
	event( 'notes-unsaved-attachment', 'metrics.ready', metrics );

	const noPageErrors = pageErrors.length === 0;
	const pass = metrics.fail_count === 0 && metrics.case_count > 0 && noPageErrors && metrics.gutenberg_plugin_assets_loaded;
	const traceResult = {
		component_id: componentId,
		scenario_id: scenarioId,
		status: pass ? 'pass' : 'fail',
		summary: `Captured Gutenberg note attachment matrix for ${ metrics.case_count } case(s): ${ metrics.pass_count } passed, ${ metrics.fail_count } failed. Orphan reproduced=${ metrics.orphan_reproduced }, saved anchor attached=${ metrics.saved_anchor_attached }, Gutenberg plugin assets loaded=${ metrics.gutenberg_plugin_assets_loaded }.` ,
		timeline,
		assertions: [
			{
				id: 'gutenberg-plugin-assets-loaded',
				status: metrics.gutenberg_plugin_assets_loaded ? 'pass' : 'fail',
				message: `Loaded Gutenberg plugin core-data and editor assets=${ metrics.gutenberg_plugin_assets_loaded }; plugin asset responses=${ metrics.gutenberg_plugin_asset_response_count }.`
			},
			{
				id: 'orphan-note-reproduced',
				status: targetCase !== 'matrix' && targetCase !== 'orphan' ? 'pass' : metrics.orphan_reproduced ? 'pass' : 'fail',
				message: `Unsaved/missing block metadata left the note ID absent from loaded block metadata=${ metrics.orphan_reproduced }.`
			},
			{
				id: 'saved-anchor-attached',
				status: targetCase !== 'matrix' && targetCase !== 'saved-anchor' ? 'pass' : metrics.saved_anchor_attached ? 'pass' : 'fail',
				message: `Saved post_content metadata.noteId attached note to block=${ metrics.saved_anchor_attached }.`
			},
			{
				id: 'live-create-used-repair-save',
				status: targetCase !== 'matrix' && ! [ 'live-create', 'dirty-live-create', 'dirty-sibling-live-create', 'dirty-structural-live-create', 'nested-live-create', 'double-live-create' ].includes( targetCase ) ? 'pass' : caseResults.every( ( item ) => ! [ 'live-create', 'dirty-live-create', 'dirty-sibling-live-create', 'dirty-structural-live-create', 'nested-live-create', 'double-live-create' ].includes( item.caseId ) || item.repairSaveObserved ) ? 'pass' : 'fail',
				message: `Live note creation saved repaired content with _crdt_document=${ caseResults.filter( ( item ) => [ 'live-create', 'dirty-live-create', 'dirty-sibling-live-create', 'dirty-structural-live-create', 'nested-live-create', 'double-live-create' ].includes( item.caseId ) ).every( ( item ) => item.repairSaveObserved ) }; network sync save responses=${ metrics.sync_save_response_count }.`
			},
			{
				id: 'dirty-live-create-did-not-restore-dirty-text',
				status: targetCase !== 'matrix' && ! [ 'dirty-live-create', 'dirty-sibling-live-create', 'dirty-structural-live-create' ].includes( targetCase ) ? 'pass' : caseResults.every( ( item ) => ! [ 'dirty-live-create', 'dirty-sibling-live-create', 'dirty-structural-live-create' ].includes( item.caseId ) || ( item.persistedHasDirtyText === false && item.reloadedHasDirtyText === false ) ) ? 'pass' : 'fail',
				message: `Dirty live-create kept unrelated dirty text out of post_content and reloaded editor state=${ caseResults.filter( ( item ) => [ 'dirty-live-create', 'dirty-sibling-live-create', 'dirty-structural-live-create' ].includes( item.caseId ) ).every( ( item ) => item.persistedHasDirtyText === false && item.reloadedHasDirtyText === false ) }.`
			},
			{
				id: 'dirty-sibling-live-create-preserved-sibling',
				status: targetCase !== 'matrix' && targetCase !== 'dirty-sibling-live-create' ? 'pass' : caseResults.every( ( item ) => item.caseId !== 'dirty-sibling-live-create' || item.persistedHasOriginalSiblingText === true ) ? 'pass' : 'fail',
				message: `Dirty sibling live-create preserved saved sibling content=${ caseResults.filter( ( item ) => item.caseId === 'dirty-sibling-live-create' ).every( ( item ) => item.persistedHasOriginalSiblingText === true ) }.`
			},
			{
				id: 'dirty-structural-live-create-targeted-anchor',
				status: targetCase !== 'matrix' && targetCase !== 'dirty-structural-live-create' ? 'pass' : caseResults.every( ( item ) => item.caseId !== 'dirty-structural-live-create' || item.reloadedNoteTargetsAnchor === true ) ? 'pass' : 'fail',
				message: `Dirty structural live-create attached note to intended anchor block=${ caseResults.filter( ( item ) => item.caseId === 'dirty-structural-live-create' ).every( ( item ) => item.reloadedNoteTargetsAnchor === true ) }.`
			},
			{
				id: 'nested-live-create-attached-after-reload',
				status: targetCase !== 'matrix' && targetCase !== 'nested-live-create' ? 'pass' : caseResults.every( ( item ) => item.caseId !== 'nested-live-create' || item.reloadedHasNoteId === true ) ? 'pass' : 'fail',
				message: `Nested live-create note remained attached after reload=${ caseResults.filter( ( item ) => item.caseId === 'nested-live-create' ).every( ( item ) => item.reloadedHasNoteId === true ) }.`
			},
			{
				id: 'double-live-create-preserved-all-notes',
				status: targetCase !== 'matrix' && targetCase !== 'double-live-create' ? 'pass' : caseResults.every( ( item ) => item.caseId !== 'double-live-create' || ( item.persistedHasAllNoteIds === true && item.reloadedHasAllNoteIds === true ) ) ? 'pass' : 'fail',
				message: `Double live-create persisted and reloaded all note IDs=${ caseResults.filter( ( item ) => item.caseId === 'double-live-create' ).every( ( item ) => item.persistedHasAllNoteIds === true && item.reloadedHasAllNoteIds === true ) }.`
			},
			{
				id: 'inline-range-note-persisted-after-reload',
				status: targetCase !== 'matrix' && targetCase !== 'inline-range-live-create' ? 'pass' : caseResults.every( ( item ) => item.caseId !== 'inline-range-live-create' || ( item.cleanPostBeforeCreate === true && item.targetedPersistenceObserved === true && item.fullPostSaveObserved === false && item.reloadedHasNoteId === true && item.reloadedHasCoreNoteMarker === true && item.reloadedNoteEntityResolvesToAttachment === true ) ) ? 'pass' : 'fail',
				message: `Inline range note used targeted persistence without a full post save and reloaded metadata.noteId=${ caseResults.filter( ( item ) => item.caseId === 'inline-range-live-create' ).every( ( item ) => item.reloadedHasNoteId === true ) }, core/note=${ caseResults.filter( ( item ) => item.caseId === 'inline-range-live-create' ).every( ( item ) => item.reloadedHasCoreNoteMarker === true ) }, and entity attachment=${ caseResults.filter( ( item ) => item.caseId === 'inline-range-live-create' ).every( ( item ) => item.reloadedNoteEntityResolvesToAttachment === true ) }.`
			},
			{
				id: 'no-saved-match-never-attaches-invalid-sibling',
				status: targetCase !== 'no-saved-match' || metrics.no_saved_match_avoids_wrong_sibling ? 'pass' : 'fail',
				message: `Live target mutation avoided attachment to the known-invalid sibling and a full editor save=${ metrics.no_saved_match_avoids_wrong_sibling }.`
			},
			{
				id: 'ambiguous-contentless-target-is-exact-sibling',
				status: targetCase !== 'ambiguous-contentless' || metrics.ambiguous_contentless_targets_second_sibling ? 'pass' : 'fail',
				message: `Identical contentless siblings retained the selected second sibling=${ metrics.ambiguous_contentless_targets_second_sibling }.`
			},
			{
				id: 'empty-saved-content-no-parse-or-full-save',
				status: targetCase !== 'empty-saved-content' || metrics.empty_saved_content_fails_closed ? 'pass' : 'fail',
				message: `Empty saved content failed closed without deriving a target or performing a full editor save=${ metrics.empty_saved_content_fails_closed }.`
			},
			{
				id: 'core-data-editor-store-coherence-before-dependent-operation',
				status: targetCase !== 'store-coherence' || metrics.store_coherence_before_dependent_operation ? 'pass' : 'fail',
				message: `Block-editor, editor, and core-data stores contained the repaired first note before the dependent operation=${ metrics.store_coherence_before_dependent_operation }.`
			},
			{
				id: 'seeded-repair-sync-race-converges',
				status: targetCase !== 'repair-sync-race' || metrics.repair_sync_race_converged ? 'pass' : 'fail',
				message: `Seeded targeted-repair/editor-save ordering converged with all note IDs=${ metrics.repair_sync_race_converged }.`
			},
			{
				id: 'crdt-peer-lineage-reloads-without-duplicates',
				status: targetCase !== 'crdt-peer-lineage' || metrics.crdt_peer_lineage_stable ? 'pass' : 'fail',
				message: `Second same-origin editor peer retained one attachment without duplicate blocks or text=${ metrics.crdt_peer_lineage_stable }.`
			},
			{
				id: 'page-errors-recorded',
				status: noPageErrors ? 'pass' : 'fail',
				message: `Recorded ${ pageErrors.length } page errors.`
			},
		],
		artifacts: [
			{ label: 'WP Codebox output', path: relativeArtifactPath( outputFile ) },
			{ label: 'Notes attachment metrics', path: relativeArtifactPath( metricsPath ) },
			{ label: 'Notes attachment metadata', path: relativeArtifactPath( metadataPath ) },
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
