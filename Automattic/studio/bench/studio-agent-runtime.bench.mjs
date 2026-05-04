import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { artifactDir as studioArtifactDir, runEval, setting } from './lib/studio-bench.mjs';

const MODEL_SETTING = 'studio_agent_model';

function evalModel() {
  return setting(MODEL_SETTING) || process.env.STUDIO_EVAL_MODEL || '';
}

const RUNTIME_TIMEOUT_MS = 60000;

export default async function studioAgentRuntimeBench() {
  const prompt = 'In one short sentence, tell me who you are. Do not call any tools.';
  const model = evalModel();
  const started = Date.now();
  const { result, resultFile, exitCode, stderr } = await runEval(prompt, {
    maxTurns: 12,
    timeoutMs: RUNTIME_TIMEOUT_MS,
    askUserPolicy: 'allow_all',
    ...(model ? { model } : {}),
  });
  const elapsedMs = Date.now() - started;

  const artifactDir = studioArtifactDir('studio-agent-runtime-artifacts');
  await mkdir(artifactDir, { recursive: true });
  const artifactFile = path.join(artifactDir, `result-${process.pid}-${Date.now()}.json`);
  await writeFile(
    artifactFile,
    JSON.stringify({ prompt, model, exitCode, stderr, resultFile, result }, null, 2)
  );

  if (result.success !== true) {
    const reason = result.timedOut === true
      ? `timed out after ${RUNTIME_TIMEOUT_MS}ms (eval-runner reported timedOut)`
      : typeof result.error === 'string'
        ? `exception: ${result.error}`
        : `exit=${exitCode}`;
    throw new Error(`Studio eval failed: ${reason}; raw_result=${artifactFile}`);
  }

  const toolCalls = Array.isArray(result.toolCalls) ? result.toolCalls : [];
  const toolResults = Array.isArray(result.toolResults) ? result.toolResults : [];
  const questions = Array.isArray(result.questions) ? result.questions : [];
  const turnDurations = Array.isArray(result.turnDurationsMs) ? result.turnDurationsMs : [];
  const phaseTimings = result.phaseTimingsMs && typeof result.phaseTimingsMs === 'object' ? result.phaseTimingsMs : {};
  const toolEvents = Array.isArray(result.toolEvents) ? result.toolEvents : [];
  const text = Array.isArray(result.textSegments) ? result.textSegments.join('\n') : '';
  const identifiesStudio = /WordPress\s+Studio/i.test(text) ? 1 : 0;
  const success = result.success === true ? 1 : 0;
  const completedToolDurations = toolEvents
    .map((item) => Number(item?.durationMs ?? 0))
    .filter((value) => Number.isFinite(value) && value > 0);

  return {
    metrics: {
      success_rate: success,
      identifies_studio_rate: identifiesStudio,
      elapsed_ms: elapsedMs,
      phase_resolve_initial_provider_ms: Number(phaseTimings.resolve_initial_provider_ms ?? 0),
      phase_resolve_unavailable_provider_ms: Number(phaseTimings.resolve_unavailable_provider_ms ?? 0),
      phase_resolve_ai_environment_ms: Number(phaseTimings.resolve_ai_environment_ms ?? 0),
      phase_start_ai_agent_ms: Number(phaseTimings.start_ai_agent_ms ?? 0),
      phase_first_assistant_message_ms: Number(phaseTimings.first_assistant_message_ms ?? 0),
      phase_total_eval_ms: Number(phaseTimings.total_eval_ms ?? 0),
      turn_count: Number(result.numTurns ?? turnDurations.length ?? 0),
      assistant_message_count: turnDurations.length,
      max_turn_ms: turnDurations.length ? Math.max(...turnDurations) : 0,
      tool_call_count: toolCalls.length,
      tool_error_count: toolResults.filter((item) => item && item.isError === true).length,
      tool_event_count: toolEvents.length,
      max_tool_duration_ms: completedToolDurations.length ? Math.max(...completedToolDurations) : 0,
      question_count: questions.length,
      permission_question_count: questions.filter((item) => item && item.isPermission === true).length,
    },
    artifacts: {
      raw_result: artifactFile,
    },
    metadata: {
      model: model || 'default',
    },
  };
}
