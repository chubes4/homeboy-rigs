import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  artifactDir as studioArtifactDir,
  createStudioSite,
  metric,
  parseStudioSiteStatus,
  redact,
  safeResult,
  setting,
  stopStudioSite,
  studioSiteStatus,
  variant,
} from './lib/studio-bench.mjs';
import {
  collectWordPressBootstrapTimeline,
  installWordPressBootstrapTimeline,
  summarizeWordPressBootstrapTimeline,
  uninstallWordPressBootstrapTimeline,
} from './lib/wordpress-bootstrap-timeline.mjs';
import { loadWordPressRequestProfiler } from './lib/wordpress-page-profiler.mjs';

const BROWSER_HELPER = process.env.HOMEBOY_NODEJS_BROWSER_BENCH_HELPER;

if (!BROWSER_HELPER) {
  throw new Error('HOMEBOY_NODEJS_BROWSER_BENCH_HELPER is required');
}

const { runBrowserBench } = await import(BROWSER_HELPER);

const DEFAULT_ROUTES = [
  '/wp-includes/css/dist/block-library/style.min.css',
  '/',
  '/wp-json/',
  '/wp-json/wp/v2/types/post?context=edit',
  '/wp-json/wp/v2/taxonomies?context=edit&per_page=100',
  '/wp-json/wp/v2/wp_pattern_category?context=view&per_page=100&_fields=id%2Cname%2Cdescription%2Cslug',
  '/wp-json/wp/v2/block-patterns/patterns',
  '/wp-json/wp/v2/blocks?context=edit&per_page=100&page=1',
  '/wp-json/wp/v2/templates/lookup?slug=front-page',
  '/wp-json/wp/v2/users/me?context=edit',
  '/wp-admin/admin-ajax.php',
];

function configuredRoutes() {
  const raw = setting('studio_rest_latency_routes') || process.env.STUDIO_REST_LATENCY_ROUTES || '';
  if (!raw.trim()) {
    return DEFAULT_ROUTES;
  }

  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed.map(String).map((value) => value.trim()).filter(Boolean);
    }
  } catch {
    // Fall back to comma/newline separated values.
  }

  return raw.split(/[,\n]/).map((value) => value.trim()).filter(Boolean);
}

function configuredIterations() {
  return Math.max(1, Number(setting('studio_rest_latency_iterations') || process.env.STUDIO_REST_LATENCY_ITERATIONS || 5));
}

function shouldProfileWordPress() {
  const raw = setting('studio_rest_latency_profile_wordpress') || process.env.STUDIO_REST_LATENCY_PROFILE_WORDPRESS || '1';
  return !['0', 'false', 'no'].includes(raw.toLowerCase());
}

function configuredWarmupIterations() {
  return Math.max(0, Number(setting('studio_rest_latency_warmup_iterations') || process.env.STUDIO_REST_LATENCY_WARMUP_ITERATIONS || 1));
}

function routeLabel(route) {
  return String(route || 'route')
    .replace(/^https?:\/\/[^/]+/i, '')
    .replace(/^\/+|\/+$/g, '')
    .replace(/\?.*$/, '')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase() || 'front_page';
}

function normalizeUri(uri) {
  return String(uri || '').replace(/_locale=user&?/g, '').replace(/[?&]$/, '');
}

function routeMatches(route, uri) {
  const key = normalizeUri(route);
  const normalized = normalizeUri(uri);
  if (key === '/') {
    return normalized === '/';
  }
  return normalized.startsWith(key);
}

function avg(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function summarizeProfilerRows(rows) {
  const byRequest = new Map();
  for (const row of rows || []) {
    if (!byRequest.has(row.request_id)) {
      byRequest.set(row.request_id, []);
    }
    byRequest.get(row.request_id).push(row);
  }

  return [...byRequest.values()].map((events) => {
    events.sort((a, b) => (a.t_ms || 0) - (b.t_ms || 0));
    const last = events[events.length - 1] || {};
    const bands = [];
    for (const start of events.filter((event) => event.event === 'hook.priority_band.start')) {
      const end = events.find(
        (event) => event.event === 'hook.priority_band.end' && event.data?.hook === start.data?.hook && event.t_ms >= start.t_ms
      );
      if (end) {
        bands.push({ hook: start.data?.hook, duration_ms: end.t_ms - start.t_ms });
      }
    }
    return { uri: last.uri || '', method: last.method || '', duration_ms: last.t_ms || 0, priority_bands: bands };
  });
}

function averageBootstrapDeltas(rows) {
  const totals = new Map();
  const counts = new Map();
  for (const row of rows || []) {
    for (const event of row.events || []) {
      totals.set(event.event, (totals.get(event.event) || 0) + event.delta_from_previous_ms);
      counts.set(event.event, (counts.get(event.event) || 0) + 1);
    }
  }

  return [...totals.entries()]
    .map(([event, total]) => ({ event, avg_delta_ms: total / counts.get(event) }))
    .sort((a, b) => b.avg_delta_ms - a.avg_delta_ms)
    .slice(0, 8);
}

function summarizeRoutes({ routes, browserResults, wpSummaries, bootstrapSummaries }) {
  return routes.map((route) => {
    const browserRows = browserResults.filter((row) => row.route === route);
    const wpRows = wpSummaries.filter((row) => routeMatches(route, row.uri));
    const bootRows = bootstrapSummaries.filter((row) => routeMatches(route, row.uri));
    return {
      route,
      label: routeLabel(route),
      n: browserRows.length,
      status_codes: [...new Set(browserRows.map((row) => row.status))],
      avg_total_ms: avg(browserRows.map((row) => row.total_ms)),
      avg_headers_ms: avg(browserRows.map((row) => row.headers_ms)),
      avg_body_bytes: avg(browserRows.map((row) => row.body_bytes)),
      avg_wordpress_muplugin_to_shutdown_ms: avg(wpRows.map((row) => row.duration_ms)),
      avg_entry_to_shutdown_ms: avg(bootRows.map((row) => row.duration_ms)),
      avg_outer_ms: bootRows.length ? avg(browserRows.map((row) => row.total_ms)) - avg(bootRows.map((row) => row.duration_ms)) : 0,
      wordpress_profile_count: wpRows.length,
      bootstrap_profile_count: bootRows.length,
      slowest_bootstrap_deltas: averageBootstrapDeltas(bootRows),
      slowest_priority_bands: wpRows.flatMap((row) => row.priority_bands).sort((a, b) => b.duration_ms - a.duration_ms).slice(0, 5),
    };
  });
}

async function sanitizeArtifact(artifact) {
  if (!artifact?.path) {
    return;
  }
  await writeFile(artifact.path, redact(await readFile(artifact.path, 'utf8')));
}

export default async function studioRestLatencyDiagnosticsBench() {
  const currentVariant = variant();
  const routes = configuredRoutes();
  const iterations = configuredIterations();
  const warmupIterations = configuredWarmupIterations();
  const profileWordPress = shouldProfileWordPress();
  const runId = `${currentVariant}-rest-latency-diagnostics-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const artifactDir = path.join(studioArtifactDir('studio-rest-latency-diagnostics-artifacts'), runId);
  const sitePath = path.join(artifactDir, 'site');
  await mkdir(artifactDir, { recursive: true });

  let create;
  let statusResult;
  let status;
  let stop;
  let browserResult;
  let profiler;

  try {
    create = await createStudioSite(sitePath, {
      name: `Studio Bench ${currentVariant} REST Latency Diagnostics ${process.pid}`,
      timeoutMs: 420000,
    });
    statusResult = await studioSiteStatus(sitePath, { timeoutMs: 90000 });
    status = parseStudioSiteStatus(statusResult.stdout);
    if (!status.siteUrl || !status.autoLoginUrl) {
      throw new Error(`site status missing siteUrl/autoLoginUrl: ${redact(statusResult.stdout).slice(0, 1000)}`);
    }

    const browserResults = [];
    let noncePrefix = '';
    browserResult = await runBrowserBench({
      id: 'studio-rest-latency-diagnostics',
      artifactsDir: artifactDir,
      trace: true,
      screenshot: true,
      waitForNetworkIdle: false,
      action: async ({ page, mark }) => {
        await page.goto(status.autoLoginUrl, { waitUntil: 'domcontentloaded', timeout: 120000 });
        await page.waitForLoadState('networkidle', { timeout: 120000 }).catch(() => {});
        await page.goto(new URL('/wp-admin/post-new.php', status.siteUrl).toString(), {
          waitUntil: 'domcontentloaded',
          timeout: 120000,
        });
        const nonce = await page.evaluate(() => globalThis.wpApiSettings?.nonce || '');
        if (!nonce) {
          throw new Error('wpApiSettings.nonce missing after post editor bootstrap');
        }
        noncePrefix = nonce.slice(0, 6);
        await mark('authenticated_with_rest_nonce');

        for (let iteration = 1; iteration <= warmupIterations; iteration += 1) {
          for (const route of routes) {
            await page.evaluate(async (targetRoute) => {
              const response = await fetch(targetRoute, {
                credentials: 'same-origin',
                headers: { 'X-WP-Nonce': globalThis.wpApiSettings.nonce },
              });
              await response.arrayBuffer();
            }, route);
          }
        }
        await mark('warmup_complete');

        if (profileWordPress) {
          await installWordPressBootstrapTimeline(sitePath, { clearArtifact: true });
          profiler = loadWordPressRequestProfiler();
          if (profiler.module?.installWordPressRequestProfiler) {
            profiler.module.installWordPressRequestProfiler(sitePath, { clearArtifact: true });
          }
        }

        for (let iteration = 1; iteration <= iterations; iteration += 1) {
          for (const route of routes) {
            browserResults.push({
              iteration,
              route,
              ...(await page.evaluate(async (targetRoute) => {
                const started = performance.now();
                const response = await fetch(targetRoute, {
                  credentials: 'same-origin',
                  headers: { 'X-WP-Nonce': globalThis.wpApiSettings.nonce },
                });
                const headersAt = performance.now();
                const text = await response.text();
                const end = performance.now();
                return {
                  status: response.status,
                  headers_ms: headersAt - started,
                  total_ms: end - started,
                  body_bytes: text.length,
                };
              }, route)),
            });
          }
        }
      },
    });

    await sanitizeArtifact(browserResult.artifacts?.network);

    const wpSummaries = profileWordPress && profiler?.module?.collectWordPressRequestProfiles
      ? summarizeProfilerRows(profiler.module.collectWordPressRequestProfiles(sitePath))
      : [];
    const bootstrapSummaries = profileWordPress
      ? summarizeWordPressBootstrapTimeline(await collectWordPressBootstrapTimeline(sitePath), { limit: 10000 })
      : [];
    const routeSummaries = summarizeRoutes({ routes, browserResults, wpSummaries, bootstrapSummaries });

    stop = await stopStudioSite(sitePath, { timeoutMs: 90000 });

    const metrics = {
      success_rate: 1,
      route_count: routes.length,
      fetch_count: browserResults.length,
      warmup_iterations: warmupIterations,
      site_create_ms: metric(create.elapsedMs),
      site_status_ms: metric(statusResult.elapsedMs),
      profile_wordpress: profileWordPress ? 1 : 0,
      slowest_route_ms: metric(Math.max(...routeSummaries.map((row) => row.avg_total_ms))),
      average_route_ms: metric(avg(routeSummaries.map((row) => row.avg_total_ms))),
      average_php_route_ms: metric(avg(routeSummaries.filter((row) => !row.route.includes('/wp-includes/')).map((row) => row.avg_total_ms))),
    };
    for (const row of routeSummaries) {
      metrics[`route_${row.label}_avg_total_ms`] = metric(row.avg_total_ms);
      metrics[`route_${row.label}_avg_headers_ms`] = metric(row.avg_headers_ms);
      metrics[`route_${row.label}_avg_body_bytes`] = metric(row.avg_body_bytes);
      metrics[`route_${row.label}_avg_entry_to_shutdown_ms`] = metric(row.avg_entry_to_shutdown_ms);
      metrics[`route_${row.label}_avg_outer_ms`] = metric(row.avg_outer_ms);
      metrics[`route_${row.label}_status_count`] = row.status_codes.length;
    }

    const artifactFile = path.join(artifactDir, `result-${runId}.json`);
    await writeFile(
      artifactFile,
      JSON.stringify(
        {
          variant: currentVariant,
          sitePath,
          siteUrl: status.siteUrl,
          routes,
          iterations,
          warmupIterations,
          profileWordPress,
          noncePrefix,
          routeSummaries,
          browserResults,
          wpSummaries,
          bootstrapSummaries,
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

    return {
      metrics: { ...metrics, ...browserResult.metrics },
      artifacts: {
        raw_result: artifactFile,
        site_path: sitePath,
        ...browserResult.artifacts,
      },
    };
  } finally {
    if (profileWordPress) {
      profiler?.module?.uninstallWordPressRequestProfiler?.(sitePath);
      await uninstallWordPressBootstrapTimeline(sitePath).catch(() => {});
    }
    if (!stop) {
      await stopStudioSite(sitePath, { timeoutMs: 90000 });
    }
  }
}
