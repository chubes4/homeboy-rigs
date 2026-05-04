import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

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
const DEFAULT_PROMPT_VARIANT = 'studio-code';
const PROMPT_CATEGORY = 'site-build';
const PROMPT_VARIANTS = [
  'artist-music',
  'astro-docs-content-collection',
  'course-education',
  'data-machine',
  'documentation-knowledge-base',
  'editorial-magazine',
  'event-conference',
  'homeboy',
  'intelligence',
  'local-service-business',
  'markdown-blog-launch-site',
  'membership-community',
  'nonprofit',
  'nonprofit-campaign',
  'portfolio',
  'product-catalog',
  'radical-speed-month',
  'restaurant',
  'saas',
  'realistic-small-business',
  'static-content-library',
  'studio-code',
  'switchback-woocommerce-extra-hard',
  'wp-coding-agents',
  'wordpress-is-dead',
];
const SYSTEM_PROMPT_FILES = ['apps/cli/ai/system-prompt.ts'];
const requireFromBench = createRequire(import.meta.url);
const VISUAL_VIEWPORT = { width: 1440, height: 1100 };
const VISUAL_SCREENSHOT_DIAGNOSTIC_LIMIT = 5;

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
  await validatePromptVariantCatalog();
  return [...PROMPT_VARIANTS];
}

export async function validatePromptVariantCatalog() {
  const promptsDir = new URL('./prompts/site-build/', import.meta.url);
  const entries = await readdir(promptsDir, { withFileTypes: true });
  const files = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
    .map((entry) => entry.name.replace(/\.md$/, ''))
    .sort();

  const registered = [...PROMPT_VARIANTS].sort();
  const missingFiles = registered.filter((variantName) => !files.includes(variantName));
  const unregisteredFiles = files.filter((variantName) => !registered.includes(variantName));

  if (missingFiles.length || unregisteredFiles.length) {
    throw new Error(
      `Studio site-build prompt catalog mismatch. Missing files: ${
        missingFiles.join(', ') || 'none'
      }. Unregistered files: ${unregisteredFiles.join(', ') || 'none'}.`
    );
  }

  return registered;
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
  if (!PROMPT_VARIANTS.includes(variantName)) {
    const variants = await availablePromptVariants();
    throw new Error(`Unknown ${PROMPT_VARIANT_SETTING}: ${variantName}. Available variants: ${variants.join(', ')}.`);
  }

  return new URL(`./prompts/site-build/${variantName}.md`, import.meta.url);
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

const QUALITY_PROBE = String.raw`
function bench_count_blocks( $blocks, &$counts ) {
    foreach ( $blocks as $block ) {
        $name = isset( $block['blockName'] ) ? (string) $block['blockName'] : '';
        if ( '' !== $name ) {
            $counts['total_blocks']++;
            if ( 'core/html' === $name ) {
                $counts['core_html_blocks']++;
            }
        }
        if ( ! empty( $block['innerBlocks'] ) ) {
            bench_count_blocks( $block['innerBlocks'], $counts );
        }
    }
}

$counts = array(
    'posts_seen' => 0,
    'posts_with_blocks' => 0,
    'pages_seen' => 0,
    'templates_seen' => 0,
    'template_parts_seen' => 0,
    'target_pages_seen' => 0,
    'target_posts_with_blocks' => 0,
    'target_raw_html_unconverted' => 0,
    'target_total_blocks' => 0,
    'target_core_html_blocks' => 0,
    'target_serialized_block_comments' => 0,
    'total_blocks' => 0,
    'core_html_blocks' => 0,
    'serialized_block_comments' => 0,
    'bfb_fallback_count' => (int) get_option( 'studio_bfb_unsupported_fallback_count', 0 ),
);

$front_page_id = (int) get_option( 'page_on_front', 0 );

$posts = get_posts( array(
    'post_type' => array( 'page', 'wp_template', 'wp_template_part' ),
    'post_status' => 'any',
    'numberposts' => -1,
) );

foreach ( $posts as $post ) {
    $content = (string) $post->post_content;
    if ( '' === trim( $content ) ) {
        continue;
    }
    $counts['posts_seen']++;
    if ( 'page' === $post->post_type ) {
        $counts['pages_seen']++;
    }
    if ( 'wp_template' === $post->post_type ) {
        $counts['templates_seen']++;
    }
    if ( 'wp_template_part' === $post->post_type ) {
        $counts['template_parts_seen']++;
    }
    $counts['serialized_block_comments'] += substr_count( $content, '<!-- wp:' );
    if ( false !== strpos( $content, '<!-- wp:' ) ) {
        $counts['posts_with_blocks']++;
    }
    $before_total     = $counts['total_blocks'];
    $before_core_html = $counts['core_html_blocks'];
    bench_count_blocks( parse_blocks( $content ), $counts );

    $is_target_page = 'page' === $post->post_type && ( (int) $post->ID === $front_page_id || 'Studio Code' === $post->post_title );
    if ( $is_target_page ) {
        $counts['target_pages_seen']++;
        $counts['target_serialized_block_comments'] += substr_count( $content, '<!-- wp:' );
        if ( false !== strpos( $content, '<!-- wp:' ) ) {
            $counts['target_posts_with_blocks']++;
        }
        if ( false === strpos( $content, '<!-- wp:' ) && preg_match( '/<\/?[a-z][\s>]/i', $content ) ) {
            $counts['target_raw_html_unconverted']++;
        }
        $counts['target_total_blocks'] += $counts['total_blocks'] - $before_total;
        $counts['target_core_html_blocks'] += $counts['core_html_blocks'] - $before_core_html;
    }
}

$counts['core_html_without_bfb_fallback'] = max( 0, $counts['core_html_blocks'] - $counts['bfb_fallback_count'] );
$counts['target_core_html_without_bfb_fallback'] = max( 0, $counts['target_core_html_blocks'] - $counts['bfb_fallback_count'] );

echo wp_json_encode( $counts, JSON_PRETTY_PRINT ) . PHP_EOL;
`;

async function probeQuality(sitePath) {
  const { stdout } = await runCli(['wp', '--path', sitePath, '--php-version', '8.3', 'eval', QUALITY_PROBE]);
  const jsonStart = stdout.indexOf('{');
  if (jsonStart === -1) {
    throw new Error(`quality probe did not emit JSON: ${stdout.slice(0, 1000)}`);
  }
  return JSON.parse(stdout.slice(jsonStart));
}

async function siteStatus(sitePath) {
  const { stdout } = await runCli(['site', 'status', '--path', sitePath, '--format', 'json']);
  const jsonStart = stdout.indexOf('{');
  if (jsonStart === -1) {
    throw new Error(`site status did not emit JSON: ${stdout.slice(0, 1000)}`);
  }
  return JSON.parse(stdout.slice(jsonStart));
}

async function collectThemeBlockDocuments(sitePath) {
  const { themeRoot } = await collectLatestGeneratedTheme(sitePath);
  if (!themeRoot) {
    return [];
  }

  const documents = [];

  async function collectDir(relativeDir, extension) {
    const dir = path.join(themeRoot, relativeDir);
    let entries = [];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(extension)) {
        continue;
      }
      const file = path.join(dir, entry.name);
      let content = await readFile(file, 'utf8');
      if (extension === '.php') {
        content = content.replace(/^\s*<\?php[\s\S]*?\?>\s*/, '');
      }
      if (content.includes('<!-- wp:')) {
        documents.push({
          source: path.relative(themeRoot, file),
          content,
        });
      }
    }
  }

  await collectDir('templates', '.html');
  await collectDir('parts', '.html');
  await collectDir('patterns', '.php');

  return documents;
}

async function collectLatestGeneratedTheme(sitePath) {
  const themesRoot = path.join(sitePath, 'wp-content/themes');
  let themeEntries = [];
  try {
    themeEntries = await readdir(themesRoot, { withFileTypes: true });
  } catch {
    return { themeRoot: '', themeSlug: '', reportPath: '', error: 'Themes directory not found.' };
  }

  const generatedThemes = [];
  for (const entry of themeEntries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const themeRoot = path.join(themesRoot, entry.name);
    const reportPath = path.join(themeRoot, 'import-report.json');
    try {
      const reportStat = await stat(reportPath);
      generatedThemes.push({ themeRoot, themeSlug: entry.name, reportPath, mtimeMs: reportStat.mtimeMs });
    } catch {
      // Ignore non-importer themes.
    }
  }

  generatedThemes.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return generatedThemes[0] || { themeRoot: '', themeSlug: '', reportPath: '', error: 'No Static Site Importer report found.' };
}

async function collectLatestImportReport(sitePath) {
  const { reportPath, error } = await collectLatestGeneratedTheme(sitePath);
  if (!reportPath) {
    return { report: null, reportPath: '', error };
  }

  try {
    return { report: JSON.parse(await readFile(reportPath, 'utf8')), reportPath, error: '' };
  } catch (error) {
    return {
      report: null,
      reportPath,
      error: `Failed to read Static Site Importer report: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
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

function semanticComparisonTargets(importReport) {
  const semanticTargets = asArray(importReport?.report?.semantic_fidelity?.comparison_targets).filter(
    (target) => target && typeof target === 'object'
  );
  return semanticTargets.length ? semanticTargets : comparisonTargets(importReport);
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

function visualProbeGroups(target) {
  const hooks = target?.comparison_hooks || {};
  const layoutProbes = hooks.layout_probes && typeof hooks.layout_probes === 'object' ? hooks.layout_probes : {};
  const groups = [];
  const seen = new Set();

  function add(name, selectors) {
    const normalizedSelectors = stringArray(selectors);
    if (!normalizedSelectors.length || seen.has(name)) {
      return;
    }
    seen.add(name);
    groups.push({ name, selectors: normalizedSelectors });
  }

  for (const [name, probe] of Object.entries(layoutProbes)) {
    add(name, probe?.selectors);
  }

  add('hero_probe', hooks.hero);
  add('visible_chrome', hooks.visible_chrome);
  add('footer_chrome', ['footer', '.site-footer', '[class*=footer]']);

  return groups;
}

async function loadVisualSurface(page, url) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  await page.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => {});
  await page.waitForTimeout(300);
}

async function evaluateVisualSurface(page, groups) {
  const evaluatedGroups = [];

  for (const group of groups) {
    const selectors = [];

    for (const selector of group.selectors) {
      try {
        const matches = await page.$$eval(selector, (elements) =>
          elements.map((element) => {
            const rect = element.getBoundingClientRect();
            const style = window.getComputedStyle(element);
            const visible =
              rect.width > 0 &&
              rect.height > 0 &&
              style.display !== 'none' &&
              style.visibility !== 'hidden' &&
              Number(style.opacity || '1') > 0;

            return {
              visible,
              boundingBox: {
                x: Math.round(rect.x),
                y: Math.round(rect.y),
                width: Math.round(rect.width),
                height: Math.round(rect.height),
              },
              text: String(element.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 160),
            };
          })
        );
        selectors.push({
          selector,
          count: matches.length,
          visible_count: matches.filter((match) => match.visible).length,
          nonzero_bounding_box_count: matches.filter(
            (match) => match.boundingBox.width > 0 && match.boundingBox.height > 0
          ).length,
          first_match: matches[0] || null,
        });
      } catch (error) {
        selectors.push({
          selector,
          count: 0,
          visible_count: 0,
          nonzero_bounding_box_count: 0,
          error: error instanceof Error ? error.message : String(error),
          first_match: null,
        });
      }
    }

    evaluatedGroups.push({
      name: group.name,
      selectors,
      selector_count: selectors.length,
      missing_selector_count: selectors.filter((item) => item.count === 0).length,
      errored_selector_count: selectors.filter((item) => item.error).length,
      matched_selector_count: selectors.filter((item) => item.count > 0).length,
      visible_selector_count: selectors.filter((item) => item.visible_count > 0).length,
      nonzero_bounding_box_selector_count: selectors.filter((item) => item.nonzero_bounding_box_count > 0).length,
    });
  }

  return evaluatedGroups;
}

function visualSurfaceTotals(groups) {
  return groups.reduce(
    (totals, group) => {
      totals.selector_count += group.selector_count;
      totals.missing_selector_count += group.missing_selector_count;
      totals.errored_selector_count += group.errored_selector_count;
      totals.matched_selector_count += group.matched_selector_count;
      totals.visible_selector_count += group.visible_selector_count;
      totals.nonzero_bounding_box_selector_count += group.nonzero_bounding_box_selector_count;
      return totals;
    },
    {
      selector_count: 0,
      missing_selector_count: 0,
      errored_selector_count: 0,
      matched_selector_count: 0,
      visible_selector_count: 0,
      nonzero_bounding_box_selector_count: 0,
    }
  );
}

function visualSelectorSummary(selector) {
  const firstMatch = selector?.first_match || null;
  return {
    count: Number(selector?.count || 0),
    visible_count: Number(selector?.visible_count || 0),
    nonzero_bounding_box_count: Number(selector?.nonzero_bounding_box_count || 0),
    first_bounding_box: firstMatch?.boundingBox || null,
    first_visible: firstMatch?.visible === true,
    first_visible_text: firstMatch?.text || '',
    error: selector?.error || '',
  };
}

function visualMismatchReason(sourceSelector, frontendSelector) {
  if (sourceSelector?.error || frontendSelector?.error) {
    return 'selector_error';
  }
  if (sourceSelector.visible_count === 0 && frontendSelector.visible_count === 0) {
    return 'missing_on_both_surfaces';
  }
  if (sourceSelector.count === 0 && frontendSelector.count === 0) {
    return 'missing_on_both_surfaces';
  }
  if (sourceSelector.count === 0) {
    return 'missing_from_source_static';
  }
  if (frontendSelector.count === 0) {
    return 'missing_from_wordpress_frontend';
  }

  const sourceVisible = sourceSelector.visible_count > 0;
  const frontendVisible = frontendSelector.visible_count > 0;
  if (sourceVisible !== frontendVisible) {
    return sourceVisible ? 'hidden_on_wordpress_frontend' : 'hidden_on_source_static';
  }

  const sourceNonzero = sourceSelector.nonzero_bounding_box_count > 0;
  const frontendNonzero = frontendSelector.nonzero_bounding_box_count > 0;
  if (sourceNonzero !== frontendNonzero) {
    return sourceNonzero ? 'zero_sized_on_wordpress_frontend' : 'zero_sized_on_source_static';
  }

  return '';
}

function visualMismatchSeverity(reason) {
  const severities = {
    selector_error: 100,
    missing_from_wordpress_frontend: 90,
    missing_from_source_static: 80,
    hidden_on_wordpress_frontend: 60,
    hidden_on_source_static: 50,
    zero_sized_on_wordpress_frontend: 40,
    zero_sized_on_source_static: 30,
  };
  return severities[reason] || 0;
}

function visualGroupMismatchSummary(groupName, mismatches) {
  const reasons = {};
  for (const mismatch of mismatches) {
    reasons[mismatch.reason] = (reasons[mismatch.reason] || 0) + 1;
  }
  return {
    group: groupName,
    mismatch_count: mismatches.length,
    reasons,
    top_selectors: mismatches.slice(0, 5).map((mismatch) => ({
      selector: mismatch.selector,
      reason: mismatch.reason,
      source_count: mismatch.source.count,
      frontend_count: mismatch.frontend.count,
      source_visible_count: mismatch.source.visible_count,
      frontend_visible_count: mismatch.frontend.visible_count,
    })),
  };
}

function visualSelectorComparisonDetail(sourceGroup, sourceSelector, frontendSelector, reason) {
  return {
    group: sourceGroup.name,
    selector: sourceSelector.selector,
    reason,
    severity: visualMismatchSeverity(reason),
    source: visualSelectorSummary(sourceSelector),
    frontend: visualSelectorSummary(frontendSelector),
    screenshots: {},
  };
}

function visualSelectorComparisonDetails(result) {
  const sourceGroups = result.surfaces.source_static?.probes || [];
  const frontendGroups = result.surfaces.wordpress_frontend?.probes || [];
  const frontendGroupsByName = new Map(frontendGroups.map((group) => [group.name, group]));
  const mismatches = [];
  const optionalProbeAbsences = [];

  for (const sourceGroup of sourceGroups) {
    const frontendGroup = frontendGroupsByName.get(sourceGroup.name);
    if (!frontendGroup) {
      continue;
    }

    const frontendSelectors = new Map(frontendGroup.selectors.map((selector) => [selector.selector, selector]));
    for (const sourceSelector of sourceGroup.selectors) {
      const frontendSelector = frontendSelectors.get(sourceSelector.selector);
      if (!frontendSelector) {
        continue;
      }

      const reason = visualMismatchReason(sourceSelector, frontendSelector);
      if (!reason) {
        continue;
      }

      const detail = visualSelectorComparisonDetail(sourceGroup, sourceSelector, frontendSelector, reason);
      if (reason === 'missing_on_both_surfaces') {
        optionalProbeAbsences.push(detail);
        continue;
      }

      mismatches.push(detail);
    }
  }

  mismatches.sort(
    (a, b) => b.severity - a.severity || a.group.localeCompare(b.group) || a.selector.localeCompare(b.selector)
  );
  optionalProbeAbsences.sort((a, b) => a.group.localeCompare(b.group) || a.selector.localeCompare(b.selector));
  return { mismatches, optionalProbeAbsences };
}

async function captureSelectorScreenshot(page, selector, screenshotPath) {
  try {
    const locator = page.locator(selector).first();
    if ((await locator.count()) === 0) {
      return '';
    }
    await locator.screenshot({ path: screenshotPath, timeout: 5_000 });
    return screenshotPath;
  } catch {
    return '';
  }
}

async function captureVisualMismatchScreenshots(browser, result, mismatches, visualDir, targetSlug) {
  if (!mismatches.length) {
    return;
  }

  const screenshotsDir = path.join(visualDir, 'mismatch-screenshots');
  const urls = {
    source_static: result.surfaces.source_static?.url || '',
    wordpress_frontend: result.surfaces.wordpress_frontend?.url || '',
  };
  const pages = {};

  try {
    await mkdir(screenshotsDir, { recursive: true });
    for (const [surface, url] of Object.entries(urls)) {
      if (!url) {
        continue;
      }
      const page = await browser.newPage({ ignoreHTTPSErrors: true, viewport: VISUAL_VIEWPORT });
      await loadVisualSurface(page, url);
      pages[surface] = page;
    }

    for (const [index, mismatch] of mismatches.slice(0, VISUAL_SCREENSHOT_DIAGNOSTIC_LIMIT).entries()) {
      const screenshotSlug = safeSlug(
        `${targetSlug}-${index + 1}-${mismatch.group}-${mismatch.selector}`,
        `mismatch-${index + 1}`
      );
      for (const [surface, page] of Object.entries(pages)) {
        const screenshotPath = path.join(screenshotsDir, `${screenshotSlug}-${surface}.png`);
        const capturedPath = await captureSelectorScreenshot(page, mismatch.selector, screenshotPath);
        if (capturedPath) {
          mismatch.screenshots[surface] = capturedPath;
        }
      }
    }
  } catch (error) {
    result.diagnostic_warnings = [
      ...(result.diagnostic_warnings || []),
      `mismatch screenshots: ${error instanceof Error ? error.message : String(error)}`,
    ];
  } finally {
    await Promise.all(Object.values(pages).map((page) => page.close().catch(() => {})));
  }
}

function buildVisualDiagnostics(results, artifactPath) {
  const targetSummaries = [];
  const allMismatches = [];
  const allOptionalProbeAbsences = [];

  for (const result of results) {
    const mismatches = asArray(result.diagnostics?.mismatches);
    const optionalProbeAbsences = asArray(result.diagnostics?.optional_probe_absences);
    const byGroup = new Map();

    for (const mismatch of mismatches) {
      if (!byGroup.has(mismatch.group)) {
        byGroup.set(mismatch.group, []);
      }
      byGroup.get(mismatch.group).push(mismatch);
      allMismatches.push({
        target: result.source_filename || String(result.wordpress_page_id || ''),
        ...mismatch,
      });
    }

    for (const absence of optionalProbeAbsences) {
      allOptionalProbeAbsences.push({
        target: result.source_filename || String(result.wordpress_page_id || ''),
        ...absence,
      });
    }

    targetSummaries.push({
      source_filename: result.source_filename || '',
      wordpress_page_id: result.wordpress_page_id || null,
      mismatch_count: mismatches.length,
      optional_probe_absent_count: optionalProbeAbsences.length,
      top_failing_groups: [...byGroup.entries()]
        .map(([groupName, groupMismatches]) => visualGroupMismatchSummary(groupName, groupMismatches))
        .sort((a, b) => b.mismatch_count - a.mismatch_count || a.group.localeCompare(b.group))
        .slice(0, 5),
      top_failing_selectors: mismatches.slice(0, 10).map((mismatch) => ({
        group: mismatch.group,
        selector: mismatch.selector,
        reason: mismatch.reason,
        source_count: mismatch.source.count,
        frontend_count: mismatch.frontend.count,
        source_first_bounding_box: mismatch.source.first_bounding_box,
        frontend_first_bounding_box: mismatch.frontend.first_bounding_box,
        source_first_visible_text: mismatch.source.first_visible_text,
        frontend_first_visible_text: mismatch.frontend.first_visible_text,
        screenshots: mismatch.screenshots,
      })),
    });
  }

  const topFailingGroups = new Map();
  for (const mismatch of allMismatches) {
    const key = `${mismatch.target || 'target'}:${mismatch.group}`;
    if (!topFailingGroups.has(key)) {
      topFailingGroups.set(key, []);
    }
    topFailingGroups.get(key).push(mismatch);
  }

  return {
    artifact: artifactPath,
    mismatch_count: allMismatches.length,
    optional_probe_absent_count: allOptionalProbeAbsences.length,
    top_failing_groups: [...topFailingGroups.entries()]
      .map(([, mismatches]) => ({
        target: mismatches[0]?.target || '',
        ...visualGroupMismatchSummary(mismatches[0]?.group || '', mismatches),
      }))
      .sort((a, b) => b.mismatch_count - a.mismatch_count || a.group.localeCompare(b.group))
      .slice(0, 10),
    targets: targetSummaries,
    mismatches: allMismatches,
    optional_probe_absences: allOptionalProbeAbsences,
  };
}

function visualParity(sourceGroups, frontendGroups) {
  const frontendByName = new Map(frontendGroups.map((group) => [group.name, group]));
  const groupComparisons = [];
  let missingSelectorCount = 0;
  let visibilityMismatchCount = 0;
  let nonzeroBoundingBoxMismatchCount = 0;
  let simpleProbeParityMismatchCount = 0;
  const simpleProbeFamilies = {
    nav: new Set(['nav_chrome']),
    footer: new Set(['footer_chrome']),
    hero: new Set(['hero_region', 'hero_probe']),
  };
  const simpleProbeNames = new Set(Object.values(simpleProbeFamilies).flatMap((names) => [...names]));
  const simpleProbeMismatches = { nav: 0, footer: 0, hero: 0 };

  for (const sourceGroup of sourceGroups) {
    const frontendGroup = frontendByName.get(sourceGroup.name);
    if (!frontendGroup) {
      continue;
    }

    const frontendSelectors = new Map(frontendGroup.selectors.map((selector) => [selector.selector, selector]));
    for (const sourceSelector of sourceGroup.selectors) {
      const frontendSelector = frontendSelectors.get(sourceSelector.selector);
      if (!frontendSelector) {
        continue;
      }

      const sourceVisible = sourceSelector.visible_count > 0;
      const frontendVisible = frontendSelector.visible_count > 0;
      const sourceNonzero = sourceSelector.nonzero_bounding_box_count > 0;
      const frontendNonzero = frontendSelector.nonzero_bounding_box_count > 0;

      if (sourceSelector.count === 0 || frontendSelector.count === 0) {
        missingSelectorCount++;
      }
      if (sourceVisible !== frontendVisible) {
        visibilityMismatchCount++;
      }
      if (sourceNonzero !== frontendNonzero) {
        nonzeroBoundingBoxMismatchCount++;
      }
    }

    const sourceGroupVisible = sourceGroup.visible_selector_count > 0;
    const frontendGroupVisible = frontendGroup.visible_selector_count > 0;
    const simpleProbeMismatch = simpleProbeNames.has(sourceGroup.name) && sourceGroupVisible !== frontendGroupVisible;
    if (simpleProbeMismatch) {
      simpleProbeParityMismatchCount++;
      for (const [family, names] of Object.entries(simpleProbeFamilies)) {
        if (names.has(sourceGroup.name)) {
          simpleProbeMismatches[family]++;
        }
      }
    }

    groupComparisons.push({
      name: sourceGroup.name,
      source_visible: sourceGroupVisible,
      frontend_visible: frontendGroupVisible,
      source_nonzero_bounding_box: sourceGroup.nonzero_bounding_box_selector_count > 0,
      frontend_nonzero_bounding_box: frontendGroup.nonzero_bounding_box_selector_count > 0,
      simple_probe_parity: simpleProbeNames.has(sourceGroup.name) ? !simpleProbeMismatch : null,
    });
  }

  return {
    missing_selector_count: missingSelectorCount,
    visibility_mismatch_count: visibilityMismatchCount,
    nonzero_bounding_box_mismatch_count: nonzeroBoundingBoxMismatchCount,
    simple_probe_parity_mismatch_count: simpleProbeParityMismatchCount,
    simple_probe_mismatches: simpleProbeMismatches,
    groups: groupComparisons,
  };
}

async function emptyVisualComparison(artifactDir, error = '') {
  const visualDir = path.join(artifactDir, 'visual-comparisons');
  await mkdir(visualDir, { recursive: true });
  const diagnosticsPath = path.join(visualDir, 'visual-comparison-skipped.json');
  const diagnostics = {
    ...buildVisualDiagnostics([], diagnosticsPath),
    skipped: true,
    reason: error,
  };
  await writeFile(diagnosticsPath, JSON.stringify(diagnostics, null, 2));

  return {
    target_count: 0,
    checked_target_count: 0,
    error_count: error ? 1 : 0,
    missing_selector_count: 0,
    visibility_mismatch_count: 0,
    nonzero_bounding_box_count: 0,
    nonzero_bounding_box_mismatch_count: 0,
    simple_probe_parity_mismatch_count: 0,
    nav_probe_parity_mismatch_count: 0,
    footer_probe_parity_mismatch_count: 0,
    hero_probe_parity_mismatch_count: 0,
    surfaces: ['source_static', 'wordpress_frontend'],
    editor_surface_ready: true,
    artifact_dir: visualDir,
    diagnostics_artifact: diagnosticsPath,
    error,
    results: [],
    diagnostics,
  };
}

export async function compareVisualFidelity(importReport, artifactDir, sitePath) {
  const targets = comparisonTargets(importReport);
  if (!targets.length) {
    return emptyVisualComparison(artifactDir, importReport?.error || 'No visual fidelity comparison targets found.');
  }

  const playwrightPackage = path.join(STUDIO_PATH, 'node_modules/@playwright/test');
  const { chromium } = requireFromBench(playwrightPackage);
  const visualDir = path.join(artifactDir, 'visual-comparisons');
  await mkdir(visualDir, { recursive: true });

  let browser;
  const results = [];

  try {
    browser = await chromium.launch({ args: ['--ignore-certificate-errors'] });

    for (const [index, target] of targets.entries()) {
      const targetSlug = safeSlug(target.source_filename || target.wordpress_page_id, `target-${index + 1}`);
      const groups = visualProbeGroups(target);
      const result = {
        source_filename: target.source_filename || '',
        wordpress_page_id: target.wordpress_page_id || null,
        generated_template: target.generated_template || '',
        generated_pattern: target.generated_pattern || '',
        comparison_hooks: target.comparison_hooks || {},
        source_probe_counts: target.source_probe_counts || {},
        generated_probe_counts: target.generated_probe_counts || {},
        surfaces: {},
        parity: null,
        errors: [],
      };

      for (const surface of ['source_static', 'wordpress_frontend']) {
        const url = surfaceUrl(target, surface, importReport.reportPath, sitePath);
        const screenshotPath = path.join(visualDir, `${targetSlug}-${surface}.png`);
        const page = await browser.newPage({ ignoreHTTPSErrors: true, viewport: VISUAL_VIEWPORT });

        try {
          if (!url) {
            throw new Error(`Missing ${surface} render URL.`);
          }
          await loadVisualSurface(page, url);
          const probeGroups = await evaluateVisualSurface(page, groups);
          await page.screenshot({ path: screenshotPath, fullPage: true });
          result.surfaces[surface] = {
            url,
            screenshot: screenshotPath,
            probes: probeGroups,
            totals: visualSurfaceTotals(probeGroups),
          };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          result.errors.push(`${surface}: ${message}`);
          result.surfaces[surface] = { url, screenshot: '', probes: [], totals: visualSurfaceTotals([]), error: message };
        } finally {
          await page.close();
        }
      }

      result.parity = visualParity(
        result.surfaces.source_static?.probes || [],
        result.surfaces.wordpress_frontend?.probes || []
      );
      const { mismatches, optionalProbeAbsences } = visualSelectorComparisonDetails(result);
      result.diagnostics = {
        mismatch_count: mismatches.length,
        optional_probe_absent_count: optionalProbeAbsences.length,
        top_failing_groups: [],
        mismatches,
        optional_probe_absences: optionalProbeAbsences,
      };
      await captureVisualMismatchScreenshots(browser, result, mismatches, visualDir, targetSlug);
      results.push(result);
    }
  } catch (error) {
    return emptyVisualComparison(artifactDir, `Visual comparison failed: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    if (browser) {
      await browser.close();
    }
  }

  const totals = results.reduce(
    (summary, result) => {
      const sourceTotals = result.surfaces.source_static?.totals || visualSurfaceTotals([]);
      const frontendTotals = result.surfaces.wordpress_frontend?.totals || visualSurfaceTotals([]);
      const parity = result.parity || visualParity([], []);
      summary.error_count += result.errors.length;
      summary.checked_target_count += result.errors.length === 0 ? 1 : 0;
      summary.missing_selector_count += sourceTotals.missing_selector_count + frontendTotals.missing_selector_count;
      summary.visibility_mismatch_count += parity.visibility_mismatch_count;
      summary.nonzero_bounding_box_count +=
        sourceTotals.nonzero_bounding_box_selector_count + frontendTotals.nonzero_bounding_box_selector_count;
      summary.nonzero_bounding_box_mismatch_count += parity.nonzero_bounding_box_mismatch_count;
      summary.simple_probe_parity_mismatch_count += parity.simple_probe_parity_mismatch_count;
      summary.nav_probe_parity_mismatch_count += parity.simple_probe_mismatches?.nav || 0;
      summary.footer_probe_parity_mismatch_count += parity.simple_probe_mismatches?.footer || 0;
      summary.hero_probe_parity_mismatch_count += parity.simple_probe_mismatches?.hero || 0;
      return summary;
    },
    {
      target_count: targets.length,
      checked_target_count: 0,
      error_count: 0,
      missing_selector_count: 0,
      visibility_mismatch_count: 0,
      nonzero_bounding_box_count: 0,
      nonzero_bounding_box_mismatch_count: 0,
      simple_probe_parity_mismatch_count: 0,
      nav_probe_parity_mismatch_count: 0,
      footer_probe_parity_mismatch_count: 0,
      hero_probe_parity_mismatch_count: 0,
    }
  );
  const diagnosticsPath = path.join(visualDir, 'visual-comparison-mismatches.json');
  const diagnostics = buildVisualDiagnostics(results, diagnosticsPath);
  await writeFile(diagnosticsPath, JSON.stringify(diagnostics, null, 2));

  return {
    ...totals,
    surfaces: ['source_static', 'wordpress_frontend'],
    editor_surface_ready: true,
    artifact_dir: visualDir,
    diagnostics_artifact: diagnosticsPath,
    diagnostics,
    results,
  };
}

function emptySemanticComparison(error = '', artifactPath = '', diagnostics = null) {
  return {
    target_count: 0,
    checked_target_count: 0,
    error_count: error ? 1 : 0,
    mismatch_count: 0,
    role_mismatch_count: 0,
    class_owner_changed_count: 0,
    interaction_group_split_count: 0,
    interaction_group_merged_count: 0,
    link_text_delta_count: 0,
    region_link_count_delta: 0,
    clickable_area_delta_ratio: 0,
    landmark_mismatch_count: 0,
    repeated_count_delta_count: 0,
    brand_logo_missing_count: 0,
    error,
    results: [],
    ...(artifactPath ? { artifact_dir: path.dirname(artifactPath), artifact: artifactPath } : {}),
    ...(diagnostics ? { diagnostics } : {}),
  };
}

function semanticTargetSelectorGroups(target) {
  const hooks = target?.comparison_hooks || {};
  const layoutProbes = hooks.layout_probes && typeof hooks.layout_probes === 'object' ? hooks.layout_probes : {};
  const groups = [];
  const seen = new Set();

  function add(name, selectors) {
    const normalizedSelectors = stringArray(selectors);
    if (!normalizedSelectors.length || seen.has(name)) {
      return;
    }
    seen.add(name);
    groups.push({ name, selectors: normalizedSelectors });
  }

  for (const [name, probe] of Object.entries(layoutProbes)) {
    add(name, probe?.selectors);
  }

  add('hero', hooks.hero);
  add('visible_chrome', hooks.visible_chrome);
  add('footer_chrome', ['footer', '.site-footer', '[class*=footer]']);
  add('brand_hooks', ['[class*=brand]', '[class*=logo]', '[class*=wordmark]']);
  add('interaction_hooks', ['a', 'button', '[role=button]', '[role=link]']);

  return groups;
}

function semanticSurfaceTotals(fingerprint) {
  const regions = fingerprint?.regions || {};
  return Object.values(regions).reduce(
    (totals, region) => {
      totals.region_link_count += Number(region?.link_count || 0);
      totals.clickable_area += Number(region?.clickable_area || 0);
      return totals;
    },
    { region_link_count: 0, clickable_area: 0 }
  );
}

function semanticFingerprintExtractor(groups) {
  const meaningfulHookPattern = /(brand|logo|wordmark|nav|menu|footer|header|hero|card|panel|cta|button|price|plan|feature|testimonial|avatar|badge|label|eyebrow|status|icon)/i;
  const landmarkSelectors = {
    header: 'header,[role=banner]',
    nav: 'nav,[role=navigation]',
    main: 'main,[role=main]',
    footer: 'footer,[role=contentinfo]',
    section: 'section',
    aside: 'aside,[role=complementary]',
  };

  function normalizeText(value, limit = 180) {
    return String(value || '').trim().replace(/\s+/g, ' ').slice(0, limit);
  }

  function visible(element) {
    const rect = element.getBoundingClientRect();
    const style = window.getComputedStyle(element);
    return (
      rect.width > 0 &&
      rect.height > 0 &&
      style.display !== 'none' &&
      style.visibility !== 'hidden' &&
      Number(style.opacity || '1') > 0
    );
  }

  function roleOf(element) {
    const explicit = element.getAttribute('role');
    if (explicit) {
      return explicit.toLowerCase();
    }
    const tag = element.tagName.toLowerCase();
    if (tag === 'a' && element.getAttribute('href')) {
      return 'link';
    }
    if (tag === 'button') {
      return 'button';
    }
    if (['input', 'select', 'textarea'].includes(tag)) {
      return 'form-control';
    }
    if (tag === 'summary') {
      return 'button';
    }
    if (['header', 'nav', 'main', 'footer', 'section', 'aside'].includes(tag)) {
      return tag;
    }
    return 'group';
  }

  function isInteractive(element) {
    const role = roleOf(element);
    const tag = element.tagName.toLowerCase();
    return role === 'link' || role === 'button' || role === 'form-control' || ['a', 'button', 'input', 'select', 'textarea', 'summary'].includes(tag);
  }

  function classTokens(element) {
    return [...element.classList].filter((token) => meaningfulHookPattern.test(token)).sort();
  }

  function childClassTokens(element) {
    return [...element.querySelectorAll('[class]')]
      .flatMap((child) => classTokens(child))
      .filter((token, index, values) => values.indexOf(token) === index)
      .sort();
  }

  function regionOf(element) {
    const region = element.closest('footer,header,nav,main,section,aside,[role=banner],[role=navigation],[role=main],[role=contentinfo]');
    if (!region) {
      return 'body';
    }
    const role = roleOf(region);
    if (role === 'banner') {
      return 'header';
    }
    if (role === 'navigation') {
      return 'nav';
    }
    if (role === 'contentinfo') {
      return 'footer';
    }
    return region.tagName.toLowerCase();
  }

  function boxOf(element) {
    const rect = element.getBoundingClientRect();
    return {
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
      area: Math.round(rect.width * rect.height),
    };
  }

  function containsLogo(element) {
    return Boolean(
      element.querySelector('img,svg,picture') ||
        /\b(?:brand|logo|wordmark)\b/i.test(element.className || '') ||
        /\b(?:logo|brand|wordmark)\b/i.test(element.getAttribute('aria-label') || '')
    );
  }

  function containsWordmark(element) {
    return Boolean(
      /\bwordmark\b/i.test(element.className || '') ||
        element.querySelector('[class*=wordmark]') ||
        normalizeText(element.textContent).length > 0
    );
  }

  function clickableDescendants(element) {
    return [...element.querySelectorAll('a[href],button,[role=button],[role=link],input,select,textarea,summary')].filter(visible);
  }

  function visualPartCount(element) {
    return [...element.children].filter((child) => visible(child)).length;
  }

  function elementSummary(element, extra = {}) {
    const clickable = clickableDescendants(element);
    const box = boxOf(element);
    return {
      tag: element.tagName.toLowerCase(),
      role: roleOf(element),
      text: normalizeText(element.textContent),
      href: element.getAttribute('href') || '',
      own_classes: classTokens(element),
      child_classes: childClassTokens(element),
      contains_logo: containsLogo(element),
      contains_wordmark: containsWordmark(element),
      contains_image: Boolean(element.querySelector('img,picture,video')),
      contains_svg: Boolean(element.querySelector('svg')),
      clickable_descendant_count: clickable.length + (isInteractive(element) ? 1 : 0),
      child_visual_part_count: visualPartCount(element),
      wraps_multiple_visual_parts: visualPartCount(element) >= 2,
      ancestor_region: regionOf(element),
      bounding_box: box,
      ...extra,
    };
  }

  function conceptForElement(element) {
    const haystack = [element.className || '', normalizeText(element.textContent), element.getAttribute('aria-label') || ''].join(' ');
    const match = haystack.match(meaningfulHookPattern);
    return match ? match[1].toLowerCase() : '';
  }

  const landmarks = {};
  for (const [name, selector] of Object.entries(landmarkSelectors)) {
    const matches = [...document.querySelectorAll(selector)].filter(visible);
    landmarks[name] = {
      count: matches.length,
      visible_count: matches.length,
      first_text: normalizeText(matches[0]?.textContent || ''),
    };
  }

  const classOwners = [];
  for (const element of [...document.querySelectorAll('[class]')].filter(visible)) {
    const classes = classTokens(element);
    if (!classes.length) {
      continue;
    }
    classOwners.push(elementSummary(element, { selector_signature: `.${classes[0]}`, concept: conceptForElement(element) }));
  }

  const interactions = [...document.querySelectorAll('a[href],button,[role=button],[role=link],input,select,textarea,summary')]
    .filter(visible)
    .map((element) => elementSummary(element, { concept: conceptForElement(element) }));

  const regions = {};
  for (const name of ['header', 'nav', 'main', 'footer', 'section', 'aside', 'body']) {
    regions[name] = {
      link_count: 0,
      button_count: 0,
      clickable_area: 0,
      media_count: 0,
      brand_present: false,
      logo_present: false,
      text: '',
    };
  }

  for (const interaction of interactions) {
    const region = regions[interaction.ancestor_region] || regions.body;
    if (interaction.role === 'link') {
      region.link_count++;
    }
    if (interaction.role === 'button') {
      region.button_count++;
    }
    region.clickable_area += interaction.bounding_box.area;
  }

  for (const [name, region] of Object.entries(regions)) {
    const root = name === 'body' ? document.body : document.querySelector(name);
    if (!root) {
      continue;
    }
    region.media_count = root.querySelectorAll('img,svg,picture,video').length;
    region.brand_present = Boolean(root.querySelector('[class*=brand],[class*=wordmark]'));
    region.logo_present = Boolean(root.querySelector('img,svg,picture,[class*=logo]'));
    region.text = normalizeText(root.textContent, 260);
  }

  const repeated = {
    card: document.querySelectorAll('[class*=card],article').length,
    list_item: document.querySelectorAll('li').length,
    feature: document.querySelectorAll('[class*=feature]').length,
    plan: document.querySelectorAll('[class*=plan],[class*=price]').length,
    testimonial: document.querySelectorAll('[class*=testimonial]').length,
  };

  const selector_groups = [];
  for (const group of groups || []) {
    const selectors = [];
    for (const selector of group.selectors || []) {
      try {
        const matches = [...document.querySelectorAll(selector)].filter(visible);
        selectors.push({
          selector,
          count: matches.length,
          first: matches[0] ? elementSummary(matches[0], { concept: conceptForElement(matches[0]) }) : null,
        });
      } catch (error) {
        selectors.push({ selector, count: 0, first: null, error: error instanceof Error ? error.message : String(error) });
      }
    }
    selector_groups.push({ name: group.name, selectors });
  }

  return {
    url: window.location.href,
    title: document.title,
    landmarks,
    class_owners: classOwners,
    interactions,
    regions,
    repeated,
    selector_groups,
  };
}

async function evaluateSemanticSurface(page, groups) {
  return page.evaluate(semanticFingerprintExtractor, groups);
}

function semanticPrimaryClassKey(owner) {
  return owner?.own_classes?.[0] || '';
}

function semanticRole(owner) {
  return owner?.role || owner?.tag || '';
}

function semanticTextTokens(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/g, ' ')
    .split(/\s+/)
    .filter((token) => token.length >= 3);
}

function semanticHasMaterialRepeatedDelta(sourceCount, frontendCount) {
  if (sourceCount < 3 && frontendCount < 3) {
    return false;
  }
  return Math.abs(sourceCount - frontendCount) >= Math.max(3, Math.ceil(sourceCount * 0.35));
}

function semanticAllowsNavigationClassRoleChange(sourceOwner, frontendOwner) {
  const sourceRole = semanticRole(sourceOwner);
  const frontendRole = semanticRole(frontendOwner);
  const key = semanticPrimaryClassKey(sourceOwner);
  if (!/nav|menu/i.test(key) || !['group', 'list'].includes(sourceRole) || frontendRole !== 'nav') {
    return false;
  }

  return (
    Number(sourceOwner.clickable_descendant_count || 0) === Number(frontendOwner.clickable_descendant_count || 0) &&
    semanticTextTokens(sourceOwner.text).every((token) => new Set(semanticTextTokens(frontendOwner.text)).has(token))
  );
}

function semanticMismatch(type, reason, source, frontend, extra = {}) {
  return {
    type,
    reason,
    region: source?.ancestor_region || frontend?.ancestor_region || extra.region || '',
    concept: source?.concept || frontend?.concept || extra.concept || '',
    selector_signature: source?.selector_signature || frontend?.selector_signature || extra.selector_signature || '',
    source,
    generated: frontend,
    ...extra,
  };
}

function compareSemanticFingerprints(source, frontend) {
  const mismatches = [];
  const optionalSelectorAbsences = [];
  const counts = {
    role_mismatch_count: 0,
    class_owner_changed_count: 0,
    interaction_group_split_count: 0,
    interaction_group_merged_count: 0,
    link_text_delta_count: 0,
    landmark_mismatch_count: 0,
    repeated_count_delta_count: 0,
    brand_logo_missing_count: 0,
  };

  for (const landmark of ['header', 'nav', 'main', 'footer']) {
    const sourceCount = Number(source?.landmarks?.[landmark]?.visible_count || 0);
    const frontendCount = Number(frontend?.landmarks?.[landmark]?.visible_count || 0);
    if (sourceCount > 0 && frontendCount === 0) {
      counts.landmark_mismatch_count++;
      mismatches.push(
        semanticMismatch('landmark', 'landmark_disappeared', source?.landmarks?.[landmark], frontend?.landmarks?.[landmark], {
          region: landmark,
          concept: landmark,
        })
      );
    }
  }

  const frontendOwnersByClass = new Map();
  for (const owner of frontend?.class_owners || []) {
    const key = semanticPrimaryClassKey(owner);
    if (key && !frontendOwnersByClass.has(key)) {
      frontendOwnersByClass.set(key, owner);
    }
  }

  for (const sourceOwner of source?.class_owners || []) {
    const key = semanticPrimaryClassKey(sourceOwner);
    const frontendOwner = key ? frontendOwnersByClass.get(key) : null;
    if (!frontendOwner) {
      continue;
    }

    const sourceRole = semanticRole(sourceOwner);
    const frontendRole = semanticRole(frontendOwner);
    const sourceInteractive = ['link', 'button', 'form-control'].includes(sourceRole);
    const frontendInteractive = ['link', 'button', 'form-control'].includes(frontendRole);
    const roleChanged = sourceRole !== frontendRole;
    const sourceClickable = Number(sourceOwner.clickable_descendant_count || 0);
    const frontendClickable = Number(frontendOwner.clickable_descendant_count || 0);

    if (sourceRole === 'link' && frontendRole !== 'link') {
      counts.role_mismatch_count++;
      counts.class_owner_changed_count++;
      if (frontendClickable > sourceClickable) {
        counts.interaction_group_split_count++;
      }
      mismatches.push(
        semanticMismatch('class_owner', 'classed_link_became_non_link', sourceOwner, frontendOwner, {
          selector_signature: `.${key}`,
        })
      );
      continue;
    }

    if (
      roleChanged &&
      !semanticAllowsNavigationClassRoleChange(sourceOwner, frontendOwner) &&
      (sourceInteractive || frontendInteractive || sourceOwner.concept || frontendOwner.concept)
    ) {
      counts.role_mismatch_count++;
      counts.class_owner_changed_count++;
      mismatches.push(
        semanticMismatch('class_owner', 'meaningful_class_moved_role', sourceOwner, frontendOwner, {
          selector_signature: `.${key}`,
        })
      );
    }

    if (sourceInteractive && frontendClickable > sourceClickable + 1) {
      counts.interaction_group_split_count++;
      mismatches.push(
        semanticMismatch('interaction_group', 'source_interaction_group_split', sourceOwner, frontendOwner, {
          selector_signature: `.${key}`,
        })
      );
    } else if (!sourceInteractive && frontendInteractive && sourceClickable > frontendClickable + 1) {
      counts.interaction_group_merged_count++;
      mismatches.push(
        semanticMismatch('interaction_group', 'source_interaction_group_merged', sourceOwner, frontendOwner, {
          selector_signature: `.${key}`,
        })
      );
    }

    const sourceTokens = semanticTextTokens(sourceOwner.text);
    const frontendTokens = new Set(semanticTextTokens(frontendOwner.text));
    const missingTokens = sourceTokens.filter((token) => !frontendTokens.has(token));
    if ((sourceRole === 'link' || sourceRole === 'button') && sourceTokens.length && missingTokens.length === sourceTokens.length) {
      counts.link_text_delta_count++;
      mismatches.push(
        semanticMismatch('interaction_text', 'link_or_button_text_disappeared', sourceOwner, frontendOwner, {
          selector_signature: `.${key}`,
          missing_text_tokens: missingTokens,
        })
      );
    }
  }

  for (const [regionName, sourceRegion] of Object.entries(source?.regions || {})) {
    const frontendRegion = frontend?.regions?.[regionName];
    if (!frontendRegion) {
      continue;
    }
    const sourceHasBrandLogo = sourceRegion.brand_present && sourceRegion.logo_present;
    const frontendHasBrandLogo = frontendRegion.brand_present && frontendRegion.logo_present;
    if (['header', 'footer'].includes(regionName) && sourceHasBrandLogo && !frontendHasBrandLogo) {
      counts.brand_logo_missing_count++;
      mismatches.push(
        semanticMismatch('brand_media', 'brand_or_logo_image_disappeared', sourceRegion, frontendRegion, {
          region: regionName,
          concept: 'brand',
        })
      );
    }
  }

  for (const [name, sourceCount] of Object.entries(source?.repeated || {})) {
    const frontendCount = Number(frontend?.repeated?.[name] || 0);
    if (semanticHasMaterialRepeatedDelta(Number(sourceCount || 0), frontendCount)) {
      counts.repeated_count_delta_count++;
      mismatches.push(
        semanticMismatch('repeated_structure', 'repeated_structure_count_changed_materially', { count: sourceCount }, { count: frontendCount }, {
          concept: name,
        })
      );
    }
  }

  const frontendSelectorGroups = new Map((frontend?.selector_groups || []).map((group) => [group.name, group]));
  for (const sourceGroup of source?.selector_groups || []) {
    const frontendGroup = frontendSelectorGroups.get(sourceGroup.name);
    if (!frontendGroup) {
      continue;
    }
    const frontendSelectors = new Map((frontendGroup.selectors || []).map((selector) => [selector.selector, selector]));
    for (const sourceSelector of sourceGroup.selectors || []) {
      const frontendSelector = frontendSelectors.get(sourceSelector.selector);
      if (!frontendSelector) {
        continue;
      }
      if (sourceSelector.count === 0 && frontendSelector.count === 0) {
        optionalSelectorAbsences.push({ group: sourceGroup.name, selector: sourceSelector.selector });
      }
    }
  }

  const sourceTotals = semanticSurfaceTotals(source);
  const frontendTotals = semanticSurfaceTotals(frontend);
  const sourceArea = sourceTotals.clickable_area;
  const areaDeltaRatio = sourceArea > 0 ? Math.abs(sourceArea - frontendTotals.clickable_area) / sourceArea : 0;

  return {
    mismatch_count: mismatches.length,
    ...counts,
    region_link_count_delta: frontendTotals.region_link_count - sourceTotals.region_link_count,
    clickable_area_delta_ratio: Number(areaDeltaRatio.toFixed(4)),
    mismatches,
    optional_selector_absences: optionalSelectorAbsences,
  };
}

function buildSemanticArtifact(results, artifactPath) {
  const mismatches = [];
  const targets = [];
  for (const result of results) {
    const comparison = result.comparison || {};
    for (const mismatch of comparison.mismatches || []) {
      mismatches.push({
        target: result.source_filename || String(result.wordpress_page_id || ''),
        ...mismatch,
      });
    }
    targets.push({
      source_filename: result.source_filename || '',
      wordpress_page_id: result.wordpress_page_id || null,
      mismatch_count: Number(comparison.mismatch_count || 0),
      role_mismatch_count: Number(comparison.role_mismatch_count || 0),
      class_owner_changed_count: Number(comparison.class_owner_changed_count || 0),
      interaction_group_split_count: Number(comparison.interaction_group_split_count || 0),
      interaction_group_merged_count: Number(comparison.interaction_group_merged_count || 0),
      link_text_delta_count: Number(comparison.link_text_delta_count || 0),
      landmark_mismatch_count: Number(comparison.landmark_mismatch_count || 0),
      repeated_count_delta_count: Number(comparison.repeated_count_delta_count || 0),
      brand_logo_missing_count: Number(comparison.brand_logo_missing_count || 0),
      region_link_count_delta: Number(comparison.region_link_count_delta || 0),
      clickable_area_delta_ratio: Number(comparison.clickable_area_delta_ratio || 0),
      optional_selector_absent_count: Number(comparison.optional_selector_absences?.length || 0),
    });
  }

  return {
    artifact: artifactPath,
    target_count: results.length,
    mismatch_count: mismatches.length,
    targets,
    mismatches,
    results,
  };
}

export async function compareSemanticFidelity(importReport, artifactDir, sitePath) {
  const targets = semanticComparisonTargets(importReport);
  if (!targets.length) {
    const semanticDir = path.join(artifactDir, 'semantic-comparisons');
    const artifactPath = path.join(semanticDir, 'semantic-fidelity-skipped.json');
    const reason = importReport?.error || 'No semantic or visual fidelity comparison targets found.';
    const artifact = {
      ...buildSemanticArtifact([], artifactPath),
      skipped: true,
      reason,
    };
    await mkdir(semanticDir, { recursive: true });
    await writeFile(artifactPath, JSON.stringify(artifact, null, 2));
    return emptySemanticComparison(reason, artifactPath, artifact);
  }

  const playwrightPackage = path.join(STUDIO_PATH, 'node_modules/@playwright/test');
  const { chromium } = requireFromBench(playwrightPackage);
  const semanticDir = path.join(artifactDir, 'semantic-comparisons');
  await mkdir(semanticDir, { recursive: true });

  let browser;
  const results = [];

  try {
    browser = await chromium.launch({ args: ['--ignore-certificate-errors'] });
    for (const [index, target] of targets.entries()) {
      const targetSlug = safeSlug(target.source_filename || target.wordpress_page_id, `target-${index + 1}`);
      const selectorGroups = semanticTargetSelectorGroups(target);
      const result = {
        source_filename: target.source_filename || '',
        wordpress_page_id: target.wordpress_page_id || null,
        generated_template: target.generated_template || '',
        generated_pattern: target.generated_pattern || '',
        comparison_hooks: target.comparison_hooks || {},
        surfaces: {},
        comparison: null,
        errors: [],
      };

      for (const surface of ['source_static', 'wordpress_frontend']) {
        const url = surfaceUrl(target, surface, importReport.reportPath, sitePath);
        const page = await browser.newPage({ ignoreHTTPSErrors: true, viewport: VISUAL_VIEWPORT });
        try {
          if (!url) {
            throw new Error(`Missing ${surface} render URL.`);
          }
          await loadVisualSurface(page, url);
          result.surfaces[surface] = {
            url,
            fingerprint: await evaluateSemanticSurface(page, selectorGroups),
          };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          result.errors.push(`${surface}: ${message}`);
          result.surfaces[surface] = { url, fingerprint: null, error: message };
        } finally {
          await page.close();
        }
      }

      if (result.surfaces.source_static?.fingerprint && result.surfaces.wordpress_frontend?.fingerprint) {
        result.comparison = compareSemanticFingerprints(
          result.surfaces.source_static.fingerprint,
          result.surfaces.wordpress_frontend.fingerprint
        );
      } else {
        result.comparison = compareSemanticFingerprints({}, {});
      }

      await writeFile(path.join(semanticDir, `${targetSlug}-semantic-fingerprint.json`), JSON.stringify(result, null, 2));
      results.push(result);
    }
  } catch (error) {
    return emptySemanticComparison(`Semantic comparison failed: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    if (browser) {
      await browser.close();
    }
  }

  const totals = results.reduce(
    (summary, result) => {
      const comparison = result.comparison || {};
      summary.error_count += result.errors.length;
      summary.checked_target_count += result.errors.length === 0 ? 1 : 0;
      summary.mismatch_count += Number(comparison.mismatch_count || 0);
      summary.role_mismatch_count += Number(comparison.role_mismatch_count || 0);
      summary.class_owner_changed_count += Number(comparison.class_owner_changed_count || 0);
      summary.interaction_group_split_count += Number(comparison.interaction_group_split_count || 0);
      summary.interaction_group_merged_count += Number(comparison.interaction_group_merged_count || 0);
      summary.link_text_delta_count += Number(comparison.link_text_delta_count || 0);
      summary.region_link_count_delta += Math.abs(Number(comparison.region_link_count_delta || 0));
      summary.clickable_area_delta_ratio += Number(comparison.clickable_area_delta_ratio || 0);
      summary.landmark_mismatch_count += Number(comparison.landmark_mismatch_count || 0);
      summary.repeated_count_delta_count += Number(comparison.repeated_count_delta_count || 0);
      summary.brand_logo_missing_count += Number(comparison.brand_logo_missing_count || 0);
      return summary;
    },
    {
      target_count: targets.length,
      checked_target_count: 0,
      error_count: 0,
      mismatch_count: 0,
      role_mismatch_count: 0,
      class_owner_changed_count: 0,
      interaction_group_split_count: 0,
      interaction_group_merged_count: 0,
      link_text_delta_count: 0,
      region_link_count_delta: 0,
      clickable_area_delta_ratio: 0,
      landmark_mismatch_count: 0,
      repeated_count_delta_count: 0,
      brand_logo_missing_count: 0,
    }
  );

  if (results.length) {
    totals.clickable_area_delta_ratio = Number((totals.clickable_area_delta_ratio / results.length).toFixed(4));
  }

  const artifactPath = path.join(semanticDir, 'semantic-fidelity.json');
  const artifact = buildSemanticArtifact(results, artifactPath);
  await writeFile(artifactPath, JSON.stringify(artifact, null, 2));

  return {
    ...totals,
    artifact_dir: semanticDir,
    artifact: artifactPath,
    diagnostics: artifact,
    results,
  };
}

async function readIfExists(file) {
  try {
    return await readFile(file, 'utf8');
  } catch {
    return '';
  }
}

async function collectCssFiles(root, maxFiles = 40) {
  const files = [];

  async function visit(dir) {
    if (files.length >= maxFiles) {
      return;
    }
    let entries = [];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (files.length >= maxFiles) {
        return;
      }
      if (entry.name === 'node_modules' || entry.name === '.git') {
        continue;
      }
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await visit(absolute);
      } else if (entry.isFile() && entry.name.endsWith('.css')) {
        files.push(absolute);
      }
    }
  }

  await visit(root);
  return files;
}

export function reportedFreeformBlockCount(importReport) {
  const quality = importReport?.report?.quality || {};
  const generatedTheme = importReport?.report?.generated_theme || {};
  const candidates = [
    quality.freeform_block_count,
    quality.freeform_blocks,
    generatedTheme.freeform_block_count,
    generatedTheme.freeform_blocks,
  ];

  for (const candidate of candidates) {
    const value = Number(candidate);
    if (Number.isFinite(value)) {
      return value;
    }
  }

  return 0;
}

function freeformDiagnostics(documents) {
  const results = [];
  let count = 0;

  for (const document of documents) {
    const documentCount = countRegex(document.content, /<!--\s+wp:freeform\b/gi);
    if (documentCount === 0) {
      continue;
    }
    count += documentCount;
    results.push({
      source: document.source,
      freeform_block_count: documentCount,
    });
  }

  return { count, results };
}

function splitSelectorList(selector) {
  const selectors = [];
  let current = '';
  let depth = 0;
  let quote = '';

  for (const char of String(selector || '')) {
    if (quote) {
      current += char;
      if (char === quote) {
        quote = '';
      }
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      current += char;
      continue;
    }

    if (char === '(' || char === '[') {
      depth += 1;
      current += char;
      continue;
    }
    if (char === ')' || char === ']') {
      depth = Math.max(0, depth - 1);
      current += char;
      continue;
    }

    if (char === ',' && depth === 0) {
      const value = current.trim();
      if (value) {
        selectors.push(value);
      }
      current = '';
      continue;
    }

    current += char;
  }

  const value = current.trim();
  if (value) {
    selectors.push(value);
  }

  return selectors;
}

function selectorCoverageTokens(selector) {
  const tokens = new Set();
  for (const match of String(selector || '').matchAll(/\.(-?[_a-zA-Z]+[_a-zA-Z0-9-]*)/g)) {
    const name = match[1];
    if (!/^(?:editor-styles-wrapper|block-editor|wp-admin|is-root-container)$/.test(name)) {
      tokens.add(`.${name}`);
    }
  }
  for (const match of String(selector || '').matchAll(/\[\s*([^\]\s~|^$*=]+)/g)) {
    tokens.add(`[${match[1].toLowerCase()}]`);
  }
  return tokens;
}

function editorOverrideCoversHiddenSelector(hiddenSelector, overrideSelector) {
  const hiddenTokens = selectorCoverageTokens(hiddenSelector);
  if (hiddenTokens.size === 0) {
    return false;
  }

  const overrideTokens = selectorCoverageTokens(overrideSelector);
  if (overrideTokens.size === 0) {
    return false;
  }

  for (const token of overrideTokens) {
    if (!hiddenTokens.has(token)) {
      return false;
    }
  }

  return true;
}

export function hiddenEditorContentDiagnostics(cssFiles) {
  const hiddenRules = [];
  const editorOverrideRules = [];
  const hiddenSelectors = [];
  const editorOverrideSelectors = [];
  const revealSelectorPattern = /(?:^|[\s.#:[>,])(?:js[-_])?(?:reveal|revealed|aos|fade[-_]in|animate[-_]on[-_]scroll|scroll[-_]reveal)\b|\[data[-_](?:reveal|aos|animate)/i;
  const hiddenSelectorPattern = /(?:^|[\s.#:[>,])hidden\b/i;
  const hiddenDeclarationPattern = /(?:opacity\s*:\s*0(?:\.0+)?\b|visibility\s*:\s*hidden\b|display\s*:\s*none\b)/i;
  const visibleDeclarationPattern = /(?:opacity\s*:\s*1(?:\.0+)?\b|visibility\s*:\s*visible\b|display\s*:\s*(?:block|grid|flex|contents)\b)/i;
  const editorSelectorPattern = /(?:editor-styles-wrapper|block-editor|wp-admin|is-root-container)/i;

  for (const file of cssFiles) {
    const content = typeof file.content === 'string' ? file.content : '';
    for (const match of content.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const selector = match[1].trim().replace(/\s+/g, ' ');
      const declarations = match[2].trim().replace(/\s+/g, ' ');
      const isRevealSelector = revealSelectorPattern.test(selector);
      const isBroadEditorHiddenOverride =
        editorSelectorPattern.test(selector) && hiddenSelectorPattern.test(selector) && visibleDeclarationPattern.test(declarations);
      if (!isRevealSelector && !isBroadEditorHiddenOverride) {
        continue;
      }

      const rule = {
        source: file.source,
        selector,
        declarations: declarations.slice(0, 300),
      };

      const selectorList = splitSelectorList(selector);

      if (isRevealSelector && hiddenDeclarationPattern.test(declarations)) {
        hiddenRules.push(rule);
        for (const selectorItem of selectorList) {
          if (revealSelectorPattern.test(selectorItem)) {
            hiddenSelectors.push({ ...rule, selector: selectorItem });
          }
        }
      }
      if (editorSelectorPattern.test(selector) && visibleDeclarationPattern.test(declarations)) {
        editorOverrideRules.push(rule);
        for (const selectorItem of selectorList) {
          if (editorSelectorPattern.test(selectorItem)) {
            editorOverrideSelectors.push({ ...rule, selector: selectorItem });
          }
        }
      }
    }
  }

  const missingEditorOverrideSelectors = hiddenSelectors.filter(
    (hiddenRule) =>
      !editorOverrideSelectors.some((editorRule) =>
        editorOverrideCoversHiddenSelector(hiddenRule.selector, editorRule.selector)
      )
  );

  return {
    hidden_rule_count: hiddenRules.length,
    editor_override_rule_count: editorOverrideRules.length,
    missing_editor_override_count: missingEditorOverrideSelectors.length,
    hidden_rules: hiddenRules.slice(0, 25),
    editor_override_rules: editorOverrideRules.slice(0, 25),
    missing_editor_override_rules: missingEditorOverrideSelectors.slice(0, 25),
  };
}

export async function collectGeneratedThemeUxGates(sitePath, importReport, artifactDir) {
  const { themeRoot, themeSlug, error } = await collectLatestGeneratedTheme(sitePath);
  const artifactPath = path.join(artifactDir, 'generated-theme-ux-gates.json');
  const reasons = [];

  if (!themeRoot) {
    const skipped = {
      skipped: true,
      error,
      theme_slug: themeSlug,
      artifact: artifactPath,
      generated_theme_ux_quality_pass: false,
      generated_theme_ux_quality_failure_count: 1,
      generated_theme_ux_quality_failure_reasons: ['missing_generated_theme'],
    };
    await writeFile(artifactPath, JSON.stringify(skipped, null, 2));
    return skipped;
  }

  const documents = await collectThemeBlockDocuments(sitePath);
  const freeform = freeformDiagnostics(documents);
  const importerFreeformCount = reportedFreeformBlockCount(importReport);
  const cssFiles = await collectCssFiles(themeRoot);
  const cssFileContents = [];
  for (const file of cssFiles) {
    cssFileContents.push({ source: path.relative(themeRoot, file), content: await readIfExists(file) });
  }
  const hiddenEditorContent = hiddenEditorContentDiagnostics(cssFileContents);

  if (freeform.count !== importerFreeformCount) {
    reasons.push('freeform_report_count_mismatch');
  }
  if (hiddenEditorContent.missing_editor_override_count > 0) {
    reasons.push('css_hidden_editor_content_without_override');
  }

  const diagnostics = {
    skipped: false,
    theme_slug: themeSlug,
    theme_root: themeRoot,
    document_count: documents.length,
    css_file_count: cssFiles.length,
    actual_freeform_block_count: freeform.count,
    importer_freeform_block_count: importerFreeformCount,
    freeform_report_mismatch_count: freeform.count === importerFreeformCount ? 0 : 1,
    freeform_documents: freeform.results,
    css_hidden_editor_content_count: hiddenEditorContent.hidden_rule_count,
    css_editor_reveal_override_count: hiddenEditorContent.editor_override_rule_count,
    css_hidden_editor_content_without_override_count: hiddenEditorContent.missing_editor_override_count,
    css_hidden_editor_content: hiddenEditorContent.hidden_rules,
    css_editor_reveal_overrides: hiddenEditorContent.editor_override_rules,
    generated_theme_ux_quality_pass: reasons.length === 0,
    generated_theme_ux_quality_failure_count: reasons.length,
    generated_theme_ux_quality_failure_reasons: reasons,
    remaining_manual_gates: [
      'site_editor_canvas_above_fold_visible_text',
      'footer_utility_links_not_responsive_nav_overlay',
      'admin_bar_not_obscured_by_fixed_or_sticky_chrome',
    ],
    artifact: artifactPath,
  };

  await writeFile(artifactPath, JSON.stringify(diagnostics, null, 2));
  return diagnostics;
}

function uniqueSorted(values) {
  return [...new Set(values.filter(Boolean))].sort((a, b) => a.localeCompare(b));
}

function uniqueInOrder(values) {
  const seen = new Set();
  const ordered = [];
  for (const value of values) {
    const normalized = typeof value === 'string' ? value.trim() : '';
    const key = normalized.toLowerCase();
    if (!normalized || seen.has(key)) {
      continue;
    }
    seen.add(key);
    ordered.push(normalized);
  }
  return ordered;
}

function countRegex(value, pattern) {
  return typeof value === 'string' ? (value.match(pattern) || []).length : 0;
}

function normalizeFontFamily(value) {
  return value
    .replace(/\\["']/g, '')
    .replace(/["']/g, '')
    .trim()
    .replace(/\s+/g, ' ');
}

function extractFontFamilies(text) {
  const families = [];
  for (const match of text.matchAll(/fonts\.googleapis\.com\/css2?[^"')\s]+/gi)) {
    try {
      const url = new URL(match[0].startsWith('http') ? match[0] : `https://${match[0]}`);
      for (const family of url.searchParams.getAll('family')) {
        families.push(normalizeFontFamily(family.split(':')[0].replaceAll('+', ' ')));
      }
    } catch {
      // Keep parsing local font-family declarations even if an import URL is malformed.
    }
  }

  for (const match of text.matchAll(/font-family\s*:\s*([^;}]+)/gi)) {
    const declaration = match[1] || '';
    for (const family of declaration.split(',')) {
      const normalized = normalizeFontFamily(family);
      if (!/^(sans-serif|serif|monospace|system-ui|inherit|initial|unset)$/i.test(normalized)) {
        families.push(normalized);
      }
    }
  }

  return uniqueSorted(families);
}

function firstFontFamilyFromDeclaration(declaration) {
  for (const family of String(declaration || '').split(',')) {
    const normalized = normalizeFontFamily(family);
    if (!/^(sans-serif|serif|monospace|system-ui|ui-sans-serif|ui-serif|inherit|initial|unset)$/i.test(normalized)) {
      return normalized;
    }
  }
  return '';
}

function extractFontFamilyDeclarations(text, selectorPattern) {
  const declarations = [];
  const pattern = new RegExp(`${selectorPattern}[^{}]*\\{[^{}]*?font-family\\s*:\\s*([^;}]+)`, 'gi');
  for (const match of text.matchAll(pattern)) {
    declarations.push(firstFontFamilyFromDeclaration(match[1]));
  }
  return uniqueInOrder(declarations);
}

function extractTypePairing(text, fontFamilies) {
  const displayFonts = extractFontFamilyDeclarations(
    text,
    '(?:h1|h2|h3|\\.display|\\.headline|\\.hero-title|\\.section-title|\\.title)'
  );
  const bodyFonts = extractFontFamilyDeclarations(text, '(?:body|html|:root|\\.site|main|p)');
  const orderedFonts = uniqueInOrder(fontFamilies);
  const primaryFont = bodyFonts[0] || orderedFonts[0] || '';
  const displayFont =
    displayFonts[0] || orderedFonts.find((font) => font.toLowerCase() !== primaryFont.toLowerCase()) || primaryFont;

  return {
    primary_font_family: primaryFont,
    display_font_family: displayFont,
    type_pairing_signature: [displayFont, primaryFont].filter(Boolean).join(' / '),
  };
}

function htmlAttributeValue(attributes, name) {
  const pattern = new RegExp(`\\b${name}\\s*=\\s*(["'])(.*?)\\1`, 'i');
  return attributes.match(pattern)?.[2] || '';
}

function extractSections(html) {
  const sections = [];
  for (const match of String(html || '').matchAll(/<section\b([^>]*)>([\s\S]*?)<\/section>/gi)) {
    const attributes = match[1] || '';
    const content = match[2] || '';
    sections.push({
      attributes,
      className: htmlAttributeValue(attributes, 'class'),
      style: htmlAttributeValue(attributes, 'style'),
      content,
    });
  }
  return sections;
}

export function extractDesignPatternFingerprint({ sourceHtml = '', cssText = '', fontFamilies = [] } = {}) {
  const text = [sourceHtml, cssText].join('\n');
  const sections = extractSections(sourceHtml);
  const heroGridBackgroundCount = countRegex(
    text,
    /(?:hero[-_\s]*(?:grid|mesh|background)|(?:grid|mesh)[-_\s]*hero|hero[\s\S]{0,240}(?:radial-gradient|linear-gradient|background-image|background(?:-size)?\s*:|grid-template|mesh)|(?:background|bg)[-_\s]*mesh)/gi
  );
  const panelSections = sections.filter((section) =>
    /\b(?:panel|section-panel|content-panel|full-bleed|full-width|feature-section|pricing-section|testimonial-section|dark-section|light-section)\b/i.test(
      `${section.className} ${section.style}`
    )
  );
  const fullWidthSections = sections.filter((section) =>
    /\b(?:full-bleed|full-width|w-full|wide|alignfull|panel)\b/i.test(`${section.className} ${section.style}`) ||
    /(?:width\s*:\s*100(?:vw|%)|margin-inline\s*:\s*calc\(|left\s*:\s*50%|right\s*:\s*50%)/i.test(section.style)
  );
  const eyebrowLabelCount = countRegex(
    sourceHtml,
    /class\s*=\s*["'][^"']*\b(?:eyebrow|kicker|overline|label|section-label|pretitle|subheading-label)\b[^"']*["']/gi
  );
  const sectionsWithEyebrowTitle = sections.filter((section) =>
    /class\s*=\s*["'][^"']*\b(?:eyebrow|kicker|overline|label|section-label|pretitle|subheading-label)\b[^"']*["'][\s\S]{0,700}<h[1-3]\b/i.test(
      section.content
    )
  );
  const typePairing = extractTypePairing(cssText || text, fontFamilies);
  const patternTokens = [];

  if (heroGridBackgroundCount > 0) {
    patternTokens.push('hero-grid-background');
  }
  if (fullWidthSections.length >= 3) {
    patternTokens.push('stacked-full-width-panels');
  } else if (panelSections.length > 0) {
    patternTokens.push('panel-sections');
  }
  if (eyebrowLabelCount > 0) {
    patternTokens.push('eyebrow-title-labels');
  }
  if (typePairing.type_pairing_signature) {
    patternTokens.push(`type:${typePairing.type_pairing_signature.toLowerCase()}`);
  }

  return {
    hero_grid_background_count: heroGridBackgroundCount,
    hero_grid_background_present: heroGridBackgroundCount > 0,
    stacked_full_width_section_count: fullWidthSections.length,
    panel_section_count: panelSections.length,
    eyebrow_label_count: eyebrowLabelCount,
    sections_with_eyebrow_title_count: sectionsWithEyebrowTitle.length,
    font_family_count: fontFamilies.length,
    ...typePairing,
    repetition_signature: patternTokens.join('|'),
  };
}

function extractColors(text) {
  const hexColors = [...text.matchAll(/#[0-9a-f]{3,8}\b/gi)].map((match) => match[0].toLowerCase());
  const functionalColors = [...text.matchAll(/\b(?:rgb|rgba|hsl|hsla)\([^)]*\)/gi)].map((match) =>
    match[0].toLowerCase().replace(/\s+/g, '')
  );
  return uniqueSorted([...hexColors, ...functionalColors]);
}

function includesAny(text, patterns) {
  return patterns.some((pattern) => pattern.test(text));
}

function extractMotifs(text) {
  const motifs = [];
  const checks = {
    bento_grid: [/\bbento\b/i],
    cards_grid: [/\bcard(s)?\b/i, /grid-template-columns/i],
    code_preview: [/code-window/i, /code-preview/i, /<pre\b/i, /<code\b/i],
    dashboard_mockup: [/dashboard/i, /metric-card/i, /analytics/i],
    glow_overlay: [/\bglow\b/i, /blur\(/i, /radial-gradient\(/i],
    marquee: [/\bmarquee\b/i, /ticker/i],
    pricing: [/\bpricing\b/i, /\bplans?\b/i],
    social_proof: [/testimonial/i, /customer/i, /trusted by/i],
    split_hero: [/split-hero/i, /hero-grid/i],
    terminal_window: [/terminal/i, /traffic-light/i, /window-chrome/i, /code-window/i],
  };

  for (const [motif, patterns] of Object.entries(checks)) {
    if (includesAny(text, patterns)) {
      motifs.push(motif);
    }
  }

  return motifs.sort();
}

function extractPaletteLabels(text, colors) {
  const labels = [];
  const lower = text.toLowerCase();
  const colorText = colors.join(' ');
  if (/purple|violet|indigo|#6|#7|#8|#9|#a/i.test(`${lower} ${colorText}`) && /lime|chartreuse|#bef|#a3e|#ccff|#d9f99d/i.test(`${lower} ${colorText}`)) {
    labels.push('purple_lime');
  }
  if (/orange|amber|coral|#f59|#fb7|#ff8/i.test(`${lower} ${colorText}`)) {
    labels.push('warm_orange');
  }
  if (/cyan|teal|aqua|#06b6|#14b8|#22d3/i.test(`${lower} ${colorText}`)) {
    labels.push('cyan_teal');
  }
  if (/black|charcoal|slate|#0[0-9a-f]{2,6}|#111|#18181b/i.test(`${lower} ${colorText}`)) {
    labels.push('dark_base');
  }
  return labels.sort();
}

async function collectDesignFingerprint(sitePath) {
  const { themeRoot, themeSlug } = await collectLatestGeneratedTheme(sitePath);
  const sourceHtml = await readIfExists(path.join(sitePath, 'tmp/static-site/index.html'));
  const cssFiles = themeRoot ? await collectCssFiles(themeRoot) : [];
  const cssParts = [];
  for (const file of cssFiles) {
    cssParts.push(await readIfExists(file));
  }

  const text = [sourceHtml, ...cssParts].join('\n');
  const lower = text.toLowerCase();
  const fontFamilies = extractFontFamilies(text);
  const colors = extractColors(text);
  const cssVariables = uniqueSorted([...text.matchAll(/--([a-z0-9-]+)\s*:/gi)].map((match) => match[1].toLowerCase()));
  const motifs = extractMotifs(text);
  const paletteLabels = extractPaletteLabels(lower, colors);
  const patternFingerprint = extractDesignPatternFingerprint({
    sourceHtml,
    cssText: cssParts.join('\n'),
    fontFamilies,
  });

  return {
    theme_slug: themeSlug,
    source_html_present: sourceHtml ? true : false,
    css_file_count: cssFiles.length,
    font_families: fontFamilies,
    dominant_font_family: fontFamilies[0] || '',
    color_values: colors,
    css_variables: cssVariables,
    motifs,
    palette_labels: paletteLabels,
    gradient_count: countRegex(text, /(?:linear|radial|conic)-gradient\(/gi),
    animation_count: countRegex(text, /@keyframes\b|\banimation(?:-[a-z]+)?\s*:/gi),
    transition_count: countRegex(text, /\btransition(?:-[a-z]+)?\s*:/gi),
    dark_theme: /#0[0-9a-f]{2,6}|#111|#18181b|#020617|background(?:-color)?\s*:\s*(?:black|rgb\(0[,\s]+0[,\s]+0\))/i.test(text),
    patterns: patternFingerprint,
  };
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

function countMatches(value, pattern) {
  return typeof value === 'string' ? (value.match(pattern) || []).length : 0;
}

export function agentAuthoredBlockMetrics(result) {
  const toolCalls = Array.isArray(result?.toolCalls) ? result.toolCalls : [];
  const writeCalls = toolCalls.filter((item) => item && item.name === 'Write');
  let agentAuthoredWpHtmlOpeners = 0;
  let agentAuthoredWpBlockComments = 0;
  let agentAuthoredWpHtmlWriteCalls = 0;

  for (const call of writeCalls) {
    const content = typeof call?.input?.content === 'string' ? call.input.content : '';
    const wpHtmlOpeners = countMatches(content, /<!--\s+wp:html\b/g);
    agentAuthoredWpHtmlOpeners += wpHtmlOpeners;
    agentAuthoredWpBlockComments += countMatches(content, /<!--\s+\/?wp:/g);
    if (wpHtmlOpeners > 0) {
      agentAuthoredWpHtmlWriteCalls++;
    }
  }

  return {
    agent_authored_wp_html_openers: agentAuthoredWpHtmlOpeners,
    agent_authored_wp_html_write_calls: agentAuthoredWpHtmlWriteCalls,
    agent_authored_wp_block_comments: agentAuthoredWpBlockComments,
  };
}

export function nativeBlockQualityMetrics(quality, authoredBlocks, editorValidation, importReport) {
  const reasons = [];
  const bfbFallbackCount = metric(quality?.bfb_fallback_count);
  const coreHtmlWithoutBfbFallback = metric(quality?.core_html_without_bfb_fallback);
  const importerQuality = importReport?.report?.quality || {};
  const importerCoreHtmlBlocks = metric(importerQuality.core_html_block_count);
  const importerInvalidBlocks = metric(importerQuality.invalid_block_count);
  const agentAuthoredWpHtmlOpeners = metric(authoredBlocks.agent_authored_wp_html_openers);
  const invalidEditorBlocks = metric(editorValidation?.invalid_blocks);
  const targetPagesSeen = metric(quality?.target_pages_seen);
  const targetPostsWithBlocks = metric(quality?.target_posts_with_blocks);

  if (targetPagesSeen === 0 || targetPostsWithBlocks === 0) {
    reasons.push('missing_target_block_page');
  }

  if (agentAuthoredWpHtmlOpeners > 0) {
    reasons.push('agent_authored_wp_html');
  }
  if (coreHtmlWithoutBfbFallback > 0) {
    reasons.push('core_html_without_bfb_fallback');
  }
  if (bfbFallbackCount > 0) {
    reasons.push('bfb_fallback');
  }
  if (importerCoreHtmlBlocks > 0) {
    reasons.push('importer_core_html_blocks');
  }
  if (importerInvalidBlocks > 0) {
    reasons.push('importer_invalid_blocks');
  }
  if (importReport?.error) {
    reasons.push('importer_report_error');
  }
  if (invalidEditorBlocks > 0) {
    reasons.push('editor_invalid_blocks');
  }
  if (editorValidation?.error) {
    reasons.push('editor_validation_error');
  }

  return {
    native_block_quality_pass: reasons.length === 0,
    native_block_quality_failure_count: reasons.length,
    native_block_quality_failure_reasons: reasons,
  };
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

export function semanticTargetMetric(semanticComparison, key) {
  return (semanticComparison?.diagnostics?.targets || semanticComparison?.targets || []).reduce(
    (sum, target) => sum + metric(target?.[key]),
    0
  );
}

export function semanticMismatchFailureDetails(semanticComparison) {
  const mismatches = semanticComparison?.diagnostics?.mismatches || semanticComparison?.mismatches || [];
  return mismatches.map((mismatch) => {
    const concept = mismatch.concept || mismatch.type || 'unknown';
    const sourceCount =
      mismatch.source && Object.hasOwn(mismatch.source, 'count') ? ` source=${mismatch.source.count}` : '';
    const generatedCount =
      mismatch.generated && Object.hasOwn(mismatch.generated, 'count') ? ` generated=${mismatch.generated.count}` : '';
    const reason = mismatch.reason ? ` reason=${mismatch.reason}` : '';
    return `semantic mismatch: ${concept}${sourceCount}${generatedCount}${reason}`;
  });
}

export function agentSuccessGate(result, semanticComparison) {
  const semanticMismatchCount = metric(semanticComparison?.mismatch_count);
  const agentTimedOut = result?.timedOut === true;
  const agentSucceeded = result?.success === true && !result?.error && !agentTimedOut && semanticMismatchCount === 0;

  return {
    agentSucceeded,
    semanticMismatchCount,
    semanticFailureDetails: semanticMismatchCount > 0 ? semanticMismatchFailureDetails(semanticComparison) : [],
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
  const agentStarted = Date.now();
  const { result, resultFile, exitCode, stderr } = await runEval(prompt, {
    maxTurns: 40,
    timeoutMs: 420000,
  });
  const agentElapsedMs = Date.now() - agentStarted;
  const qualityProbeStarted = Date.now();
  const quality = await probeQuality(sitePath);
  const qualityProbeMs = Date.now() - qualityProbeStarted;
  const status = await siteStatus(sitePath);
  assertNamespacedPort(status, runtime);
  const importReport = await collectLatestImportReport(sitePath);
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
  const gate = agentSuccessGate(result, semanticComparison);
  const semanticMismatchCount = gate.semanticMismatchCount;
  const semanticOptionalSelectorAbsentCount = semanticTargetMetric(semanticComparison, 'optional_selector_absent_count');
  const semanticFailureDetails = gate.semanticFailureDetails;

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
      importer_fallback_count: Number(importReport.report?.quality?.fallback_count || 0),
      importer_core_html_block_count: Number(importReport.report?.quality?.core_html_block_count || 0),
      importer_invalid_block_count: Number(importReport.report?.quality?.invalid_block_count || 0),
      importer_invalid_block_document_count: Number(importReport.report?.quality?.invalid_block_document_count || 0),
      importer_generated_block_document_count: Number(importReport.report?.generated_theme?.block_documents?.length || 0),
      system_prompt_size_bytes: systemPrompt.system_prompt_size_bytes,
      visual_comparison_target_count: Number(visualComparison.target_count || 0),
      visual_comparison_checked_target_count: Number(visualComparison.checked_target_count || 0),
      visual_comparison_error_count: Number(visualComparison.error_count || 0),
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
      ...optionalArtifactPath('semantic_fidelity', semanticComparison.artifact),
      ...optionalArtifactPath('semantic_comparison_dir', semanticComparison.artifact_dir),
      ...optionalArtifactPath('generated_theme_ux_gates', generatedThemeUxGates.artifact),
    },
    errors: semanticFailureDetails,
    metadata: {
      benchmark_variant: currentVariant,
      bench_namespace: runtime.namespaceSlug,
      bench_port_range: runtime.namespaceSlug ? `${runtime.portBase}-${runtime.portMax}` : '',
      prompt_variant: selectedPromptVariant,
      prompt_file: selectedPromptFile,
      prompt_category: PROMPT_CATEGORY,
      design_primary_font_family: designFingerprint.patterns?.primary_font_family || '',
      design_display_font_family: designFingerprint.patterns?.display_font_family || '',
      design_type_pairing_signature: designFingerprint.patterns?.type_pairing_signature || '',
      design_repetition_signature: designFingerprint.patterns?.repetition_signature || '',
      design: designFingerprint,
      ...systemPrompt,
    },
  };
}
