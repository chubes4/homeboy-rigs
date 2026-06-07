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
const PROMPT_VARIANT_SETTING = 'studio_site_build_prompt_variant';
const PROMPT_FILE_SETTING = 'studio_site_build_prompt_file';
const WORKFLOW_BENCH_SCENARIO_SETTING = 'studio_workflow_bench_scenario_id';
const MODEL_SETTING = 'studio_agent_model';
const DEFAULT_PROMPT_VARIANT = 'studio-code';
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

function promptVariant() {
  return setting(PROMPT_VARIANT_SETTING) || DEFAULT_PROMPT_VARIANT;
}

export function workflowBenchScenarioId() {
  return setting(WORKFLOW_BENCH_SCENARIO_SETTING);
}

export async function availablePromptVariants() {
  return validatePromptVariantCatalog();
}

export async function validatePromptVariantCatalog() {
  const promptsDir = new URL('../prompts/site-build/', import.meta.url);
  const files = await promptFiles(promptsDir);
  return Object.keys(promptVariantCatalog(files));
}

export function promptVariantCatalog(files) {
  const variants = {};
  const duplicatePaths = new Map();

  for (const relativePath of files) {
    const variantName = path.posix.basename(relativePath, '.md');
    if (variants[variantName]) {
      if (!duplicatePaths.has(variantName)) {
        duplicatePaths.set(variantName, [variants[variantName]]);
      }
      duplicatePaths.get(variantName).push(relativePath);
      continue;
    }

    variants[variantName] = relativePath;
  }

  if (duplicatePaths.size) {
    const duplicates = [...duplicatePaths.entries()]
      .map(([variantName, paths]) => `${variantName} (${paths.join(', ')})`)
      .join('; ');
    throw new Error(
      `Studio site-build prompt catalog has duplicate basename-derived variant IDs. Rename prompt files so each basename is unique. Duplicates: ${duplicates}.`
    );
  }

  return variants;
}

export async function workflowBenchScenarioMapping() {
  const mappingPath = new URL('../prompts/site-build/workflow-bench-mapping.json', import.meta.url);
  const mapping = JSON.parse(await readFile(mappingPath, 'utf8'));
  return mapping.scenarios && typeof mapping.scenarios === 'object' ? mapping.scenarios : {};
}

export async function resolvedPromptVariant() {
  const scenarioId = workflowBenchScenarioId();
  if (!scenarioId) {
    return promptVariant();
  }

  const mapping = await workflowBenchScenarioMapping();
  const mappedVariant = mapping[scenarioId]?.prompt_variant;
  if (typeof mappedVariant === 'string' && mappedVariant) {
    return mappedVariant;
  }

  const scenarioIds = Object.keys(mapping).sort();
  throw new Error(
    `Unknown ${WORKFLOW_BENCH_SCENARIO_SETTING}: ${scenarioId}. Available scenario IDs: ${scenarioIds.join(', ')}.`
  );
}

async function promptFiles(directoryUrl, prefix = '') {
  const entries = await readdir(directoryUrl, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      files.push(...(await promptFiles(new URL(`${entry.name}/`, directoryUrl), relativePath)));
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      files.push(relativePath);
    }
  }

  return files.sort();
}

export async function promptTemplatePath() {
  const explicitPromptFile = expandHome(setting(PROMPT_FILE_SETTING) || '');
  if (explicitPromptFile) {
    return explicitPromptFile;
  }

  const variantName = await resolvedPromptVariant();
  if (!/^[a-z0-9][a-z0-9-]*$/.test(variantName)) {
    throw new Error(`Invalid ${PROMPT_VARIANT_SETTING}: ${variantName}`);
  }
  const promptsDir = new URL('../prompts/site-build/', import.meta.url);
  const relativePromptPath = promptVariantCatalog(await promptFiles(promptsDir))[variantName];
  if (!relativePromptPath) {
    const variants = await availablePromptVariants();
    throw new Error(`Unknown ${PROMPT_VARIANT_SETTING}: ${variantName}. Available variants: ${variants.join(', ')}.`);
  }

  return new URL(`../prompts/site-build/${relativePromptPath}`, import.meta.url);
}

export async function siteBuildPrompt(sitePath) {
  const promptPath = await promptTemplatePath();
  let template;
  try {
    template = await readFile(promptPath, 'utf8');
  } catch (error) {
    const variants = await availablePromptVariants().catch(() => []);
    const hint = variants.length ? ` Available variants: ${variants.join(', ')}.` : '';
    throw new Error(
      `Failed to read Studio site-build prompt for variant "${await resolvedPromptVariant()}" from ${String(promptPath)}.${hint} ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }

  return template.trim().replaceAll('{{sitePath}}', sitePath).replaceAll('${sitePath}', sitePath);
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
