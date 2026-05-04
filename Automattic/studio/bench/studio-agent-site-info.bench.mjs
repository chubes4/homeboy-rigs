import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { artifactDir as studioArtifactDir, metric, runEval } from './lib/studio-bench.mjs';

const SITE_INFO_TIMEOUT_MS = 60000;

export default async function studioAgentSiteInfoBench() {
  const siteName = process.env.STUDIO_SITE_INFO_BENCH_SITE || 'intelligence-chubes4';
  const prompt = `Use only the Studio site_info tool for the site named ${siteName}, then answer with its running status in one sentence. Do not use any other tools.`;
  const started = Date.now();
  const { result, resultFile, exitCode, stderr } = await runEval(prompt, {
    maxTurns: 5,
    timeoutMs: SITE_INFO_TIMEOUT_MS,
  });
  const elapsedMs = Date.now() - started;

  const artifactDir = studioArtifactDir('studio-agent-site-info-artifacts');
  await mkdir(artifactDir, { recursive: true });
  const artifactFile = path.join(artifactDir, `result-${process.pid}-${Date.now()}.json`);
  await writeFile(artifactFile, JSON.stringify({ prompt, exitCode, stderr, resultFile, result }, null, 2));

  if (result.success !== true) {
    const reason = result.timedOut === true
      ? `timed out after ${SITE_INFO_TIMEOUT_MS}ms (eval-runner reported timedOut)`
      : typeof result.error === 'string'
        ? `exception: ${result.error}`
        : `exit=${exitCode}`;
    throw new Error(`Studio eval failed: ${reason}; raw_result=${artifactFile}`);
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
