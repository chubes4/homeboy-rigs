import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  artifactDir as studioArtifactDir,
  createStudioSite,
  metric,
  parseStudioSiteStatus,
  redact,
  safeResult,
  stopStudioSite,
  studioSiteStatus,
  variant,
} from './lib/studio-bench.mjs';
import {
  SITE_EDITOR_PAGE_SPEC,
  loadWordPressPageProfiler,
  loadWordPressRequestProfiler,
  profileWordPressPage,
} from './lib/wordpress-page-profiler.mjs';

const BROWSER_HELPER = process.env.HOMEBOY_NODEJS_BROWSER_BENCH_HELPER;

if (!BROWSER_HELPER) {
  throw new Error('HOMEBOY_NODEJS_BROWSER_BENCH_HELPER is required');
}

const { runBrowserBench } = await import(BROWSER_HELPER);

const WESTON_PRELOAD_PATCH = `
// HOMEBOY_SITE_EDITOR_PRELOAD_DIAGNOSTICS: begin
$preload_paths[] = '/wp/v2/wp_pattern_category?context=view&per_page=100&_fields=id%2Cname%2Cdescription%2Cslug';
$preload_paths[] = '/wp/v2/taxonomies?context=edit&per_page=100';
$preload_paths[] = '/wp/v2/menus?context=view&per_page=100';
$preload_paths[] = '/wp/v2/pages?context=view&parent=0&order=asc&orderby=id&per_page=100';
$preload_paths[] = array( '/wp/v2/settings', 'OPTIONS' );
$preload_paths[] = array( $navigation_rest_route, 'OPTIONS' );
// HOMEBOY_SITE_EDITOR_PRELOAD_DIAGNOSTICS: end
`;

const EXACT_VISIBLE_PRELOAD_PATCH = `
// HOMEBOY_SITE_EDITOR_PRELOAD_DIAGNOSTICS_EXACT_VISIBLE: begin
$preload_paths[] = '/wp/v2/wp_pattern_category?_fields=id%2Cname%2Cdescription%2Cslug&_locale=user&context=view&per_page=100';
$preload_paths[] = '/wp/v2/taxonomies?_locale=user&context=view';
$preload_paths[] = '/wp/v2/menus?_locale=user&context=view&per_page=100';
$preload_paths[] = '/wp/v2/pages?_locale=user&context=view&order=asc&orderby=id&parent=0&per_page=100';
$preload_paths[] = array( '/wp/v2/settings?_locale=user', 'OPTIONS' );
$preload_paths[] = array( $navigation_rest_route . '?_locale=user', 'OPTIONS' );
// HOMEBOY_SITE_EDITOR_PRELOAD_DIAGNOSTICS_EXACT_VISIBLE: end
`;

function extraPreloadPatch() {
  const raw = process.env.HOMEBOY_SITE_EDITOR_PRELOAD_DIAGNOSTICS_EXTRA_PATHS_JSON;
  if (!raw) {
    return '';
  }

  const paths = JSON.parse(raw);
  if (!Array.isArray(paths)) {
    throw new Error('HOMEBOY_SITE_EDITOR_PRELOAD_DIAGNOSTICS_EXTRA_PATHS_JSON must be an array');
  }

  return [
    '// HOMEBOY_SITE_EDITOR_PRELOAD_DIAGNOSTICS_EXTRA: begin',
    ...paths.map((pathValue) => `$preload_paths[] = ${JSON.stringify(pathValue)};`),
    '// HOMEBOY_SITE_EDITOR_PRELOAD_DIAGNOSTICS_EXTRA: end',
  ].join('\n');
}

const WATCH_TARGETS = [
  { label: 'settings OPTIONS', method: 'OPTIONS', pattern: /^\/wp\/v2\/settings(?:\?|$)/ },
  { label: 'pattern categories', method: 'GET', pattern: /^\/wp\/v2\/wp_pattern_category(?:\?|$)/ },
  { label: 'taxonomies', method: 'GET', pattern: /^\/wp\/v2\/taxonomies(?:\?|$)/ },
  { label: 'menus', method: 'GET', pattern: /^\/wp\/v2\/menus(?:\?|$)/ },
  { label: 'pages', method: 'GET', pattern: /^\/wp\/v2\/pages(?:\?|$)/ },
  { label: 'navigation OPTIONS', method: 'OPTIONS', pattern: /^\/wp\/v2\/navigation(?:\?|$)/ },
];

async function createSite(sitePath) {
  return createStudioSite(sitePath, {
    name: `Studio Bench ${variant()} Site Editor Preload Diagnostics ${process.pid}`,
    wp: process.env.HOMEBOY_SITE_EDITOR_PRELOAD_DIAGNOSTICS_WP_VERSION,
    php: process.env.HOMEBOY_SITE_EDITOR_PRELOAD_DIAGNOSTICS_PHP_VERSION,
    timeoutMs: 420000,
  });
}

async function injectPreloadPatch(sitePath) {
  const file = path.join(sitePath, 'wp-admin/site-editor.php');
  const source = await readFile(file, 'utf8');
  const needle = 'block_editor_rest_api_preload( $preload_paths, $block_editor_context );';

  if (!source.includes(needle)) {
    throw new Error('site-editor.php preload call not found');
  }

  const exactVisible = process.env.HOMEBOY_SITE_EDITOR_PRELOAD_DIAGNOSTICS_EXACT_VISIBLE === '1';
  const extraPatch = extraPreloadPatch();
  const patch = [
    WESTON_PRELOAD_PATCH,
    exactVisible ? EXACT_VISIBLE_PRELOAD_PATCH : '',
    extraPatch,
  ].filter(Boolean).join('\n');

  await writeFile(file, source.replace(needle, `${patch}\n${needle}`));
  return patch;
}

async function sanitizeNetworkArtifact(artifact) {
  if (!artifact?.path) {
    return;
  }
  const raw = await readFile(artifact.path, 'utf8');
  await writeFile(artifact.path, redact(raw));
}

function rowsForTarget(rows, target) {
  return rows.filter((row) => row.method === target.method && target.pattern.test(row.url || ''));
}

function summarizeTargetRows(profile) {
  const waterfall = profile.restWaterfall || {};
  const networkRows = waterfall.remainingRestNetworkRows || waterfall.networkRows || [];
  const preloadedRows = waterfall.preloadedOrCacheRows || [];
  const attempts = waterfall.apiFetchAttempts || [];
  const diagnostics = waterfall.preloadDiagnostics?.rows || [];

  return WATCH_TARGETS.map((target) => ({
    label: target.label,
    method: target.method,
    preloadedOrCache: rowsForTarget(preloadedRows, target).map((row) => row.url),
    network: rowsForTarget(networkRows, target).map((row) => row.url),
    diagnostics: rowsForTarget(diagnostics, target).map((row) => ({
      url: row.url,
      primaryReason: row.primaryReason,
      reasons: row.reasons,
      evidence: row.evidence,
    })),
    apiFetchAttempts: rowsForTarget(attempts, target).map((row) => ({
      url: row.url,
      durationMs: row.durationMs,
      status: row.status,
    })),
  }));
}

export default async function studioSiteEditorPreloadDiagnosticsBench() {
  const currentVariant = variant();
  const runId = `${currentVariant}-site-editor-preload-diagnostics-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const artifactDir = path.join(studioArtifactDir('studio-site-editor-preload-diagnostics-artifacts'), runId);
  const sitePath = path.join(artifactDir, 'site');
  await mkdir(artifactDir, { recursive: true });

  const totalStarted = Date.now();
  let create;
  let statusResult;
  let status;
  let stop;
  let browserResult;
  let profile = {};
  let targetSummary = [];
  let injectedPreloadPatch = '';

  try {
    create = await createSite(sitePath);
    injectedPreloadPatch = await injectPreloadPatch(sitePath);
    statusResult = await studioSiteStatus(sitePath, { timeoutMs: 90000 });
    status = parseStudioSiteStatus(statusResult.stdout);

    if (!status.siteUrl || !status.autoLoginUrl) {
      throw new Error(`site status missing siteUrl/autoLoginUrl: ${redact(statusResult.stdout).slice(0, 1000)}`);
    }

    const { path: profilerPath } = loadWordPressRequestProfiler();
    const pageProfilerResult = loadWordPressPageProfiler({ profilerPath });
    const pageProfiler = pageProfilerResult.module;

    browserResult = await runBrowserBench({
      id: 'studio-site-editor-preload-diagnostics',
      artifactsDir: artifactDir,
      trace: true,
      screenshot: true,
      action: async ({ page, mark }) => {
        await page.goto(status.autoLoginUrl, { waitUntil: 'domcontentloaded', timeout: 120000 });
        await page.waitForLoadState('networkidle', { timeout: 120000 });
        await mark('browser_auto_login_networkidle');

        profile = await profileWordPressPage({
          page,
          siteUrl: status.siteUrl,
          pageProfiler,
          pageSpec: SITE_EDITOR_PAGE_SPEC,
          mark,
        });
        await mark('site_editor_ready');
      },
    });

    await sanitizeNetworkArtifact(browserResult.artifacts?.network);
    targetSummary = summarizeTargetRows(profile);
    stop = await stopStudioSite(sitePath, { timeoutMs: 90000 });

    const diagnostics = profile.restWaterfall?.preloadDiagnostics || {};
    const totalElapsedMs = Date.now() - totalStarted;
    const artifactFile = path.join(artifactDir, `result-${runId}.json`);
    await writeFile(
      artifactFile,
      JSON.stringify(
        {
          variant: currentVariant,
          sitePath,
          siteUrl: status.siteUrl,
          injectedPreloadPatch,
          pageProfilerPath: pageProfilerResult.path,
          pageProfilerAvailable: Boolean(pageProfiler),
          readyMs: profile.readyMs,
          targetSummary,
          preloadDiagnostics: diagnostics,
          profile,
          commands: {
            create: safeResult(create),
            status: safeResult(statusResult),
            stop: safeResult(stop),
          },
          browserMetrics: browserResult.metrics,
          browserArtifacts: browserResult.artifacts,
          timings: {
            total_elapsed_ms: totalElapsedMs,
          },
        },
        null,
        2
      )
    );

    return {
      metrics: {
        ...browserResult.metrics,
        success_rate: 1,
        site_editor_ready_ms: metric(profile.readyMs),
        watched_network_target_count: metric(targetSummary.filter((target) => target.network.length > 0).length),
        watched_network_request_count: metric(targetSummary.reduce((sum, target) => sum + target.network.length, 0)),
        preload_diagnostic_count: metric(diagnostics.count),
        preload_locale_mismatch_count: metric(diagnostics.countsByReason?.['locale-query-mismatch']),
        preload_locale_mismatch_after_hit_count: metric(diagnostics.countsByReason?.['locale-query-mismatch-after-preload-hit']),
        preload_fetch_all_mismatch_count: metric(diagnostics.countsByReason?.['fetch-all-per-page-mismatch']),
        preload_no_matching_preload_count: metric(diagnostics.countsByReason?.['no-matching-preload']),
      },
      artifacts: {
        raw_result: artifactFile,
        site_path: sitePath,
        ...browserResult.artifacts,
      },
    };
  } finally {
    if (!stop) {
      await stopStudioSite(sitePath, { timeoutMs: 90000 });
    }
  }
}
