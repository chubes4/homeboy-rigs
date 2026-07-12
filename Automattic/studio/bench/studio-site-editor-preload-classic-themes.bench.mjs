import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

import {
  STUDIO_PATH,
  artifactDir as studioArtifactDir,
  createStudioSite,
  metric,
  parseStudioSiteStatus,
  runCli,
  safeResult,
  sanitizeArtifact,
  stopStudioSite,
  studioSiteStatus,
  variant,
} from './lib/studio-bench.mjs';
import {
  buildClassicThemePreloadRollUp,
  classifyPreloadHitWaste,
  collectPreloadedRestPaths,
  formatClassicThemePreloadRollUpMarkdown,
  installSiteEditorPreloadCandidate,
  installSiteEditorPreloadCapture,
} from './lib/site-editor-preload-harness.mjs';
import {
  collectWordPressBootstrapTimeline,
  installWordPressBootstrapTimeline,
  summarizeWordPressBootstrapTimeline,
  uninstallWordPressBootstrapTimeline,
} from './lib/wordpress-bootstrap-timeline.mjs';
import {
  SITE_EDITOR_PAGE_SPEC,
  loadWordPressAdminPageScenarios,
  loadWordPressPageProfiler,
  loadWordPressRequestProfiler,
  profileWordPressAdminPageScenario,
} from './lib/wordpress-page-profiler.mjs';
import {
  buildTimingDeltaSummary,
  flattenPhasedResourceTimings,
  loadTimingCorrelator,
  requestProfilerPath,
} from './lib/site-editor-timing-deltas.mjs';

const BROWSER_HELPER = process.env.HOMEBOY_NODEJS_BROWSER_BENCH_HELPER;

if (!BROWSER_HELPER) {
  throw new Error('HOMEBOY_NODEJS_BROWSER_BENCH_HELPER is required');
}

const { runBrowserBench } = await import(BROWSER_HELPER);

// Classic-theme Site Editor readiness: the editor opens on the templates /
// patterns list rather than the block canvas, so wait for network idle instead
// of the editor-canvas iframe selector used by block themes.
const CLASSIC_SITE_EDITOR_PAGE_SPEC = {
  id: 'site-editor-classic',
  path: '/wp-admin/site-editor.php',
  ready: { state: 'networkidle', timeout: 120000 },
  resources: { includeResourceSubstrings: ['/wp-json/', '/wp-admin/site-editor.php'] },
  timeout: 120000,
};

const BLOCK_THEME = process.env.HOMEBOY_CLASSIC_PRELOAD_BLOCK_THEME || 'twentytwentyfive';
const CLASSIC_THEME = process.env.HOMEBOY_CLASSIC_PRELOAD_CLASSIC_THEME || 'twentytwentyone';

const SCENARIOS = [
  { id: 'block', theme: BLOCK_THEME, blockTemplateParts: false, pageSpec: SITE_EDITOR_PAGE_SPEC },
  { id: 'classic', theme: CLASSIC_THEME, blockTemplateParts: false, pageSpec: CLASSIC_SITE_EDITOR_PAGE_SPEC },
  { id: 'classic-btp', theme: CLASSIC_THEME, blockTemplateParts: true, pageSpec: CLASSIC_SITE_EDITOR_PAGE_SPEC },
];

const BTP_MU_PLUGIN = `<?php
/**
 * Homeboy classic-theme evidence rig: opts a classic theme into
 * block-template-parts so the Site Editor opens in template-parts mode.
 * Installed only for the classic-btp scenario by the bench harness.
 */
add_action( 'after_setup_theme', function () {
	add_theme_support( 'block-template-parts' );
} );
`;

function siteAdminUrl(siteUrl, relativePath = '') {
  const base = siteUrl.endsWith('/') ? siteUrl : `${siteUrl}/`;
  return new URL(`wp-admin/${relativePath}`, base).toString();
}

async function wpEval(sitePath, code, options = {}) {
  const result = await runCli(
    ['wp', '--path', sitePath, '--php-version', '8.3', 'eval', code],
    { timeoutMs: 90000, ...options }
  );
  return String(result.stdout || '').trim();
}

async function activateTheme(sitePath, theme) {
  await runCli(
    ['wp', '--path', sitePath, '--php-version', '8.3', 'theme', 'activate', theme],
    { timeoutMs: 90000 }
  );
}

async function getActiveTheme(sitePath) {
  return wpEval(sitePath, 'echo get_stylesheet();');
}

async function getIsBlockTheme(sitePath) {
  const value = await wpEval(sitePath, "echo wp_is_block_theme() ? '1' : '0';");
  return value === '1';
}

async function configureBlockTemplateParts(sitePath, enable) {
  const muDir = path.join(sitePath, 'wp-content', 'mu-plugins');
  await mkdir(muDir, { recursive: true });
  const file = path.join(muDir, 'homeboy-block-template-parts.php');
  if (enable) {
    await writeFile(file, BTP_MU_PLUGIN);
  } else {
    await rm(file, { force: true });
  }
}

async function createAndStatus(sitePath, name) {
  const create = await createStudioSite(sitePath, { name, timeoutMs: 420000 });
  const statusResult = await studioSiteStatus(sitePath, { timeoutMs: 90000 });
  const status = parseStudioSiteStatus(statusResult.stdout);
  if (!status.siteUrl || !status.autoLoginUrl) {
    throw new Error('site status missing siteUrl/autoLoginUrl');
  }
  return { create, statusResult, status };
}

async function runBotPath({
  label,
  artifactDir,
  sitePath,
  status,
  pageProfiler,
  adminPageScenarios,
  requestProfiler,
  capturePath,
}) {
  await installWordPressBootstrapTimeline(sitePath, { clearArtifact: true });
  requestProfiler?.installWordPressRequestProfiler?.(sitePath, { clearArtifact: true });

  const network = [];
  const requestStarts = new Map();
  let phase = 'setup';
  let phaseStartedAt = performance.now();
  let currentScenarioId = 'setup';
  const setPhase = (nextPhase) => {
    phase = nextPhase;
    phaseStartedAt = performance.now();
  };
  const scenarioResults = {};

  const browserResult = await runBrowserBench({
    id: `studio-site-editor-preload-classic-themes-${label}`,
    artifactsDir: path.join(artifactDir, label),
    trace: true,
    screenshot: true,
    action: async ({ page, mark }) => {
      page.__studioSiteUrl = status.siteUrl;
      page.on('request', (request) => requestStarts.set(request, { started: performance.now(), phase, phaseStartedAt, scenarioId: currentScenarioId }));
      page.on('requestfinished', async (request) => {
        const response = await request.response().catch(() => null);
        const started = requestStarts.get(request) || { started: performance.now(), phase: 'unknown', phaseStartedAt: performance.now(), scenarioId: 'unknown' };
        network.push({
          scenario: started.scenarioId,
          phase: started.phase,
          bot_path: label,
          url: request.url(),
          method: request.method(),
          status: response?.status() ?? 0,
          start_ms: started.started - started.phaseStartedAt,
          end_ms: performance.now() - started.phaseStartedAt,
          duration_ms: performance.now() - started.started,
          resource_type: request.resourceType(),
        });
      });
      page.on('requestfailed', (request) => {
        const started = requestStarts.get(request) || { started: performance.now(), phase: 'unknown', phaseStartedAt: performance.now(), scenarioId: 'unknown' };
        network.push({
          scenario: started.scenarioId,
          phase: started.phase,
          bot_path: label,
          url: request.url(),
          method: request.method(),
          failed: true,
          failure: request.failure()?.errorText,
          start_ms: started.started - started.phaseStartedAt,
          end_ms: performance.now() - started.phaseStartedAt,
          duration_ms: performance.now() - started.started,
          resource_type: request.resourceType(),
        });
      });

      setPhase('login');
      await page.goto(status.autoLoginUrl, { waitUntil: 'domcontentloaded', timeout: 120000 });
      await page.waitForLoadState('networkidle', { timeout: 120000 });
      await mark(`${label}_auto_login_networkidle`);

      for (const scenario of SCENARIOS) {
        currentScenarioId = scenario.id;
        await activateTheme(sitePath, scenario.theme);
        await configureBlockTemplateParts(sitePath, scenario.blockTemplateParts);
        const theme = await getActiveTheme(sitePath);
        const isBlockTheme = await getIsBlockTheme(sitePath);

        setPhase(`${scenario.id}-warmup`);
        const warmup = await profileWordPressAdminPageScenario({
          page,
          siteUrl: status.siteUrl,
          adminPageScenarios,
          pageSpec: scenario.pageSpec,
          mark,
        });
        await mark(`${label}_${scenario.id}_warmup_ready`);

        setPhase('admin-between-runs');
        await new Promise((resolve) => setTimeout(resolve, 1500));
        await page.goto(siteAdminUrl(status.siteUrl), { waitUntil: 'domcontentloaded', timeout: 120000 });
        await page.waitForLoadState('networkidle', { timeout: 120000 });
        await mark(`${label}_${scenario.id}_admin_networkidle_between_runs`);

        setPhase(`${scenario.id}-measure`);
        const measure = await profileWordPressAdminPageScenario({
          page,
          siteUrl: status.siteUrl,
          adminPageScenarios,
          pageSpec: scenario.pageSpec,
          mark,
        });
        await mark(`${label}_${scenario.id}_measure_ready`);
        setPhase('done');

        const preloaded = await collectPreloadedRestPaths(capturePath);
        if (pageProfiler?.summarizeWordPressRestWaterfall) {
          measure.restWaterfall = pageProfiler.summarizeWordPressRestWaterfall({
            readyMs: measure.readyMs,
            apiFetchAttempts: measure.restWaterfall?.apiFetchAttempts || [],
            preloadChecks: measure.restWaterfall?.preloadChecks || [],
            restPreloads: measure.restWaterfall?.preloads || [],
            resourceTimings: [],
            networkRequests: network.filter((request) => request.phase === `${scenario.id}-measure`),
          });
        }
        const attempts = measure.restWaterfall?.apiFetchAttempts || [];
        const measureNetwork = network.filter(
          (request) => request.scenario === scenario.id && request.phase === `${scenario.id}-measure`
        );
        const restNetworkRequests = measureNetwork.filter((request) => /\/wp-json\/|(\?|&)rest_route=/.test(request.url || ''));
        const classification = classifyPreloadHitWaste({ preloaded, attempts, networkRequests: restNetworkRequests });

        scenarioResults[scenario.id] = {
          id: scenario.id,
          theme,
          isBlockTheme,
          blockTemplateParts: scenario.blockTemplateParts,
          warmup,
          measure,
          preloaded,
          classification,
          restNetworkCount: restNetworkRequests.length,
        };
      }
    },
  });

  await sanitizeArtifact(browserResult.artifacts?.network);

  const wordpressRequests = requestProfiler?.collectWordPressRequestProfiles?.(sitePath) || [];
  const bootstrapRows = await collectWordPressBootstrapTimeline(sitePath);
  const phasedBrowserTimings = flattenPhasedResourceTimings(
    Object.fromEntries(
      SCENARIOS.flatMap((scenario) => [
        [`${label}-${scenario.id}-warmup`, scenarioResults[scenario.id]?.warmup?.resources?.resources || []],
        [`${label}-${scenario.id}-measure`, scenarioResults[scenario.id]?.measure?.resources?.resources || []],
      ])
    )
  );
  const { module: correlator } = loadTimingCorrelator({ profilerPath: requestProfilerPath() });

  requestProfiler?.uninstallWordPressRequestProfiler?.(sitePath);
  await uninstallWordPressBootstrapTimeline(sitePath);

  for (const scenario of SCENARIOS) {
    const result = scenarioResults[scenario.id];
    if (!result) {
      continue;
    }
    result.timingDeltas = buildTimingDeltaSummary({
      browserResourceTimings: phasedBrowserTimings.filter((row) => row.phase.startsWith(`${label}-${scenario.id}`)),
      wordpressRequests,
      correlator,
    });
    result.bootstrapTimeline = summarizeWordPressBootstrapTimeline(bootstrapRows, { limit: 40 });
  }

  return {
    sitePath,
    siteUrl: status.siteUrl,
    scenarioResults,
    network,
    browserMetrics: browserResult.metrics,
    browserArtifacts: browserResult.artifacts,
  };
}

export default async function studioSiteEditorPreloadClassicThemesBench() {
  const currentVariant = variant();
  const runId = `${currentVariant}-site-editor-preload-classic-themes-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const artifactDir = path.join(studioArtifactDir('studio-site-editor-preload-classic-themes-artifacts'), runId);
  await mkdir(artifactDir, { recursive: true });

  const totalStarted = Date.now();
  const { module: requestProfiler } = loadWordPressRequestProfiler();
  const { path: pageProfilerPath, module: pageProfiler } = loadWordPressPageProfiler({});
  const { path: adminPageScenariosPath, module: adminPageScenarios } = loadWordPressAdminPageScenarios({});

  const baselineSitePath = path.join(artifactDir, 'baseline-site');
  const candidateSitePath = path.join(artifactDir, 'candidate-site');
  // Capture files live inside each site's wp-content so the Playground PHP
  // process (which can only write inside the site mount) can snapshot the
  // final $preload_paths array; the bench reads them back from sitePath.
  const baselineCapturePath = path.join(baselineSitePath, 'wp-content', 'homeboy-preload-capture.json');
  const candidateCapturePath = path.join(candidateSitePath, 'wp-content', 'homeboy-preload-capture.json');
  let baselineCreate;
  let baselineStatusResult;
  let candidateCreate;
  let candidateStatusResult;
  let baseline;
  let candidate;

  // The candidate must execute the actual WordPress/wordpress-develop#11766
  // derivation logic, so force the verbatim PR block regardless of env.
  process.env.HOMEBOY_SITE_EDITOR_PRELOAD_MODE = 'pr-11766';

  try {
    const baselineSite = await createAndStatus(
      baselineSitePath,
      `Studio Bench ${currentVariant} Site Editor Preload Classic Baseline ${process.pid}`
    );
    baselineCreate = baselineSite.create;
    baselineStatusResult = baselineSite.statusResult;
    // Baseline keeps the default WordPress preload set; install capture-only so
    // the default preload set is recorded for the roll-up comparison.
    await installSiteEditorPreloadCapture(baselineSitePath, { capturePath: baselineCapturePath });
    baseline = await runBotPath({
      label: 'baseline',
      artifactDir,
      sitePath: baselineSitePath,
      status: baselineSite.status,
      pageProfiler,
      adminPageScenarios,
      requestProfiler,
      capturePath: baselineCapturePath,
    });

    const candidateSite = await createAndStatus(
      candidateSitePath,
      `Studio Bench ${currentVariant} Site Editor Preload Classic Candidate ${process.pid}`
    );
    candidateCreate = candidateSite.create;
    candidateStatusResult = candidateSite.statusResult;
    await installSiteEditorPreloadCandidate(candidateSitePath, { mode: 'pr-11766' });
    await installSiteEditorPreloadCapture(candidateSitePath, { capturePath: candidateCapturePath });
    candidate = await runBotPath({
      label: 'candidate',
      artifactDir,
      sitePath: candidateSitePath,
      status: candidateSite.status,
      pageProfiler,
      adminPageScenarios,
      requestProfiler,
      capturePath: candidateCapturePath,
    });

    const scenarios = SCENARIOS.map((scenario) => ({
      id: scenario.id,
      theme: candidate.scenarioResults[scenario.id]?.theme || baseline.scenarioResults[scenario.id]?.theme,
      isBlockTheme: candidate.scenarioResults[scenario.id]?.isBlockTheme,
      blockTemplateParts: scenario.blockTemplateParts,
      baseline: baseline.scenarioResults[scenario.id],
      candidate: candidate.scenarioResults[scenario.id],
    }));
    const rollUp = buildClassicThemePreloadRollUp(scenarios);
    const rollUpMarkdown = formatClassicThemePreloadRollUpMarkdown(rollUp);
    const totalElapsedMs = Date.now() - totalStarted;
    const artifactFile = path.join(artifactDir, `result-${runId}.json`);
    await writeFile(
      artifactFile,
      JSON.stringify(
        {
          variant: currentVariant,
          studioPath: STUDIO_PATH,
          pageProfilerPath,
          pageProfilerAvailable: Boolean(pageProfiler),
          adminPageScenariosPath,
          adminPageScenariosAvailable: Boolean(adminPageScenarios),
          candidate_source: 'WordPress/wordpress-develop#11766 @ 360e7cbf02793323f9fa24fcbbea379a9ed7e4c9 (verbatim)',
          reviewer_context: {
            core_pr: 'https://github.com/WordPress/wordpress-develop/pull/11766',
            review_comment: 't-hamano (review 4680372983): were classic themes tested?',
            trac_ticket: 'https://core.trac.wordpress.org/ticket/65206',
          },
          scenarios,
          roll_up: rollUp,
          roll_up_markdown: rollUpMarkdown,
          timings: {
            baseline_site_create_ms: baselineCreate.elapsedMs,
            baseline_site_status_ms: baselineStatusResult.elapsedMs,
            candidate_site_create_ms: candidateCreate.elapsedMs,
            candidate_site_status_ms: candidateStatusResult.elapsedMs,
            total_elapsed_ms: totalElapsedMs,
          },
          candidate,
          baseline,
          commands: {
            baselineCreate: safeResult(baselineCreate),
            baselineStatus: safeResult(baselineStatusResult),
            candidateCreate: safeResult(candidateCreate),
            candidateStatus: safeResult(candidateStatusResult),
          },
        },
        null,
        2
      )
    );

    for (const row of rollUp) {
      if (row.candidate_status < 200 || row.candidate_status >= 400) {
        throw new Error(`Candidate Site Editor returned HTTP status ${row.candidate_status} for scenario ${row.scenario}; raw_result=${artifactFile}`);
      }
      if (row.baseline_status < 200 || row.baseline_status >= 400) {
        throw new Error(`Baseline Site Editor returned HTTP status ${row.baseline_status} for scenario ${row.scenario}; raw_result=${artifactFile}`);
      }
    }

    return {
      metrics: {
        success_rate: 1,
        elapsed_ms: totalElapsedMs,
        total_elapsed_ms: totalElapsedMs,
        ...Object.fromEntries(
          rollUp.flatMap((row) => [
            [`${row.scenario}_candidate_wasted`, metric(row.candidate_wasted)],
            [`${row.scenario}_candidate_preloaded`, metric(row.candidate_preloaded)],
            [`${row.scenario}_delta_ms`, metric(row.delta_ms)],
            [`${row.scenario}_rest_network_delta`, metric(row.rest_network_delta)],
          ])
        ),
      },
      artifacts: {
        raw_result: artifactFile,
        baseline_site_path: baselineSitePath,
        candidate_site_path: candidateSitePath,
        baseline_trace: baseline.browserArtifacts?.trace,
        candidate_trace: candidate.browserArtifacts?.trace,
        baseline_screenshot: baseline.browserArtifacts?.screenshot,
        candidate_screenshot: candidate.browserArtifacts?.screenshot,
        roll_up_markdown: rollUpMarkdown,
      },
    };
  } finally {
    requestProfiler?.uninstallWordPressRequestProfiler?.(baselineSitePath);
    requestProfiler?.uninstallWordPressRequestProfiler?.(candidateSitePath);
    await uninstallWordPressBootstrapTimeline(baselineSitePath);
    await uninstallWordPressBootstrapTimeline(candidateSitePath);
    await stopStudioSite(baselineSitePath, { timeoutMs: 90000 });
    await stopStudioSite(candidateSitePath, { timeoutMs: 90000 });
  }
}
