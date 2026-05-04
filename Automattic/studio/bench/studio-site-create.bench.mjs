import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { artifactDir as studioArtifactDir, metric, redact, runCli, safeResult, variant } from './lib/studio-bench.mjs';

async function createSite(sitePath, start) {
  return runCli([
    'site',
    'create',
    '--name',
    `Studio Bench ${variant()} Site Create ${process.pid}`,
    '--path',
    sitePath,
    ...(start ? [] : ['--no-start']),
    '--skip-browser',
    '--skip-log-details',
  ], { timeoutMs: start ? 420000 : 240000 });
}

async function stopSite(sitePath) {
  return runCli(['site', 'stop', '--path', sitePath], { allowFailure: true, timeoutMs: 90000 });
}

async function siteStatus(sitePath) {
  return runCli(['site', 'status', '--path', sitePath, '--format', 'json'], { allowFailure: true, timeoutMs: 90000 });
}

export default async function studioSiteCreateBench() {
  const currentVariant = variant();
  const runId = `${currentVariant}-site-create-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const artifactDir = studioArtifactDir('studio-site-create-artifacts');
  const sitesDir = path.join(artifactDir, 'sites');
  const noStartSitePath = path.join(sitesDir, `${runId}-no-start`);
  const startSitePath = path.join(sitesDir, `${runId}-start`);
  await mkdir(sitesDir, { recursive: true });

  const progressFile = path.join(artifactDir, `progress-${runId}.json`);
  const progress = {
    variant: currentVariant,
    sites: {
      no_start: noStartSitePath,
      start: startSitePath,
    },
    steps: [],
  };
  async function recordStep(name, result) {
    progress.steps.push({
      name,
      elapsed_ms: metric(result?.elapsedMs),
      exit_code: result?.code ?? null,
      stdout_tail: redact(result?.stdout).slice(-1000),
      stderr_tail: redact(result?.stderr).slice(-1000),
      recorded_at: new Date().toISOString(),
    });
    await writeFile(progressFile, JSON.stringify(progress, null, 2));
  }

  const totalStarted = Date.now();

  const noStartCreate = await createSite(noStartSitePath, false);
  await recordStep('site_create_no_start', noStartCreate);
  const startCreate = await createSite(startSitePath, true);
  await recordStep('site_create_start', startCreate);
  const startStatus = await siteStatus(startSitePath);
  await recordStep('site_status_started', startStatus);
  const stopStarted = Date.now();
  const stopResult = await stopSite(startSitePath);
  const stopMs = Date.now() - stopStarted;
  await recordStep('site_stop_started', { ...stopResult, elapsedMs: stopMs });

  const totalElapsedMs = Date.now() - totalStarted;

  const artifactFile = path.join(artifactDir, `result-${runId}.json`);
  await mkdir(artifactDir, { recursive: true });
  await writeFile(
    artifactFile,
    JSON.stringify(
      {
        variant: currentVariant,
        sites: {
          no_start: noStartSitePath,
          start: startSitePath,
        },
        timings: {
          site_create_no_start_ms: noStartCreate.elapsedMs,
          site_create_start_ms: startCreate.elapsedMs,
          site_status_started_ms: startStatus.elapsedMs,
          site_stop_started_ms: stopMs,
          total_elapsed_ms: totalElapsedMs,
        },
        commands: {
          noStartCreate: safeResult(noStartCreate),
          startCreate: safeResult(startCreate),
          startStatus: safeResult(startStatus),
          stopResult: safeResult(stopResult),
        },
        progressFile,
      },
      null,
      2
    )
  );

  return {
    metrics: {
      success_rate: 1,
      elapsed_ms: totalElapsedMs,
      site_create_no_start_ms: metric(noStartCreate.elapsedMs),
      site_create_start_ms: metric(startCreate.elapsedMs),
      site_status_started_ms: metric(startStatus.elapsedMs),
      site_stop_started_ms: metric(stopMs),
      total_elapsed_ms: totalElapsedMs,
    },
    artifacts: {
      raw_result: artifactFile,
      progress: progressFile,
      no_start_site_path: noStartSitePath,
      start_site_path: startSitePath,
    },
  };
}
