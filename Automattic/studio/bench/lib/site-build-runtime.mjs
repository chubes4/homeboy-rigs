import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  SHARED_STATE,
  STUDIO_PATH,
  createStudioSite,
  expandHome,
  runCli as sharedRunCli,
  runEval as sharedRunEval,
  setting,
  studioSiteStatusJson,
  variant,
} from './studio-bench.mjs';

const DEFAULT_STUDIO_PORT = 8881;
const INVOCATION_NAMESPACE = 'studio-agent-site-build';
const WORKFLOW_BENCH_SCENARIO_SETTING = 'studio_workflow_bench_scenario_id';
const WORKFLOW_BENCH_ROOT_SETTING = 'studio_workflow_bench_root';
const MODEL_SETTING = 'studio_agent_model';
const DEFAULT_WORKFLOW_BENCH_SCENARIO_ID = 'homeboy-plain-site-restaurant';
const SYSTEM_PROMPT_FILES = ['apps/cli/ai/system-prompt.ts'];

export const PROMPT_CATEGORY = 'site-build';

export { variant };

export function evalModel() {
  return setting(MODEL_SETTING) || process.env.STUDIO_EVAL_MODEL || '';
}

function envPath(key) {
  return typeof process.env[key] === 'string' && process.env[key] ? process.env[key] : '';
}

export async function createStudioBenchRuntime(sharedState = SHARED_STATE) {
  const helperPath = envPath('HOMEBOY_NODEJS_INVOCATION_RUNTIME_HELPER');
  if (!helperPath) {
    const artifactDir = path.join(sharedState, 'studio-agent-site-build-artifacts');
    return {
      invocationId: '',
      artifactDir,
      siteRoot: path.join(artifactDir, 'sites'),
      stateDir: '',
      cliConfigDir: '',
      appDataDir: '',
      processManagerHome: '',
      tmpDir: '',
      portBase: null,
      portMax: null,
      env: {},
      async prepareDirs() {},
      assertPort() {},
    };
  }

  const { resolveHomeboyInvocationRuntime } = await import(helperPath);
  const invocationRuntime = resolveHomeboyInvocationRuntime({ namespace: INVOCATION_NAMESPACE });
  const stateDir = invocationRuntime.dirs.state || '';
  const artifactDir =
    invocationRuntime.baseDirs.artifact || path.join(sharedState, 'studio-agent-site-build-artifacts');
  const tmpDir = invocationRuntime.dirs.tmp || (stateDir ? path.join(stateDir, 'tmp') : '');
  const cliConfigDir = stateDir ? path.join(stateDir, 'cli-config') : '';
  const appDataDir = stateDir ? path.join(stateDir, 'appdata') : '';
  const processManagerHome = stateDir ? path.join(stateDir, 'daemon') : '';
  const portBase = invocationRuntime.portRange?.base ?? null;
  const portMax = invocationRuntime.portRange?.max ?? null;

  return {
    invocationId: invocationRuntime.invocationId || '',
    artifactDir,
    siteRoot: stateDir ? path.join(stateDir, 'sites') : path.join(artifactDir, 'sites'),
    stateDir,
    cliConfigDir,
    appDataDir,
    processManagerHome,
    tmpDir,
    portBase,
    portMax,
    env: invocationRuntime.isolated
      ? invocationRuntime.childEnv({
          E2E: '1',
          E2E_CLI_CONFIG_PATH: cliConfigDir,
          E2E_APP_DATA_PATH: appDataDir,
          STUDIO_PROCESS_MANAGER_HOME: processManagerHome,
          ...(tmpDir ? { TMPDIR: tmpDir } : {}),
        })
      : {},
    prepareDirs: () => invocationRuntime.prepareDirs(),
    assertPort: invocationRuntime.assertPort,
  };
}

async function cliEnv(extra = {}) {
  const staticSiteImporterPath = expandHome(setting('studio_static_site_importer_plugin_path') || '');
  const runtime = await createStudioBenchRuntime();
  return {
    ...process.env,
    ...(staticSiteImporterPath
      ? { STUDIO_STATIC_SITE_IMPORTER_PLUGIN_PATH: staticSiteImporterPath }
      : {}),
    ...runtime.env,
    ...extra,
  };
}

export async function prepareStudioRuntime(runtime) {
  if (!runtime.stateDir) {
    return;
  }

  await runtime.prepareDirs();
  await mkdir(runtime.cliConfigDir, { recursive: true });
  await mkdir(runtime.appDataDir, { recursive: true });
  await mkdir(runtime.processManagerHome, { recursive: true });
  if (runtime.tmpDir) {
    await mkdir(runtime.tmpDir, { recursive: true });
  }
  await mkdir(runtime.siteRoot, { recursive: true });

  const reservedSites = [];
  if (runtime.portBase !== null) {
    for (let port = DEFAULT_STUDIO_PORT; port < runtime.portBase; port++) {
      reservedSites.push({
        id: `bench-reserved-${runtime.invocationId || 'invocation'}-${port}`,
        name: `Bench reserved ${port}`,
        path: path.join(runtime.stateDir, 'reserved-ports', String(port)),
        port,
        phpVersion: '8.3',
        url: `http://localhost:${port}`,
        running: false,
      });
    }
  }

  const configPath = path.join(runtime.cliConfigDir, 'cli.json');
  await writeFile(configPath, JSON.stringify({ version: 1, sites: reservedSites, snapshots: [] }, null, 2) + '\n');
}

export function statusPort(status) {
  const siteUrl = String(status?.siteUrl || status?.url || '');
  let urlPort = 0;
  try {
    urlPort = Number(new URL(siteUrl).port || 0);
  } catch {
    urlPort = 0;
  }
  return Number(status?.port || urlPort || 0);
}

export async function runCli(args, options = {}) {
  return sharedRunCli(args, { ...options, env: await cliEnv(options.env) });
}

export async function runEval(prompt, vars) {
  return sharedRunEval(prompt, vars, { env: await cliEnv() });
}

export function workflowBenchScenarioId() {
  return setting(WORKFLOW_BENCH_SCENARIO_SETTING) || DEFAULT_WORKFLOW_BENCH_SCENARIO_ID;
}

export function workflowBenchRoot() {
  return expandHome(
    setting(WORKFLOW_BENCH_ROOT_SETTING) ||
      process.env.STUDIO_WEB_WORKFLOW_BENCH_ROOT ||
      process.env.WORKFLOW_BENCH_ROOT ||
      ''
  );
}

export async function workflowBenchScenarios() {
  const root = workflowBenchRoot();
  if (!root) {
    throw new Error(
      `Studio site-build requires the canonical Studio Web Workflow Bench corpus. Set ${WORKFLOW_BENCH_ROOT_SETTING}, STUDIO_WEB_WORKFLOW_BENCH_ROOT, or WORKFLOW_BENCH_ROOT to a Studio Web checkout.`
    );
  }

  const benchRoot = path.join(root, 'eval/workflow-bench');
  return [
    ...(await workflowBenchScenarioFiles(path.join(benchRoot, 'scenarios'))),
    ...(await workflowBenchCorpusScenarios(path.join(benchRoot, 'corpora'))),
  ];
}

async function workflowBenchScenarioFiles(directoryPath) {
  const entries = await readdir(directoryPath, { withFileTypes: true }).catch((error) => {
    if (error?.code === 'ENOENT') {
      return [];
    }
    throw error;
  });
  const scenarios = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) {
      continue;
    }
    const scenario = JSON.parse(await readFile(path.join(directoryPath, entry.name), 'utf8'));
    if (scenario.schema === 'workflow-bench/scenario/v1') {
      scenarios.push(scenario);
    }
  }
  return scenarios;
}

async function workflowBenchCorpusScenarios(directoryPath) {
  const entries = await readdir(directoryPath, { withFileTypes: true }).catch((error) => {
    if (error?.code === 'ENOENT') {
      return [];
    }
    throw error;
  });
  const scenarios = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) {
      continue;
    }
    const corpus = JSON.parse(await readFile(path.join(directoryPath, entry.name), 'utf8'));
    if (corpus.schema !== 'workflow-bench/scenario-corpus/v1') {
      continue;
    }
    for (const scenario of corpus.scenarios || []) {
      scenarios.push(normalizeWorkflowBenchScenario(scenario, corpus));
    }
  }
  return scenarios;
}

function normalizeWorkflowBenchScenario(scenario, corpus) {
  if (scenario.schema === 'workflow-bench/scenario/v1') {
    return scenario;
  }
  return {
    schema: 'workflow-bench/scenario/v1',
    id: scenario.id,
    version: scenario.version || 1,
    title: scenario.label,
    category: scenario.category || 'other',
    task: { type: scenario.task_type || 'create', prompt: scenario.prompt },
    success_gates: (scenario.success_gates || []).map((gate, index) => ({
      id: `gate-${index + 1}`,
      kind: 'content',
      severity: 'required',
      description: String(gate),
      evidence: ['output-artifacts'],
    })),
    metadata: { ...(scenario.metadata || {}), corpus_id: corpus.id || null },
  };
}

export async function workflowBenchScenario() {
  const scenarioId = workflowBenchScenarioId();
  const scenarios = await workflowBenchScenarios();
  const scenario = scenarios.find((item) => item.id === scenarioId);
  if (scenario) {
    return scenario;
  }

  const scenarioIds = scenarios.map((item) => item.id).sort();
  throw new Error(
    `Unknown ${WORKFLOW_BENCH_SCENARIO_SETTING}: ${scenarioId}. Available scenario IDs: ${scenarioIds.join(', ')}.`
  );
}

export async function siteBuildPrompt(sitePath) {
  const scenario = await workflowBenchScenario();
  return String(scenario.task?.prompt || '')
    .trim()
    .replaceAll('{{sitePath}}', sitePath)
    .replaceAll('${sitePath}', sitePath)
    .replaceAll('active benchmark site', sitePath);
}

export async function systemPromptFingerprint() {
  const hash = createHash('sha256');
  const manifest = [];
  let sizeBytes = 0;

  for (const relativePath of SYSTEM_PROMPT_FILES) {
    const content = await readFile(path.join(STUDIO_PATH, relativePath));
    const contentSha = createHash('sha256').update(content).digest('hex');
    sizeBytes += content.byteLength;
    manifest.push({
      path: relativePath,
      sha256: contentSha,
      size_bytes: content.byteLength,
    });

    hash.update(relativePath, 'utf8');
    hash.update('\0');
    hash.update(String(content.byteLength), 'utf8');
    hash.update('\0');
    hash.update(content);
    hash.update('\0');
  }

  return {
    system_prompt_sha: hash.digest('hex'),
    system_prompt_file: SYSTEM_PROMPT_FILES.length === 1 ? SYSTEM_PROMPT_FILES[0] : undefined,
    system_prompt_files: SYSTEM_PROMPT_FILES,
    system_prompt_manifest: manifest,
    system_prompt_size_bytes: sizeBytes,
  };
}

export async function createFreshSite(sitePath) {
  await createStudioSite(sitePath, { name: `Studio Bench ${variant()} ${process.pid}`, env: cliEnv() });
}

export async function siteStatus(sitePath) {
  return studioSiteStatusJson(sitePath, { env: cliEnv() });
}
