import { mkdir, writeFile } from 'node:fs/promises';
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

function siteAdminUrl(siteUrl, relativePath = '') {
  const base = siteUrl.endsWith('/') ? siteUrl : `${siteUrl}/`;
  return new URL(`wp-admin/${relativePath}`, base).toString();
}

async function runBotPath({ label, artifactDir, sitePath, status, requestProfiler, pageProfiler, candidate }) {
  if (candidate) {
    await installSiteEditorPreloadCandidate(sitePath);
  }
  await installWordPressBootstrapTimeline(sitePath, { clearArtifact: true });
  requestProfiler?.installWordPressRequestProfiler?.(sitePath, { clearArtifact: true });

  let warmup = {};
  let measure = {};
  const network = [];
  const requestStarts = new Map();
  let phase = 'setup';
  let phaseStartedAt = performance.now();
  const setPhase = (nextPhase) => {
    phase = nextPhase;
    phaseStartedAt = performance.now();
  };
  const browserResult = await runBrowserBench({
    id: `studio-site-editor-preload-${label}`,
    artifactsDir: path.join(artifactDir, label),
    trace: true,
    screenshot: true,
    action: async ({ page, mark }) => {
      page.__studioSiteUrl = status.siteUrl;
      page.on('request', (request) => requestStarts.set(request, { started: performance.now(), phase, phaseStartedAt }));
      page.on('requestfinished', async (request) => {
        const response = await request.response().catch(() => null);
        const started = requestStarts.get(request) || { started: performance.now(), phase: 'unknown', phaseStartedAt: performance.now() };
        network.push({
          phase: started.phase,
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
        const started = requestStarts.get(request) || { started: performance.now(), phase: 'unknown', phaseStartedAt: performance.now() };
        network.push({
          phase: started.phase,
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

      setPhase('warmup-site-editor');
      warmup = await profileWordPressPage({
        page,
        siteUrl: status.siteUrl,
        pageProfiler,
        pageSpec: SITE_EDITOR_PAGE_SPEC,
        mark,
      });
      await mark(`${label}_warmup_site_editor_ready`);

      setPhase('admin-between-runs');
      await new Promise((resolve) => setTimeout(resolve, 2000));
      await page.goto(siteAdminUrl(status.siteUrl), { waitUntil: 'domcontentloaded', timeout: 120000 });
      await page.waitForLoadState('networkidle', { timeout: 120000 });
      await mark(`${label}_admin_networkidle_between_runs`);

      setPhase('measure-site-editor');
      measure = await profileWordPressPage({
        page,
        siteUrl: status.siteUrl,
        pageProfiler,
        pageSpec: SITE_EDITOR_PAGE_SPEC,
        mark,
      });
      await mark(`${label}_measure_site_editor_ready`);
      setPhase('done');
    },
  });

  await sanitizeArtifact(browserResult.artifacts?.network);

  const wordpressRequests = requestProfiler?.collectWordPressRequestProfiles?.(sitePath) || [];
  const bootstrapRows = await collectWordPressBootstrapTimeline(sitePath);
  if (pageProfiler?.summarizeWordPressRestWaterfall) {
    warmup.restWaterfall = pageProfiler.summarizeWordPressRestWaterfall({
      readyMs: warmup.readyMs,
      apiFetchAttempts: warmup.restWaterfall?.apiFetchAttempts || [],
      resourceTimings: [],
      networkRequests: network.filter((request) => request.phase === 'warmup-site-editor'),
    });
    measure.restWaterfall = pageProfiler.summarizeWordPressRestWaterfall({
      readyMs: measure.readyMs,
      apiFetchAttempts: measure.restWaterfall?.apiFetchAttempts || [],
      resourceTimings: [],
      networkRequests: network.filter((request) => request.phase === 'measure-site-editor'),
    });
  }
  const phasedBrowserTimings = flattenPhasedResourceTimings({
    [`${label}-warmup-site-editor`]: warmup.resources?.resources || [],
    [`${label}-measure-site-editor`]: measure.resources?.resources || [],
  });
  const { module: correlator } = loadTimingCorrelator({ profilerPath: requestProfilerPath() });

  requestProfiler?.uninstallWordPressRequestProfiler?.(sitePath);
  await uninstallWordPressBootstrapTimeline(sitePath);

  return {
    sitePath,
    siteUrl: status.siteUrl,
    warmup,
    measure,
    timingDeltas: buildTimingDeltaSummary({
      browserResourceTimings: phasedBrowserTimings,
      wordpressRequests,
      correlator,
    }),
    bootstrapTimeline: summarizeWordPressBootstrapTimeline(bootstrapRows, { limit: 80 }),
    network,
    browserMetrics: browserResult.metrics,
    browserArtifacts: browserResult.artifacts,
  };
}

async function createAndStatus(sitePath, name) {
  const create = await createStudioSite(sitePath, { name, timeoutMs: 420000 });
  await configureSiteEditorScenario(sitePath);
  const statusResult = await studioSiteStatus(sitePath, { timeoutMs: 90000 });
  const status = parseStudioSiteStatus(statusResult.stdout);
  if (!status.siteUrl || !status.autoLoginUrl) {
    throw new Error('site status missing siteUrl/autoLoginUrl');
  }
  return { create, statusResult, status };
}

async function configureSiteEditorScenario(sitePath) {
  const scenario = process.env.HOMEBOY_SITE_EDITOR_SCENARIO || 'default';
  if (scenario !== 'static-home') {
    if (scenario === 'front-no-query') {
      await installFrontPageTemplate(sitePath, '<!-- wp:template-part {"slug":"header","theme":"twentytwentyfive"} /--><!-- wp:group {"tagName":"main","layout":{"type":"constrained"}} --><main class="wp-block-group"><!-- wp:paragraph --><p>Custom front page without posts.</p><!-- /wp:paragraph --></main><!-- /wp:group --><!-- wp:template-part {"slug":"footer","theme":"twentytwentyfive"} /-->');
    }
    if (scenario === 'front-query') {
      await installFrontPageTemplate(sitePath, '<!-- wp:template-part {"slug":"header","theme":"twentytwentyfive"} /--><!-- wp:group {"tagName":"main","layout":{"type":"constrained"}} --><main class="wp-block-group"><!-- wp:query {"query":{"perPage":3,"pages":0,"offset":0,"postType":"post","order":"desc","orderBy":"date","author":"","search":"","exclude":[],"sticky":"","inherit":false}} --><div class="wp-block-query"><!-- wp:post-template --><!-- wp:post-title /--><!-- /wp:post-template --></div><!-- /wp:query --></main><!-- /wp:group --><!-- wp:template-part {"slug":"footer","theme":"twentytwentyfive"} /-->');
    }
    return;
  }

  const code = `
$page_id = wp_insert_post(
	array(
		'post_title'   => 'About Me',
		'post_name'    => 'about-me',
		'post_status'  => 'publish',
		'post_type'    => 'page',
		'post_content' => '<!-- wp:paragraph --><p>Static homepage content.</p><!-- /wp:paragraph -->',
	)
);
if ( is_wp_error( $page_id ) ) {
	fwrite( STDERR, $page_id->get_error_message() );
	exit( 1 );
}
update_option( 'show_on_front', 'page' );
update_option( 'page_on_front', $page_id );
echo wp_json_encode( array( 'page_id' => $page_id ) );
`;

  await runCli(['wp', '--path', sitePath, '--php-version', '8.3', 'eval', code], { timeoutMs: 90000 });
}

async function installFrontPageTemplate(sitePath, content) {
  const code = `
$template_id = wp_insert_post(
	array(
		'post_title'   => 'Front Page',
		'post_name'    => 'front-page',
		'post_status'  => 'publish',
		'post_type'    => 'wp_template',
		'post_content' => ${JSON.stringify(content)},
	)
);
if ( is_wp_error( $template_id ) ) {
	fwrite( STDERR, $template_id->get_error_message() );
	exit( 1 );
}
wp_set_post_terms( $template_id, get_stylesheet(), 'wp_theme' );
echo wp_json_encode( array( 'template_id' => $template_id ) );
`;

  await runCli(['wp', '--path', sitePath, '--php-version', '8.3', 'eval', code], { timeoutMs: 90000 });
}

export default async function studioSiteEditorPreloadComparisonBench() {
  const currentVariant = variant();
  const runId = `${currentVariant}-site-editor-preload-comparison-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const artifactDir = path.join(studioArtifactDir('studio-site-editor-preload-comparison-artifacts'), runId);
  await mkdir(artifactDir, { recursive: true });

  const totalStarted = Date.now();
  const { path: profilerPath, module: requestProfiler } = loadWordPressRequestProfiler();
  const { path: pageProfilerPath, module: pageProfiler } = loadWordPressPageProfiler({ profilerPath });
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
      requestProfiler,
      pageProfiler,
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
      requestProfiler,
      pageProfiler,
      candidate: true,
    });

    const comparison = buildSiteEditorPreloadComparison({ baseline, candidate });
    const restWaterfallComparison = pageProfiler?.compareWordPressRestWaterfalls
      ? pageProfiler.compareWordPressRestWaterfalls({
          baseline: baseline.measure?.restWaterfall,
          candidate: candidate.measure?.restWaterfall,
        })
      : null;
    const totalElapsedMs = Date.now() - totalStarted;
    const artifactFile = path.join(artifactDir, `result-${runId}.json`);
    await writeFile(
      artifactFile,
      JSON.stringify(
        {
          variant: currentVariant,
          studioPath: STUDIO_PATH,
          profilerPath,
          profilerAvailable: Boolean(requestProfiler),
          pageProfilerPath,
          pageProfilerAvailable: Boolean(pageProfiler),
          timings: {
            baseline_site_create_ms: baselineCreate.elapsedMs,
            baseline_site_status_ms: baselineStatusResult.elapsedMs,
            candidate_site_create_ms: candidateCreate.elapsedMs,
            candidate_site_status_ms: candidateStatusResult.elapsedMs,
            total_elapsed_ms: totalElapsedMs,
          },
          comparison,
          restWaterfallComparison,
          restWaterfallReport: restWaterfallComparison && pageProfiler?.formatWordPressRestWaterfallMarkdownReport
            ? pageProfiler.formatWordPressRestWaterfallMarkdownReport(restWaterfallComparison)
            : '',
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
        baseline_measure_rest_network_count: metric(restWaterfallComparison?.counts?.baselineNetwork),
        candidate_measure_rest_network_count: metric(restWaterfallComparison?.counts?.candidateNetwork),
        site_editor_preload_removed_rest_network_count: metric(restWaterfallComparison?.counts?.removedNetwork),
        site_editor_preload_new_rest_network_count: metric(restWaterfallComparison?.counts?.newNetwork),
        site_editor_preload_remaining_rest_opportunity_count: metric(restWaterfallComparison?.remainingNetworkOpportunities?.length),
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
    requestProfiler?.uninstallWordPressRequestProfiler?.(baselineSitePath);
    requestProfiler?.uninstallWordPressRequestProfiler?.(candidateSitePath);
    await uninstallWordPressBootstrapTimeline(baselineSitePath);
    await uninstallWordPressBootstrapTimeline(candidateSitePath);
    await stopStudioSite(baselineSitePath, { timeoutMs: 90000 });
    await stopStudioSite(candidateSitePath, { timeoutMs: 90000 });
  }
}
