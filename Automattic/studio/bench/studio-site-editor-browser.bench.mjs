import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
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

const BROWSER_HELPER = process.env.HOMEBOY_NODEJS_BROWSER_BENCH_HELPER;

if (!BROWSER_HELPER) {
  throw new Error('HOMEBOY_NODEJS_BROWSER_BENCH_HELPER is required');
}

const { runBrowserBench } = await import(BROWSER_HELPER);

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

function siteAdminUrl(siteUrl, relativePath = '') {
  const base = siteUrl.endsWith('/') ? siteUrl : `${siteUrl}/`;
  return new URL(`wp-admin/${relativePath}`, base).toString();
}

async function sanitizeNetworkArtifact(artifact) {
  if (!artifact || typeof artifact.path !== 'string') {
    return;
  }
  const raw = await readFile(artifact.path, 'utf8');
  await writeFile(artifact.path, redact(raw));
}

async function waitForSiteEditorReady(page) {
  const timings = {};
  const started = performance.now();
  const elapsed = () => performance.now() - started;

  const response = await page.goto(siteAdminUrl(page.__studioSiteUrl, 'site-editor.php'), {
    waitUntil: 'commit',
    timeout: 120000,
  });
  timings.commit_ms = elapsed();
  timings.status = response ? response.status() : 0;

  await page.waitForSelector('iframe[name="editor-canvas"]', {
    state: 'visible',
    timeout: 120000,
  });
  timings.editor_canvas_iframe_visible_ms = elapsed();

  const frame = page.frame({ name: 'editor-canvas' });
  if (!frame) {
    throw new Error('Site Editor canvas frame not found');
  }

  await frame.waitForLoadState('domcontentloaded', { timeout: 120000 });
  timings.editor_canvas_domcontentloaded_ms = elapsed();

  await frame.waitForSelector('[data-block]', { timeout: 60000 });
  timings.first_data_block_ms = elapsed();

  await frame.waitForFunction(
    () => {
      return (
        document.querySelectorAll('[data-block]').length > 0 &&
        !document.querySelector('.components-spinner') &&
        !document.querySelector('.is-loading') &&
        !document.querySelector('.wp-block-editor__loading')
      );
    },
    { timeout: 60000 }
  );
  timings.site_editor_ready_ms = elapsed();

  return timings;
}

export default async function studioSiteEditorBrowserBench() {
  const currentVariant = variant();
  const runId = `${currentVariant}-site-editor-browser-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const artifactDir = path.join(studioArtifactDir('studio-site-editor-browser-artifacts'), runId);
  const sitePath = path.join(artifactDir, 'site');
  await mkdir(artifactDir, { recursive: true });

  const totalStarted = Date.now();
  let create;
  let statusResult;
  let stop;
  let status;
  let browserResult;
  let warmupTimings = {};
  let measureTimings = {};
  let loginFormSeen = 0;

  try {
    create = await createSite(sitePath);
    statusResult = await siteStatus(sitePath);
    status = parseStudioSiteStatus(statusResult.stdout);
    if (!status.siteUrl || !status.autoLoginUrl) {
      throw new Error(`site status missing siteUrl/autoLoginUrl: ${redact(statusResult.stdout).slice(0, 1000)}`);
    }

    browserResult = await runBrowserBench({
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

        warmupTimings = await waitForSiteEditorReady(page);
        await mark('warmup_site_editor_ready');

        await page.goto(siteAdminUrl(status.siteUrl), { waitUntil: 'domcontentloaded', timeout: 120000 });
        await page.waitForLoadState('networkidle', { timeout: 120000 });
        await mark('browser_admin_networkidle_between_runs');

        measureTimings = await waitForSiteEditorReady(page);
        await mark('measure_site_editor_ready');
      },
    });

    await sanitizeNetworkArtifact(browserResult.artifacts?.network);
    stop = await stopSite(sitePath);

    const totalElapsedMs = Date.now() - totalStarted;
    const artifactFile = path.join(artifactDir, `result-${runId}.json`);
    await writeFile(
      artifactFile,
      JSON.stringify(
        {
          variant: currentVariant,
          sitePath,
          siteUrl: status.siteUrl,
          timings: {
            site_create_ms: create.elapsedMs,
            site_status_ms: statusResult.elapsedMs,
            total_elapsed_ms: totalElapsedMs,
          },
          siteEditorTimings: {
            warmup: warmupTimings,
            measure: measureTimings,
          },
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

    if (measureTimings.status < 200 || measureTimings.status >= 400) {
      throw new Error(`Site Editor returned HTTP status ${measureTimings.status}; raw_result=${artifactFile}`);
    }
    if (loginFormSeen > 0) {
      throw new Error(`Login form remained visible after auto-login; raw_result=${artifactFile}`);
    }
    if (!browserResult.artifacts?.trace || !browserResult.artifacts?.screenshot) {
      throw new Error(`Browser trace/screenshot artifacts missing; raw_result=${artifactFile}`);
    }

    return {
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
        ...browserResult.metrics,
      },
      artifacts: {
        raw_result: artifactFile,
        site_path: sitePath,
        ...browserResult.artifacts,
      },
    };
  } finally {
    if (!stop) {
      stop = await stopSite(sitePath);
    }
  }
}
