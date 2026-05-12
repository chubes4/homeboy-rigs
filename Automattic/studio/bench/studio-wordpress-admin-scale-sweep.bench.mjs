import { cp, mkdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  artifactDir as studioArtifactDir,
  createStudioSite,
  expandHome,
  metric,
  parseStudioSiteStatus,
  redact,
  runCli,
  safeResult,
  sanitizeArtifact,
  setting,
  startStudioSite,
  stopStudioSite,
  studioSiteStatus,
  variant,
} from './lib/studio-bench.mjs';
import {
  loadWordPressAdminScaleSweepManifest,
} from './lib/wordpress-admin-scale-sweep.mjs';
import {
  loadWordPressPageProfiler,
  loadWordPressRequestProfiler,
} from './lib/wordpress-page-profiler.mjs';

const BROWSER_HELPER = process.env.HOMEBOY_NODEJS_BROWSER_BENCH_HELPER;

if (!BROWSER_HELPER) {
  throw new Error('HOMEBOY_NODEJS_BROWSER_BENCH_HELPER is required');
}

const { runBrowserBench } = await import(BROWSER_HELPER);

async function createSite(sitePath) {
  return createStudioSite(sitePath, {
    name: `Studio Bench ${variant()} WordPress Admin Scale Sweep ${process.pid}`,
    wp: process.env.HOMEBOY_WORDPRESS_ADMIN_SCALE_SWEEP_WP_VERSION || process.env.HOMEBOY_WORDPRESS_PAGE_PROFILE_WP_VERSION,
    php: process.env.HOMEBOY_WORDPRESS_ADMIN_SCALE_SWEEP_PHP_VERSION || process.env.HOMEBOY_WORDPRESS_PAGE_PROFILE_PHP_VERSION,
    timeoutMs: 420000,
  });
}

async function siteStatus(sitePath) {
  return studioSiteStatus(sitePath, { timeoutMs: 90000 });
}

async function stopSite(sitePath) {
  return stopStudioSite(sitePath, { timeoutMs: 90000 });
}

function profilePlugins() {
  const json = process.env.HOMEBOY_WORDPRESS_ADMIN_SCALE_SWEEP_PLUGINS_JSON || process.env.HOMEBOY_WORDPRESS_PAGE_PROFILE_PLUGINS_JSON;
  if (json) {
    const parsed = JSON.parse(json);
    if (!Array.isArray(parsed)) {
      throw new Error('HOMEBOY_WORDPRESS_ADMIN_SCALE_SWEEP_PLUGINS_JSON must be an array');
    }
    return parsed.map((plugin) => {
      if (typeof plugin === 'string') {
        return { path: expandHome(plugin) };
      }
      return { ...plugin, path: expandHome(plugin.path) };
    });
  }

  const paths = process.env.HOMEBOY_WORDPRESS_ADMIN_SCALE_SWEEP_PLUGIN_PATHS || process.env.HOMEBOY_WORDPRESS_PAGE_PROFILE_PLUGIN_PATHS;
  if (!paths) {
    return [];
  }
  return paths
    .split(',')
    .map((pluginPath) => ({ path: expandHome(pluginPath.trim()) }))
    .filter((plugin) => plugin.path);
}

async function installProfilePlugins(sitePath) {
  const plugins = profilePlugins();
  if (plugins.length === 0) {
    return [];
  }

  const pluginDir = path.join(sitePath, 'wp-content', 'plugins');
  await mkdir(pluginDir, { recursive: true });

  const installed = [];
  for (const plugin of plugins) {
    if (!plugin.path) {
      throw new Error('Profile plugin entry requires a path');
    }
    const slug = plugin.slug || path.basename(plugin.path);
    const linkPath = path.join(pluginDir, slug);
    const backupPath = `${linkPath}.homeboy-profile-backup-${process.pid}-${Date.now()}`;
    let hadExistingPath = false;

    try {
      await rename(linkPath, backupPath);
      hadExistingPath = true;
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        throw error;
      }
    }

    await rm(linkPath, { recursive: true, force: true });
    if (plugin.copy === true) {
      await cp(plugin.path, linkPath, { recursive: true, force: true });
    } else {
      await symlink(plugin.path, linkPath, 'dir');
    }
    installed.push({ ...plugin, slug, linkPath, backupPath, hadExistingPath });
  }

  const activate = installed.filter((plugin) => plugin.activate !== false);
  const activateTimeoutMs = Number(process.env.HOMEBOY_WORDPRESS_ADMIN_SCALE_SWEEP_PLUGIN_ACTIVATE_TIMEOUT_MS || process.env.HOMEBOY_WORDPRESS_PAGE_PROFILE_PLUGIN_ACTIVATE_TIMEOUT_MS || 420000);
  for (const plugin of activate) {
    await runCli(['wp', 'plugin', 'activate', plugin.plugin || plugin.slug], { cwd: sitePath, timeoutMs: activateTimeoutMs });
  }

  return installed.map((plugin) => ({
    slug: plugin.slug,
    path: plugin.path,
    linkPath: plugin.linkPath,
    backupPath: plugin.backupPath,
    hadExistingPath: plugin.hadExistingPath,
  }));
}

async function restoreProfilePlugins(installedPlugins) {
  for (const plugin of [...installedPlugins].reverse()) {
    await rm(plugin.linkPath, { recursive: true, force: true });
    if (plugin.hadExistingPath) {
      await rename(plugin.backupPath, plugin.linkPath);
    }
  }
}

async function loadProfileExtensionModule() {
  const modulePath = expandHome(
    process.env.HOMEBOY_WORDPRESS_ADMIN_SCALE_SWEEP_EXTENSION_MODULE ||
      process.env.HOMEBOY_WORDPRESS_PAGE_PROFILE_EXTENSION_MODULE ||
      ''
  );
  if (!modulePath) {
    return null;
  }
  return import(pathToFileURL(modulePath).href);
}

function manifestHasInteractions(manifest) {
  return (manifest.pages || []).some((page) => Array.isArray(page.interactions) && page.interactions.length > 0);
}

function assertInteractionSupport({ manifest, pageProfiler, profileExtension }) {
  if (!manifestHasInteractions(manifest)) {
    return;
  }
  if (pageProfiler?.runBrowserActions || profileExtension?.runBrowserActions || profileExtension?.profileWordPressAdminScaleSweepPages) {
    return;
  }
  throw new Error('WordPress admin scale sweep manifest includes interactions, but the installed Homeboy WordPress page profiler does not expose runBrowserActions(). Update homeboy-extensions.');
}

function assertAdminSweepSummarySupport({ pageProfiler, profileExtension }) {
  const profiler = profileExtension || pageProfiler;
  if (
    profiler?.summarizeWordPressAdminPageProfile &&
    profiler?.buildWordPressAdminPageSweepSummary &&
    profiler?.formatWordPressAdminPageSweepMarkdownReport
  ) {
    return;
  }
  throw new Error('WordPress admin scale sweep requires admin page summary helpers. Update homeboy-extensions to include summarizeWordPressAdminPageProfile().');
}

function pageMetricId(pageSpec, pageSummary) {
  return pageSpec?.metricId || String(pageSummary.id || 'page')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '') || 'page';
}

function adaptAdminPageSummary({ pageSpec, pageSummary, profile, artifacts }) {
  return {
    ...pageSummary,
    metric_id: pageMetricId(pageSpec, pageSummary),
    status: metric(pageSummary.status),
    ready_ms: metric(pageSummary.readyMs),
    resource_count: metric(pageSummary.resourceCount),
    rest_count: metric(pageSummary.restCount),
    rest_bytes: metric(pageSummary.restBytes),
    failed_request_count: metric(pageSummary.failedRequestCount),
    failure_count: metric(pageSummary.failureCount),
    slowest_resource_ms: metric(pageSummary.slowestResources?.[0]?.durationMs),
    slowest_resources: pageSummary.slowestResources || [],
    slowest_requests: pageSummary.slowestRestRows || [],
    failures: [
      ...(pageSummary.failedRestRows || []).map((row) => ({ type: 'rest', url: row.url, status: row.status || 0, error: row.error || '' })),
      ...(pageSummary.findings || []).map((finding) => ({ type: 'budget', code: finding.code, error: finding.message })),
    ],
    interaction: profile?.interactions || null,
    artifacts: artifacts || {},
    rawProfile: profile,
    profileSummary: pageSummary,
  };
}

function summarizeWordPressRequests(entries = []) {
  const byRequest = new Map();
  for (const entry of entries) {
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
      };
    })
    .sort((a, b) => b.duration_ms - a.duration_ms)
    .slice(0, 120);
}

export default async function studioWordPressAdminScaleSweepBench() {
  const currentVariant = variant();
  const { path: profilerPath, module: profiler } = loadWordPressRequestProfiler();
  const { path: pageProfilerPath, module: pageProfiler } = loadWordPressPageProfiler({ profilerPath });
  const manifest = await loadWordPressAdminScaleSweepManifest({
    json: setting('wordpress_admin_scale_sweep_manifest_json'),
    path: expandHome(setting('wordpress_admin_scale_sweep_manifest')),
    pageProfiler,
  });
  const runId = `${currentVariant}-wordpress-admin-scale-sweep-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const artifactDir = path.join(studioArtifactDir('studio-wordpress-admin-scale-sweep-artifacts'), runId);
  const existingSitePath = expandHome(
    setting('wordpress_admin_scale_sweep_site_path') ||
    process.env.HOMEBOY_WORDPRESS_ADMIN_SCALE_SWEEP_SITE_PATH ||
      process.env.HOMEBOY_WORDPRESS_PAGE_PROFILE_SITE_PATH ||
      ''
  );
  const sitePath = existingSitePath || path.join(artifactDir, 'site');
  const createdSite = !existingSitePath;
  await mkdir(artifactDir, { recursive: true });

  const totalStarted = Date.now();
  let create;
  let start;
  let initialStatusResult;
  let statusResult;
  let stop;
  let status;
  let browserResult;
  let setupProfile = null;
  let profileExtension = null;
  let installedPlugins = [];
  let loginFormSeen = 0;
  let wordpressRequests = [];
  const pageResults = [];
  const metrics = {};

  try {
    if (createdSite) {
      create = await createSite(sitePath);
    } else {
      start = await startStudioSite(sitePath, { timeoutMs: 240000 });
    }
    initialStatusResult = await siteStatus(sitePath);
    installedPlugins = await installProfilePlugins(sitePath);
    profileExtension = await loadProfileExtensionModule();
    assertInteractionSupport({ manifest, pageProfiler, profileExtension });
    assertAdminSweepSummarySupport({ pageProfiler, profileExtension });
    if (profileExtension?.setupWordPressAdminScaleSweep || profileExtension?.setupWordPressPageProfile) {
      const startedSetup = Date.now();
      const setup = profileExtension.setupWordPressAdminScaleSweep || profileExtension.setupWordPressPageProfile;
      setupProfile = await setup({ sitePath, artifactDir, manifest, pageSpecs: manifest.pages, pageSpec: manifest.pages[0], runCli });
      setupProfile = { elapsedMs: Date.now() - startedSetup, ...setupProfile };
    }

    statusResult = await siteStatus(sitePath);
    status = parseStudioSiteStatus(statusResult.stdout);
    if (!status.siteUrl || !status.autoLoginUrl) {
      throw new Error(`site status missing siteUrl/autoLoginUrl: ${redact(statusResult.stdout).slice(0, 1000)}`);
    }

    profiler?.installWordPressRequestProfiler?.(sitePath);

    browserResult = await runBrowserBench({
      id: 'studio-wordpress-admin-scale-sweep',
      artifactsDir: artifactDir,
      trace: true,
      screenshot: true,
      waitForNetworkIdle: false,
      action: async ({ page, mark }) => {
        await page.goto(status.autoLoginUrl, { waitUntil: 'domcontentloaded', timeout: 120000 });
        await page.waitForLoadState('networkidle', { timeout: 120000 }).catch(() => {});
        await mark('auto_login_ready');
        loginFormSeen = await page.locator('#loginform').count().catch(() => 0);

        const runPagesProfile = profileExtension?.profileWordPressAdminScaleSweepPages || profileExtension?.profileWordPressPages || pageProfiler?.profileWordPressPages;
        const adminPageProfiler = profileExtension?.summarizeWordPressAdminPageProfile ? profileExtension : pageProfiler;
        if (!runPagesProfile) {
          throw new Error('WordPress admin scale sweep requires pageProfiler.profileWordPressPages(). Update homeboy-extensions.');
        }

        const sweepProfile = await runPagesProfile({
          page,
          baseUrl: status.siteUrl,
          siteUrl: status.siteUrl,
          pageProfiler,
          manifest,
          mark,
        });

        const pageSummaries = [];
        for (const profile of sweepProfile.pages || []) {
          const pageSpec = manifest.pages.find((candidate) => candidate.id === profile.id) || { id: profile.id, label: profile.label, path: profile.path };
          const pageSummary = adminPageProfiler.summarizeWordPressAdminPageProfile({ profile, spec: pageSpec });
          pageSummaries.push(pageSummary);
          pageResults.push(
            adaptAdminPageSummary({
              pageSpec,
              pageSummary,
              profile,
            })
          );
        }
        pageResults.profileSummaries = pageSummaries;
      },
    });

    await sanitizeArtifact(browserResult.artifacts?.network);
    wordpressRequests = profiler?.collectWordPressRequestProfiles?.(sitePath) || [];
    profiler?.uninstallWordPressRequestProfiler?.(sitePath);
    if (createdSite) {
      stop = await stopSite(sitePath);
    }

    const totalElapsedMs = Date.now() - totalStarted;
    for (const page of pageResults) {
      const pageMetricId = page.metric_id || page.id;
      page.artifacts = {
        trace: browserResult.artifacts?.trace,
        screenshot: browserResult.artifacts?.screenshot,
        network: browserResult.artifacts?.network,
      };
      metrics[`page_${pageMetricId}_status`] = metric(page.status);
      metrics[`page_${pageMetricId}_ready_ms`] = metric(page.ready_ms);
      metrics[`page_${pageMetricId}_rest_count`] = metric(page.rest_count);
      metrics[`page_${pageMetricId}_rest_bytes`] = metric(page.rest_bytes);
      metrics[`page_${pageMetricId}_failed_request_count`] = metric(page.failed_request_count);
      metrics[`page_${pageMetricId}_failure_count`] = metric(page.failure_count);
      metrics[`page_${pageMetricId}_slowest_resource_ms`] = metric(page.slowest_resource_ms);
    }

    const adminPageProfiler = profileExtension?.buildWordPressAdminPageSweepSummary ? profileExtension : pageProfiler;
    const summary = adminPageProfiler.buildWordPressAdminPageSweepSummary(pageResults.profileSummaries || pageResults.map((page) => page.profileSummary));
    summary.markdown = adminPageProfiler.formatWordPressAdminPageSweepMarkdownReport(summary, { title: 'WordPress admin scale sweep' });
    const failingPageCount = summary.totals.failedPageCount;
    const slowestPageMs = Math.max(0, ...pageResults.map((page) => metric(page.ready_ms)));
    const artifactFile = path.join(artifactDir, `result-${runId}.json`);
    await writeFile(
      artifactFile,
      JSON.stringify(
        {
          variant: currentVariant,
          manifest,
          profilerPath,
          profilerAvailable: Boolean(profiler),
          pageProfilerPath,
          pageProfilerAvailable: Boolean(pageProfiler),
          sitePath,
          siteUrl: status.siteUrl,
          installedPlugins,
          setupProfile,
          timings: {
            site_create_ms: create?.elapsedMs || 0,
            site_initial_status_ms: initialStatusResult.elapsedMs,
            setup_profile_ms: setupProfile?.elapsedMs || 0,
            site_status_ms: statusResult.elapsedMs,
            total_elapsed_ms: totalElapsedMs,
          },
          pages: pageResults,
          combinedSummary: summary,
          wordpressRequests: summarizeWordPressRequests(wordpressRequests),
          commands: {
            create: safeResult(create),
            start: safeResult(start),
            initialStatus: safeResult(initialStatusResult),
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

    if (loginFormSeen > 0) {
      throw new Error(`Login form remained visible after auto-login; raw_result=${artifactFile}`);
    }
    if (failingPageCount > 0) {
      throw new Error(`WordPress admin scale sweep found ${failingPageCount} failing page(s); raw_result=${artifactFile}`);
    }
    if (!browserResult.artifacts?.trace || !browserResult.artifacts?.screenshot) {
      throw new Error(`Browser trace/screenshot artifacts missing; raw_result=${artifactFile}`);
    }

    return {
      metrics: {
        success_rate: 1,
        elapsed_ms: totalElapsedMs,
        page_count: pageResults.length,
        failing_page_count: failingPageCount,
        slowest_page_ms: slowestPageMs,
        site_create_ms: metric(create?.elapsedMs),
        site_initial_status_ms: metric(initialStatusResult.elapsedMs),
        setup_profile_ms: metric(setupProfile?.elapsedMs),
        site_status_ms: metric(statusResult.elapsedMs),
        login_form_seen: metric(loginFormSeen),
        total_elapsed_ms: totalElapsedMs,
        ...metrics,
        ...browserResult.metrics,
      },
      artifacts: {
        raw_result: artifactFile,
        site_path: sitePath,
        ...browserResult.artifacts,
      },
    };
  } finally {
    if (profileExtension?.cleanupWordPressAdminScaleSweep || profileExtension?.cleanupWordPressPageProfile) {
      const cleanup = profileExtension.cleanupWordPressAdminScaleSweep || profileExtension.cleanupWordPressPageProfile;
      await cleanup({ sitePath, setupProfile, manifest, pageSpecs: manifest.pages, pageSpec: manifest.pages[0] });
    }
    if (profiler) {
      profiler.uninstallWordPressRequestProfiler?.(sitePath);
    }
    await restoreProfilePlugins(installedPlugins);
    if (createdSite && !stop) {
      stop = await stopSite(sitePath);
    }
  }
}
