import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import {
  STUDIO_PATH,
  artifactDir as studioArtifactDir,
  createStudioSite,
  metric,
  parseStudioSiteStatus,
  safeResult,
  stopStudioSite,
  studioSiteStatus,
  variant,
} from './lib/studio-bench.mjs';
import {
  buildTimingDeltaSummary,
  flattenPhasedResourceTimings,
  loadTimingCorrelator,
  requestProfilerPath,
} from './lib/site-editor-timing-deltas.mjs';
import {
  buildSiteEditorPreloadComparison,
  installSiteEditorPreloadCandidate,
} from './lib/site-editor-preload-harness.mjs';
import {
  collectWordPressBootstrapTimeline,
  installWordPressBootstrapTimeline,
  summarizeWordPressBootstrapTimeline,
  uninstallWordPressBootstrapTimeline,
} from './lib/wordpress-bootstrap-timeline.mjs';

const BROWSER_HELPER = process.env.HOMEBOY_NODEJS_BROWSER_BENCH_HELPER;

if (!BROWSER_HELPER) {
  throw new Error('HOMEBOY_NODEJS_BROWSER_BENCH_HELPER is required');
}

const { runBrowserBench } = await import(BROWSER_HELPER);
const require = createRequire(import.meta.url);

function loadRequestProfiler() {
  const profilerPath = requestProfilerPath();
  if (!profilerPath || !existsSync(profilerPath)) {
    return { profilerPath, profiler: null };
  }
  return { profilerPath, profiler: require(profilerPath) };
}

function siteAdminUrl(siteUrl, relativePath = '') {
  const base = siteUrl.endsWith('/') ? siteUrl : `${siteUrl}/`;
  return new URL(`wp-admin/${relativePath}`, base).toString();
}

function scrubUrl(url) {
  try {
    const parsed = new URL(url);
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return String(url || '');
  }
}

async function sanitizeArtifact(artifact) {
  if (!artifact || typeof artifact.path !== 'string') {
    return;
  }
  const raw = await readFile(artifact.path, 'utf8');
  await writeFile(artifact.path, raw.replace(/([?&](?:token|password|key|nonce)=)[^&#\s]+/gi, '$1[redacted]'));
}

async function collectResourceTimings(page) {
  const entries = await page.evaluate(() =>
    performance
      .getEntriesByType('resource')
      .filter((entry) => entry.name.includes('/wp-json/') || entry.name.includes('/wp-admin/site-editor.php'))
      .map((entry) => ({
        name: entry.name,
        initiatorType: entry.initiatorType,
        startTime: entry.startTime,
        duration: entry.duration,
        fetchStart: entry.fetchStart,
        requestStart: entry.requestStart,
        responseStart: entry.responseStart,
        responseEnd: entry.responseEnd,
        transferSize: entry.transferSize,
        encodedBodySize: entry.encodedBodySize,
        decodedBodySize: entry.decodedBodySize,
      }))
  );
  return entries;
}

function summarizeResourceTimings(entries) {
  return entries
    .map((entry) => ({
      url: scrubUrl(entry.name),
      start_ms: entry.startTime,
      duration_ms: entry.duration,
      request_start_ms: entry.requestStart,
      response_start_ms: entry.responseStart,
      response_end_ms: entry.responseEnd,
      ttfb_ms: entry.responseStart - entry.requestStart,
      transfer_size: entry.transferSize,
      encoded_body_size: entry.encodedBodySize,
      decoded_body_size: entry.decodedBodySize,
    }))
    .sort((a, b) => b.duration_ms - a.duration_ms);
}

async function waitForSiteEditorReady(page) {
  const timings = {};
  const marks = [];
  const started = performance.now();
  const elapsed = () => performance.now() - started;
  const mark = (name) => marks.push({ name, t_ms: elapsed() });

  const response = await page.goto(siteAdminUrl(page.__studioSiteUrl, 'site-editor.php'), {
    waitUntil: 'commit',
    timeout: 120000,
  });
  timings.commit_ms = elapsed();
  timings.status = response ? response.status() : 0;
  mark('commit');

  await page.waitForSelector('iframe[name="editor-canvas"]', { state: 'visible', timeout: 120000 });
  timings.editor_canvas_iframe_visible_ms = elapsed();
  mark('iframe-visible');

  const frame = page.frame({ name: 'editor-canvas' });
  if (!frame) {
    throw new Error('Site Editor canvas frame not found');
  }

  await frame.waitForLoadState('domcontentloaded', { timeout: 120000 });
  timings.editor_canvas_domcontentloaded_ms = elapsed();
  mark('iframe-domcontentloaded');

  await frame.waitForSelector('[data-block]', { timeout: 60000 });
  timings.first_data_block_ms = elapsed();
  mark('first-data-block');

  await frame.waitForFunction(
    () =>
      document.querySelectorAll('[data-block]').length > 0 &&
      !document.querySelector('.components-spinner') &&
      !document.querySelector('.is-loading') &&
      !document.querySelector('.wp-block-editor__loading'),
    { timeout: 60000 }
  );
  timings.site_editor_ready_ms = elapsed();
  timings.duration_ms = timings.site_editor_ready_ms;
  mark('ready');
  timings.marks = marks;
  timings.resourceTimings = await collectResourceTimings(page);

  return timings;
}

async function runBotPath({ label, artifactDir, sitePath, status, profiler, candidate }) {
  if (candidate) {
    await installSiteEditorPreloadCandidate(sitePath);
  }
  await installWordPressBootstrapTimeline(sitePath, { clearArtifact: true });
  profiler?.installWordPressRequestProfiler?.(sitePath, { clearArtifact: true });

  let warmup = {};
  let measure = {};
  const browserResult = await runBrowserBench({
    id: `studio-site-editor-preload-${label}`,
    artifactsDir: path.join(artifactDir, label),
    trace: true,
    screenshot: true,
    action: async ({ page, mark }) => {
      page.__studioSiteUrl = status.siteUrl;
      await page.goto(status.autoLoginUrl, { waitUntil: 'domcontentloaded', timeout: 120000 });
      await page.waitForLoadState('networkidle', { timeout: 120000 });
      await mark(`${label}_auto_login_networkidle`);

      warmup = await waitForSiteEditorReady(page);
      await mark(`${label}_warmup_site_editor_ready`);

      await new Promise((resolve) => setTimeout(resolve, 2000));
      await page.goto(siteAdminUrl(status.siteUrl), { waitUntil: 'domcontentloaded', timeout: 120000 });
      await page.waitForLoadState('networkidle', { timeout: 120000 });
      await mark(`${label}_admin_networkidle_between_runs`);

      measure = await waitForSiteEditorReady(page);
      await mark(`${label}_measure_site_editor_ready`);
    },
  });

  await sanitizeArtifact(browserResult.artifacts?.network);

  const wordpressRequests = profiler?.collectWordPressRequestProfiles?.(sitePath) || [];
  const bootstrapRows = await collectWordPressBootstrapTimeline(sitePath);
  const phasedBrowserTimings = flattenPhasedResourceTimings({
    [`${label}-warmup-site-editor`]: warmup.resourceTimings || [],
    [`${label}-measure-site-editor`]: measure.resourceTimings || [],
  });
  const { module: correlator } = loadTimingCorrelator({ profilerPath: requestProfilerPath() });

  profiler?.uninstallWordPressRequestProfiler?.(sitePath);
  await uninstallWordPressBootstrapTimeline(sitePath);

  return {
    sitePath,
    siteUrl: status.siteUrl,
    warmup: {
      ...warmup,
      resourceTimings: summarizeResourceTimings(warmup.resourceTimings || []),
    },
    measure: {
      ...measure,
      resourceTimings: summarizeResourceTimings(measure.resourceTimings || []),
    },
    timingDeltas: buildTimingDeltaSummary({
      browserResourceTimings: phasedBrowserTimings,
      wordpressRequests,
      correlator,
    }),
    bootstrapTimeline: summarizeWordPressBootstrapTimeline(bootstrapRows, { limit: 80 }),
    browserMetrics: browserResult.metrics,
    browserArtifacts: browserResult.artifacts,
  };
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

export default async function studioSiteEditorPreloadComparisonBench() {
  const currentVariant = variant();
  const runId = `${currentVariant}-site-editor-preload-comparison-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const artifactDir = path.join(studioArtifactDir('studio-site-editor-preload-comparison-artifacts'), runId);
  await mkdir(artifactDir, { recursive: true });

  const totalStarted = Date.now();
  const { profilerPath, profiler } = loadRequestProfiler();
  const baselineSitePath = path.join(artifactDir, 'baseline-site');
  const candidateSitePath = path.join(artifactDir, 'candidate-site');
  let baselineCreate;
  let baselineStatusResult;
  let candidateCreate;
  let candidateStatusResult;
  let baseline;
  let candidate;

  try {
    const baselineSite = await createAndStatus(
      baselineSitePath,
      `Studio Bench ${currentVariant} Site Editor Preload Baseline ${process.pid}`
    );
    baselineCreate = baselineSite.create;
    baselineStatusResult = baselineSite.statusResult;
    baseline = await runBotPath({
      label: 'baseline',
      artifactDir,
      sitePath: baselineSitePath,
      status: baselineSite.status,
      profiler,
      candidate: false,
    });

    const candidateSite = await createAndStatus(
      candidateSitePath,
      `Studio Bench ${currentVariant} Site Editor Preload Candidate ${process.pid}`
    );
    candidateCreate = candidateSite.create;
    candidateStatusResult = candidateSite.statusResult;
    candidate = await runBotPath({
      label: 'candidate',
      artifactDir,
      sitePath: candidateSitePath,
      status: candidateSite.status,
      profiler,
      candidate: true,
    });

    const comparison = buildSiteEditorPreloadComparison({ baseline, candidate });
    const totalElapsedMs = Date.now() - totalStarted;
    const artifactFile = path.join(artifactDir, `result-${runId}.json`);
    await writeFile(
      artifactFile,
      JSON.stringify(
        {
          variant: currentVariant,
          studioPath: STUDIO_PATH,
          profilerPath,
          profilerAvailable: Boolean(profiler),
          timings: {
            baseline_site_create_ms: baselineCreate.elapsedMs,
            baseline_site_status_ms: baselineStatusResult.elapsedMs,
            candidate_site_create_ms: candidateCreate.elapsedMs,
            candidate_site_status_ms: candidateStatusResult.elapsedMs,
            total_elapsed_ms: totalElapsedMs,
          },
          comparison,
          baseline,
          candidate,
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

    if (comparison.baseline_status < 200 || comparison.baseline_status >= 400) {
      throw new Error(`Baseline Site Editor returned HTTP status ${comparison.baseline_status}; raw_result=${artifactFile}`);
    }
    if (comparison.candidate_status < 200 || comparison.candidate_status >= 400) {
      throw new Error(`Candidate Site Editor returned HTTP status ${comparison.candidate_status}; raw_result=${artifactFile}`);
    }

    return {
      metrics: {
        success_rate: 1,
        elapsed_ms: totalElapsedMs,
        baseline_site_editor_measure_ms: metric(comparison.baseline_measure_ms),
        candidate_site_editor_measure_ms: metric(comparison.candidate_measure_ms),
        site_editor_preload_delta_ms: metric(comparison.delta_ms),
        site_editor_preload_delta_pct: metric(comparison.delta_pct),
        baseline_measure_resource_count: metric(comparison.baseline_measure_resource_count),
        candidate_measure_resource_count: metric(comparison.candidate_measure_resource_count),
        baseline_slowest_measure_resource_ms: metric(comparison.baseline_slowest_measure_resources[0]?.duration_ms),
        candidate_slowest_measure_resource_ms: metric(comparison.candidate_slowest_measure_resources[0]?.duration_ms),
        baseline_bootstrap_request_count: metric(baseline.bootstrapTimeline.length),
        candidate_bootstrap_request_count: metric(candidate.bootstrapTimeline.length),
        total_elapsed_ms: totalElapsedMs,
      },
      artifacts: {
        raw_result: artifactFile,
        baseline_site_path: baselineSitePath,
        candidate_site_path: candidateSitePath,
        baseline_trace: baseline.browserArtifacts?.trace,
        candidate_trace: candidate.browserArtifacts?.trace,
        baseline_screenshot: baseline.browserArtifacts?.screenshot,
        candidate_screenshot: candidate.browserArtifacts?.screenshot,
      },
    };
  } finally {
    profiler?.uninstallWordPressRequestProfiler?.(baselineSitePath);
    profiler?.uninstallWordPressRequestProfiler?.(candidateSitePath);
    await uninstallWordPressBootstrapTimeline(baselineSitePath);
    await uninstallWordPressBootstrapTimeline(candidateSitePath);
    await stopStudioSite(baselineSitePath, { timeoutMs: 90000 });
    await stopStudioSite(candidateSitePath, { timeoutMs: 90000 });
  }
}
