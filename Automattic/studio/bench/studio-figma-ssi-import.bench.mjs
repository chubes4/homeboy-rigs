import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadNodeWorkloadUtils } from '../../../shared/nodejs-workload-utils-loader.mjs';

const {
  artifactDir: nodeArtifactDir,
  metric,
  redactText,
  runNode,
  safeResult: nodeSafeResult,
  setting,
} = await loadNodeWorkloadUtils();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(__dirname, '..');
const defaultFixturePath = path.join(
  packageRoot,
  'fixtures',
  'figma-to-wordpress-studio',
  'basic-runner-request.json'
);
const defaultSsiPluginUrl = 'https://github.com/Automattic/static-site-importer/releases/latest/download/static-site-importer.zip';

function artifactDir(name) {
  return nodeArtifactDir(name, { sharedState: process.env.HOMEBOY_BENCH_SHARED_STATE });
}

function redact(text) {
  return redactText(String(text || ''), { replacement: '[redacted]' });
}

function safeResult(result) {
  return nodeSafeResult(result, { redaction: { replacement: '[redacted]' } });
}

function runStudio(args, options = {}) {
  return runNode(['studio', ...args], { allowFailure: true, ...options });
}

function requestTitle(request) {
  return String(
    request.site_title ||
      request.title ||
      request.name ||
      request?.figma?.name ||
      'Figma Studio Import'
  );
}

function slugify(value) {
  const slug = String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'figma-studio-import';
}

function phpString(value) {
  return JSON.stringify(String(value));
}

function buildImportPhp(requestBase64) {
  return `<?php
require_once ABSPATH . 'wp-admin/includes/plugin.php';

$payload = json_decode( base64_decode( ${phpString(requestBase64)} ), true );
if ( ! is_array( $payload ) ) {
    throw new RuntimeException( 'Figma runner request payload could not be decoded.' );
}

if ( ! function_exists( 'static_site_importer_ability_import_figma' ) ) {
    throw new RuntimeException( 'Static Site Importer Figma import ability is unavailable.' );
}

$result = static_site_importer_ability_import_figma( $payload );

update_option( 'figma_to_wordpress_studio_import_result', $result, false );

if ( ! is_array( $result ) || empty( $result['success'] ) ) {
    throw new RuntimeException( 'Static Site Importer import failed: ' . wp_json_encode( $result ) );
}
?>`;
}

function buildBlueprint(request, ssiPluginUrl) {
  const requestBase64 = Buffer.from(JSON.stringify(request)).toString('base64');
  return {
    landingPage: '/',
    preferredVersions: {
      php: '8.4',
      wp: 'latest',
    },
    features: {
      networking: true,
    },
    steps: [
      {
        step: 'login',
      },
      {
        step: 'installPlugin',
        pluginData: {
          resource: 'url',
          url: ssiPluginUrl,
        },
        options: {
          activate: true,
          targetFolderName: 'static-site-importer',
        },
      },
      {
        step: 'runPHP',
        code: buildImportPhp(requestBase64),
      },
    ],
  };
}

function parseStatus(stdout) {
  const jsonStart = String(stdout || '').indexOf('{');
  if (jsonStart === -1) {
    throw new Error(`studio site status did not emit JSON: ${redact(stdout).slice(0, 1000)}`);
  }
  const status = JSON.parse(String(stdout).slice(jsonStart));
  if (!status.siteUrl) {
    throw new Error(`studio site status missing siteUrl: ${redact(stdout).slice(0, 1000)}`);
  }
  return status;
}

async function readFixture(fixturePath) {
  const request = JSON.parse(await readFile(fixturePath, 'utf8'));
  if (!request || typeof request !== 'object') {
    throw new Error(`Fixture did not decode to an object: ${fixturePath}`);
  }
  if (!request.figma && !request.scenegraph) {
    throw new Error(`Fixture must include figma or scenegraph data for the Figma import ability: ${fixturePath}`);
  }
  return request;
}

async function runRequired(label, args, options = {}) {
  const result = await runStudio(args, options);
  if (result.code !== 0) {
    throw new Error(`${label} failed with exit ${result.code}: ${redact(result.stderr || result.stdout).slice(-4000)}`);
  }
  return result;
}

export default async function studioFigmaSsiImportBench() {
  const fixturePath = setting('figma_studio_runner_request') || defaultFixturePath;
  const ssiPluginUrl = setting('figma_studio_ssi_plugin_url') || defaultSsiPluginUrl;
  const siteNameSetting = setting('figma_studio_site_name');
  const artifactRoot = artifactDir('studio-figma-ssi-import-artifacts');
  const runId = `figma-studio-import-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const runDir = path.join(artifactRoot, runId);
  const sitesDir = path.join(artifactRoot, 'sites');
  await mkdir(runDir, { recursive: true });
  await mkdir(sitesDir, { recursive: true });

  const request = await readFixture(fixturePath);
  const siteName = siteNameSetting || `${requestTitle(request)} ${process.pid}`;
  const sitePath = path.join(sitesDir, `${slugify(siteName)}-${Date.now()}`);
  const requestArtifact = path.join(runDir, 'runner-request.json');
  const blueprintPath = path.join(runDir, 'blueprint.json');
  const progressPath = path.join(runDir, 'progress.json');
  const resultPath = path.join(runDir, 'result.json');
  const progress = { runId, fixturePath, siteName, sitePath, steps: [] };

  async function recordStep(name, result, extra = {}) {
    progress.steps.push({
      name,
      exit_code: result?.code ?? null,
      elapsed_ms: metric(result?.elapsedMs),
      stdout_tail: redact(result?.stdout).slice(-1000),
      stderr_tail: redact(result?.stderr).slice(-1000),
      recorded_at: new Date().toISOString(),
      ...extra,
    });
    await writeFile(progressPath, `${JSON.stringify(progress, null, 2)}\n`);
  }

  await writeFile(requestArtifact, `${JSON.stringify(request, null, 2)}\n`);
  await writeFile(blueprintPath, `${JSON.stringify(buildBlueprint(request, ssiPluginUrl), null, 2)}\n`);

  const totalStarted = Date.now();
  const preflight = await runRequired('studio preflight', ['site', 'create', '--help'], { timeoutMs: 60000 });
  await recordStep('studio_site_create_help', preflight);

  const create = await runRequired(
    'studio site create from Figma import Blueprint',
    [
      'site',
      'create',
      '--name',
      siteName,
      '--path',
      sitePath,
      '--blueprint',
      blueprintPath,
      '--skip-browser',
      '--skip-log-details',
    ],
    { timeoutMs: 600000 }
  );
  await recordStep('studio_site_create_blueprint', create);

  const statusResult = await runRequired('studio site status', ['site', 'status', '--path', sitePath, '--format', 'json'], {
    timeoutMs: 90000,
  });
  const status = parseStatus(statusResult.stdout);
  await recordStep('studio_site_status', statusResult, { siteUrl: status.siteUrl });

  const pluginCheck = await runRequired(
    'static-site-importer plugin check',
    ['--path', sitePath, 'wp', 'plugin', 'is-installed', 'static-site-importer'],
    { timeoutMs: 90000 }
  );
  await recordStep('wp_plugin_is_installed_static_site_importer', pluginCheck);

  const activeTheme = await runRequired('active theme check', ['--path', sitePath, 'wp', 'option', 'get', 'stylesheet'], {
    timeoutMs: 90000,
  });
  await recordStep('wp_option_get_stylesheet', activeTheme, { stylesheet: activeTheme.stdout.trim() });

  const importResult = await runRequired(
    'SSI import result option check',
    ['--path', sitePath, 'wp', 'option', 'get', 'figma_to_wordpress_studio_import_result', '--format=json'],
    { timeoutMs: 90000 }
  );
  await recordStep('wp_option_get_import_result', importResult);

  let importResultJson = null;
  try {
    importResultJson = JSON.parse(importResult.stdout);
  } catch {
    throw new Error(`Import result option was not JSON: ${redact(importResult.stdout).slice(0, 1000)}`);
  }
  if (!importResultJson?.success) {
    throw new Error(`Import result option did not report success: ${redact(importResult.stdout).slice(0, 2000)}`);
  }

  const stop = await runStudio(['site', 'stop', '--path', sitePath], { timeoutMs: 90000 });
  await recordStep('studio_site_stop', stop);

  const totalElapsedMs = Date.now() - totalStarted;
  const result = {
    runId,
    fixturePath,
    siteName,
    sitePath,
    siteUrl: status.siteUrl,
    ssiPluginUrl,
    activeTheme: activeTheme.stdout.trim(),
    importResult: importResultJson,
    timings: {
      studio_preflight_ms: preflight.elapsedMs,
      site_create_ms: create.elapsedMs,
      site_status_ms: statusResult.elapsedMs,
      total_elapsed_ms: totalElapsedMs,
    },
    commands: {
      preflight: safeResult(preflight),
      create: safeResult(create),
      status: safeResult(statusResult),
      pluginCheck: safeResult(pluginCheck),
      activeTheme: safeResult(activeTheme),
      importResult: safeResult(importResult),
      stop: safeResult(stop),
    },
    artifacts: {
      request: requestArtifact,
      blueprint: blueprintPath,
      progress: progressPath,
    },
  };
  await writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`);

  return {
    metrics: {
      success_rate: 1,
      elapsed_ms: totalElapsedMs,
      site_create_ms: metric(create.elapsedMs),
      site_status_ms: metric(statusResult.elapsedMs),
      active_theme_present: activeTheme.stdout.trim() ? 1 : 0,
      import_success: importResultJson?.success ? 1 : 0,
    },
    artifacts: {
      raw_result: resultPath,
      progress: progressPath,
      blueprint: blueprintPath,
      runner_request: requestArtifact,
      site_path: sitePath,
      site_url: status.siteUrl,
    },
  };
}
