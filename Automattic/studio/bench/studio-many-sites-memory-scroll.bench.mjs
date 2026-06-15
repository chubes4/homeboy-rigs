import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  STUDIO_PATH,
  artifactDir as studioArtifactDir,
  metric,
  redact,
  safeResult,
  setting,
  variant,
} from './lib/studio-bench.mjs';

const RUNNING_MODES = new Set(['all-stopped', 'half-running', 'all-running']);
const RUNTIMES = new Set(['playground', 'native-php']);
const benchHelperPath = process.env.HOMEBOY_RUNTIME_BENCH_HELPER_JS;
if (!benchHelperPath) {
  throw new Error('HOMEBOY_RUNTIME_BENCH_HELPER_JS is required for phase-aware Homeboy bench attribution. Update Homeboy.');
}
const { homeboyRunBenchPhase } = await import(pathToFileURL(benchHelperPath).href);

function boolSetting(name, defaultValue) {
  const value = String(setting(name) || '').trim().toLowerCase();
  if (!value) {
    return defaultValue;
  }
  return !['0', 'false', 'no', 'off'].includes(value);
}

function intSetting(name, defaultValue) {
  const value = Number.parseInt(setting(name), 10);
  return Number.isFinite(value) && value > 0 ? value : defaultValue;
}

function stringSetting(name, defaultValue, allowedValues) {
  const value = String(setting(name) || defaultValue).trim();
  if (!allowedValues.has(value)) {
    throw new Error(`${name} must be one of ${[...allowedValues].join(', ')}`);
  }
  return value;
}

function runCommand(command, args, options = {}) {
  return homeboyRunBenchPhase(options.memoryLabel, command, args, {
    cwd: options.cwd || STUDIO_PATH,
    env: options.env || {},
    timeoutMs: options.timeoutMs,
    sampleIntervalMs: intSetting('many_sites_memory_sample_interval_ms', 1000),
  });
}

async function assertManySitesHarnessExists() {
  const harnessPath = path.join(STUDIO_PATH, 'tools/metrics/tests/many-sites.test.ts');
  try {
    await access(harnessPath);
  } catch {
    throw new Error(`Studio checkout does not include many-sites metrics harness: ${harnessPath}`);
  }
  return harnessPath;
}

async function readJsonIfPresent(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

export default async function studioManySitesMemoryScrollBench() {
  const currentVariant = variant();
  const siteCount = intSetting('many_sites_count', 1000);
  const iconSizeKb = intSetting('many_sites_icon_kb', 64);
  const runningMode = stringSetting('many_sites_running_mode', 'all-stopped', RUNNING_MODES);
  const runtime = stringSetting('many_sites_runtime', 'playground', RUNTIMES);
  const shouldInstall = boolSetting('many_sites_install', true);
  const shouldPackage = boolSetting('many_sites_package', true);
  const runId = `${currentVariant}-many-sites-${runtime}-${runningMode}-${siteCount}-${process.pid}-${Date.now()}-${Math.random()
    .toString(36)
    .slice(2)}`;
  const artifactDir = path.join(studioArtifactDir('studio-many-sites-memory-scroll-artifacts'), runId);
  const resultFile = path.join(artifactDir, 'many-sites.results.json');
  const rawResultFile = path.join(artifactDir, `result-${runId}.json`);
  await mkdir(artifactDir, { recursive: true });

  await assertManySitesHarnessExists();

  const started = Date.now();
  const phaseEvents = [];
  let installResult = null;
  if (shouldInstall) {
    installResult = await runCommand('npm', ['install'], {
      timeoutMs: intSetting('many_sites_install_timeout_ms', 1200000),
      memoryLabel: 'install',
    });
    phaseEvents.push(...installResult.phaseEvents);
    if (installResult.code !== 0) {
      await writeFile(
        rawResultFile,
        JSON.stringify({ variant: currentVariant, install: safeResult(installResult), passed: false }, null, 2)
      );
      throw new Error(`Studio npm install failed; raw_result=${rawResultFile}; stderr=${redact(installResult.stderr).slice(-1500)}`);
    }
  }

  let packageResult = null;
  if (shouldPackage) {
    packageResult = await runCommand('npm', ['run', 'package'], {
      timeoutMs: intSetting('many_sites_package_timeout_ms', 1200000),
      memoryLabel: 'package',
    });
    phaseEvents.push(...packageResult.phaseEvents);
    if (packageResult.code !== 0) {
      await writeFile(
        rawResultFile,
        JSON.stringify({ variant: currentVariant, package: safeResult(packageResult), passed: false }, null, 2)
      );
      throw new Error(`Studio package failed; raw_result=${rawResultFile}; stderr=${redact(packageResult.stderr).slice(-1500)}`);
    }
  }

  const testResult = await runCommand(
    'npx',
    ['playwright', 'test', '--config=./tools/metrics/playwright.metrics.config.ts', 'tools/metrics/tests/many-sites.test.ts'],
    {
      timeoutMs: intSetting('many_sites_test_timeout_ms', 600000),
      memoryLabel: 'playwright_test',
      env: {
        ARTIFACTS_PATH: artifactDir,
        RESULTS_ID: 'many-sites',
        MANY_SITES_COUNT: String(siteCount),
        MANY_SITES_ICON_KB: String(iconSizeKb),
        MANY_SITES_RUNNING_MODE: runningMode,
        STUDIO_RUNTIME: runtime,
        TIMEOUT: String(intSetting('many_sites_playwright_timeout_ms', 300000)),
      },
    }
  );
  phaseEvents.push(...testResult.phaseEvents);
  const totalElapsedMs = Date.now() - started;
  const results = await readJsonIfPresent(resultFile);
  const passed = testResult.code === 0 && Boolean(results);

  await writeFile(
    rawResultFile,
    JSON.stringify(
      {
        variant: currentVariant,
        studioPath: STUDIO_PATH,
        matrix: {
          site_count: siteCount,
          icon_size_kb: iconSizeKb,
          running_mode: runningMode,
          runtime,
        },
        timings: {
          install_ms: metric(installResult?.elapsedMs),
          package_ms: metric(packageResult?.elapsedMs),
          test_ms: metric(testResult.elapsedMs),
          total_elapsed_ms: totalElapsedMs,
        },
        phase_events: phaseEvents,
        memory_timeline: { source: 'homeboy_phase_attribution' },
        commands: {
          install: installResult ? safeResult(installResult) : null,
          package: packageResult ? safeResult(packageResult) : null,
          test: safeResult(testResult),
        },
        results,
        passed,
      },
      null,
      2
    )
  );

  if (!passed) {
    throw new Error(`many-sites metrics test failed; raw_result=${rawResultFile}; stderr=${redact(testResult.stderr).slice(-1500)}`);
  }

  return {
    metrics: {
      success_rate: 1,
      site_count: metric(results.siteCount),
      icon_size_kb: metric(results.iconSizeKb),
      running_site_count: metric(results.runningSiteCount),
      native_php_runtime: metric(results.nativePhpRuntime),
      launch_rss_mb: metric(results.launchRssMb),
      scrolled_rss_mb: metric(results.scrolledRssMb),
      scroll_duration_ms: metric(results.scrollDuration),
      install_ms: metric(installResult?.elapsedMs),
      scroll_stress_cycles: metric(results.scrollStressCycles),
      scroll_stress_duration_ms: metric(results.scrollStressDuration),
      scroll_stress_rss_mb: metric(results.scrollStressRssMb),
      package_ms: metric(packageResult?.elapsedMs),
      test_ms: metric(testResult.elapsedMs),
      total_elapsed_ms: totalElapsedMs,
    },
    artifacts: {
      raw_result: rawResultFile,
      metrics_result: resultFile,
      screenshot_top: path.join(artifactDir, 'many-sites-top.png'),
      screenshot_bottom: path.join(artifactDir, 'many-sites-bottom.png'),
      screenshot_stress_bottom: path.join(artifactDir, 'many-sites-stress-bottom.png'),
      test_results: path.join(artifactDir, 'test-results'),
    },
  };
}
