import { mkdir } from 'node:fs/promises';
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
const ARTIFACT_CONTEXT_HELPER = process.env.HOMEBOY_NODEJS_BENCH_ARTIFACT_CONTEXT;
const REDACTION_HELPER = process.env.HOMEBOY_NODEJS_BENCH_REDACTION;

if (!BROWSER_HELPER) {
  throw new Error('HOMEBOY_NODEJS_BROWSER_BENCH_HELPER is required');
}
if (!ARTIFACT_CONTEXT_HELPER) {
  throw new Error('HOMEBOY_NODEJS_BENCH_ARTIFACT_CONTEXT is required');
}
if (!REDACTION_HELPER) {
  throw new Error('HOMEBOY_NODEJS_BENCH_REDACTION is required');
}

const { buildBrowserBenchResult, runBrowserPageScenario } = await import(BROWSER_HELPER);
const { createBenchArtifactContext } = await import(ARTIFACT_CONTEXT_HELPER);
const { sanitizeArtifactFile } = await import(REDACTION_HELPER);

async function createSite(sitePath) {
  return createStudioSite(sitePath, {
    name: `Studio Bench ${variant()} Site Editor Browser ${process.pid}`,
    timeoutMs: 420000,
  });
}

async function siteStatus(sitePath) {
  return studioSiteStatus(sitePath, { timeoutMs: 90000 });
}

async function stopSite(sitePath) {
  return stopStudioSite(sitePath, { timeoutMs: 90000 });
}

function siteEditorTimingsFromProfile(profile) {
  const readiness = profile?.readiness || {};
  if (readiness.commitMs === undefined || readiness.frameSelectorMs === undefined) {
    throw new Error('Homeboy WordPress page profiler must expose phased readiness. Update homeboy-extensions.');
  }

  return {
    commit_ms: readiness.commitMs,
    status: profile.status,
    editor_canvas_iframe_visible_ms: readiness.selectorMs,
    editor_canvas_domcontentloaded_ms: readiness.frameLoadStateMs,
    first_data_block_ms: readiness.frameSelectorMs,
    site_editor_ready_ms: readiness.readyMs ?? profile.readyMs,
  };
}

export default async function studioSiteEditorBrowserBench() {
  const currentVariant = variant();
  const artifactContext = createBenchArtifactContext({
    id: `${currentVariant}-site-editor-browser`,
    artifactsDir: studioArtifactDir('studio-site-editor-browser-artifacts'),
  });
  const artifactDir = artifactContext.artifactDir;
  const sitePath = artifactContext.artifactPath('site', { prefix: '', extension: '' });
  await mkdir(artifactDir, { recursive: true });

  const totalStarted = Date.now();
  let create;
  let statusResult;
  let stop;
  let status;
  let browserResult;
  let pageProfilerPath = '';
  let pageProfilerAvailable = false;
  let warmupTimings = {};
  let measureTimings = {};
  let warmupProfile = {};
  let measureProfile = {};
  let loginFormSeen = 0;

  try {
    create = await createSite(sitePath);
    statusResult = await siteStatus(sitePath);
    status = parseStudioSiteStatus(statusResult.stdout);
    if (!status.siteUrl || !status.autoLoginUrl) {
      throw new Error(`site status missing siteUrl/autoLoginUrl: ${redact(statusResult.stdout).slice(0, 1000)}`);
    }

    const { path: profilerPath } = loadWordPressRequestProfiler();
    const pageProfilerResult = loadWordPressPageProfiler({ profilerPath });
    pageProfilerPath = pageProfilerResult.path;
    const pageProfiler = pageProfilerResult.module;
    pageProfilerAvailable = Boolean(pageProfiler);

    browserResult = await runBrowserPageScenario({
      id: 'studio-site-editor-browser',
      artifactsDir: artifactDir,
      trace: true,
      screenshot: true,
      action: async ({ page, mark }) => {
        page.__studioSiteUrl = status.siteUrl;

        await page.goto(status.autoLoginUrl, { waitUntil: 'domcontentloaded', timeout: 120000 });
        await page.waitForLoadState('networkidle', { timeout: 120000 });
        await mark('browser_auto_login_networkidle');

        loginFormSeen = await page.locator('#loginform').count();

        warmupProfile = await profileWordPressPage({
          page,
          siteUrl: status.siteUrl,
          pageProfiler,
          pageSpec: SITE_EDITOR_PAGE_SPEC,
          mark,
        });
        warmupTimings = siteEditorTimingsFromProfile(warmupProfile);
        await mark('warmup_site_editor_ready');

        await page.goto(new URL('/wp-admin/', status.siteUrl).toString(), { waitUntil: 'domcontentloaded', timeout: 120000 });
        await page.waitForLoadState('networkidle', { timeout: 120000 });
        await mark('browser_admin_networkidle_between_runs');

        measureProfile = await profileWordPressPage({
          page,
          siteUrl: status.siteUrl,
          pageProfiler,
          pageSpec: SITE_EDITOR_PAGE_SPEC,
          mark,
        });
        measureTimings = siteEditorTimingsFromProfile(measureProfile);
        await mark('measure_site_editor_ready');
      },
      postSanitizeAssertions: [
        { type: 'artifact', key: 'trace', kind: 'playwright-trace' },
        { type: 'artifact', key: 'screenshot', kind: 'screenshot' },
      ],
      sanitizeArtifacts: async ({ artifacts }) => {
        if (artifacts.network?.path) {
          await sanitizeArtifactFile(artifacts.network.path, { profile: 'web' });
        }
        return artifacts;
      },
    });

    stop = await stopSite(sitePath);

    const totalElapsedMs = Date.now() - totalStarted;
    const rawResultArtifact = await artifactContext.writeJson('raw-result', {
      variant: currentVariant,
      sitePath,
      siteUrl: status.siteUrl,
      pageProfilerPath,
      pageProfilerAvailable,
      timings: {
        site_create_ms: create.elapsedMs,
        site_status_ms: statusResult.elapsedMs,
        total_elapsed_ms: totalElapsedMs,
      },
      siteEditorTimings: {
        warmup: warmupTimings,
        measure: measureTimings,
      },
      pageProfiles: {
        warmup: warmupProfile,
        measure: measureProfile,
      },
      commands: {
        create: safeResult(create),
        status: safeResult(statusResult),
        stop: safeResult(stop),
      },
      browserMetrics: browserResult.metrics,
      browserArtifacts: browserResult.artifacts,
    }, { kind: 'browser-page-scenario-result', label: 'Studio Site Editor browser raw result' });
    const artifactFile = rawResultArtifact.path;

    if (measureTimings.status < 200 || measureTimings.status >= 400) {
      throw new Error(`Site Editor returned HTTP status ${measureTimings.status}; raw_result=${artifactFile}`);
    }
    if (loginFormSeen > 0) {
      throw new Error(`Login form remained visible after auto-login; raw_result=${artifactFile}`);
    }
    if (!browserResult.artifacts?.trace || !browserResult.artifacts?.screenshot) {
      throw new Error(`Browser trace/screenshot artifacts missing; raw_result=${artifactFile}`);
    }

    return buildBrowserBenchResult({
      browserResult,
      metrics: {
        success_rate: 1,
        elapsed_ms: totalElapsedMs,
        site_create_ms: metric(create.elapsedMs),
        site_status_ms: metric(statusResult.elapsedMs),
        login_form_seen: metric(loginFormSeen),
        site_editor_status: metric(measureTimings.status),
        site_editor_commit_ms: metric(measureTimings.commit_ms),
        site_editor_iframe_visible_ms: metric(measureTimings.editor_canvas_iframe_visible_ms),
        site_editor_iframe_domcontentloaded_ms: metric(measureTimings.editor_canvas_domcontentloaded_ms),
        site_editor_first_data_block_ms: metric(measureTimings.first_data_block_ms),
        site_editor_ready_ms: metric(measureTimings.site_editor_ready_ms),
        site_editor_warmup_ready_ms: metric(warmupTimings.site_editor_ready_ms),
        total_elapsed_ms: totalElapsedMs,
      },
      rawResultArtifact,
      artifacts: {
        site_path: sitePath,
      },
    });
  } finally {
    if (!stop) {
      stop = await stopSite(sitePath);
    }
  }
}
