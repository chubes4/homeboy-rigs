import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import {
  artifactDir as studioArtifactDir,
  createStudioSite,
  metric,
  parseStudioSiteStatus,
  redact,
  safeResult,
  sanitizeArtifact,
  setting,
  stopStudioSite,
  studioSiteStatus,
  variant,
} from './lib/studio-bench.mjs';

const BROWSER_HELPER = process.env.HOMEBOY_NODEJS_BROWSER_BENCH_HELPER;

if (!BROWSER_HELPER) {
  throw new Error('HOMEBOY_NODEJS_BROWSER_BENCH_HELPER is required');
}

const { runBrowserBench } = await import(BROWSER_HELPER);

const DEFAULT_PATHS = [
  '/',
  '/sample-page/',
  '/wp-admin/index.php',
  '/wp-admin/edit.php',
  '/wp-admin/post-new.php',
  '/wp-admin/edit.php?post_type=page',
  '/wp-admin/post-new.php?post_type=page',
  '/wp-admin/upload.php',
  '/wp-admin/media-new.php',
  '/wp-admin/edit-comments.php',
  '/wp-admin/plugins.php',
  '/wp-admin/plugin-install.php',
  '/wp-admin/update-core.php',
  '/wp-admin/themes.php',
  '/wp-admin/theme-install.php',
  '/wp-admin/customize.php',
  '/wp-admin/widgets.php',
  '/wp-admin/nav-menus.php',
  '/wp-admin/site-editor.php',
  '/wp-admin/users.php',
  '/wp-admin/user-new.php',
  '/wp-admin/profile.php',
  '/wp-admin/tools.php',
  '/wp-admin/import.php',
  '/wp-admin/export.php',
  '/wp-admin/site-health.php',
  '/wp-admin/options-general.php',
  '/wp-admin/options-writing.php',
  '/wp-admin/options-reading.php',
  '/wp-admin/options-discussion.php',
  '/wp-admin/options-media.php',
  '/wp-admin/options-permalink.php',
  '/wp-admin/options-privacy.php',
];

const NETWORK_IDLE_PROBE_TIMEOUT_MS = 1000;

async function createSite(sitePath) {
  return createStudioSite(sitePath, {
    name: `Studio Bench ${variant()} Page Timing Matrix ${process.pid}`,
    timeoutMs: 420000,
  });
}

async function siteStatus(sitePath) {
  return studioSiteStatus(sitePath, { timeoutMs: 90000 });
}

async function stopSite(sitePath) {
  return stopStudioSite(sitePath, { timeoutMs: 90000 });
}

async function cleanupSite(sitePath) {
  if (keepGeneratedSite()) {
    return;
  }

  await rm(sitePath, { recursive: true, force: true });
}

function configuredPaths() {
  const raw = setting('studio_page_timing_paths') || process.env.STUDIO_PAGE_TIMING_PATHS || '';
  if (!raw.trim()) {
    return { paths: DEFAULT_PATHS, includeAdminMenu: false };
  }

  if (raw.trim() === 'admin-menu') {
    return { paths: [], includeAdminMenu: true };
  }

  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      const values = parsed.map(String).map((value) => value.trim()).filter(Boolean);
      return normalizeConfiguredPaths(values);
    }
  } catch {
    // Fall back to comma/newline separated values.
  }

  return normalizeConfiguredPaths(raw.split(/[,\n]/).map((value) => value.trim()).filter(Boolean));
}

function browserLaunchOptions() {
  const executablePath = setting('studio_browser_executable_path') || process.env.STUDIO_BROWSER_EXECUTABLE_PATH || '';
  return executablePath ? { executablePath } : {};
}

function keepGeneratedSite() {
  const value = setting('studio_page_timing_keep_site') || process.env.STUDIO_PAGE_TIMING_KEEP_SITE || '';
  return ['1', 'true', 'yes'].includes(String(value).trim().toLowerCase());
}

function normalizeConfiguredPaths(values) {
  return {
    paths: values.filter((value) => value !== 'admin-menu'),
    includeAdminMenu: values.includes('admin-menu'),
  };
}

function uniquePaths(values) {
  const seen = new Set();
  const paths = [];
  for (const value of values) {
    if (!value || seen.has(value)) {
      continue;
    }
    seen.add(value);
    paths.push(value);
  }
  return paths;
}

function pageUrl(siteUrl, pagePath) {
  if (/^https?:\/\//i.test(pagePath)) {
    return pagePath;
  }
  const normalized = pagePath.startsWith('/') ? pagePath.slice(1) : pagePath;
  const base = siteUrl.endsWith('/') ? siteUrl : `${siteUrl}/`;
  return new URL(normalized, base).toString();
}

function metricName(pagePath) {
  const clean = pagePath
    .replace(/^https?:\/\/[^/]+/i, '')
    .replace(/^\/+|\/+$/g, '') || 'front_page';
  return clean.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'page';
}

function scrubUrl(url, siteUrl) {
  try {
    const parsed = new URL(url);
    const base = new URL(siteUrl);
    if (parsed.origin === base.origin) {
      return `${parsed.pathname}${parsed.search}`;
    }
  } catch {
    // Fall through to normal redaction.
  }
  return redact(url);
}

function summarizeRequests(requests, siteUrl) {
  return requests
    .filter((request) => request.duration_ms > 10 || request.failed || request.status >= 400)
    .sort((a, b) => {
      if (a.failed !== b.failed) {
        return a.failed ? -1 : 1;
      }
      return metric(b.duration_ms) - metric(a.duration_ms);
    })
    .slice(0, 40)
    .map((request) => ({
      ...request,
      url: scrubUrl(request.url, siteUrl),
    }));
}

async function navigationTimings(page) {
  return page.evaluate(() => {
    const navigation = performance.getEntriesByType('navigation').at(-1);
    const paint = performance.getEntriesByType('paint');
    const fcp = paint.find((entry) => entry.name === 'first-contentful-paint');
    const resources = performance.getEntriesByType('resource').map((entry) => ({
      name: entry.name,
      initiatorType: entry.initiatorType,
      startTime: entry.startTime,
      duration: entry.duration,
      requestStart: entry.requestStart,
      responseStart: entry.responseStart,
      responseEnd: entry.responseEnd,
      transferSize: entry.transferSize,
      encodedBodySize: entry.encodedBodySize,
      decodedBodySize: entry.decodedBodySize,
    }));

    return {
      domcontentloaded_ms: navigation?.domContentLoadedEventEnd || 0,
      load_ms: navigation?.loadEventEnd || 0,
      ttfb_ms: navigation ? navigation.responseStart - navigation.requestStart : 0,
      response_end_ms: navigation?.responseEnd || 0,
      first_contentful_paint_ms: fcp?.startTime || 0,
      transfer_size: navigation?.transferSize || 0,
      encoded_body_size: navigation?.encodedBodySize || 0,
      decoded_body_size: navigation?.decodedBodySize || 0,
      resource_count: resources.length,
      slowest_resources: resources
        .slice()
        .sort((a, b) => b.duration - a.duration)
        .slice(0, 20),
    };
  });
}

async function waitForPathReady(page, pagePath) {
  if (/\/wp-admin\/site-editor\.php(?:$|[?#])/i.test(pagePath)) {
    await page.locator('body').waitFor({ timeout: 120000 });
    await page.locator('iframe[name="editor-canvas"]').first().waitFor({ state: 'visible', timeout: 120000 });
    return;
  }

  if (/\/wp-admin\//i.test(pagePath)) {
    await page.locator('#wpbody-content, body.wp-admin').first().waitFor({ timeout: 120000 });
    return;
  }

  await page.locator('body').waitFor({ timeout: 120000 });
}

async function collectAdminMenuPaths(page, siteUrl) {
  const links = await page.evaluate(() =>
    [...document.querySelectorAll('#adminmenu a[href]')]
      .map((anchor) => anchor.href)
      .filter(Boolean)
  );
  const siteOrigin = new URL(siteUrl).origin;
  return uniquePaths(
    links
      .map((href) => {
        try {
          const parsed = new URL(href);
          if (parsed.origin !== siteOrigin || !parsed.pathname.startsWith('/wp-admin/')) {
            return '';
          }
          return `${parsed.pathname}${parsed.search}`;
        } catch {
          return '';
        }
      })
      .filter(Boolean)
  );
}

function summarizePage(page, siteUrl) {
  const failedRequests = page.requests.filter((request) => request.failed || request.status >= 400);
  const requestDurations = page.requests.map((request) => request.duration_ms).filter((value) => Number.isFinite(value));
  const slowestRequestMs = requestDurations.length ? Math.max(...requestDurations) : 0;
  return {
    ...page,
    final_url: scrubUrl(page.final_url, siteUrl),
    request_count: page.requests.length,
    requests: summarizeRequests(page.requests, siteUrl),
    failed_request_count: failedRequests.length,
    slowest_request_ms: slowestRequestMs,
  };
}

export default async function studioPageTimingMatrixBench() {
  const currentVariant = variant();
  const pathConfig = configuredPaths();
  const keepSite = keepGeneratedSite();
  let paths = [...pathConfig.paths];
  const runId = `${currentVariant}-page-timing-matrix-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const artifactDir = path.join(studioArtifactDir('studio-page-timing-matrix-artifacts'), runId);
  const sitePath = path.join(artifactDir, 'site');
  await mkdir(artifactDir, { recursive: true });

  const totalStarted = Date.now();
  let create;
  let statusResult;
  let stop;
  let status;
  let browserResult;
  const pages = [];
  const metrics = {};
  let loginFormSeen = 0;

  try {
    create = await createSite(sitePath);
    statusResult = await siteStatus(sitePath);
    status = parseStudioSiteStatus(statusResult.stdout);
    if (!status.siteUrl || !status.autoLoginUrl) {
      throw new Error(`site status missing siteUrl/autoLoginUrl: ${redact(statusResult.stdout).slice(0, 1000)}`);
    }

    browserResult = await runBrowserBench({
      id: 'studio-page-timing-matrix',
      artifactsDir: artifactDir,
      trace: true,
      screenshot: true,
      waitForNetworkIdle: false,
      launchOptions: browserLaunchOptions(),
      action: async ({ page, mark }) => {
        await page.goto(status.autoLoginUrl, { waitUntil: 'domcontentloaded', timeout: 120000 });
        await page.waitForLoadState('networkidle', { timeout: 120000 }).catch(() => {});
        await mark('auto_login_ready');

        if (pathConfig.includeAdminMenu) {
          paths = uniquePaths([...paths, ...(await collectAdminMenuPaths(page, status.siteUrl))]);
        }

        for (const pagePath of paths) {
          const label = metricName(pagePath);
          const targetUrl = pageUrl(status.siteUrl, pagePath);
          const requests = [];
          const startedRequests = new Map();
          const onRequest = (request) => {
            startedRequests.set(request, performance.now());
          };
          const onFinished = async (request) => {
            const started = startedRequests.get(request) || performance.now();
            const response = await request.response().catch(() => null);
            requests.push({
              url: request.url(),
              method: request.method(),
              status: response?.status() || 0,
              failed: false,
              duration_ms: performance.now() - started,
              resource_type: request.resourceType(),
            });
          };
          const onFailed = (request) => {
            const started = startedRequests.get(request) || performance.now();
            requests.push({
              url: request.url(),
              method: request.method(),
              status: 0,
              failed: true,
              failure: request.failure()?.errorText || 'request failed',
              duration_ms: performance.now() - started,
              resource_type: request.resourceType(),
            });
          };

          page.on('request', onRequest);
          page.on('requestfinished', onFinished);
          page.on('requestfailed', onFailed);

          const started = performance.now();
          let response;
          let loadTimedOut = false;
          let networkIdleTimedOut = false;
          let networkIdleMs = 0;
          let readyError = '';
          let loadMs = 0;
          let readyMs = 0;
          try {
            response = await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 120000 });
            await page.waitForLoadState('load', { timeout: 120000 }).catch(() => {
              loadTimedOut = true;
            });
            loadMs = performance.now() - started;
            await waitForPathReady(page, pagePath).catch((error) => {
              readyError = error.message;
            });
            readyMs = performance.now() - started;
            await page.waitForLoadState('networkidle', { timeout: NETWORK_IDLE_PROBE_TIMEOUT_MS }).then(
              () => {
                networkIdleMs = performance.now() - started;
              },
              () => {
                networkIdleTimedOut = true;
              }
            );
            if (!networkIdleMs) {
              networkIdleMs = performance.now() - started;
            }
          } finally {
            page.off('request', onRequest);
            page.off('requestfinished', onFinished);
            page.off('requestfailed', onFailed);
            if (!readyMs) {
              readyMs = performance.now() - started;
            }
            if (!loadMs) {
              loadMs = readyMs;
            }
            if (!networkIdleMs) {
              networkIdleMs = readyMs;
            }
          }

          const timing = await navigationTimings(page).catch(() => ({}));
          const pageLoginFormSeen = await page.locator('#loginform').count().catch(() => 0);
          loginFormSeen += pageLoginFormSeen;
          pages.push({
            path: pagePath,
            label,
            requested_url: scrubUrl(targetUrl, status.siteUrl),
            final_url: page.url(),
            status: response?.status() || 0,
            ready_ms: readyMs,
            elapsed_ms: readyMs,
            load_probe_ms: loadMs,
            network_idle_probe_ms: networkIdleMs,
            network_idle_probe_timeout_ms: NETWORK_IDLE_PROBE_TIMEOUT_MS,
            load_timed_out: loadTimedOut,
            network_idle_timed_out: networkIdleTimedOut,
            ready_error: readyError,
            login_form_seen: pageLoginFormSeen,
            timings: timing,
            requests,
          });
          await mark(`page_${label}_done`);
        }
      },
    });

    await sanitizeArtifact(browserResult.artifacts?.network);
    stop = await stopSite(sitePath);

    const totalElapsedMs = Date.now() - totalStarted;
    const summarizedPages = pages.map((page) => summarizePage(page, status.siteUrl));
    let failingPageCount = 0;
    let slowestPageMs = 0;
    for (const page of summarizedPages) {
      const label = page.label;
      const failed = page.status >= 500 || page.status === 0 || page.login_form_seen > 0 || Boolean(page.ready_error);
      if (failed) {
        failingPageCount += 1;
      }
      slowestPageMs = Math.max(slowestPageMs, metric(page.elapsed_ms));
      metrics[`page_${label}_status`] = metric(page.status);
      metrics[`page_${label}_elapsed_ms`] = metric(page.elapsed_ms);
      metrics[`page_${label}_ready_ms`] = metric(page.ready_ms);
      metrics[`page_${label}_load_probe_ms`] = metric(page.load_probe_ms);
      metrics[`page_${label}_network_idle_probe_ms`] = metric(page.network_idle_probe_ms);
      metrics[`page_${label}_domcontentloaded_ms`] = metric(page.timings?.domcontentloaded_ms);
      metrics[`page_${label}_load_ms`] = metric(page.timings?.load_ms);
      metrics[`page_${label}_ttfb_ms`] = metric(page.timings?.ttfb_ms);
      metrics[`page_${label}_first_contentful_paint_ms`] = metric(page.timings?.first_contentful_paint_ms);
      metrics[`page_${label}_request_count`] = metric(page.request_count);
      metrics[`page_${label}_failed_request_count`] = metric(page.failed_request_count);
      metrics[`page_${label}_slowest_request_ms`] = metric(page.slowest_request_ms);
      metrics[`page_${label}_login_form_seen`] = metric(page.login_form_seen);
      metrics[`page_${label}_load_timed_out`] = page.load_timed_out ? 1 : 0;
      metrics[`page_${label}_network_idle_timed_out`] = page.network_idle_timed_out ? 1 : 0;
      metrics[`page_${label}_ready_failed`] = page.ready_error ? 1 : 0;
    }

    const artifactFile = path.join(artifactDir, `result-${runId}.json`);
    await writeFile(
      artifactFile,
      JSON.stringify(
        {
          variant: currentVariant,
          sitePath,
          siteUrl: status.siteUrl,
          paths,
          timings: {
            site_create_ms: create.elapsedMs,
            site_status_ms: statusResult.elapsedMs,
            total_elapsed_ms: totalElapsedMs,
          },
          pages: summarizedPages,
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

    if (failingPageCount > 0) {
      throw new Error(`Studio page timing matrix found ${failingPageCount} failing page(s); raw_result=${artifactFile}`);
    }

    return {
      metrics: {
        success_rate: 1,
        elapsed_ms: totalElapsedMs,
        page_count: paths.length,
        failing_page_count: failingPageCount,
        slowest_page_ms: slowestPageMs,
        site_create_ms: metric(create.elapsedMs),
        site_status_ms: metric(statusResult.elapsedMs),
        login_form_seen: metric(loginFormSeen),
        total_elapsed_ms: totalElapsedMs,
        ...metrics,
        ...browserResult.metrics,
      },
      artifacts: {
        raw_result: artifactFile,
        ...(keepSite ? { site_path: sitePath } : {}),
        ...browserResult.artifacts,
      },
    };
  } finally {
    if (!stop) {
      stop = await stopSite(sitePath);
    }
    await cleanupSite(sitePath);
  }
}
