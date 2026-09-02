import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

const DEFAULT_TARGET_URL = 'https://playground.wordpress.net/';
const DEFAULT_TIMEOUT_MS = 120000;
const VIEWPORT_SELECTOR = '#playground-viewport:visible,.playground-viewport:visible';

function validateTargetUrl(value) {
  const target = new URL(value || DEFAULT_TARGET_URL);
  if (!['http:', 'https:'].includes(target.protocol)) {
    throw new Error(`playground_cold_boot_target_url must use HTTP or HTTPS, got ${target.protocol}`);
  }
  return target.toString();
}

async function waitForNonEmptyBody(body, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      await body.waitFor({ state: 'attached', timeout: Math.min(1000, deadline - Date.now()) });
      const ready = await body.evaluate(
        (element) => element.childElementCount > 0 || Boolean(element.textContent?.trim())
      );
      if (ready) {
        return;
      }
    } catch (error) {
      // The wrapper and WordPress frames navigate during boot; retry against the current document.
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  throw new Error(
    `Timed out after ${timeoutMs}ms waiting for the nested WordPress document to render${lastError ? `: ${lastError.message}` : ''}`
  );
}

async function frameNavigationMetrics(body) {
  return body.evaluate((element) => {
    const frameWindow = element.ownerDocument.defaultView;
    const navigation = frameWindow?.performance.getEntriesByType('navigation').at(-1);
    const paint = frameWindow?.performance.getEntriesByType('paint') || [];
    const fcp = paint.find((entry) => entry.name === 'first-contentful-paint');
    return {
      domcontentloaded_ms: navigation?.domContentLoadedEventEnd || 0,
      load_ms: navigation?.loadEventEnd || 0,
      response_start_ms: navigation?.responseStart || 0,
      response_end_ms: navigation?.responseEnd || 0,
      ttfb_ms: navigation ? navigation.responseStart - navigation.requestStart : 0,
      first_contentful_paint_ms: fcp?.startTime || 0,
    };
  });
}

export default async function playgroundBrowserColdBootBench() {
  const browserHelperPath = process.env.HOMEBOY_NODEJS_BROWSER_BENCH_HELPER;
  const workloadUtilsPath = process.env.HOMEBOY_NODEJS_WORKLOAD_UTILS;
  if (!browserHelperPath) {
    throw new Error('HOMEBOY_NODEJS_BROWSER_BENCH_HELPER is required');
  }
  if (!workloadUtilsPath) {
    throw new Error('HOMEBOY_NODEJS_WORKLOAD_UTILS is required');
  }

  const { artifactDir, runId, setting, settingInt } = await import(workloadUtilsPath);
  const { buildBrowserBenchResult, runBrowserBench } = await import(browserHelperPath);
  const targetUrl = validateTargetUrl(setting('playground_cold_boot_target_url', DEFAULT_TARGET_URL));
  const browserName = setting('playground_cold_boot_browser', 'chromium');
  const timeoutMs = settingInt('playground_cold_boot_timeout_ms', DEFAULT_TIMEOUT_MS, { min: 1000 });
  const id = runId('playground-browser-cold-boot');
  const artifactsRoot = process.env.HOMEBOY_BENCH_ARTIFACTS_DIR || artifactDir('playground-browser-cold-boot');
  const artifactsDir = path.join(artifactsRoot, id);
  await mkdir(artifactsDir, { recursive: true });

  let responseStatus = 0;
  let navigationResponseMs = 0;
  let topLevelDomContentLoadedMs = 0;
  let wrapperReadyMs = 0;
  let coldBootMs = 0;
  let nestedNavigation = {};

  const browserResult = await runBrowserBench({
    id,
    artifactsDir,
    browserName,
    contextOptions: {
      viewport: { width: 1440, height: 900 },
    },
    networkIdleTimeoutMs: 1000,
    waitForNetworkIdle: false,
    action: async ({ page, mark }) => {
      const navigationStarted = performance.now();
      const response = await page.goto(targetUrl, { waitUntil: 'commit', timeout: timeoutMs });
      responseStatus = response?.status() || 0;
      navigationResponseMs = performance.now() - navigationStarted;
      await mark('top_level_response');

      await page.waitForLoadState('domcontentloaded', { timeout: timeoutMs });
      topLevelDomContentLoadedMs = performance.now() - navigationStarted;
      await mark('top_level_domcontentloaded');

      const wrapper = page.locator(VIEWPORT_SELECTOR).first();
      await wrapper.waitFor({ state: 'visible', timeout: timeoutMs });
      wrapperReadyMs = performance.now() - navigationStarted;
      await mark('playground_wrapper_ready');

      const wordpressBody = page
        .frameLocator(VIEWPORT_SELECTOR)
        .frameLocator('#wp')
        .locator('body');
      await waitForNonEmptyBody(wordpressBody, timeoutMs);
      coldBootMs = performance.now() - navigationStarted;
      nestedNavigation = await frameNavigationMetrics(wordpressBody);
      await mark('wordpress_document_ready');
    },
  });

  if (responseStatus < 200 || responseStatus >= 400) {
    throw new Error(`Playground returned HTTP status ${responseStatus}`);
  }

  const measurement = {
    schema: 'homeboy-rigs/playground-browser-cold-boot/v1',
    target_url: targetUrl,
    browser: browserName,
    cold_definition: 'Fresh browser process and profile; navigation start to non-empty body in the nested WordPress #wp frame.',
    timings: {
      navigation_response_ms: navigationResponseMs,
      top_level_domcontentloaded_ms: topLevelDomContentLoadedMs,
      playground_wrapper_ready_ms: wrapperReadyMs,
      cold_boot_ms: coldBootMs,
      nested_wordpress: nestedNavigation,
    },
    response_status: responseStatus,
  };
  const rawResultPath = path.join(artifactsDir, `${id}-raw-result.json`);
  await writeFile(rawResultPath, `${JSON.stringify({
    ...measurement,
    browser_metrics: browserResult.metrics,
    browser_artifacts: browserResult.artifacts,
  }, null, 2)}\n`);

  return buildBrowserBenchResult({
    metrics: {
      ...browserResult.metrics,
      success_rate: 1,
      response_status: responseStatus,
      navigation_response_ms: navigationResponseMs,
      top_level_domcontentloaded_ms: topLevelDomContentLoadedMs,
      playground_wrapper_ready_ms: wrapperReadyMs,
      cold_boot_ms: coldBootMs,
      nested_wordpress_domcontentloaded_ms: nestedNavigation.domcontentloaded_ms || 0,
      nested_wordpress_load_ms: nestedNavigation.load_ms || 0,
      nested_wordpress_ttfb_ms: nestedNavigation.ttfb_ms || 0,
      nested_wordpress_first_contentful_paint_ms: nestedNavigation.first_contentful_paint_ms || 0,
    },
    artifacts: {
      ...browserResult.artifacts,
      raw_result: {
        path: rawResultPath,
        kind: 'browser-page-scenario-result',
        label: 'WordPress Playground cold-boot raw result',
      },
    },
    metadata: {
      target_url: targetUrl,
      browser: browserName,
      browser_cache: 'ephemeral-profile',
      service_worker_state: 'ephemeral-profile',
      readiness: 'nested-wordpress-body-non-empty',
    },
  });
}
