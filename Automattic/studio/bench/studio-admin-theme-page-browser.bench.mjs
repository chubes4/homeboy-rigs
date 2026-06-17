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
    name: `Studio Bench ${variant()} Add Themes Browser ${process.pid}`,
    timeoutMs: 420000,
  });
}

async function siteStatus(sitePath) {
  return studioSiteStatus(sitePath, { timeoutMs: 90000 });
}

async function stopSite(sitePath) {
  return stopStudioSite(sitePath, { timeoutMs: 90000 });
}

function autoLoginUrl(siteUrl, relativePath) {
  const url = new URL('/studio-auto-login', siteUrl);
  url.searchParams.set('redirect_to', new URL(relativePath, siteUrl).pathname);
  return url.toString();
}

async function firstContentfulPaint(page) {
  return page.evaluate(() => {
    const paint = performance.getEntriesByType('paint').find((entry) => entry.name === 'first-contentful-paint');
    return paint && Number.isFinite(paint.startTime) ? paint.startTime : 0;
  });
}

export default async function studioAdminThemePageBrowserBench() {
  const currentVariant = variant();
  const artifactContext = createBenchArtifactContext({
    id: `${currentVariant}-admin-theme-page-browser`,
    artifactsDir: studioArtifactDir('studio-admin-theme-page-browser-artifacts'),
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
  let loginFormSeen = 0;
  let firstContentfulPaintMs = 0;
  let finalStatus = 0;

  try {
    create = await createSite(sitePath);
    statusResult = await siteStatus(sitePath);
    status = parseStudioSiteStatus(statusResult.stdout);
    if (!status.siteUrl || !status.autoLoginUrl) {
      throw new Error(`site status missing siteUrl/autoLoginUrl: ${redact(statusResult.stdout).slice(0, 1000)}`);
    }

    browserResult = await runBrowserPageScenario({
      id: 'studio-admin-theme-page-browser',
      artifactsDir: artifactDir,
      trace: true,
      screenshot: true,
      action: async ({ page, mark }) => {
        const response = await page.goto(autoLoginUrl(status.siteUrl, 'wp-admin/theme-install.php'), {
          waitUntil: 'domcontentloaded',
          timeout: 120000,
        });
        finalStatus = response ? response.status() : 0;
        await mark('browser_theme_install_domcontentloaded');

        const loginForm = page.locator('#loginform');
        loginFormSeen = await loginForm.count();

        await page.getByRole('heading', { name: /add themes/i }).waitFor({ timeout: 120000 });
        await mark('add_themes_heading_visible');

        await page.locator('.theme-browser, .wp-filter, .theme-install-php').first().waitFor({ timeout: 120000 });
        await mark('theme_browser_visible');

        firstContentfulPaintMs = await firstContentfulPaint(page);
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
      timings: {
        site_create_ms: create.elapsedMs,
        site_status_ms: statusResult.elapsedMs,
        total_elapsed_ms: totalElapsedMs,
      },
      commands: {
        create: safeResult(create),
        status: safeResult(statusResult),
        stop: safeResult(stop),
      },
      browserMetrics: browserResult.metrics,
      browserArtifacts: browserResult.artifacts,
    }, { kind: 'browser-page-scenario-result', label: 'Studio Add Themes browser raw result' });
    const artifactFile = rawResultArtifact.path;

    if (finalStatus < 200 || finalStatus >= 400) {
      throw new Error(`Add Themes returned HTTP status ${finalStatus}; raw_result=${artifactFile}`);
    }
    if (loginFormSeen > 0) {
      throw new Error(`Login form remained visible after auto-login; raw_result=${artifactFile}`);
    }
    if (!browserResult.artifacts?.trace || !browserResult.artifacts?.screenshot) {
      throw new Error(`Browser trace/screenshot artifacts missing; raw_result=${artifactFile}`);
    }

    return buildBrowserBenchResult({
      metrics: {
        success_rate: 1,
        elapsed_ms: totalElapsedMs,
        site_create_ms: metric(create.elapsedMs),
        site_status_ms: metric(statusResult.elapsedMs),
        browser_first_contentful_paint_ms: metric(firstContentfulPaintMs),
        add_themes_status: metric(finalStatus),
        login_form_seen: metric(loginFormSeen),
        total_elapsed_ms: totalElapsedMs,
        ...browserResult.metrics,
      },
      rawResultArtifact,
      artifacts: {
        site_path: sitePath,
        ...browserResult.artifacts,
      },
    });
  } finally {
    if (!stop) {
      stop = await stopSite(sitePath);
    }
  }
}
