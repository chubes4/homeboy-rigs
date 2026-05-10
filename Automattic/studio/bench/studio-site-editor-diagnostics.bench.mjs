import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import {
  STUDIO_PATH,
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
  buildTimingDeltaSummary,
  flattenPhasedResourceTimings,
  loadTimingCorrelator,
} from './lib/site-editor-timing-deltas.mjs';
import {
  collectWordPressBootstrapTimeline,
  installWordPressBootstrapTimeline,
  summarizeWordPressBootstrapTimeline,
  uninstallWordPressBootstrapTimeline,
} from './lib/wordpress-bootstrap-timeline.mjs';
import {
  loadWordPressPageProfiler,
  loadWordPressRequestProfiler,
  profileWordPressPage,
  wordpressPageProfilerSpec,
} from './lib/wordpress-page-profiler.mjs';

const BROWSER_HELPER = process.env.HOMEBOY_NODEJS_BROWSER_BENCH_HELPER;

if (!BROWSER_HELPER) {
  throw new Error('HOMEBOY_NODEJS_BROWSER_BENCH_HELPER is required');
}

const { runBrowserBench } = await import(BROWSER_HELPER);

async function createSite(sitePath) {
  return createStudioSite(sitePath, {
    name: `Studio Bench ${variant()} Site Editor Diagnostics ${process.pid}`,
    timeoutMs: 420000,
  });
}

async function siteStatus(sitePath) {
  return studioSiteStatus(sitePath, { timeoutMs: 90000 });
}

async function stopSite(sitePath) {
  return stopStudioSite(sitePath, { timeoutMs: 90000 });
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
    return redact(url);
  }
}

async function sanitizeNetworkArtifact(artifact) {
  if (!artifact || typeof artifact.path !== 'string') {
    return;
  }
  const raw = await readFile(artifact.path, 'utf8');
  await writeFile(artifact.path, redact(raw));
}

function summarizeNetwork(network, phase) {
  return network
    .filter((request) => request.phase === phase)
    .filter((request) => request.duration_ms > 10 || request.failed)
    .sort((a, b) => b.duration_ms - a.duration_ms)
    .slice(0, 60)
    .map((request) => ({
      ...request,
      url: scrubUrl(request.url),
    }));
}

function summarizeWordPressRequests(entries) {
  const byRequest = new Map();
  for (const entry of entries || []) {
    const id = entry.request_id || 'unknown';
    if (!byRequest.has(id)) {
      byRequest.set(id, []);
    }
    byRequest.get(id).push(entry);
  }

  return [...byRequest.values()]
    .map((events) => {
      events.sort((a, b) => (a.t_ms || 0) - (b.t_ms || 0));
      const last = events[events.length - 1];
      return {
        uri: redact(last?.uri || ''),
        method: last?.method,
        duration_ms: last?.t_ms || 0,
        http_urls: events
          .filter((event) => event.event === 'http.request.start')
          .map((event) => redact(event.data?.url || '')),
        hooks: events
          .filter((event) => event.event === 'hook.stop')
          .sort((a, b) => (b.data?.duration_ms || 0) - (a.data?.duration_ms || 0))
          .slice(0, 8)
          .map((event) => ({ hook: event.data?.hook, duration_ms: event.data?.duration_ms })),
      };
    })
    .sort((a, b) => b.duration_ms - a.duration_ms)
    .slice(0, 80);
}

export default async function studioSiteEditorDiagnosticsBench() {
  const currentVariant = variant();
  const pageSpec = wordpressPageProfilerSpec();
  const runId = `${currentVariant}-${pageSpec.id}-diagnostics-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const artifactDir = path.join(studioArtifactDir('studio-wordpress-page-diagnostics-artifacts'), runId);
  const sitePath = path.join(artifactDir, 'site');
  await mkdir(artifactDir, { recursive: true });

  const totalStarted = Date.now();
  const { path: profilerPath, module: profiler } = loadWordPressRequestProfiler();
  const { path: pageProfilerPath, module: pageProfiler } = loadWordPressPageProfiler({ profilerPath });
  const { path: correlatorPath, module: correlator } = loadTimingCorrelator({ profilerPath });
  let create;
  let statusResult;
  let stop;
  let status;
  let browserResult;
  let warmupProfile = {};
  let measureProfile = {};
  let loginFormSeen = 0;
  let wordpressRequests = [];
  let wordpressBootstrapTimeline = [];
  let bootstrapTimelineArtifactPath = '';
  const network = [];
  const startedRequests = new Map();
  let phase = 'setup';

  try {
    create = await createSite(sitePath);
    statusResult = await siteStatus(sitePath);
    status = parseStudioSiteStatus(statusResult.stdout);
    if (!status.siteUrl || !status.autoLoginUrl) {
      throw new Error(`site status missing siteUrl/autoLoginUrl: ${redact(statusResult.stdout).slice(0, 1000)}`);
    }

    const bootstrapTimeline = await installWordPressBootstrapTimeline(sitePath, { clearArtifact: true });
    bootstrapTimelineArtifactPath = bootstrapTimeline.artifactPath;
    profiler?.installWordPressRequestProfiler?.(sitePath);

    browserResult = await runBrowserBench({
      id: `studio-wordpress-page-diagnostics-${pageSpec.id}`,
      artifactsDir: artifactDir,
      trace: true,
      screenshot: true,
      action: async ({ page, mark }) => {
        page.__studioSiteUrl = status.siteUrl;
        page.on('request', (request) => startedRequests.set(request, { started: performance.now(), phase }));
        page.on('requestfinished', async (request) => {
          const response = await request.response().catch(() => null);
          const started = startedRequests.get(request) || { started: performance.now(), phase: 'unknown' };
          network.push({
            phase: started.phase,
            url: request.url(),
            method: request.method(),
            status: response?.status() ?? 0,
            start_ms: started.started,
            end_ms: performance.now(),
            duration_ms: performance.now() - started.started,
            resource_type: request.resourceType(),
          });
        });
        page.on('requestfailed', (request) => {
          const started = startedRequests.get(request) || { started: performance.now(), phase: 'unknown' };
          network.push({
            phase: started.phase,
            url: request.url(),
            method: request.method(),
            failed: true,
            failure: request.failure()?.errorText,
            start_ms: started.started,
            end_ms: performance.now(),
            duration_ms: performance.now() - started.started,
            resource_type: request.resourceType(),
          });
        });

        phase = 'login';
        await page.goto(status.autoLoginUrl, { waitUntil: 'domcontentloaded', timeout: 120000 });
        await page.waitForLoadState('networkidle', { timeout: 120000 });
        await mark('browser_auto_login_networkidle');

        loginFormSeen = await page.locator('#loginform').count();

        phase = 'warmup-page';
        warmupProfile = await profileWordPressPage({ page, siteUrl: status.siteUrl, pageProfiler, pageSpec, mark });
        await mark('warmup_wordpress_page_ready');

        phase = 'dashboard-between-runs';
        await page.goto(siteAdminUrl(status.siteUrl), { waitUntil: 'domcontentloaded', timeout: 120000 });
        await page.waitForLoadState('networkidle', { timeout: 120000 });
        await mark('browser_admin_networkidle_between_runs');

        phase = 'measure-page';
        measureProfile = await profileWordPressPage({ page, siteUrl: status.siteUrl, pageProfiler, pageSpec, mark });
        await mark('measure_wordpress_page_ready');
        phase = 'done';
      },
    });

    await sanitizeNetworkArtifact(browserResult.artifacts?.network);
    wordpressRequests = profiler?.collectWordPressRequestProfiles?.(sitePath) || [];
    profiler?.uninstallWordPressRequestProfiler?.(sitePath);
    wordpressBootstrapTimeline = await collectWordPressBootstrapTimeline(sitePath);
    await uninstallWordPressBootstrapTimeline(sitePath);
    stop = await stopSite(sitePath);

    const totalElapsedMs = Date.now() - totalStarted;
    const measureResourceTimingSummary = measureProfile.resources?.slowest || [];

    // Studio-specific browser-vs-WordPress timing delta summary. Consumes
    // the generic homeboy-extensions correlator (PR #452) and tags each
    // browser entry with the diagnostics phase that produced it so the
    // resulting summary highlights where in the Site Editor flow the
    // largest transport overhead lives.
    const phasedBrowserTimings = flattenPhasedResourceTimings({
      'warmup-page': warmupProfile.resources?.resources || [],
      'measure-page': measureProfile.resources?.resources || [],
    });
    const timingDeltas = buildTimingDeltaSummary({
      browserResourceTimings: phasedBrowserTimings,
      wordpressRequests,
      correlator,
    });

    const artifactFile = path.join(artifactDir, `result-${runId}.json`);
    await writeFile(
      artifactFile,
      JSON.stringify(
        {
          variant: currentVariant,
          pageSpec,
          profilerPath,
          profilerAvailable: Boolean(profiler),
          pageProfilerPath,
          pageProfilerAvailable: Boolean(pageProfiler),
          correlatorPath,
          correlatorAvailable: Boolean(correlator),
          bootstrapTimelineArtifactPath,
          // Effective Studio checkout that produced this artifact. The bench
          // run envelope itself now records the same path under
          // rig_state.components.studio.path (Homeboy PR #2364), but we
          // duplicate it here so the raw artifact is self-describing when
          // it is read in isolation (drag-and-dropped into a viewer, copied
          // out of `homeboy runs export`, etc.).
          studioPath: STUDIO_PATH,
          sitePath,
          siteUrl: status.siteUrl,
          timings: {
            site_create_ms: create.elapsedMs,
            site_status_ms: statusResult.elapsedMs,
            total_elapsed_ms: totalElapsedMs,
          },
          pageProfiles: {
            warmup: warmupProfile,
            measure: measureProfile,
          },
          network: {
            login: summarizeNetwork(network, 'login'),
            warmupPage: summarizeNetwork(network, 'warmup-page'),
            dashboardBetweenRuns: summarizeNetwork(network, 'dashboard-between-runs'),
            measurePage: summarizeNetwork(network, 'measure-page'),
          },
          wordpressRequests: summarizeWordPressRequests(wordpressRequests),
          wordpressBootstrapTimeline: summarizeWordPressBootstrapTimeline(wordpressBootstrapTimeline),
          timingDeltas,
          commands: {
            create: safeResult(create),
            status: safeResult(statusResult),
            stop: safeResult(stop),
          },
          browserMetrics: browserResult.metrics,
          browserArtifacts: browserResult.artifacts,
        },
        null,
        2
      )
    );

    if (measureProfile.status < 200 || measureProfile.status >= 400) {
      throw new Error(`${pageSpec.label || pageSpec.id} returned HTTP status ${measureProfile.status}; raw_result=${artifactFile}`);
    }
    if (loginFormSeen > 0) {
      throw new Error(`Login form remained visible after auto-login; raw_result=${artifactFile}`);
    }
    if (!browserResult.artifacts?.trace || !browserResult.artifacts?.screenshot) {
      throw new Error(`Browser trace/screenshot artifacts missing; raw_result=${artifactFile}`);
    }

    const slowestResource = measureResourceTimingSummary[0] || {};
    const bootstrapTimelineSummary = summarizeWordPressBootstrapTimeline(wordpressBootstrapTimeline);
    const slowestBootstrapRequest = bootstrapTimelineSummary[0] || {};
    const slowestBootstrapEvents = slowestBootstrapRequest.events || [];
    const slowestBootstrapSlice = slowestBootstrapEvents
      .slice()
      .sort((a, b) => (b.delta_from_previous_ms || 0) - (a.delta_from_previous_ms || 0))[0] || {};
    const overallDelta = timingDeltas?.overall || {};
    const largestTransport = overallDelta.largest_transport_delta || {};
    return {
      metrics: {
        success_rate: 1,
        elapsed_ms: totalElapsedMs,
        site_create_ms: metric(create.elapsedMs),
        site_status_ms: metric(statusResult.elapsedMs),
        login_form_seen: metric(loginFormSeen),
        wordpress_page_status: metric(measureProfile.status),
        wordpress_page_ready_ms: metric(measureProfile.readyMs),
        wordpress_page_warmup_ready_ms: metric(warmupProfile.readyMs),
        wordpress_page_resource_count: metric(measureProfile.resources?.count),
        wordpress_page_rest_resource_count: metric(measureProfile.resources?.restCount),
        wordpress_page_slowest_resource_ms: metric(slowestResource.durationMs),
        wordpress_page_slowest_resource_ttfb_ms: metric(slowestResource.ttfbMs),
        site_editor_status: metric(measureProfile.status),
        site_editor_ready_ms: metric(measureProfile.readyMs),
        site_editor_warmup_ready_ms: metric(warmupProfile.readyMs),
        site_editor_resource_count: metric(measureProfile.resources?.count),
        site_editor_rest_resource_count: metric(measureProfile.resources?.restCount),
        site_editor_slowest_resource_ms: metric(slowestResource.durationMs),
        site_editor_slowest_resource_ttfb_ms: metric(slowestResource.ttfbMs),
        // Browser-vs-WordPress timing deltas. Transport delta = browser
        // TTFB - WordPress app duration; it is the canonical signal for
        // Playground request/bootstrap/transport overhead under Studio.
        site_editor_correlator_available: metric(timingDeltas?.available ? 1 : 0),
        site_editor_correlated_request_count: metric(timingDeltas?.counts?.correlated),
        site_editor_unmatched_browser_count: metric(timingDeltas?.counts?.unmatched_browser),
        site_editor_unmatched_wordpress_count: metric(timingDeltas?.counts?.unmatched_wordpress),
        site_editor_max_transport_delta_ms: metric(overallDelta.max_transport_delta_ms),
        site_editor_avg_transport_delta_ms: metric(overallDelta.avg_transport_delta_ms),
        site_editor_max_total_delta_ms: metric(overallDelta.max_total_delta_ms),
        site_editor_avg_total_delta_ms: metric(overallDelta.avg_total_delta_ms),
        site_editor_largest_delta_browser_ttfb_ms: metric(largestTransport.browser_ttfb_ms),
        site_editor_largest_delta_browser_duration_ms: metric(largestTransport.browser_duration_ms),
        site_editor_largest_delta_wordpress_duration_ms: metric(largestTransport.wordpress_duration_ms),
        site_editor_bootstrap_timeline_request_count: metric(bootstrapTimelineSummary.length),
        site_editor_slowest_bootstrap_request_ms: metric(slowestBootstrapRequest.duration_ms),
        site_editor_slowest_bootstrap_slice_ms: metric(slowestBootstrapSlice.delta_from_previous_ms),
        total_elapsed_ms: totalElapsedMs,
        ...browserResult.metrics,
      },
      artifacts: {
        raw_result: artifactFile,
        site_path: sitePath,
        bootstrap_timeline: bootstrapTimelineArtifactPath,
        ...browserResult.artifacts,
      },
    };
  } finally {
    if (profiler) {
      profiler.uninstallWordPressRequestProfiler?.(sitePath);
    }
    await uninstallWordPressBootstrapTimeline(sitePath);
    if (!stop) {
      stop = await stopSite(sitePath);
    }
  }
}
