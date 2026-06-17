import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire( import.meta.url );
const { runWpCodeboxRecipe } = require( 'homeboy-extension-wordpress/wp-codebox-recipe-helper' );

const componentPath = process.env.HOMEBOY_COMPONENT_PATH;
const componentId = process.env.HOMEBOY_COMPONENT_ID || 'gutenberg';
const scenarioId = process.env.HOMEBOY_TRACE_SCENARIO || 'pattern-preview-assets';
const resultsFile = process.env.HOMEBOY_TRACE_RESULTS_FILE;
const artifactDir = process.env.HOMEBOY_TRACE_ARTIFACT_DIR || path.join( tmpdir(), 'gutenberg-pattern-preview-assets-artifacts' );
const wpVersion = process.env.HOMEBOY_GUTENBERG_PATTERN_ASSETS_WP_VERSION || '7.0';
const blockCount = Number.parseInt( process.env.HOMEBOY_GUTENBERG_PATTERN_ASSETS_BLOCK_COUNT || '6', 10 );
const patternCount = Number.parseInt( process.env.HOMEBOY_GUTENBERG_PATTERN_ASSETS_PATTERN_COUNT || '12', 10 );
const probeDuration = process.env.HOMEBOY_GUTENBERG_PATTERN_ASSETS_PROBE_DURATION || '12s';
const viewport = process.env.HOMEBOY_GUTENBERG_PATTERN_ASSETS_VIEWPORT || '1366x900';
const readinessTimeoutMs = Number.parseInt( process.env.HOMEBOY_GUTENBERG_PATTERN_ASSETS_READINESS_TIMEOUT_MS || '12000', 10 );
const assetDelayMs = Number.parseInt( process.env.HOMEBOY_GUTENBERG_PATTERN_ASSETS_ASSET_DELAY_MS || '0', 10 );
const serializeAssetDelay = [ '1', 'true', 'yes' ].includes(
	( process.env.HOMEBOY_GUTENBERG_PATTERN_ASSETS_SERIALIZE_DELAY || '' ).toLowerCase()
);

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

const workDir = await mkdtemp( path.join( tmpdir(), 'gutenberg-pattern-preview-assets.' ) );
const fixturePluginDir = path.join( workDir, 'gutenberg-pattern-asset-repro' );
const fixtureAssetsDir = path.join( fixturePluginDir, 'assets' );
const recipeFile = path.join( workDir, 'recipe.json' );
const outputFile = path.join( artifactDir, 'wp-codebox-output.json' );
const codeboxArtifacts = path.join( artifactDir, 'wp-codebox-artifacts' );
const metricsPath = path.join( artifactDir, 'pattern-preview-assets-metrics.json' );
const metadataPath = path.join( artifactDir, 'pattern-preview-assets-metadata.json' );
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

function assetUrlKey( url ) {
	try {
		const parsed = new URL( url );
		parsed.searchParams.delete( 'ver' );
		return `${ parsed.pathname }${ parsed.search }`;
	} catch {
		return url;
	}
}

async function writeFixturePlugin() {
	await mkdir( fixtureAssetsDir, { recursive: true } );
	if ( assetDelayMs > 0 ) {
		await writeFile(
			path.join( fixturePluginDir, 'asset.php' ),
			`<?php
$type  = isset( $_GET['type'] ) ? preg_replace( '/[^a-z]/', '', $_GET['type'] ) : 'css';
$index = isset( $_GET['index'] ) ? max( 1, (int) $_GET['index'] ) : 1;
${ serializeAssetDelay ? `$lock = fopen( sys_get_temp_dir() . '/gutenberg-pattern-asset-repro.lock', 'c' );
if ( $lock ) {
	flock( $lock, LOCK_EX );
}
` : '' }usleep( ${ assetDelayMs } * 1000 );
${ serializeAssetDelay ? `if ( isset( $lock ) && $lock ) {
	flock( $lock, LOCK_UN );
	fclose( $lock );
}
` : '' }

if ( 'js' === $type ) {
	header( 'Content-Type: application/javascript; charset=UTF-8' );
	printf(
		"window.__gutenbergPatternAssetRepro = window.__gutenbergPatternAssetRepro || []; window.__gutenbergPatternAssetRepro.push('pattern-asset-%d');\n",
		$index
	);
	exit;
}

header( 'Content-Type: text/css; charset=UTF-8' );
printf(
	'.wp-block-gutenberg-pattern-asset-repro-pattern-asset-%1$d{border:%1$dpx solid rgba(0,0,0,.15);padding:8px;margin:4px;background:#fff}' . "\n",
	$index
);
`
		);
	}

	let plugin = `<?php
/**
 * Plugin Name: Gutenberg Pattern Preview Asset Repro Fixture
 */

add_action(
	'init',
	function () {
`;

	for ( let index = 1; index <= blockCount; index += 1 ) {
		const slug = `pattern-asset-${ index }`;
		const scriptHandle = `gutenberg-pattern-asset-repro-script-${ index }`;
		const styleHandle = `gutenberg-pattern-asset-repro-style-${ index }`;
		const scriptUrl = assetDelayMs > 0
			? `plugins_url( 'asset.php?type=js&index=${ index }', __FILE__ )`
			: `plugins_url( 'assets/${ slug }.js', __FILE__ )`;
		const styleUrl = assetDelayMs > 0
			? `plugins_url( 'asset.php?type=css&index=${ index }', __FILE__ )`
			: `plugins_url( 'assets/${ slug }.css', __FILE__ )`;
		await writeFile(
			path.join( fixtureAssetsDir, `${ slug }.js` ),
			`window.__gutenbergPatternAssetRepro = window.__gutenbergPatternAssetRepro || []; window.__gutenbergPatternAssetRepro.push('${ slug }');\n`
		);
		await writeFile(
			path.join( fixtureAssetsDir, `${ slug }.css` ),
			`.wp-block-gutenberg-pattern-asset-repro-${ slug }{border:${ index }px solid rgba(0,0,0,.15);padding:8px;margin:4px;background:#fff}\n`
		);

		plugin += `
		wp_register_script(
			'${ scriptHandle }',
			${ scriptUrl },
			array(),
			'1.0.0',
			true
		);
		wp_register_style(
			'${ styleHandle }',
			${ styleUrl },
			array(),
			'1.0.0'
		);
		register_block_type(
			'gutenberg-pattern-asset-repro/${ slug }',
			array(
				'api_version'     => 3,
				'title'           => 'Pattern Asset Repro ${ index }',
				'category'        => 'widgets',
				'editor_script'   => '${ scriptHandle }',
				'editor_style'    => '${ styleHandle }',
				'render_callback' => function () {
					return '<div class="wp-block-gutenberg-pattern-asset-repro-${ slug }">Pattern Asset Repro ${ index }</div>';
				},
			)
		);
`;
	}

	plugin += `
		register_block_pattern_category(
			'gutenberg-pattern-asset-repro',
			array( 'label' => 'Pattern Asset Repro' )
		);
`;

	for ( let patternIndex = 1; patternIndex <= patternCount; patternIndex += 1 ) {
		let content = '';
		for ( let blockIndex = 1; blockIndex <= blockCount; blockIndex += 1 ) {
			content += `<!-- wp:gutenberg-pattern-asset-repro/pattern-asset-${ blockIndex } /-->`;
		}
		plugin += `
		register_block_pattern(
			'gutenberg-pattern-asset-repro/pattern-${ patternIndex }',
			array(
				'title'      => 'Pattern Asset Repro ${ patternIndex }',
				'categories' => array( 'gutenberg-pattern-asset-repro' ),
				'content'    => '${ content }',
			)
		);
`;
	}

	plugin += `
	}
);
`;

	await writeFile( path.join( fixturePluginDir, 'pattern-assets-repro.php' ), plugin );
}

const browserScript = `
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const expectedPatterns = ${ patternCount };
const readinessTimeoutMs = ${ readinessTimeoutMs };
const visible = (element) => {
	if (!element) return false;
	const style = getComputedStyle(element);
	const rect = element.getBoundingClientRect();
	return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
};
const byText = (selector, text) => Array.from(document.querySelectorAll(selector)).find((node) => visible(node) && (node.textContent || '').trim().includes(text));
const fixtureAssetPattern = new RegExp('gutenberg-pattern-asset-repro/(assets/.+\\\\.(js|css)|asset\\\\.php)(\\\\?|$)');
const timing = {
	startedAt: performance.now(),
	longTasksSupported: false,
	longTasks: [],
};
try {
	const observer = new PerformanceObserver((list) => {
		for (const entry of list.getEntries()) {
			timing.longTasks.push({ startTime: entry.startTime, duration: entry.duration, name: entry.name });
		}
	});
	observer.observe({ entryTypes: ['longtask'] });
	timing.longTasksSupported = true;
} catch (error) {
	timing.longTasksSupported = false;
}
const mark = (name) => {
	if (timing[name] === undefined) {
		timing[name] = performance.now() - timing.startedAt;
		try {
			performance.mark('gutenberg-pattern-preview:' + name);
		} catch (error) {}
	}
};
const resourceSnapshot = () => Array.from(performance.getEntriesByType('resource')).map((entry) => entry.name).filter(Boolean);
const beforeResourceUrls = resourceSnapshot();
const clickFirst = async (selectors) => {
	for (const selector of selectors) {
		const node = Array.from(document.querySelectorAll(selector)).find(visible);
		if (node) {
			mark('inserterClickStartMs');
			node.click();
			mark('inserterClickEndMs');
			await sleep(500);
			return selector;
		}
	}
	return null;
};
const previewFrames = () => Array.from(document.querySelectorAll('.block-editor-block-preview__content iframe, iframe.block-editor-block-preview__content-iframe'));
const previewItems = () => document.querySelectorAll('.block-editor-block-patterns-list__item').length;
const frameBodyReady = (frame) => {
	try {
		const body = frame.contentDocument?.body;
		return !!body && body.children.length > 0 && body.getBoundingClientRect().height > 0;
	} catch (error) {
		return false;
	}
};
const frameStylesReady = (frame) => {
	try {
		const doc = frame.contentDocument;
		const links = Array.from(doc?.querySelectorAll('link[href*="gutenberg-pattern-asset-repro/"]') || []);
		const inlineStyles = doc?.querySelectorAll('style[data-wp-inline-stylesheet*="gutenberg-pattern-asset-repro/"], style[id^="gutenberg-pattern-asset-repro-style-"]') || [];
		if (inlineStyles.length > 0) return true;
		return links.length > 0 && links.every((link) => !!link.sheet);
	} catch (error) {
		return false;
	}
};
const waitForPreviewReadiness = async () => {
	const deadline = performance.now() + readinessTimeoutMs;
	let state = {};
	while (performance.now() < deadline) {
		const frames = previewFrames();
		const items = previewItems();
		if (items > 0) {
			mark('firstPreviewItemMs');
		}
		if (frames.length > 0) {
			mark('firstPreviewIframeMs');
		}
		if (items >= expectedPatterns) {
			mark('allPreviewItemsMs');
		}
		if (frames.length >= expectedPatterns) {
			mark('allPreviewIframesMs');
		}
		const expectedFrames = frames.slice(0, expectedPatterns);
		const bodiesReady = expectedFrames.length >= expectedPatterns && expectedFrames.every(frameBodyReady);
		const stylesReady = expectedFrames.length >= expectedPatterns && expectedFrames.every(frameStylesReady);
		if (bodiesReady) {
			mark('previewBodiesReadyMs');
		}
		if (stylesReady) {
			mark('previewStylesReadyMs');
		}
		state = { items, frames: frames.length, bodiesReady, stylesReady };
		if (items >= expectedPatterns && frames.length >= expectedPatterns && bodiesReady && stylesReady) {
			mark('previewReadyMs');
			return { ready: true, ...state };
		}
		await sleep(100);
	}
	return { ready: false, ...state };
};

await sleep(1500);
const inserterSelector = await clickFirst([
	'button[aria-label="Toggle block inserter"]',
	'button[aria-label="Add block"]',
	'button[aria-label="Inserter"]',
	'.edit-post-header-toolbar__inserter-toggle button',
	'.block-editor-inserter__toggle',
]);

let patternsClicked = false;
for (let attempt = 0; attempt < 20; attempt += 1) {
	if (previewItems() > 0 || previewFrames().length > 0) {
		break;
	}
	const tab = byText('[role="tab"], button', 'Patterns');
	if (tab) {
		tab.click();
		patternsClicked = true;
		break;
	}
	await sleep(250);
}

let categoryClicked = false;
for (let attempt = 0; attempt < 20; attempt += 1) {
	if (previewItems() > 0 || previewFrames().length > 0) {
		break;
	}
	const category = byText('button, [role="button"], [role="option"]', 'Pattern Asset Repro');
	if (category) {
		category.click();
		categoryClicked = true;
		break;
	}
	await sleep(250);
}

const readiness = await waitForPreviewReadiness();
const afterResourceUrls = resourceSnapshot();
const beforeResources = new Set(beforeResourceUrls);
const newResourceUrls = afterResourceUrls.filter((url) => !beforeResources.has(url));
mark('measurementCompleteMs');

const resourceUrlsForWindow = (win) => {
	try {
		return Array.from(win.performance.getEntriesByType('resource')).map((entry) => ({
			name: entry.name,
			initiatorType: entry.initiatorType || '',
			transferSize: entry.transferSize || 0,
		}));
	} catch (error) {
		return [];
	}
};
const resourceEntries = resourceUrlsForWindow(window);
const iframeHeadSnapshots = [];
for (const frame of document.querySelectorAll('iframe')) {
	if (frame.contentWindow) {
		const iframeResources = resourceUrlsForWindow(frame.contentWindow);
		resourceEntries.push(...iframeResources);
		try {
			iframeHeadSnapshots.push({
				className: frame.className || '',
				src: frame.getAttribute('src') || '',
				links: Array.from(frame.contentDocument.querySelectorAll('link[href]')).map((node) => ({
					rel: node.getAttribute('rel') || '',
					href: node.href || node.getAttribute('href') || '',
					id: node.id || '',
				})),
				styles: Array.from(frame.contentDocument.querySelectorAll('style')).map((node) => ({
					id: node.id || '',
					attributes: Array.from(node.attributes).map((attribute) => [attribute.name, attribute.value]),
					textSample: (node.textContent || '').slice(0, 500),
				})),
				fixtureResources: iframeResources.filter((entry) => fixtureAssetPattern.test(entry.name)).slice(0, 40),
			});
		} catch (error) {
			iframeHeadSnapshots.push({ error: String(error) });
		}
	}
}

return {
	title: document.title,
	inserterSelector,
	patternsClicked,
	categoryClicked,
	patternItems: document.querySelectorAll('.block-editor-block-patterns-list__item').length,
	previewIframes: document.querySelectorAll('.block-editor-block-preview__content iframe, iframe.block-editor-block-preview__content-iframe').length,
	allIframes: document.querySelectorAll('iframe').length,
	fixtureScriptsExecuted: window.__gutenbergPatternAssetRepro || [],
	readiness,
	timing: {
		...timing,
		longTaskCount: timing.longTasks.length,
		longTaskTotalMs: timing.longTasks.reduce((total, entry) => total + entry.duration, 0),
		newResourceCount: newResourceUrls.length,
		newFixtureResourceCount: newResourceUrls.filter((url) => fixtureAssetPattern.test(url)).length,
	},
	iframeHeadSnapshots,
	fixtureResourceEntries: resourceEntries.filter((entry) => fixtureAssetPattern.test(entry.name)).slice(0, 200),
	resourceUrls: resourceEntries.map((entry) => entry.name).filter(Boolean),
	resourceCount: resourceEntries.length,
	transferSizeBytes: resourceEntries.reduce((total, entry) => total + (entry.transferSize || 0), 0),
	jsHeapUsedSize: performance.memory?.usedJSHeapSize || null,
};
`;

try {
	event( 'scenario', 'start', {
		component_path: componentPath,
		block_count: blockCount,
		pattern_count: patternCount,
		wp_version: wpVersion,
	} );

	await writeFixturePlugin();

	const recipe = {
		schema: 'wp-codebox/workspace-recipe/v1',
		runtime: {
			wp: wpVersion,
			blueprint: {
				steps: [
					{ step: 'activatePlugin', pluginPath: '/wordpress/wp-content/plugins/gutenberg/gutenberg.php' },
					{ step: 'activatePlugin', pluginPath: '/wordpress/wp-content/plugins/gutenberg-pattern-asset-repro/pattern-assets-repro.php' },
					{ step: 'login', username: 'admin', password: 'password' },
				],
			},
		},
		inputs: {
			extraPlugins: [
				{ source: componentPath, slug: 'gutenberg', pluginFile: 'gutenberg/gutenberg.php', activate: true },
				{ source: fixturePluginDir, slug: 'gutenberg-pattern-asset-repro', pluginFile: 'gutenberg-pattern-asset-repro/pattern-assets-repro.php', activate: true },
			],
		},
		workflow: {
			steps: [
				{
					command: 'wordpress.browser-probe',
					args: [
						'url=/wp-admin/post-new.php?post_type=page',
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
		maxBuffer: 1024 * 1024 * 50,
	} );

	const output = result.json || JSON.parse( result.stdout );
	const bundleDir = output.artifacts?.directory;
	const browserDir = bundleDir ? path.join( bundleDir, 'files', 'browser' ) : '';
	const networkPath = browserDir ? path.join( browserDir, 'network.jsonl' ) : '';
	const summaryPath = browserDir ? path.join( browserDir, 'summary.json' ) : '';
	const performancePath = browserDir ? path.join( browserDir, 'performance.json' ) : '';
	const errorsPath = browserDir ? path.join( browserDir, 'errors.jsonl' ) : '';
	const network = await readJsonl( networkPath );
	const summary = await readJsonAsync( summaryPath );
	const performanceSummary = await readJsonAsync( performancePath );
	const pageErrors = await readJsonl( errorsPath );
	const responses = network.filter( ( entry ) => entry.type === 'response' );
	const scriptResult = summary?.summary?.scriptResult || summary?.scriptResult || {};
	const requestUrls = responses.length > 0
		? responses.map( ( entry ) => entry.url || entry.request?.url || '' ).filter( Boolean )
		: Array.isArray( scriptResult.resourceUrls ) ? scriptResult.resourceUrls.filter( Boolean ) : [];
	const fixtureAssetUrls = requestUrls.filter( ( url ) => /gutenberg-pattern-asset-repro\/(assets\/.+\.(js|css)|asset\.php)(\?|$)/.test( url ) );
	const counts = new Map();

	for ( const url of fixtureAssetUrls ) {
		const key = assetUrlKey( url );
		counts.set( key, ( counts.get( key ) || 0 ) + 1 );
	}

	const duplicateFixtureAssets = Array.from( counts.entries() )
		.filter( ( [ , count ] ) => count > 1 )
		.map( ( [ asset, count ] ) => ( { asset, count } ) );
	const browserMetrics = summary?.summary?.metrics ?? {};
	const cdpMetrics = performanceSummary?.final?.cdpMetrics ?? {};

	event( 'browser', 'probe.ready', {
		total_responses: responses.length,
		fixture_asset_responses: fixtureAssetUrls.length,
	} );

	const metrics = {
		block_count: blockCount,
		pattern_count: patternCount,
		preview_ready: scriptResult.readiness?.ready ?? null,
		preview_ready_ms: scriptResult.timing?.previewReadyMs ?? null,
		first_preview_iframe_ms: scriptResult.timing?.firstPreviewIframeMs ?? null,
		all_preview_iframes_ms: scriptResult.timing?.allPreviewIframesMs ?? null,
		preview_bodies_ready_ms: scriptResult.timing?.previewBodiesReadyMs ?? null,
		preview_styles_ready_ms: scriptResult.timing?.previewStylesReadyMs ?? null,
		measurement_complete_ms: scriptResult.timing?.measurementCompleteMs ?? null,
		long_task_supported: scriptResult.timing?.longTasksSupported ?? null,
		long_task_count: scriptResult.timing?.longTaskCount ?? null,
		long_task_total_ms: scriptResult.timing?.longTaskTotalMs ?? null,
		new_resource_count: scriptResult.timing?.newResourceCount ?? null,
		new_fixture_resource_count: scriptResult.timing?.newFixtureResourceCount ?? null,
		network_response_count: responses.length,
		fixture_asset_response_count: fixtureAssetUrls.length,
		unique_fixture_asset_count: counts.size,
		duplicate_fixture_asset_count: duplicateFixtureAssets.length,
		max_duplicate_count: duplicateFixtureAssets.reduce( ( max, entry ) => Math.max( max, entry.count ), 0 ),
		page_error_count: pageErrors.length,
		browser_iframe_count: browserMetrics.browser_iframe_count ?? scriptResult.allIframes ?? null,
		browser_resource_count: browserMetrics.browser_resource_count ?? performanceSummary?.summary?.resources ?? scriptResult.resourceCount ?? null,
		browser_transfer_size_bytes: browserMetrics.browser_transfer_size_bytes ?? performanceSummary?.summary?.transferSizeBytes ?? scriptResult.transferSizeBytes ?? null,
		browser_web_frame_count: browserMetrics.browser_web_frame_count ?? performanceSummary?.final?.web?.frames?.total ?? null,
		browser_web_accessible_frame_count: browserMetrics.browser_web_accessible_frame_count ?? performanceSummary?.final?.web?.frames?.accessible ?? null,
		browser_web_resource_count: browserMetrics.browser_web_resource_count ?? performanceSummary?.final?.web?.resources?.count ?? null,
		browser_web_transfer_size_bytes: browserMetrics.browser_web_transfer_size_bytes ?? performanceSummary?.final?.web?.resources?.transferSizeBytes ?? null,
		browser_web_mark_count: browserMetrics.browser_web_mark_count ?? performanceSummary?.final?.web?.marks?.length ?? null,
		browser_web_long_task_count: browserMetrics.browser_web_long_task_count ?? performanceSummary?.final?.web?.longTasks?.count ?? null,
		browser_web_long_task_total_ms: browserMetrics.browser_web_long_task_total_ms ?? performanceSummary?.final?.web?.longTasks?.totalDurationMs ?? null,
		browser_long_task_count: browserMetrics.browser_long_task_count ?? performanceSummary?.final?.longTasks?.count ?? null,
		browser_long_task_total_ms: browserMetrics.browser_long_task_total_ms ?? performanceSummary?.final?.longTasks?.totalDurationMs ?? null,
		browser_final_used_js_heap_bytes: browserMetrics.browser_final_used_js_heap_bytes ?? cdpMetrics.JSHeapUsedSize ?? scriptResult.jsHeapUsedSize ?? null,
		pattern_preview_items: scriptResult.patternItems ?? null,
		pattern_preview_iframes: scriptResult.previewIframes ?? null,
		fixture_scripts_executed_count: Array.isArray( scriptResult.fixtureScriptsExecuted ) ? scriptResult.fixtureScriptsExecuted.length : 0,
	};

	await writeFile( metricsPath, `${ JSON.stringify( metrics, null, 2 ) }\n` );
	await writeFile(
		metadataPath,
		`${ JSON.stringify(
			{
				final_url: summary?.summary?.finalUrl || summary?.finalUrl || null,
				scenario: {
					id: scenarioId,
					description: 'Pattern preview asset fan-out repro for WordPress/gutenberg#68979.',
				},
				fixture: {
					block_count: blockCount,
					pattern_count: patternCount,
				},
				duplicate_fixture_assets: duplicateFixtureAssets,
				fixture_asset_urls_sample: fixtureAssetUrls.slice( 0, 50 ),
				page_errors_sample: pageErrors.slice( 0, 20 ),
				browser_script_result: scriptResult,
			},
			null,
			2
		) }\n`
	);
	event( 'pattern-assets', 'metrics.ready', metrics );

	const patternPreviewsRendered = metrics.pattern_preview_items >= patternCount && metrics.pattern_preview_iframes >= patternCount;
	const duplicateFanOutObserved = metrics.fixture_asset_response_count > metrics.unique_fixture_asset_count && metrics.max_duplicate_count > 1;
	const pass = patternPreviewsRendered && duplicateFanOutObserved;
	const traceResult = {
		component_id: componentId,
		scenario_id: scenarioId,
		status: pass ? 'pass' : 'fail',
		summary: pass
			? `Captured duplicated pattern-preview fixture asset requests: ${ metrics.fixture_asset_response_count } responses for ${ metrics.unique_fixture_asset_count } unique fixture assets, max duplicate count ${ metrics.max_duplicate_count }.`
			: 'Pattern preview asset fan-out was not observed.',
		timeline,
		assertions: [
			{
				id: 'pattern-previews-rendered',
				status: patternPreviewsRendered ? 'pass' : 'fail',
				message: `Observed ${ metrics.pattern_preview_items } pattern preview item(s) and ${ metrics.pattern_preview_iframes } pattern preview iframe(s) for ${ patternCount } registered fixture patterns. Patterns tab clicked=${ scriptResult.patternsClicked === true }, fixture category clicked=${ scriptResult.categoryClicked === true }.`
			},
			{
				id: 'fixture-assets-observed',
				status: metrics.fixture_asset_response_count > 0 ? 'pass' : 'fail',
				message: `Observed ${ metrics.fixture_asset_response_count } fixture asset responses.`
			},
			{
				id: 'duplicate-fixture-assets-observed',
				status: duplicateFanOutObserved ? 'pass' : 'fail',
				message: `Observed ${ metrics.fixture_asset_response_count } fixture asset responses for ${ metrics.unique_fixture_asset_count } unique fixture assets; max duplicate count ${ metrics.max_duplicate_count }.`
			},
			{
				id: 'page-errors-recorded',
				status: 'pass',
				message: `Recorded ${ pageErrors.length } page errors.`
			},
		],
		artifacts: [
			{ label: 'WP Codebox output', path: relativeArtifactPath( outputFile ) },
			{ label: 'Pattern preview asset metrics', path: relativeArtifactPath( metricsPath ) },
			{ label: 'Pattern preview asset metadata', path: relativeArtifactPath( metadataPath ) },
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
