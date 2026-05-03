import { mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const STUDIO_PATH = process.env.HOMEBOY_COMPONENT_PATH;
const SHARED_STATE = process.env.HOMEBOY_BENCH_SHARED_STATE || os.tmpdir();
const RESULT_PREFIX = 'EVAL_RUNNER_RESULT_FILE=';

if (!STUDIO_PATH) {
  throw new Error('HOMEBOY_COMPONENT_PATH is required');
}

function runEval(prompt, vars) {
  const evalRunner = path.join(STUDIO_PATH, 'apps/cli/dist/cli/eval-runner.mjs');

  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [evalRunner, prompt, 'unused-provider-slot', JSON.stringify({ vars: { prompt, ...vars } })],
      {
        cwd: STUDIO_PATH,
        env: { ...process.env, CLAUDECODE: '' },
      }
    );

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('error', reject);
    child.on('close', async (code) => {
      const marker = stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find((line) => line.startsWith(RESULT_PREFIX));

      if (!marker) {
        reject(new Error(`eval runner did not emit result marker; exit=${code}; stderr=${stderr.slice(0, 1000)}`));
        return;
      }

      try {
        const resultFile = marker.slice(RESULT_PREFIX.length);
        const result = JSON.parse(await readFile(resultFile, 'utf8'));
        resolve({ result, resultFile, exitCode: code, stderr });
      } catch (error) {
        reject(error);
      }
    });
  });
}

function metric(value) {
  const number = Number(value ?? 0);
  return Number.isFinite(number) ? number : 0;
}

export default async function studioAgentSiteInfoBench() {
  const siteName = process.env.STUDIO_SITE_INFO_BENCH_SITE || 'homeboy-bench-site';
  const prompt = `Use only the Studio site_info tool for the site named ${siteName}, then answer with its running status in one sentence. Do not use any other tools.`;
  const started = Date.now();
  const { result, resultFile, exitCode, stderr } = await runEval(prompt, {
    maxTurns: 5,
    timeoutMs: 60000,
  });
  const elapsedMs = Date.now() - started;

  const artifactDir = path.join(SHARED_STATE, 'studio-agent-site-info-artifacts');
  await mkdir(artifactDir, { recursive: true });
  const artifactFile = path.join(artifactDir, `result-${process.pid}-${Date.now()}.json`);
  await writeFile(artifactFile, JSON.stringify({ prompt, exitCode, stderr, resultFile, result }, null, 2));

  if (result.success !== true) {
    const detail = typeof result.error === 'string' ? result.error : `exit=${exitCode}`;
    throw new Error(`Studio eval failed: ${detail}; raw_result=${artifactFile}`);
  }

  const phaseTimings = result.phaseTimingsMs && typeof result.phaseTimingsMs === 'object' ? result.phaseTimingsMs : {};
  const toolEvents = Array.isArray(result.toolEvents) ? result.toolEvents : [];
  const siteInfoEvents = toolEvents.filter((event) => event && event.toolName === 'site_info');
  const toolDurations = toolEvents.map((event) => metric(event?.durationMs)).filter((value) => value > 0);
  const text = Array.isArray(result.textSegments) ? result.textSegments.join('\n') : '';

  if (siteInfoEvents.length !== 1 || toolEvents.length !== 1) {
    throw new Error(
      `Expected exactly one site_info tool call and no other tools; saw ${siteInfoEvents.length}/${toolEvents.length}; raw_result=${artifactFile}`
    );
  }
  if (siteInfoEvents[0].isError === true) {
    throw new Error(`site_info returned an error; raw_result=${artifactFile}`);
  }
  if (!/offline/i.test(text)) {
    throw new Error(`Expected assistant answer to mention offline status; raw_result=${artifactFile}`);
  }

  return {
    metrics: {
      success_rate: 1,
      elapsed_ms: elapsedMs,
      phase_resolve_initial_provider_ms: metric(phaseTimings.resolve_initial_provider_ms),
      phase_resolve_unavailable_provider_ms: metric(phaseTimings.resolve_unavailable_provider_ms),
      phase_resolve_ai_environment_ms: metric(phaseTimings.resolve_ai_environment_ms),
      phase_start_ai_agent_ms: metric(phaseTimings.start_ai_agent_ms),
      phase_first_assistant_message_ms: metric(phaseTimings.first_assistant_message_ms),
      phase_total_eval_ms: metric(phaseTimings.total_eval_ms),
      turn_count: metric(result.numTurns),
      tool_event_count: toolEvents.length,
      site_info_tool_count: siteInfoEvents.length,
      max_tool_duration_ms: toolDurations.length ? Math.max(...toolDurations) : 0,
      site_info_duration_ms: siteInfoEvents.length ? metric(siteInfoEvents[0].durationMs) : 0,
      tool_error_count: toolEvents.filter((event) => event && event.isError === true).length,
      answered_offline_rate: /offline/i.test(text) ? 1 : 0,
    },
    artifacts: {
      raw_result: artifactFile,
    },
  };
}
