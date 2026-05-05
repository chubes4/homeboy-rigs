import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

import {
  agentAuthoredBlockMetrics,
  collectGeneratedThemeUxGates,
  collectLatestImportReport,
  collectThemeBlockDocuments,
  importerTimingMetrics,
  nativeBlockQualityMetrics,
  probeQuality,
} from './lib/wordpress-quality.mjs';

import { collectDesignFingerprint } from './lib/design-gates.mjs';

export {
  agentAuthoredBlockMetrics,
  importerTimingMetrics,
  nativeBlockQualityMetrics,
} from './lib/wordpress-quality.mjs';

export { extractDesignPatternFingerprint } from './lib/design-gates.mjs';

export {
  hiddenEditorContentDiagnostics,
  reportedFreeformBlockCount,
  structuralSelectorDriftDiagnostics,
} from './lib/design-gates.mjs';

import { compareVisualFidelity, VISUAL_VIEWPORT } from './lib/visual-fidelity.mjs';
export { compareVisualFidelity } from './lib/visual-fidelity.mjs';

import {
  compareSemanticFidelity as compareSemanticFidelityImpl,
  semanticMismatchFailureDetails,
  semanticTargetMetric,
} from './lib/semantic-fidelity.mjs';
export { semanticMismatchFailureDetails, semanticTargetMetric } from './lib/semantic-fidelity.mjs';

const STUDIO_PATH = process.env.HOMEBOY_COMPONENT_PATH;
const SHARED_STATE = process.env.HOMEBOY_BENCH_SHARED_STATE || os.tmpdir();
const RESULT_PREFIX = 'EVAL_RUNNER_RESULT_FILE=';
const DEFAULT_STUDIO_PORT = 8881;
const NAMESPACE_PORT_RANGE_SIZE = 10;
const NAMESPACE_PORT_RANGE_START = 8900;
const NAMESPACE_PORT_RANGE_COUNT = 100;
const PROMPT_VARIANT_SETTING = 'studio_site_build_prompt_variant';
const PROMPT_FILE_SETTING = 'studio_site_build_prompt_file';
const BENCH_NAMESPACE_SETTING = 'studio_bench_namespace';
const MODEL_SETTING = 'studio_agent_model';
const DEFAULT_PROMPT_VARIANT = 'studio-code';
const PROMPT_CATEGORY = 'site-build';
const SYSTEM_PROMPT_FILES = ['apps/cli/ai/system-prompt.ts'];
const requireFromBench = createRequire(import.meta.url);
const VISUAL_EDITOR_PIXEL_DIFF_THRESHOLD = 0.05;
// Whole-page screenshots have minor browser/font antialiasing noise; 5% keeps
// that noise green while failing visible regressions such as missing icons.
export const VISUAL_PIXEL_DIFF_THRESHOLD = 0.05;

if (!STUDIO_PATH) {
  throw new Error('HOMEBOY_COMPONENT_PATH is required');
}

function expandHome(value) {
  if (!value) {
    return value;
  }
  if (value === '~') {
    return os.homedir();
  }
  if (value.startsWith('~/')) {
    return path.join(os.homedir(), value.slice(2));
  }
  return value;
}

function variant() {
  return setting('studio_bench_variant') || path.basename(STUDIO_PATH);
}

function benchmarkNamespace() {
  return (
    setting(BENCH_NAMESPACE_SETTING) ||
    process.env.STUDIO_BENCH_NAMESPACE ||
    process.env.studio_bench_namespace ||
    ''
  );
}

function evalModel() {
  return setting(MODEL_SETTING) || process.env.STUDIO_EVAL_MODEL || '';
}

function namespacePortBase(namespace) {
  const digest = createHash('sha256').update(namespace).digest();
  const bucket = digest.readUInt16BE(0) % NAMESPACE_PORT_RANGE_COUNT;
  return NAMESPACE_PORT_RANGE_START + bucket * NAMESPACE_PORT_RANGE_SIZE;
}

export function resolveBenchRuntime(namespace = benchmarkNamespace(), sharedState = SHARED_STATE) {
  if (!namespace) {
    const artifactDir = path.join(sharedState, 'studio-agent-site-build-artifacts');
    return {
      namespace: '',
      namespaceSlug: '',
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
    };
  }

  const namespaceSlug = safeSlug(namespace, 'namespace');
  const stateDir = path.join(sharedState, 'studio-agent-site-build-runtime', namespaceSlug);
  const cliConfigDir = path.join(stateDir, 'cli-config');
  const appDataDir = path.join(stateDir, 'appdata');
  const processManagerHome = path.join(stateDir, 'daemon');
  const tmpDir = path.join(stateDir, 'tmp');
  const portBase = namespacePortBase(namespaceSlug);

  return {
    namespace,
    namespaceSlug,
    artifactDir: path.join(sharedState, 'studio-agent-site-build-artifacts', namespaceSlug),
    siteRoot: path.join(sharedState, 'studio-agent-site-build-sites', namespaceSlug),
    stateDir,
    cliConfigDir,
    appDataDir,
    processManagerHome,
    tmpDir,
    portBase,
    portMax: portBase + NAMESPACE_PORT_RANGE_SIZE - 1,
    env: {
      E2E: '1',
      E2E_CLI_CONFIG_PATH: cliConfigDir,
      E2E_APP_DATA_PATH: appDataDir,
      STUDIO_PROCESS_MANAGER_HOME: processManagerHome,
      STUDIO_BENCH_NAMESPACE: namespaceSlug,
      TMPDIR: tmpDir,
    },
  };
}

function setting(key) {
  try {
    const settings = JSON.parse(process.env.HOMEBOY_SETTINGS_JSON || '{}');
    if (settings && typeof settings[key] === 'string') {
      return settings[key];
    }
  } catch {
    // Ignore malformed settings and fall back to direct env/debug defaults.
  }

  return process.env[`HOMEBOY_SETTINGS_${key.toUpperCase()}`] || '';
}

function cliEnv(extra = {}) {
  const staticSiteImporterPath = expandHome(setting('studio_static_site_importer_plugin_path') || '');
  const runtime = resolveBenchRuntime();
  return {
    ...process.env,
    ...(staticSiteImporterPath
      ? { STUDIO_STATIC_SITE_IMPORTER_PLUGIN_PATH: staticSiteImporterPath }
      : {}),
    ...runtime.env,
    ...extra,
  };
}

async function prepareNamespacedStudioRuntime(runtime) {
  if (!runtime.namespaceSlug) {
    return;
  }

  await reserveNamespacePortRange(runtime);
  await mkdir(runtime.cliConfigDir, { recursive: true });
  await mkdir(runtime.appDataDir, { recursive: true });
  await mkdir(runtime.processManagerHome, { recursive: true });
  await mkdir(runtime.tmpDir, { recursive: true });
  await mkdir(runtime.siteRoot, { recursive: true });

  const reservedSites = [];
  for (let port = DEFAULT_STUDIO_PORT; port < runtime.portBase; port++) {
    reservedSites.push({
      id: `bench-reserved-${runtime.namespaceSlug}-${port}`,
      name: `Bench reserved ${port}`,
      path: path.join(runtime.stateDir, 'reserved-ports', String(port)),
      port,
      phpVersion: '8.3',
      url: `http://localhost:${port}`,
      running: false,
    });
  }

  const configPath = path.join(runtime.cliConfigDir, 'cli.json');
  await writeFile(configPath, JSON.stringify({ version: 1, sites: reservedSites, snapshots: [] }, null, 2) + '\n');
}

async function reserveNamespacePortRange(runtime) {
  const rangeDir = path.join(SHARED_STATE, 'studio-agent-site-build-runtime', 'port-ranges');
  await mkdir(rangeDir, { recursive: true });

  const markerPath = path.join(rangeDir, `${runtime.portBase}-${runtime.portMax}.json`);
  const marker = {
    namespace: runtime.namespaceSlug,
    portBase: runtime.portBase,
    portMax: runtime.portMax,
  };

  try {
    await writeFile(markerPath, JSON.stringify(marker, null, 2) + '\n', { flag: 'wx' });
    return;
  } catch (error) {
    if (error?.code !== 'EEXIST') {
      throw error;
    }
  }

  const existing = JSON.parse(await readFile(markerPath, 'utf8'));
  if (existing.namespace !== runtime.namespaceSlug) {
    throw new Error(
      `Studio benchmark namespace "${runtime.namespaceSlug}" maps to port range ${runtime.portBase}-${runtime.portMax}, already reserved by namespace "${existing.namespace}". Choose a different ${BENCH_NAMESPACE_SETTING}; isolated ports cannot be guaranteed.`
    );
  }
}

function assertNamespacedPort(status, runtime) {
  if (!runtime.namespaceSlug || runtime.portBase === null || runtime.portMax === null) {
    return;
  }

  const siteUrl = String(status?.siteUrl || status?.url || '');
  let urlPort = 0;
  try {
    urlPort = Number(new URL(siteUrl).port || 0);
  } catch {
    urlPort = 0;
  }
  const port = Number(status?.port || urlPort || 0);
  if (!Number.isInteger(port) || port < runtime.portBase || port > runtime.portMax) {
    throw new Error(
      `Studio benchmark namespace "${runtime.namespaceSlug}" expected a port in ${runtime.portBase}-${runtime.portMax}, but site status reported ${port || 'none'}. Isolated ports cannot be guaranteed.`
    );
  }
}

function run(args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: options.cwd || STUDIO_PATH,
      env: cliEnv(options.env),
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0 && options.allowFailure !== true) {
        reject(new Error(`${args.join(' ')} exited ${code}; stderr=${stderr.slice(0, 1500)}`));
        return;
      }
      resolve({ code, stdout, stderr });
    });
  });
}

async function runCli(args, options = {}) {
  const cliPath = path.join(STUDIO_PATH, 'apps/cli/dist/cli/main.mjs');
  return run([cliPath, ...args], options);
}

async function runEval(prompt, vars) {
  const evalRunner = path.join(STUDIO_PATH, 'apps/cli/dist/cli/eval-runner.mjs');
  const { code, stdout, stderr } = await run(
    [evalRunner, prompt, 'unused-provider-slot', JSON.stringify({ vars: { prompt, ...vars } })],
    { allowFailure: true }
  );

  const marker = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.startsWith(RESULT_PREFIX));

  if (!marker) {
    throw new Error(`eval runner did not emit result marker; exit=${code}; stderr=${stderr.slice(0, 1500)}`);
  }

  const resultFile = marker.slice(RESULT_PREFIX.length);
  const result = JSON.parse(await readFile(resultFile, 'utf8'));
  return { result, resultFile, exitCode: code, stderr };
}

function promptVariant() {
  return setting(PROMPT_VARIANT_SETTING) || DEFAULT_PROMPT_VARIANT;
}

export async function availablePromptVariants() {
  return validatePromptVariantCatalog();
}

export async function validatePromptVariantCatalog() {
  const promptsDir = new URL('./prompts/site-build/', import.meta.url);
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

async function promptTemplatePath() {
  const explicitPromptFile = expandHome(setting(PROMPT_FILE_SETTING) || '');
  if (explicitPromptFile) {
    return explicitPromptFile;
  }

  const variantName = promptVariant();
  if (!/^[a-z0-9][a-z0-9-]*$/.test(variantName)) {
    throw new Error(`Invalid ${PROMPT_VARIANT_SETTING}: ${variantName}`);
  }
  const promptsDir = new URL('./prompts/site-build/', import.meta.url);
  const relativePromptPath = promptVariantCatalog(await promptFiles(promptsDir))[variantName];
  if (!relativePromptPath) {
    const variants = await availablePromptVariants();
    throw new Error(`Unknown ${PROMPT_VARIANT_SETTING}: ${variantName}. Available variants: ${variants.join(', ')}.`);
  }

  return new URL(`./prompts/site-build/${relativePromptPath}`, import.meta.url);
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
      `Failed to read Studio site-build prompt for variant "${promptVariant()}" from ${String(promptPath)}.${hint} ${
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

async function createFreshSite(sitePath) {
  await runCli([
    'site',
    'create',
    '--name',
    `Studio Bench ${variant()} ${process.pid}`,
    '--path',
    sitePath,
    '--skip-browser',
    '--skip-log-details',
  ]);
}

async function siteStatus(sitePath) {
  const { stdout } = await runCli(['site', 'status', '--path', sitePath, '--format', 'json']);
  const jsonStart = stdout.indexOf('{');
  if (jsonStart === -1) {
    throw new Error(`site status did not emit JSON: ${stdout.slice(0, 1000)}`);
  }
  return JSON.parse(stdout.slice(jsonStart));
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function stringArray(value) {
  return asArray(value).filter((item) => typeof item === 'string' && item.trim() !== '');
}

function safeSlug(value, fallback) {
  const slug = String(value || fallback || 'target')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return slug || 'target';
}

function comparisonTargets(importReport) {
  return asArray(importReport?.report?.visual_fidelity?.comparison_targets).filter(
    (target) => target && typeof target === 'object'
  );
}


export function resolveSourceStaticFile(sourceFile, reportPath, sitePath) {
  if (!sourceFile) {
    return '';
  }

  if (path.isAbsolute(sourceFile)) {
    const wordpressRoot = '/wordpress';
    if (sitePath && (sourceFile === wordpressRoot || sourceFile.startsWith(`${wordpressRoot}/`))) {
      return path.join(sitePath, sourceFile.slice(wordpressRoot.length));
    }

    return sourceFile;
  }

  return path.resolve(path.dirname(reportPath), sourceFile);
}

function surfaceUrl(target, surface, reportPath, sitePath) {
  const surfaces = target?.comparison_hooks?.render_surfaces || {};
  const configured = surfaces[surface]?.url || '';
  if (surface === 'source_static') {
    const sourceFile = configured || target?.source_file || '';
    if (!sourceFile) {
      return '';
    }
    const absoluteSource = resolveSourceStaticFile(sourceFile, reportPath, sitePath);
    return pathToFileURL(absoluteSource).toString();
  }

  if (surface === 'wordpress_frontend') {
    return configured || target?.wordpress_url || '';
  }

  if (surface === 'wordpress_editor') {
    if (configured) {
      return configured;
    }

    const postId = Number(target?.wordpress_page_id || target?.home_page_id || target?.front_page_id || 0);
    const frontendUrl = surfaceUrl(target, 'wordpress_frontend', reportPath, sitePath);
    if (!postId || !frontendUrl) {
      return '';
    }

    const url = new URL(frontendUrl);
    url.pathname = '/studio-auto-login';
    url.search = '';
    url.searchParams.set('redirect_to', `/wp-admin/post.php?post=${postId}&action=edit`);
    return url.toString();
  }

  return configured;
}

async function restoreMissingSourceStaticFiles(importReport, sitePath, result) {
  const writes = new Map();
  for (const call of Array.isArray(result?.toolCalls) ? result.toolCalls : []) {
    if (call?.name !== 'Write' || typeof call?.input?.file_path !== 'string' || typeof call?.input?.content !== 'string') {
      continue;
    }
    writes.set(path.resolve(call.input.file_path), call.input.content);
  }

  if (!writes.size) {
    return;
  }

  for (const target of comparisonTargets(importReport)) {
    const surfaces = target?.comparison_hooks?.render_surfaces || {};
    const sourceFile = surfaces.source_static?.url || target?.source_file || '';
    const hostPath = resolveSourceStaticFile(sourceFile, importReport.reportPath, sitePath);
    if (!hostPath) {
      continue;
    }

    try {
      await stat(hostPath);
      continue;
    } catch {
      // Restore only files the agent authored during this benchmark run.
    }

    const content = writes.get(path.resolve(hostPath));
    if (typeof content !== 'string') {
      continue;
    }

    await mkdir(path.dirname(hostPath), { recursive: true });
    await writeFile(hostPath, content);
  }
}

export async function compareSemanticFidelity(importReport, artifactDir, sitePath) {
  return compareSemanticFidelityImpl(importReport, artifactDir, sitePath, {
    studioPath: STUDIO_PATH,
    viewport: VISUAL_VIEWPORT,
  });
}

function designFingerprintMetrics(fingerprint) {
  const motifs = new Set(fingerprint?.motifs || []);
  const paletteLabels = new Set(fingerprint?.palette_labels || []);
  const fonts = (fingerprint?.font_families || []).map((font) => font.toLowerCase());
  const patterns = fingerprint?.patterns || {};

  return {
    design_source_html_present: fingerprint?.source_html_present ? 1 : 0,
    design_css_file_count: Number(fingerprint?.css_file_count || 0),
    design_font_unique_count: Number(fingerprint?.font_families?.length || 0),
    design_color_unique_count: Number(fingerprint?.color_values?.length || 0),
    design_css_variable_count: Number(fingerprint?.css_variables?.length || 0),
    design_motif_count: Number(fingerprint?.motifs?.length || 0),
    design_palette_label_count: Number(fingerprint?.palette_labels?.length || 0),
    design_gradient_count: Number(fingerprint?.gradient_count || 0),
    design_animation_count: Number(fingerprint?.animation_count || 0),
    design_transition_count: Number(fingerprint?.transition_count || 0),
    design_hero_grid_background_count: Number(patterns.hero_grid_background_count || 0),
    design_hero_grid_background_present: patterns.hero_grid_background_present ? 1 : 0,
    design_stacked_full_width_section_count: Number(patterns.stacked_full_width_section_count || 0),
    design_panel_section_count: Number(patterns.panel_section_count || 0),
    design_eyebrow_label_count: Number(patterns.eyebrow_label_count || 0),
    design_sections_with_eyebrow_title_count: Number(patterns.sections_with_eyebrow_title_count || 0),
    design_font_family_count: Number(patterns.font_family_count || fingerprint?.font_families?.length || 0),
    design_uses_inter: fonts.includes('inter') ? 1 : 0,
    design_uses_syne: fonts.includes('syne') ? 1 : 0,
    design_uses_space_grotesk: fonts.includes('space grotesk') ? 1 : 0,
    design_uses_purple_lime: paletteLabels.has('purple_lime') ? 1 : 0,
    design_uses_dark_base: paletteLabels.has('dark_base') || fingerprint?.dark_theme ? 1 : 0,
    design_uses_bento_grid: motifs.has('bento_grid') ? 1 : 0,
    design_uses_cards_grid: motifs.has('cards_grid') ? 1 : 0,
    design_uses_code_preview: motifs.has('code_preview') ? 1 : 0,
    design_uses_dashboard_mockup: motifs.has('dashboard_mockup') ? 1 : 0,
    design_uses_glow_overlay: motifs.has('glow_overlay') ? 1 : 0,
    design_uses_marquee: motifs.has('marquee') ? 1 : 0,
    design_uses_terminal_window: motifs.has('terminal_window') ? 1 : 0,
  };
}

async function validateThemeBlocks(sitePath, siteUrl) {
  const documents = await collectThemeBlockDocuments(sitePath);
  if (documents.length === 0) {
    return {
      document_count: 0,
      total_blocks: 0,
      valid_blocks: 0,
      invalid_blocks: 0,
      error: 'No generated theme block documents found.',
      results: [],
    };
  }

  const playwrightPackage = path.join(STUDIO_PATH, 'node_modules/@playwright/test');
  const { chromium } = requireFromBench(playwrightPackage);
  let browser;
  let page;

  try {
    browser = await chromium.launch({ args: ['--ignore-certificate-errors'] });
    page = await browser.newPage({ ignoreHTTPSErrors: true });
    const normalizedSiteUrl = siteUrl.replace(/\/+$/, '');
    await page.goto(`${normalizedSiteUrl}/studio-auto-login?redirect_to=%2Fwp-admin%2Fpost-new.php`, {
      waitUntil: 'domcontentloaded',
      timeout: 30_000,
    });
    await page.waitForFunction(
      () => {
        try {
          const wp = window.wp;
          return (
            wp &&
            wp.blocks &&
            typeof wp.blocks.getBlockTypes === 'function' &&
            wp.blocks.getBlockTypes().length > 0
          );
        } catch {
          return false;
        }
      },
      { timeout: 30_000 }
    );

    const report = await page.evaluate((docs) => {
      const wpBlocks = window.wp?.blocks;
      const results = [];

      function issueStrings(validationIssues) {
        const issues = [];
        for (const issue of validationIssues || []) {
          if (!issue?.args) {
            continue;
          }
          const message = String(issue.args[0] || '');
          if (message.startsWith('Block validation failed')) {
            continue;
          }
          issues.push(
            issue.args
              .map((arg) => (typeof arg === 'object' ? JSON.stringify(arg).slice(0, 200) : String(arg).slice(0, 500)))
              .join(' ')
          );
        }
        return issues;
      }

      function validateRecursive(block, source) {
        if (!block?.name || block.name === 'core/freeform' || block.name === 'core/missing') {
          return;
        }

        const blockType = wpBlocks.getBlockType(block.name);
        let isValid = true;
        let issues = [];
        let expectedContent;

        if (!blockType) {
          isValid = false;
          issues = [`Block type "${block.name}" is not registered.`];
        } else {
          const validation = wpBlocks.validateBlock(block, blockType);
          if (Array.isArray(validation)) {
            isValid = validation[0];
            if (!isValid) {
              issues = issueStrings(validation[1]);
            }
          } else {
            isValid = validation.isValid;
            if (!isValid) {
              issues = issueStrings(validation.validationIssues);
            }
          }

          if (!isValid) {
            try {
              expectedContent = wpBlocks.getSaveContent(blockType, block.attributes, block.innerBlocks);
            } catch {
              expectedContent = undefined;
            }
          }
        }

        results.push({
          source,
          blockName: block.name,
          isValid,
          issues,
          originalContent: block.originalContent || '',
          expectedContent,
        });

        for (const inner of block.innerBlocks || []) {
          validateRecursive(inner, source);
        }
      }

      for (const doc of docs) {
        for (const block of wpBlocks.parse(doc.content)) {
          validateRecursive(block, doc.source);
        }
      }

      const validBlocks = results.filter((result) => result.isValid).length;
      return {
        document_count: docs.length,
        total_blocks: results.length,
        valid_blocks: validBlocks,
        invalid_blocks: results.length - validBlocks,
        results,
      };
    }, documents);

    await page.close();
    return report;
  } catch (error) {
    let diagnostics = '';
    if (page && !page.isClosed()) {
      try {
        diagnostics = await page.evaluate(() => {
          const wp = window.wp;
          return JSON.stringify({
            url: window.location.href,
            title: document.title,
            bodyClass: document.body?.className || '',
            hasWp: typeof wp !== 'undefined',
            hasBlocks: !!wp?.blocks,
            blockTypeCount: wp?.blocks?.getBlockTypes?.()?.length || 0,
          });
        });
      } catch (diagnosticError) {
        diagnostics = `diagnostics failed: ${diagnosticError instanceof Error ? diagnosticError.message : String(diagnosticError)}`;
      }
    }

    return {
      document_count: documents.length,
      total_blocks: 0,
      valid_blocks: 0,
      invalid_blocks: 0,
      error: `Editor block validation failed: ${error instanceof Error ? error.message : String(error)}${diagnostics ? `; ${diagnostics}` : ''}`,
      results: [],
    };
  } finally {
    if (browser) {
      await browser.close();
    }
  }
}

function validationMetrics(result) {
  const toolCalls = Array.isArray(result.toolCalls) ? result.toolCalls : [];
  const toolResults = Array.isArray(result.toolResults) ? result.toolResults : [];
  const validateCallCount = toolCalls.filter((item) => item && item.name === 'validate_blocks').length;
  const validateResults = toolResults.filter((item) => item && item.toolName === 'validate_blocks');
  const validateErrorCount = validateResults.filter((item) => item.isError === true).length;
  const validatedAllCount = validateResults.filter((item) => {
    const text = typeof item.text === 'string' ? item.text : '';
    const match = text.match(/Validation:\s+(\d+)\/(\d+)\s+blocks valid/i);
    return match && match[1] === match[2];
  }).length;

  return { validateCallCount, validateErrorCount, validatedAllCount };
}

function metric(value) {
  const number = Number(value ?? 0);
  return Number.isFinite(number) ? number : 0;
}

function toolMetrics(result) {
  const toolEvents = Array.isArray(result.toolEvents) ? result.toolEvents : [];
  const names = ['site_info', 'wp_cli', 'validate_blocks', 'take_screenshot', 'Write', 'Edit'];
  const metrics = {
    tool_event_count: toolEvents.length,
    max_tool_duration_ms: 0,
  };

  for (const event of toolEvents) {
    const duration = metric(event?.durationMs);
    if (duration > metrics.max_tool_duration_ms) {
      metrics.max_tool_duration_ms = duration;
    }
  }

  for (const name of names) {
    const events = toolEvents.filter((event) => event && event.toolName === name);
    const durations = events.map((event) => metric(event?.durationMs)).filter((value) => value > 0);
    const key = name.toLowerCase().replace(/[^a-z0-9]+/g, '_');
    metrics[`${key}_tool_count`] = events.length;
    metrics[`${key}_error_count`] = events.filter((event) => event.isError === true).length;
    metrics[`${key}_duration_ms`] = durations.reduce((sum, value) => sum + value, 0);
    metrics[`${key}_max_duration_ms`] = durations.length ? Math.max(...durations) : 0;
  }

  return metrics;
}

function optionalArtifactPath(name, value) {
  return typeof value === 'string' && value.length > 0 ? { [name]: value } : {};
}


export function importerBlockQualityMetrics(importReport) {
  const quality = importReport?.report?.quality || {};

  return {
    importerCoreHtmlBlockCount: metric(quality.core_html_block_count),
    importerFreeformBlockCount: metric(quality.freeform_block_count),
    importerFallbackCount: metric(quality.fallback_count),
  };
}

export function importerBlockQualityFailureDetails(importerBlockQuality) {
  const { importerCoreHtmlBlockCount, importerFreeformBlockCount, importerFallbackCount } = importerBlockQuality;

  if (importerCoreHtmlBlockCount === 0 && importerFreeformBlockCount === 0 && importerFallbackCount === 0) {
    return [];
  }

  return [
    `importer block quality: core/html=${importerCoreHtmlBlockCount}, freeform=${importerFreeformBlockCount}, fallback=${importerFallbackCount}`,
  ];
}

function visualRatio(value) {
  const ratio = metric(value);
  return Number.isFinite(ratio) ? ratio : 1;
}

function formatVisualRatio(value) {
  return visualRatio(value).toFixed(2);
}

export function visualEditorParityMetrics(visualComparison) {
  return {
    visualEditorVsSourcePixelDiffRatio: visualRatio(visualComparison?.visual_editor_vs_source_pixel_diff_ratio),
    visualEditorVsFrontendPixelDiffRatio: visualRatio(visualComparison?.visual_editor_vs_frontend_pixel_diff_ratio),
    visualSourceVsFrontendPixelDiffRatio: visualRatio(
      visualComparison?.visual_pixel_diff_ratio ??
        visualComparison?.pixel_diff_ratio ??
        visualComparison?.visual_source_vs_frontend_pixel_diff_ratio_diagnostic
    ),
    visualEditorParityErrorCount: metric(visualComparison?.visual_editor_parity_error_count),
  };
}

export function visualEditorParityFailureDetails(visualEditorParity) {
  const {
    visualEditorVsSourcePixelDiffRatio,
    visualEditorVsFrontendPixelDiffRatio,
    visualSourceVsFrontendPixelDiffRatio,
    visualEditorParityErrorCount,
  } = visualEditorParity;
  const editorFailedSource = visualEditorVsSourcePixelDiffRatio > VISUAL_EDITOR_PIXEL_DIFF_THRESHOLD;
  const editorFailedFrontend = visualEditorVsFrontendPixelDiffRatio > VISUAL_EDITOR_PIXEL_DIFF_THRESHOLD;

  if (visualEditorParityErrorCount > 0) {
    return [`editor visual parity could not be measured (${visualEditorParityErrorCount} capture/diff errors)`];
  }

  if (!editorFailedSource && !editorFailedFrontend) {
    return [];
  }

  if (editorFailedFrontend && visualSourceVsFrontendPixelDiffRatio <= VISUAL_EDITOR_PIXEL_DIFF_THRESHOLD) {
    return [
      `editor render diverges from frontend (editor diff: ${formatVisualRatio(
        visualEditorVsSourcePixelDiffRatio
      )}, frontend diff: ${formatVisualRatio(
        visualSourceVsFrontendPixelDiffRatio
      )}) - likely block-validation or unscoped CSS`,
    ];
  }

  if (editorFailedSource && visualSourceVsFrontendPixelDiffRatio > VISUAL_EDITOR_PIXEL_DIFF_THRESHOLD) {
    return [
      `editor and frontend both diverge from source (editor: ${formatVisualRatio(
        visualEditorVsSourcePixelDiffRatio
      )}, frontend: ${formatVisualRatio(visualSourceVsFrontendPixelDiffRatio)}) - conversion failed before editor concern`,
    ];
  }

  return [
    `editor visual parity failed (editor vs source: ${formatVisualRatio(
      visualEditorVsSourcePixelDiffRatio
    )}, editor vs frontend: ${formatVisualRatio(visualEditorVsFrontendPixelDiffRatio)})`,
  ];
}

export function visualPixelDiffFailureDetails(visualComparison) {
  const visualPixelDiffRatio = metric(visualComparison?.pixel_diff_ratio);
  if (visualPixelDiffRatio <= VISUAL_PIXEL_DIFF_THRESHOLD) {
    return [];
  }

  return [
    `visual pixel diff: ${visualPixelDiffRatio.toFixed(3)} (threshold: ${VISUAL_PIXEL_DIFF_THRESHOLD.toFixed(3)})`,
  ];
}

export function agentSuccessGate(result, semanticComparison, importReport, visualComparison) {
  const semanticMismatchCount = metric(semanticComparison?.mismatch_count);
  const importerBlockQuality = importerBlockQualityMetrics(importReport);
  const visualEditorParity = visualEditorParityMetrics(visualComparison);
  const visualPixelDiffRatio = metric(visualComparison?.pixel_diff_ratio);
  const agentTimedOut = result?.timedOut === true;
  const agentSucceeded =
    result?.success === true &&
    !result?.error &&
    !agentTimedOut &&
    semanticMismatchCount === 0 &&
    importerBlockQuality.importerCoreHtmlBlockCount === 0 &&
    importerBlockQuality.importerFreeformBlockCount === 0 &&
    importerBlockQuality.importerFallbackCount === 0 &&
    visualEditorParity.visualEditorParityErrorCount === 0 &&
    visualEditorParity.visualEditorVsSourcePixelDiffRatio <= VISUAL_EDITOR_PIXEL_DIFF_THRESHOLD &&
    visualEditorParity.visualEditorVsFrontendPixelDiffRatio <= VISUAL_EDITOR_PIXEL_DIFF_THRESHOLD &&
    visualPixelDiffRatio <= VISUAL_PIXEL_DIFF_THRESHOLD;

  return {
    agentSucceeded,
    semanticMismatchCount,
    semanticFailureDetails: semanticMismatchCount > 0 ? semanticMismatchFailureDetails(semanticComparison) : [],
    importerBlockQuality,
    importerBlockQualityFailureDetails: importerBlockQualityFailureDetails(importerBlockQuality),
    visualEditorParity,
    visualEditorFailureDetails: visualEditorParityFailureDetails(visualEditorParity),
    visualPixelDiffRatio,
    visualPixelDiffFailureDetails: visualPixelDiffFailureDetails(visualComparison),
    metrics: {
      success_rate: agentSucceeded ? 1 : 0,
      agent_error_rate: agentSucceeded ? 0 : 1,
      timed_out: agentTimedOut ? 1 : 0,
      agent_runner_error: typeof result?.error === 'string' ? 1 : 0,
    },
  };
}

export default async function studioAgentSiteBuildBench() {
  const runtime = resolveBenchRuntime();
  const currentVariant = variant();
  const runId = `${currentVariant}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const artifactDir = runtime.artifactDir;
  const sitePath = path.join(runtime.siteRoot, runId);
  await prepareNamespacedStudioRuntime(runtime);
  await mkdir(runtime.siteRoot, { recursive: true });

  const totalStarted = Date.now();
  const siteCreateStarted = Date.now();
  await createFreshSite(sitePath);
  const siteCreateMs = Date.now() - siteCreateStarted;

  const selectedPromptVariant = promptVariant();
  const selectedPromptFile = String(await promptTemplatePath());
  const systemPrompt = await systemPromptFingerprint();
  const prompt = await siteBuildPrompt(sitePath);
  const model = evalModel();
  const agentStarted = Date.now();
  const { result, resultFile, exitCode, stderr } = await runEval(prompt, {
    maxTurns: 40,
    timeoutMs: 420000,
    ...(model ? { model } : {}),
  });
  const agentElapsedMs = Date.now() - agentStarted;
  const qualityProbeStarted = Date.now();
  const quality = await probeQuality(sitePath, { runCli });
  const qualityProbeMs = Date.now() - qualityProbeStarted;
  const status = await siteStatus(sitePath);
  assertNamespacedPort(status, runtime);
  const importReport = await collectLatestImportReport(sitePath);
  const importerTimings = importerTimingMetrics(importReport);
  await mkdir(artifactDir, { recursive: true });
  await restoreMissingSourceStaticFiles(importReport, sitePath, result);
  const visualComparisonStarted = Date.now();
  const visualComparison = await compareVisualFidelity(importReport, artifactDir, sitePath);
  const visualComparisonMs = Date.now() - visualComparisonStarted;
  const semanticComparisonStarted = Date.now();
  const semanticComparison = await compareSemanticFidelity(importReport, artifactDir, sitePath);
  const semanticComparisonMs = Date.now() - semanticComparisonStarted;
  const editorValidationStarted = Date.now();
  const editorValidation = await validateThemeBlocks(sitePath, status.siteUrl);
  const editorValidationMs = Date.now() - editorValidationStarted;
  const generatedThemeUxStarted = Date.now();
  const generatedThemeUxGates = await collectGeneratedThemeUxGates(sitePath, importReport, artifactDir);
  const generatedThemeUxMs = Date.now() - generatedThemeUxStarted;
  const totalElapsedMs = Date.now() - totalStarted;
  const validation = validationMetrics(result);
  const authoredBlocks = agentAuthoredBlockMetrics(result);
  const nativeBlockQuality = nativeBlockQualityMetrics(quality, authoredBlocks, editorValidation, importReport);
  const designFingerprint = await collectDesignFingerprint(sitePath);
  const designMetrics = designFingerprintMetrics(designFingerprint);
  const gate = agentSuccessGate(result, semanticComparison, importReport, visualComparison);
  const semanticMismatchCount = gate.semanticMismatchCount;
  const semanticOptionalSelectorAbsentCount = semanticTargetMetric(semanticComparison, 'optional_selector_absent_count');
  const failureDetails = [
    ...gate.semanticFailureDetails,
    ...gate.importerBlockQualityFailureDetails,
    ...gate.visualEditorFailureDetails,
    ...gate.visualPixelDiffFailureDetails,
  ];
  const { importerCoreHtmlBlockCount, importerFreeformBlockCount, importerFallbackCount } = gate.importerBlockQuality;

  const artifactFile = path.join(artifactDir, `result-${runId}.json`);
  await writeFile(
    artifactFile,
    JSON.stringify(
      {
        variant: currentVariant,
        bench_namespace: runtime.namespaceSlug,
        bench_port_range: runtime.namespaceSlug ? `${runtime.portBase}-${runtime.portMax}` : '',
        prompt_variant: selectedPromptVariant,
        prompt_file: selectedPromptFile,
        prompt_category: PROMPT_CATEGORY,
        model,
        ...systemPrompt,
        prompt,
        sitePath,
        siteUrl: status.siteUrl,
        autoLoginUrl: status.autoLoginUrl,
        exitCode,
        stderr,
        resultFile,
        result,
        timings: {
          site_create_ms: siteCreateMs,
          agent_elapsed_ms: agentElapsedMs,
          quality_probe_ms: qualityProbeMs,
          visual_comparison_ms: visualComparisonMs,
          semantic_comparison_ms: semanticComparisonMs,
          editor_validation_ms: editorValidationMs,
          generated_theme_ux_ms: generatedThemeUxMs,
          total_elapsed_ms: totalElapsedMs,
        },
        quality,
        importReport,
        visualComparison,
        semanticComparison,
        editorValidation,
        generatedThemeUxGates,
        designFingerprint,
        authoredBlocks,
        nativeBlockQuality,
        validation,
      },
      null,
      2
    )
  );

  const toolCalls = Array.isArray(result.toolCalls) ? result.toolCalls : [];
  const toolResults = Array.isArray(result.toolResults) ? result.toolResults : [];
  const turnDurations = Array.isArray(result.turnDurationsMs) ? result.turnDurationsMs : [];
  const phaseTimings = result.phaseTimingsMs && typeof result.phaseTimingsMs === 'object' ? result.phaseTimingsMs : {};
  const toolBreakdown = toolMetrics(result);
  // result.error and result.timedOut land in the eval-runner JSON via
  // Automattic/studio#3330. Both are nullish on Studio versions older than
  // that PR, which collapses the AND to result.success === true (the same
  // gate the bench had before). On versions with #3330, the bench correctly
  // distinguishes successful runs from runs that finished with a runner-side
  // exception, and from runs that timed out. timed_out is surfaced as its
  // own metric so timeout regressions are visible separately from agent
  // failures.
  // Issue #60: Static Site Importer can produce a syntactically valid theme
  // while dropping meaningful source content. Any semantic-fidelity mismatch
  // means the generated site no longer preserves the source fixture, so the
  // correct threshold for this bench is zero mismatches rather than warnings.

  return {
    metrics: {
      ...gate.metrics,
      elapsed_ms: totalElapsedMs,
      site_create_ms: siteCreateMs,
      agent_elapsed_ms: agentElapsedMs,
      quality_probe_ms: qualityProbeMs,
      visual_comparison_ms: visualComparisonMs,
      semantic_comparison_ms: semanticComparisonMs,
      editor_validation_ms: editorValidationMs,
      generated_theme_ux_ms: generatedThemeUxMs,
      total_elapsed_ms: totalElapsedMs,
      phase_resolve_initial_provider_ms: metric(phaseTimings.resolve_initial_provider_ms),
      phase_resolve_unavailable_provider_ms: metric(phaseTimings.resolve_unavailable_provider_ms),
      phase_resolve_ai_environment_ms: metric(phaseTimings.resolve_ai_environment_ms),
      phase_start_ai_agent_ms: metric(phaseTimings.start_ai_agent_ms),
      phase_first_assistant_message_ms: metric(phaseTimings.first_assistant_message_ms),
      phase_total_eval_ms: metric(phaseTimings.total_eval_ms),
      turn_count: Number(result.numTurns ?? turnDurations.length ?? 0),
      assistant_message_count: turnDurations.length,
      max_turn_ms: turnDurations.length ? Math.max(...turnDurations) : 0,
      tool_call_count: toolCalls.length,
      tool_error_count: toolResults.filter((item) => item && item.isError === true).length,
      ...toolBreakdown,
      validate_call_count: validation.validateCallCount,
      validate_error_count: validation.validateErrorCount,
      validated_all_count: validation.validatedAllCount,
      ...authoredBlocks,
      native_block_quality_pass: nativeBlockQuality.native_block_quality_pass ? 1 : 0,
      native_block_quality_failure_count: nativeBlockQuality.native_block_quality_failure_count,
      generated_theme_ux_quality_pass: generatedThemeUxGates.generated_theme_ux_quality_pass ? 1 : 0,
      generated_theme_ux_quality_failure_count: Number(generatedThemeUxGates.generated_theme_ux_quality_failure_count || 0),
      generated_theme_actual_freeform_block_count: Number(generatedThemeUxGates.actual_freeform_block_count || 0),
      generated_theme_importer_freeform_block_count: Number(generatedThemeUxGates.importer_freeform_block_count || 0),
      generated_theme_freeform_report_mismatch_count: Number(generatedThemeUxGates.freeform_report_mismatch_count || 0),
      generated_theme_css_hidden_editor_content_count: Number(generatedThemeUxGates.css_hidden_editor_content_count || 0),
      generated_theme_css_editor_reveal_override_count: Number(generatedThemeUxGates.css_editor_reveal_override_count || 0),
      generated_theme_css_hidden_editor_content_without_override_count: Number(
        generatedThemeUxGates.css_hidden_editor_content_without_override_count || 0
      ),
      editor_validation_document_count: Number(editorValidation.document_count || 0),
      editor_validation_total_blocks: Number(editorValidation.total_blocks || 0),
      editor_validation_valid_blocks: Number(editorValidation.valid_blocks || 0),
      editor_validation_invalid_blocks: Number(editorValidation.invalid_blocks || 0),
      editor_validation_error_count: editorValidation.error ? 1 : 0,
      importer_report_error_count: importReport.error ? 1 : 0,
      importer_fallback_count: importerFallbackCount,
      importer_core_html_block_count: importerCoreHtmlBlockCount,
      importer_freeform_block_count: importerFreeformBlockCount,
      importer_invalid_block_count: Number(importReport.report?.quality?.invalid_block_count || 0),
      importer_invalid_block_document_count: Number(importReport.report?.quality?.invalid_block_document_count || 0),
      importer_generated_block_document_count: Number(importReport.report?.generated_theme?.block_documents?.length || 0),
      ...importerTimings,
      system_prompt_size_bytes: systemPrompt.system_prompt_size_bytes,
      visual_comparison_target_count: Number(visualComparison.target_count || 0),
      visual_comparison_checked_target_count: Number(visualComparison.checked_target_count || 0),
      visual_comparison_error_count: Number(visualComparison.error_count || 0),
      visual_editor_vs_source_pixel_diff_ratio: metric(visualComparison.visual_editor_vs_source_pixel_diff_ratio),
      visual_editor_vs_frontend_pixel_diff_ratio: metric(visualComparison.visual_editor_vs_frontend_pixel_diff_ratio),
      visual_editor_parity_error_count: Number(visualComparison.visual_editor_parity_error_count || 0),
      visual_missing_selector_count: Number(visualComparison.missing_selector_count || 0),
      visual_visibility_mismatch_count: Number(visualComparison.visibility_mismatch_count || 0),
      visual_nonzero_bounding_box_count: Number(visualComparison.nonzero_bounding_box_count || 0),
      visual_nonzero_bounding_box_mismatch_count: Number(visualComparison.nonzero_bounding_box_mismatch_count || 0),
      visual_mismatch_detail_count: Number(visualComparison.diagnostics?.mismatch_count || 0),
      visual_optional_probe_absent_count: Number(visualComparison.diagnostics?.optional_probe_absent_count || 0),
      visual_simple_probe_parity_mismatch_count: Number(visualComparison.simple_probe_parity_mismatch_count || 0),
      visual_nav_probe_parity_mismatch_count: Number(visualComparison.nav_probe_parity_mismatch_count || 0),
      visual_footer_probe_parity_mismatch_count: Number(visualComparison.footer_probe_parity_mismatch_count || 0),
      visual_hero_probe_parity_mismatch_count: Number(visualComparison.hero_probe_parity_mismatch_count || 0),
      visual_pixel_diff_ratio: gate.visualPixelDiffRatio,
      visual_pixel_diff_pixel_count: Number(visualComparison.pixel_diff_pixel_count || 0),
      semantic_comparison_target_count: Number(semanticComparison.target_count || 0),
      semantic_comparison_checked_target_count: Number(semanticComparison.checked_target_count || 0),
      semantic_comparison_error_count: Number(semanticComparison.error_count || 0),
      semantic_mismatch_count: semanticMismatchCount,
      semantic_dom_mismatch_count: semanticMismatchCount,
      semantic_role_mismatch_count: Number(semanticComparison.role_mismatch_count || 0),
      semantic_class_owner_changed_count: Number(semanticComparison.class_owner_changed_count || 0),
      semantic_interaction_group_split_count: Number(semanticComparison.interaction_group_split_count || 0),
      semantic_interaction_group_merged_count: Number(semanticComparison.interaction_group_merged_count || 0),
      semantic_link_text_delta_count: Number(semanticComparison.link_text_delta_count || 0),
      semantic_region_link_count_delta: metric(semanticComparison.region_link_count_delta),
      semantic_clickable_area_delta_ratio: metric(semanticComparison.clickable_area_delta_ratio),
      semantic_optional_selector_absent_count: semanticOptionalSelectorAbsentCount,
      region_link_count_delta: metric(semanticComparison.region_link_count_delta),
      clickable_area_delta_ratio: metric(semanticComparison.clickable_area_delta_ratio),
      optional_selector_absent_count: semanticOptionalSelectorAbsentCount,
      semantic_landmark_mismatch_count: Number(semanticComparison.landmark_mismatch_count || 0),
      semantic_repeated_count_delta_count: Number(semanticComparison.repeated_count_delta_count || 0),
      semantic_brand_logo_missing_count: Number(semanticComparison.brand_logo_missing_count || 0),
      ...designMetrics,
      posts_seen: Number(quality.posts_seen || 0),
      posts_with_blocks: Number(quality.posts_with_blocks || 0),
      pages_seen: Number(quality.pages_seen || 0),
      templates_seen: Number(quality.templates_seen || 0),
      template_parts_seen: Number(quality.template_parts_seen || 0),
      target_pages_seen: Number(quality.target_pages_seen || 0),
      target_posts_with_blocks: Number(quality.target_posts_with_blocks || 0),
      target_raw_html_unconverted: Number(quality.target_raw_html_unconverted || 0),
      target_total_blocks: Number(quality.target_total_blocks || 0),
      target_core_html_blocks: Number(quality.target_core_html_blocks || 0),
      target_serialized_block_comments: Number(quality.target_serialized_block_comments || 0),
      total_blocks: Number(quality.total_blocks || 0),
      core_html_blocks: Number(quality.core_html_blocks || 0),
      core_html_without_bfb_fallback: Number(quality.core_html_without_bfb_fallback || 0),
      target_core_html_without_bfb_fallback: Number(quality.target_core_html_without_bfb_fallback || 0),
      serialized_block_comments: Number(quality.serialized_block_comments || 0),
      bfb_fallback_count: Number(quality.bfb_fallback_count || 0),
    },
    artifacts: {
      raw_result: artifactFile,
      site_path: sitePath,
      frontend_url: status.siteUrl,
      admin_auto_login_url: status.autoLoginUrl,
      ...optionalArtifactPath('visual_comparison_dir', visualComparison.artifact_dir),
      ...optionalArtifactPath('visual_comparison_mismatches', visualComparison.diagnostics_artifact),
      ...optionalArtifactPath('visual_pixel_diff', visualComparison.pixel_diff_artifact),
      ...optionalArtifactPath('semantic_fidelity', semanticComparison.artifact),
      ...optionalArtifactPath('semantic_comparison_dir', semanticComparison.artifact_dir),
      ...optionalArtifactPath('generated_theme_ux_gates', generatedThemeUxGates.artifact),
    },
    errors: failureDetails,
    metadata: {
      benchmark_variant: currentVariant,
      bench_namespace: runtime.namespaceSlug,
      bench_port_range: runtime.namespaceSlug ? `${runtime.portBase}-${runtime.portMax}` : '',
      prompt_variant: selectedPromptVariant,
      prompt_file: selectedPromptFile,
      prompt_category: PROMPT_CATEGORY,
      model: model || 'default',
      design_primary_font_family: designFingerprint.patterns?.primary_font_family || '',
      design_display_font_family: designFingerprint.patterns?.display_font_family || '',
      design_type_pairing_signature: designFingerprint.patterns?.type_pairing_signature || '',
      design_repetition_signature: designFingerprint.patterns?.repetition_signature || '',
      design: designFingerprint,
      ...systemPrompt,
    },
  };
}
