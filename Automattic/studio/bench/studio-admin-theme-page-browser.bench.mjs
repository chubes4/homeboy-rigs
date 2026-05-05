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

const BROWSER_HELPER = process.env.HOMEBOY_NODEJS_BROWSER_BENCH_HELPER;

if (!BROWSER_HELPER) {
  throw new Error('HOMEBOY_NODEJS_BROWSER_BENCH_HELPER is required');
}

const { runBrowserBench } = await import(BROWSER_HELPER);

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

function siteAdminUrl(siteUrl, relativePath) {
  const base = siteUrl.endsWith('/') ? siteUrl : `${siteUrl}/`;
  return new URL(relativePath, base).toString();
}

async function sanitizeNetworkArtifact(artifact) {
  if (!artifact || typeof artifact.path !== 'string') {
    return;
  }
  const raw = await readFile(artifact.path, 'utf8');
  await writeFile(artifact.path, redact(raw));
}

async function firstContentfulPaint(page) {
  return page.evaluate(() => {
    const paint = performance.getEntriesByType('paint').find((entry) => entry.name === 'first-contentful-paint');
    return paint && Number.isFinite(paint.startTime) ? paint.startTime : 0;
  });
}

export default async function studioAdminThemePageBrowserBench() {
  const currentVariant = variant();
  const runId = `${currentVariant}-admin-theme-page-browser-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const artifactDir = path.join(studioArtifactDir('studio-admin-theme-page-browser-artifacts'), runId);
  const sitePath = path.join(artifactDir, 'site');
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

    browserResult = await runBrowserBench({
      id: 'studio-admin-theme-page-browser',
      artifactsDir: artifactDir,
      trace: true,
      screenshot: true,
      action: async ({ page, mark }) => {
        await page.goto(status.autoLoginUrl, { waitUntil: 'domcontentloaded', timeout: 120000 });
        await mark('browser_auto_login_domcontentloaded');

        const loginForm = page.locator('#loginform');
        loginFormSeen = await loginForm.count();

        const response = await page.goto(siteAdminUrl(status.siteUrl, 'wp-admin/theme-install.php'), {
          waitUntil: 'domcontentloaded',
          timeout: 120000,
        });
        finalStatus = response ? response.status() : 0;
        await mark('browser_theme_install_domcontentloaded');

        await page.getByRole('heading', { name: /add themes/i }).waitFor({ timeout: 120000 });
        await mark('add_themes_heading_visible');

        await page.locator('.theme-browser, .wp-filter, .theme-install-php').first().waitFor({ timeout: 120000 });
        await mark('theme_browser_visible');

        firstContentfulPaintMs = await firstContentfulPaint(page);
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

    if (finalStatus < 200 || finalStatus >= 400) {
      throw new Error(`Add Themes returned HTTP status ${finalStatus}; raw_result=${artifactFile}`);
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
        browser_first_contentful_paint_ms: metric(firstContentfulPaintMs),
        add_themes_status: metric(finalStatus),
        login_form_seen: metric(loginFormSeen),
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
