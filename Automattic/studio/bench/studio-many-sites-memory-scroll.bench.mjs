import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';

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

function processRows() {
  if (process.platform === 'win32') {
    return [];
  }

  try {
    return execFileSync('ps', ['-axo', 'pid=,ppid=,rss=,comm='], { encoding: 'utf8' })
      .trim()
      .split('\n')
      .map((line) => {
        const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/);
        if (!match) {
          return null;
        }
        return {
          pid: Number.parseInt(match[1], 10),
          ppid: Number.parseInt(match[2], 10),
          rssKb: Number.parseInt(match[3], 10),
          command: match[4],
        };
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function summarizeProcessTree(rootPid) {
  const rows = processRows();
  if (!rows.length) {
    return { process_count: 0, total_rss_mb: 0, groups: {} };
  }

  const children = new Map();
  for (const row of rows) {
    const list = children.get(row.ppid) || [];
    list.push(row.pid);
    children.set(row.ppid, list);
  }

  const seen = new Set([rootPid]);
  const queue = [rootPid];
  while (queue.length) {
    const pid = queue.shift();
    for (const childPid of children.get(pid) || []) {
      if (!seen.has(childPid)) {
        seen.add(childPid);
        queue.push(childPid);
      }
    }
  }

  const groups = {};
  let totalRssKb = 0;
  for (const row of rows) {
    if (!seen.has(row.pid)) {
      continue;
    }
    totalRssKb += row.rssKb;
    const command = path.basename(row.command).toLowerCase();
    const group = command.includes('electron') || command.includes('studio') ? 'electron' : command || 'unknown';
    groups[group] = (groups[group] || 0) + row.rssKb;
  }

  return {
    process_count: seen.size,
    total_rss_mb: Math.round(totalRssKb / 1024),
    groups: Object.fromEntries(
      Object.entries(groups)
        .sort(([, a], [, b]) => b - a)
        .map(([group, rssKb]) => [group, Math.round(rssKb / 1024)])
    ),
  };
}

function peakRss(samples, phase) {
  return samples
    .filter((sample) => !phase || sample.phase === phase)
    .reduce((peak, sample) => Math.max(peak, sample.total_rss_mb || 0), 0);
}

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
  return new Promise((resolve, reject) => {
    const started = Date.now();
    let settled = false;
    let stdout = '';
    let stderr = '';
    const child = spawn(command, args, {
      cwd: options.cwd || STUDIO_PATH,
      env: { ...process.env, ...(options.env || {}) },
    });

    const sampleMemory = () => {
      if (!options.memorySamples || !options.memoryLabel) {
        return;
      }
      options.memorySamples.push({
        elapsed_ms: Date.now() - options.startedAt,
        phase: options.memoryLabel,
        root_pid: child.pid,
        ...summarizeProcessTree(child.pid),
      });
    };

    sampleMemory();
    const memoryTimer = options.memorySamples
      ? setInterval(sampleMemory, intSetting('many_sites_memory_sample_interval_ms', 1000))
      : undefined;

    const timer = options.timeoutMs
      ? setTimeout(() => {
          if (settled) {
            return;
          }
          settled = true;
          child.kill('SIGKILL');
          if (memoryTimer) {
            clearInterval(memoryTimer);
          }
          reject(
            new Error(
              `${command} ${args.join(' ')} timed out after ${options.timeoutMs}ms; stdout=${redact(stdout).slice(
                -1000
              )}; stderr=${redact(stderr).slice(-1000)}`
            )
          );
        }, options.timeoutMs)
      : undefined;

    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('error', (error) => {
      if (timer) {
        clearTimeout(timer);
      }
      if (memoryTimer) {
        clearInterval(memoryTimer);
      }
      reject(error);
    });
    child.on('close', (code) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timer) {
        clearTimeout(timer);
      }
      sampleMemory();
      if (memoryTimer) {
        clearInterval(memoryTimer);
      }
      resolve({ code, stdout, stderr, elapsedMs: Date.now() - started });
    });
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
  const memoryTimelineFile = path.join(artifactDir, `memory-timeline-${runId}.json`);
  await mkdir(artifactDir, { recursive: true });

  await assertManySitesHarnessExists();

  const started = Date.now();
  const memorySamples = [];
  const phaseEvents = [{ phase: 'start', elapsed_ms: 0 }];
  let installResult = null;
  if (shouldInstall) {
    phaseEvents.push({ phase: 'before_install', elapsed_ms: Date.now() - started });
    installResult = await runCommand('npm', ['install'], {
      timeoutMs: intSetting('many_sites_install_timeout_ms', 1200000),
      memoryLabel: 'install',
      memorySamples,
      startedAt: started,
    });
    phaseEvents.push({ phase: 'after_install', elapsed_ms: Date.now() - started });
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
    phaseEvents.push({ phase: 'before_package', elapsed_ms: Date.now() - started });
    packageResult = await runCommand('npm', ['run', 'package'], {
      timeoutMs: intSetting('many_sites_package_timeout_ms', 1200000),
      memoryLabel: 'package',
      memorySamples,
      startedAt: started,
    });
    phaseEvents.push({ phase: 'after_package', elapsed_ms: Date.now() - started });
    if (packageResult.code !== 0) {
      await writeFile(
        rawResultFile,
        JSON.stringify({ variant: currentVariant, package: safeResult(packageResult), passed: false }, null, 2)
      );
      throw new Error(`Studio package failed; raw_result=${rawResultFile}; stderr=${redact(packageResult.stderr).slice(-1500)}`);
    }
  }

  phaseEvents.push({ phase: 'before_playwright_test', elapsed_ms: Date.now() - started });
  const testResult = await runCommand(
    'npx',
    ['playwright', 'test', '--config=./tools/metrics/playwright.metrics.config.ts', 'tools/metrics/tests/many-sites.test.ts'],
    {
      timeoutMs: intSetting('many_sites_test_timeout_ms', 600000),
      memoryLabel: 'playwright_test',
      memorySamples,
      startedAt: started,
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
  phaseEvents.push({ phase: 'after_playwright_test', elapsed_ms: Date.now() - started });
  const totalElapsedMs = Date.now() - started;
  const results = await readJsonIfPresent(resultFile);
  const passed = testResult.code === 0 && Boolean(results);

  await writeFile(
    memoryTimelineFile,
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
        sample_interval_ms: intSetting('many_sites_memory_sample_interval_ms', 1000),
        phases: phaseEvents,
        samples: memorySamples,
      },
      null,
      2
    )
  );

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
        memory_timeline: {
          file: memoryTimelineFile,
          peak_install_rss_mb: peakRss(memorySamples, 'install'),
          peak_package_rss_mb: peakRss(memorySamples, 'package'),
          peak_playwright_test_rss_mb: peakRss(memorySamples, 'playwright_test'),
          peak_total_rss_mb: peakRss(memorySamples),
          sample_count: memorySamples.length,
        },
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
      peak_install_rss_mb: peakRss(memorySamples, 'install'),
      peak_package_rss_mb: peakRss(memorySamples, 'package'),
      peak_playwright_test_rss_mb: peakRss(memorySamples, 'playwright_test'),
      peak_workload_rss_mb: peakRss(memorySamples),
    },
    artifacts: {
      raw_result: rawResultFile,
      memory_timeline: memoryTimelineFile,
      metrics_result: resultFile,
      screenshot_top: path.join(artifactDir, 'many-sites-top.png'),
      screenshot_bottom: path.join(artifactDir, 'many-sites-bottom.png'),
      screenshot_stress_bottom: path.join(artifactDir, 'many-sites-stress-bottom.png'),
      test_results: path.join(artifactDir, 'test-results'),
    },
  };
}
