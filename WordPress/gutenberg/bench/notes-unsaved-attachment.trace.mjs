import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify( execFile );

const componentPath = process.env.HOMEBOY_COMPONENT_PATH;
const componentId = process.env.HOMEBOY_COMPONENT_ID || 'gutenberg';
const scenarioId = process.env.HOMEBOY_TRACE_SCENARIO || 'notes-unsaved-attachment';
const resultsFile = process.env.HOMEBOY_TRACE_RESULTS_FILE;
const artifactDir = process.env.HOMEBOY_TRACE_ARTIFACT_DIR || path.join( tmpdir(), 'gutenberg-notes-unsaved-attachment-artifacts' );
const wpCodeboxBin = process.env.HOMEBOY_WP_CODEBOX_BIN || process.env.HOMEBOY_SETTINGS_WP_CODEBOX_BIN || path.join( process.env.HOME || '', 'Developer/wp-codebox/packages/cli/dist/index.js' );
const wpVersion = process.env.HOMEBOY_GUTENBERG_NOTES_WP_VERSION || process.env.HOMEBOY_SETTINGS_GUTENBERG_NOTES_WP_VERSION || '7.0';
const targetCase = process.env.HOMEBOY_GUTENBERG_NOTES_CASE || process.env.HOMEBOY_SETTINGS_GUTENBERG_NOTES_CASE || 'orphan';
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

function wpCodeboxCommand() {
	if ( wpCodeboxBin.endsWith( '.js' ) || wpCodeboxBin.endsWith( '.cjs' ) || wpCodeboxBin.endsWith( '.mjs' ) ) {
		return { command: 'node', args: [ wpCodeboxBin ] };
	}

	return { command: wpCodeboxBin, args: [] };
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

	$autosave_post_id = homeboy_gutenberg_notes_create_post( 'homeboy-notes-autosave-anchor', 'Homeboy Notes Autosave Anchor' );
	$autosave_note_id = homeboy_gutenberg_notes_create_note( $autosave_post_id, 'Homeboy autosave anchor note' );
	wp_create_post_autosave(
		array(
			'post_ID'      => $autosave_post_id,
			'post_title'   => 'Homeboy Notes Autosave Anchor',
			'post_content' => homeboy_gutenberg_notes_content( $autosave_note_id ),
			'post_author'  => 1,
		)
	);

	$live_post_id       = homeboy_gutenberg_notes_create_post( 'homeboy-notes-live-create', 'Homeboy Notes Live Create' );
	$dirty_live_post_id = homeboy_gutenberg_notes_create_post( 'homeboy-notes-dirty-live-create', 'Homeboy Notes Dirty Live Create' );

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
		'autosave-anchor' => array(
			'post_id' => $autosave_post_id,
			'note_id' => $autosave_note_id,
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
const stateResponse = await fetch('/wp-json/homeboy-gutenberg-notes/v1/state', { credentials: 'include' });
const fixtureState = await stateResponse.json();
const currentCase = new URL(location.href).searchParams.get('homeboy_notes_case') || targetCase;
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
const findButtonByText = (text) => Array.from(document.querySelectorAll('button')).find((button) => (button.textContent || '').trim() === text);
const isVisible = (node) => {
	const rect = node?.getBoundingClientRect?.();
	return !!rect && rect.width > 0 && rect.height > 0;
};
const findMenuItemByText = (text) => Array.from(document.querySelectorAll('[role="menuitem"], button')).find((node) => (node.textContent || '').trim().startsWith(text) && isVisible(node));
const setFieldValue = (field, value) => {
	const prototype = field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
	const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
	if (setter) {
		setter.call(field, value);
	} else {
		field.value = value;
	}
	field.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
	field.dispatchEvent(new Event('change', { bubbles: true }));
};
const flattenBlocks = (blocks) => blocks.flatMap((block) => [block, ...flattenBlocks(block.innerBlocks || [])]);
const getBlockNoteIds = () => flattenBlocks(window.wp.data.select('core/block-editor').getBlocks()).flatMap((block) => {
	const noteId = block?.attributes?.metadata?.noteId;
	return Array.isArray(noteId) ? noteId : noteId ? [noteId] : [];
}).map((value) => Number(value)).filter((value) => Number.isFinite(value));
const getPostContent = async (postId) => {
	if (window.wp?.apiFetch) {
		const post = await window.wp.apiFetch({ path: '/wp/v2/posts/' + encodeURIComponent(postId) + '?context=edit' });
		return post.content?.raw || post.content?.rendered || '';
	}
	const response = await fetch('/wp-json/wp/v2/posts/' + encodeURIComponent(postId), { credentials: 'include' });
	if (!response.ok) {
		throw new Error('Failed to fetch post: HTTP ' + response.status);
	}
	const post = await response.json();
	return post.content?.raw || post.content?.rendered || '';
};
const contentHasNoteId = (content, noteId) => {
	const noteIdIndex = content.indexOf('"noteId"');
	return noteIdIndex !== -1 && content.slice(noteIdIndex, noteIdIndex + 120).includes(String(noteId));
};
const waitForEditorReady = async (label) => {
	await waitFor(() => document.body && document.body.classList.contains('block-editor-page'), 'editor shell for ' + label);
	await waitFor(() => document.body.textContent.includes('Homeboy note anchor target'), 'editor content for ' + label);
	await waitFor(() => window.wp?.data?.select('core/block-editor')?.getBlocks, 'block editor data store for ' + label);
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
	const hasAutosaveNotice = /backup of this post|autosave of this post|more recent than the version below/i.test(bodyText);
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
		hasAutosaveNotice,
		passed: item.expected_orphan ? logicalOrphan : blockHasNoteId,
	};
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
	const block = await waitFor(() => window.wp.data.select('core/block-editor').getBlocks()[0], 'first block for ' + caseId);
	if (caseId === 'dirty-live-create') {
		window.wp.data.dispatch('core/block-editor').updateBlockAttributes(block.clientId, { content: dirtyText });
		await waitFor(() => window.wp.data.select('core/editor').isEditedPostDirty?.(), 'dirty editor state before note create');
	}
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
	const findNewNoteField = () => Array.from(document.querySelectorAll('textarea, input[type="text"]')).find(isVisible);
	if (!findNewNoteField()) {
		const toolbarButtons = Array.from(document.querySelectorAll('.block-editor-block-toolbar button, .block-editor-block-contextual-toolbar button')).filter(isVisible);
		const optionsButton = toolbarButtons.sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left).at(-1);
		if (!optionsButton) {
			throw new Error('Could not find block toolbar options button; toolbar buttons=' + toolbarButtons.map((button) => button.getAttribute('aria-label') || button.textContent || '').join(', '));
		}
		optionsButton.click();
		const addNoteMenuItem = await waitFor(() => findMenuItemByText('Add note'), 'Add note menu item');
		addNoteMenuItem.click();
	}
	const textarea = await waitFor(findNewNoteField, 'new note textarea');
	textarea.focus();
	setFieldValue(textarea, 'Homeboy live note');
	await sleep(250);
	const addButton = await waitFor(() => findButtonByText('Add note'), 'Add note button');
	addButton.click();
	await waitFor(() => document.body.textContent.includes('Homeboy live note'), 'created live note thread');
	const noteId = await waitFor(() => getBlockNoteIds().at(-1), 'live note id in edited block metadata');
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
	let persistedHasDirtyText = persistedContent.includes(dirtyText);
	try {
		persistedHasNoteId = await waitFor(async () => {
			persistedContent = await getPostContent(item.post_id);
			persistedHasDirtyText = persistedContent.includes(dirtyText);
			return contentHasNoteId(persistedContent, noteId);
		}, 'persisted post_content noteId after live note create');
	} catch (error) {}
	const collected = await collectBlockAttachment(caseId, { ...item, note_id: noteId }, noteId);
	const dirtyCasePassed = caseId !== 'dirty-live-create' || !persistedHasDirtyText;
	return {
		...collected,
		blockHasPersistedNoteId: persistedHasNoteId,
		logicalOrphan: !persistedHasNoteId,
		passed: persistedHasNoteId && dirtyCasePassed,
		saveSettled,
		persistedHasDirtyText,
		persistedContentSample: persistedContent.slice(0, 500),
	};
};
const collectCase = async (caseId) => {
	const item = fixtureState[caseId];
	if (!item) {
		throw new Error('Missing fixture case ' + caseId);
	}
	if (caseId === 'live-create' || caseId === 'dirty-live-create') {
		return collectLiveCreateCase(caseId);
	}
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

	event( 'wp_codebox', 'recipe.start', { recipe_file: recipeFile } );
	const { command, args } = wpCodeboxCommand();
	const result = await execFileAsync( command, [ ...args, 'recipe-run', '--recipe', recipeFile, '--artifacts', codeboxArtifacts, '--json' ], {
		maxBuffer: 1024 * 1024 * 50,
	} );
	await writeFile( outputFile, result.stdout );

	const output = JSON.parse( result.stdout );
	const bundleDir = output.artifacts?.directory;
	const browserDir = bundleDir ? path.join( bundleDir, 'files', 'browser' ) : '';
	const summaryPath = browserDir ? path.join( browserDir, 'summary.json' ) : '';
	const errorsPath = browserDir ? path.join( browserDir, 'errors.jsonl' ) : '';
	const networkPath = browserDir ? path.join( browserDir, 'network.jsonl' ) : '';
	const performancePath = browserDir ? path.join( browserDir, 'performance.json' ) : '';
	const summary = await readJsonAsync( summaryPath );
	const pageErrors = await readJsonl( errorsPath );
	const network = await readJsonl( networkPath );
	const scriptResult = summary?.summary?.scriptResult || summary?.scriptResult || {};
	const caseResults = Array.isArray( scriptResult.results ) ? scriptResult.results : [];

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
		autosave_anchor_attached: caseResults.some( ( item ) => item.caseId === 'autosave-anchor' && item.blockHasNoteId === true ),
		autosave_notice_seen: caseResults.some( ( item ) => item.caseId === 'autosave-anchor' && item.hasAutosaveNotice === true ),
		page_error_count: pageErrors.length,
		network_response_count: network.filter( ( entry ) => entry.type === 'response' ).length,
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
	const pass = metrics.fail_count === 0 && metrics.case_count > 0 && noPageErrors;
	const traceResult = {
		component_id: componentId,
		scenario_id: scenarioId,
		status: pass ? 'pass' : 'fail',
		summary: `Captured Gutenberg note attachment matrix for ${ metrics.case_count } case(s): ${ metrics.pass_count } passed, ${ metrics.fail_count } failed. Orphan reproduced=${ metrics.orphan_reproduced }, saved anchor attached=${ metrics.saved_anchor_attached }, autosave anchor attached=${ metrics.autosave_anchor_attached }.` ,
		timeline,
		assertions: [
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
				id: 'autosave-anchor-attached',
				status: targetCase !== 'matrix' && targetCase !== 'autosave-anchor' ? 'pass' : metrics.autosave_anchor_attached ? 'pass' : 'fail',
				message: `Autosave content metadata.noteId attached note to block=${ metrics.autosave_anchor_attached }; autosave notice seen=${ metrics.autosave_notice_seen }.`
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
