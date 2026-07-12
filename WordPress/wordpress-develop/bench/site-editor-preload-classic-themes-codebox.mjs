import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildClassicThemePreloadRollUp,
  classifyPreloadHitWaste,
  formatClassicThemePreloadRollUpMarkdown,
  installSiteEditorPreloadCandidateSource,
  installSiteEditorPreloadCaptureSource,
} from '../../../Automattic/studio/bench/lib/site-editor-preload-harness.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const codeboxBin = process.env.HOMEBOY_WP_CODEBOX_BIN;
const browserHelper = process.env.HOMEBOY_NODEJS_BROWSER_BENCH_HELPER;
const artifactRoot = path.resolve(process.env.HOMEBOY_SITE_EDITOR_PRELOAD_ARTIFACTS || path.join(here, 'artifacts'));
const wpVersion = process.env.HOMEBOY_SITE_EDITOR_PRELOAD_WP_VERSION || 'trunk';
const holdSeconds = Number(process.env.HOMEBOY_SITE_EDITOR_PRELOAD_HOLD_SECONDS || 300);

if (!codeboxBin) throw new Error('HOMEBOY_WP_CODEBOX_BIN is required');
if (!browserHelper) throw new Error('HOMEBOY_NODEJS_BROWSER_BENCH_HELPER is required');
if (!existsSync(browserHelper)) throw new Error(`Browser helper does not exist: ${browserHelper}`);

const { runBrowserBench } = await import(browserHelper);

const scenarios = [
  { id: 'block', theme: 'twentytwentyfive', blockTemplateParts: false },
  { id: 'classic', theme: 'twentytwentyone', blockTemplateParts: false },
  { id: 'classic-btp', theme: 'twentytwentyone', blockTemplateParts: true },
];

const preloadCall = 'block_editor_rest_api_preload( $preload_paths, $block_editor_context );';

function phpQuote(value) {
  return `'${String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

function captureInsertion({ candidate, capturePath }) {
  const seed = `<?php\n${preloadCall}`;
  const withCandidate = candidate
    ? installSiteEditorPreloadCandidateSource(seed, { mode: 'pr-11766' })
    : seed;
  const transformed = installSiteEditorPreloadCaptureSource(withCandidate, { capturePath });
  return transformed.slice('<?php\n'.length, -preloadCall.length);
}

function blueprintSetupPhp({ scenario, candidate, capturePath, timingPath }) {
  const insertion = captureInsertion({ candidate, capturePath });
  const btpPlugin = scenario.blockTemplateParts
    ? "add_action( 'after_setup_theme', static function () { add_theme_support( 'block-template-parts' ); } );"
    : '';
  const observerPlugin = `<?php
add_action( 'rest_api_init', static function () {
	register_rest_route( 'homeboy-preload-evidence/v1', '/capture', array(
		'methods' => 'GET',
		'permission_callback' => static function () { return current_user_can( 'manage_options' ); },
		'callback' => static function () {
			$paths = file_exists( ${phpQuote(capturePath)} ) ? json_decode( file_get_contents( ${phpQuote(capturePath)} ), true ) : array();
			$timing = file_exists( ${phpQuote(timingPath)} ) ? json_decode( file_get_contents( ${phpQuote(timingPath)} ), true ) : null;
			return rest_ensure_response( array( 'paths' => is_array( $paths ) ? $paths : array(), 'timing' => $timing ) );
		},
	) );
	register_rest_route( 'homeboy-preload-evidence/v1', '/scenario', array(
		'methods' => 'GET',
		'permission_callback' => static function () { return current_user_can( 'manage_options' ); },
		'callback' => static function () {
			return rest_ensure_response( array( 'theme' => get_stylesheet(), 'theme_exists' => wp_get_theme()->exists(), 'is_block_theme' => wp_is_block_theme(), 'block_template_parts' => current_theme_supports( 'block-template-parts' ) ) );
		},
	) );
} );
add_action( 'shutdown', static function () {
	if ( false !== strpos( $_SERVER['SCRIPT_NAME'] ?? '', '/wp-admin/site-editor.php' ) ) {
		file_put_contents( ${phpQuote(timingPath)}, wp_json_encode( array( 'server_request_ms' => ( microtime( true ) - (float) $_SERVER['REQUEST_TIME_FLOAT'] ) * 1000 ) ) );
	}
} );
${btpPlugin}
`;
  return `<?php
$wp_load = '/wordpress/wp-load.php';
require_once $wp_load;
$site_editor = ABSPATH . 'wp-admin/site-editor.php';
$source = file_get_contents( $site_editor );
if ( false === strpos( $source, ${phpQuote(preloadCall)} ) ) {
	throw new RuntimeException( 'site-editor.php preload call not found' );
}
$insertion = <<<'HOMEBOY_PRELOAD_INSERTION'
${insertion}
HOMEBOY_PRELOAD_INSERTION;
file_put_contents( $site_editor, str_replace( ${phpQuote(preloadCall)}, $insertion . ${phpQuote(preloadCall)}, $source ) );
wp_mkdir_p( WP_CONTENT_DIR . '/mu-plugins' );
file_put_contents( WP_CONTENT_DIR . '/mu-plugins/homeboy-site-editor-preload-evidence.php', <<<'HOMEBOY_OBSERVER_PLUGIN'
${observerPlugin}
HOMEBOY_OBSERVER_PLUGIN
);
switch_theme( ${phpQuote(scenario.theme)} );
`;
}

async function availablePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

async function waitForSite(siteUrl, boot) {
  const deadline = Date.now() + 120000;
  let lastError = '';
  while (Date.now() < deadline) {
    if (boot.child.exitCode !== null) {
      throw new Error(`WP Codebox boot exited before readiness: ${boot.child.exitCode}\n${boot.output()}`);
    }
    try {
      const response = await fetch(`${siteUrl}/wp-login.php`, { redirect: 'manual' });
      if (response.status >= 200 && response.status < 500) return;
    } catch (error) {
      lastError = error.message;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Timed out waiting for WP Codebox at ${siteUrl}: ${lastError}`);
}

function startCodebox({ blueprintPath, runDir, port }) {
  const child = spawn(codeboxBin, [
    'boot',
    '--wp', wpVersion,
    '--blueprint', blueprintPath,
    '--artifacts', path.join(runDir, 'codebox'),
    '--preview-port', String(port),
    '--preview-bind', '127.0.0.1',
    '--preview-hold-seconds', String(holdSeconds),
    '--json',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  return { child, output: () => output };
}

async function stopCodebox(child) {
  if (child.exitCode !== null) return;
  child.kill('SIGTERM');
  await new Promise((resolve) => child.once('exit', resolve));
}

async function runVariant({ scenario, candidate, runDir }) {
  const capturePath = '/wordpress/wp-content/homeboy-preload-paths.json';
  const timingPath = '/wordpress/wp-content/homeboy-site-editor-timing.json';
  const blueprintPath = path.join(runDir, 'blueprint.json');
  await mkdir(runDir, { recursive: true });
  await writeFile(blueprintPath, `${JSON.stringify({ steps: [
    { step: 'login', username: 'admin', password: 'password' },
    { step: 'runPHP', code: blueprintSetupPhp({ scenario, candidate, capturePath, timingPath }) },
  ] }, null, 2)}\n`);

  const port = await availablePort();
  const siteUrl = `http://127.0.0.1:${port}`;
  const boot = startCodebox({ blueprintPath, runDir, port });
  try {
    await waitForSite(siteUrl, boot);
    let observer;
    let scenarioState;
    const browser = await runBrowserBench({
      id: `${scenario.id}-${candidate ? 'candidate' : 'baseline'}`,
      artifactsDir: path.join(runDir, 'browser'),
      trace: true,
      screenshot: true,
      action: async ({ page, mark }) => {
        await page.goto(`${siteUrl}/wp-login.php`, { waitUntil: 'domcontentloaded', timeout: 120000 });
        await page.locator('#user_login').fill('admin');
        await page.locator('#user_pass').fill('password');
        await Promise.all([
          page.waitForURL(/\/wp-admin\//, { timeout: 120000 }),
          page.locator('#wp-submit').click(),
        ]);
        await mark('logged_in');
        await page.goto(`${siteUrl}/wp-admin/site-editor.php`, { waitUntil: 'domcontentloaded', timeout: 120000 });
        await page.waitForLoadState('networkidle', { timeout: 120000 });
        await page.waitForTimeout(1500);
        await mark('site_editor_idle');
        observer = await page.evaluate(async () => {
          const response = await fetch('/wp-json/homeboy-preload-evidence/v1/capture');
          if (!response.ok) throw new Error(`capture endpoint returned ${response.status}`);
          return response.json();
        });
        scenarioState = await page.evaluate(async () => {
          const response = await fetch('/wp-json/homeboy-preload-evidence/v1/scenario');
          if (!response.ok) throw new Error(`scenario endpoint returned ${response.status}`);
          return response.json();
        });
      },
    });
    if (scenarioState.theme !== scenario.theme || !scenarioState.theme_exists) {
      throw new Error(`Theme setup failed for ${scenario.id}: ${JSON.stringify(scenarioState)}`);
    }
    if (Boolean(scenarioState.block_template_parts) !== scenario.blockTemplateParts) {
      throw new Error(`block-template-parts setup failed for ${scenario.id}: ${JSON.stringify(scenarioState)}`);
    }
    const siteEditorRequests = browser.network.filter((entry) => {
      const url = new URL(entry.url);
      return url.pathname === '/wp-admin/site-editor.php';
    });
    const siteEditorRequest = siteEditorRequests.at(-1);
    const clientFetches = browser.network.filter((entry) => ['fetch', 'xhr'].includes(entry.resource_type));
    const restNetworkRequests = clientFetches.filter((entry) => /\/wp-json\/wp\/v2\//.test(entry.url));
    const preloaded = Array.isArray(observer?.paths) ? observer.paths : [];
    const classification = classifyPreloadHitWaste({
      preloaded,
      networkRequests: clientFetches,
    });
    return {
      id: scenario.id,
      theme: scenarioState.theme,
      isBlockTheme: Boolean(scenarioState.is_block_theme),
      blockTemplateParts: scenario.blockTemplateParts,
      preloaded,
      classification,
      restNetworkCount: restNetworkRequests.length,
      measure: {
        status: siteEditorRequest?.status || 0,
        readyMs: browser.metrics.site_editor_idle_ms || 0,
        serverResponseMs: observer?.timing?.server_request_ms || 0,
      },
      clientFetches,
      restNetworkRequests,
      browserArtifacts: browser.artifacts,
    };
  } finally {
    await stopCodebox(boot.child);
  }
}

async function main() {
  const runId = `site-editor-preload-codebox-${Date.now()}`;
  const runRoot = path.join(artifactRoot, runId);
  await mkdir(runRoot, { recursive: true });
  try {
    const allScenarios = [];
    for (const scenario of scenarios) {
      const baseline = await runVariant({ scenario, candidate: false, runDir: path.join(runRoot, scenario.id, 'baseline') });
      const candidate = await runVariant({ scenario, candidate: true, runDir: path.join(runRoot, scenario.id, 'candidate') });
      const result = {
        id: scenario.id,
        theme: scenario.theme,
        isBlockTheme: candidate.isBlockTheme,
        blockTemplateParts: scenario.blockTemplateParts,
        baseline,
        candidate,
      };
      allScenarios.push(result);
      await writeFile(path.join(runRoot, `${scenario.id}.json`), `${JSON.stringify(result, null, 2)}\n`);
    }
    const rollUp = buildClassicThemePreloadRollUp(allScenarios);
    const markdown = formatRollUp(allScenarios, rollUp);
    await writeFile(path.join(runRoot, 'roll-up.md'), markdown);
    await writeFile(path.join(runRoot, 'result.json'), `${JSON.stringify({
      candidate_source: 'WordPress/wordpress-develop#11766 @ 360e7cbf02793323f9fa24fcbbea379a9ed7e4c9 (verbatim)',
      wp_version: wpVersion,
      scenarios: allScenarios,
      roll_up: rollUp,
      compact_roll_up_markdown: formatClassicThemePreloadRollUpMarkdown(rollUp),
    }, null, 2)}\n`);
    console.log(markdown);
  } finally {
    // Preserve all artifacts when a real Codebox/browser failure occurs.
  }
}

function formatRollUp(scenarioResults, rollUp) {
  const rollUpById = new Map(rollUp.map((row) => [row.scenario, row]));
  const lines = [
    '| scenario | preloaded | consumed | wasted | wasted paths | site-editor.php time baseline vs candidate | notes |',
    '| --- | ---: | ---: | ---: | --- | --- | --- |',
  ];
  for (const scenario of scenarioResults) {
    const row = rollUpById.get(scenario.id);
    const wastedPaths = scenario.candidate.classification.rows
      .filter((item) => !item.consumed)
      .map((item) => item.path)
      .join('<br>') || 'none';
    const timing = `${Math.round(scenario.baseline.measure.serverResponseMs)} ms vs ${Math.round(scenario.candidate.measure.serverResponseMs)} ms`;
    const notes = `${scenario.isBlockTheme ? 'block theme' : 'classic theme'}; REST requests baseline/candidate ${scenario.baseline.restNetworkCount}/${scenario.candidate.restNetworkCount}; browser idle ${row.baseline_measure_ms}/${row.candidate_measure_ms} ms`;
    lines.push(`| ${scenario.id} | ${row.candidate_preloaded} | ${row.candidate_consumed} | ${row.candidate_wasted} | ${wastedPaths} | ${timing} | ${notes} |`);
  }
  return `${lines.join('\n')}\n`;
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
