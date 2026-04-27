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
        env: {
          ...process.env,
          // The eval runner intentionally deletes CLAUDECODE, but clearing it
          // here keeps child-process behaviour stable if that implementation changes.
          CLAUDECODE: '',
        },
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

export default async function studioAgentRuntimeBench() {
  const prompt = 'In one short sentence, tell me who you are. Do not call any tools.';
  const started = Date.now();
  const { result, resultFile, exitCode, stderr } = await runEval(prompt, {
    maxTurns: 12,
    timeoutMs: 60000,
    askUserPolicy: 'allow_all',
  });
  const elapsedMs = Date.now() - started;

  const artifactDir = path.join(SHARED_STATE, 'studio-agent-runtime-artifacts');
  await mkdir(artifactDir, { recursive: true });
  const artifactFile = path.join(artifactDir, `result-${process.pid}-${Date.now()}.json`);
  await writeFile(
    artifactFile,
    JSON.stringify({ prompt, exitCode, stderr, resultFile, result }, null, 2)
  );

  const toolCalls = Array.isArray(result.toolCalls) ? result.toolCalls : [];
  const toolResults = Array.isArray(result.toolResults) ? result.toolResults : [];
  const questions = Array.isArray(result.questions) ? result.questions : [];
  const turnDurations = Array.isArray(result.turnDurationsMs) ? result.turnDurationsMs : [];
  const text = Array.isArray(result.textSegments) ? result.textSegments.join('\n') : '';
  const identifiesStudio = /WordPress\s+Studio/i.test(text) ? 1 : 0;
  const success = result.success === true ? 1 : 0;

  return {
    metrics: {
      success_rate: success,
      identifies_studio_rate: identifiesStudio,
      elapsed_ms: elapsedMs,
      turn_count: Number(result.numTurns ?? turnDurations.length ?? 0),
      assistant_message_count: turnDurations.length,
      max_turn_ms: turnDurations.length ? Math.max(...turnDurations) : 0,
      tool_call_count: toolCalls.length,
      tool_error_count: toolResults.filter((item) => item && item.isError === true).length,
      question_count: questions.length,
      permission_question_count: questions.filter((item) => item && item.isPermission === true).length,
    },
    artifacts: {
      raw_result: artifactFile,
    },
  };
}
