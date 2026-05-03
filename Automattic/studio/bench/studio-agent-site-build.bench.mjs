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
const PROMPT_VARIANT_SETTING = 'studio_site_build_prompt_variant';
const PROMPT_FILE_SETTING = 'studio_site_build_prompt_file';
const DEFAULT_PROMPT_VARIANT = 'studio-code';
const PROMPT_CATEGORY = 'site-build';
const SYSTEM_PROMPT_FILES = ['apps/cli/ai/system-prompt.ts'];
const requireFromBench = createRequire(import.meta.url);
const VISUAL_VIEWPORT = { width: 1440, height: 1100 };

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
  return {
    ...process.env,
    ...(staticSiteImporterPath
      ? { STUDIO_STATIC_SITE_IMPORTER_PLUGIN_PATH: staticSiteImporterPath }
      : {}),
    ...extra,
  };
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

async function availablePromptVariants() {
  const promptsDir = new URL('./prompts/site-build/', import.meta.url);
  const entries = await readdir(promptsDir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
    .map((entry) => entry.name.replace(/\.md$/, ''))
    .sort();
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

  return new URL(`./prompts/site-build/${variantName}.md`, import.meta.url);
}

async function siteBuildPrompt(sitePath) {
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
  const themesRoot = path.join(sitePath, 'wp-content/themes');
  let themeEntries = [];
  try {
    themeEntries = await readdir(themesRoot, { withFileTypes: true });
  } catch {
    return [];
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
      generatedThemes.push({ themeRoot, mtimeMs: reportStat.mtimeMs });
    } catch {
      // Only validate importer-generated themes. Default themes can contain
      // historical/core patterns that are irrelevant to this benchmark.
    }
  }

  generatedThemes.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const themeRoot = generatedThemes[0]?.themeRoot;
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

async function collectLatestImportReport(sitePath) {
  const themesRoot = path.join(sitePath, 'wp-content/themes');
  let themeEntries = [];
  try {
    themeEntries = await readdir(themesRoot, { withFileTypes: true });
  } catch {
    return { report: null, reportPath: '', error: 'Themes directory not found.' };
  }

  const reports = [];
  for (const entry of themeEntries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const reportPath = path.join(themesRoot, entry.name, 'import-report.json');
    try {
      const reportStat = await stat(reportPath);
      reports.push({ reportPath, mtimeMs: reportStat.mtimeMs });
    } catch {
      // Ignore non-importer themes.
    }
  }

  reports.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const reportPath = reports[0]?.reportPath || '';
  if (!reportPath) {
    return { report: null, reportPath: '', error: 'No Static Site Importer report found.' };
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

function emptyVisualComparison(error = '') {
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
    error,
    results: [],
  };
}

async function compareVisualFidelity(importReport, artifactDir, sitePath) {
  const targets = comparisonTargets(importReport);
  if (!targets.length) {
    return emptyVisualComparison(importReport?.error || 'No visual fidelity comparison targets found.');
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
      results.push(result);
    }
  } catch (error) {
    return emptyVisualComparison(`Visual comparison failed: ${error instanceof Error ? error.message : String(error)}`);
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

  return {
    ...totals,
    surfaces: ['source_static', 'wordpress_frontend'],
    editor_surface_ready: true,
    artifact_dir: visualDir,
    results,
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

export default async function studioAgentSiteBuildBench() {
  const currentVariant = variant();
  const runId = `${currentVariant}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const artifactDir = path.join(SHARED_STATE, 'studio-agent-site-build-artifacts');
  const sitePath = path.join(artifactDir, 'sites', runId);
  await mkdir(path.dirname(sitePath), { recursive: true });

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
  const importReport = await collectLatestImportReport(sitePath);
  await mkdir(artifactDir, { recursive: true });
  await restoreMissingSourceStaticFiles(importReport, sitePath, result);
  const visualComparisonStarted = Date.now();
  const visualComparison = await compareVisualFidelity(importReport, artifactDir, sitePath);
  const visualComparisonMs = Date.now() - visualComparisonStarted;
  const editorValidationStarted = Date.now();
  const editorValidation = await validateThemeBlocks(sitePath, status.siteUrl);
  const editorValidationMs = Date.now() - editorValidationStarted;
  const totalElapsedMs = Date.now() - totalStarted;
  const validation = validationMetrics(result);
  const authoredBlocks = agentAuthoredBlockMetrics(result);
  const nativeBlockQuality = nativeBlockQualityMetrics(quality, authoredBlocks, editorValidation, importReport);

  const artifactFile = path.join(artifactDir, `result-${runId}.json`);
  await writeFile(
    artifactFile,
    JSON.stringify(
      {
        variant: currentVariant,
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
          editor_validation_ms: editorValidationMs,
          total_elapsed_ms: totalElapsedMs,
        },
        quality,
        importReport,
        visualComparison,
        editorValidation,
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
  const agentSucceeded = result.success === true && !result.error;

  return {
    metrics: {
      success_rate: agentSucceeded ? 1 : 0,
      agent_error_rate: agentSucceeded ? 0 : 1,
      elapsed_ms: totalElapsedMs,
      site_create_ms: siteCreateMs,
      agent_elapsed_ms: agentElapsedMs,
      quality_probe_ms: qualityProbeMs,
      visual_comparison_ms: visualComparisonMs,
      editor_validation_ms: editorValidationMs,
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
      visual_simple_probe_parity_mismatch_count: Number(visualComparison.simple_probe_parity_mismatch_count || 0),
      visual_nav_probe_parity_mismatch_count: Number(visualComparison.nav_probe_parity_mismatch_count || 0),
      visual_footer_probe_parity_mismatch_count: Number(visualComparison.footer_probe_parity_mismatch_count || 0),
      visual_hero_probe_parity_mismatch_count: Number(visualComparison.hero_probe_parity_mismatch_count || 0),
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
      visual_comparison_dir: visualComparison.artifact_dir || '',
    },
    metadata: {
      benchmark_variant: currentVariant,
      prompt_variant: selectedPromptVariant,
      prompt_file: selectedPromptFile,
      prompt_category: PROMPT_CATEGORY,
      ...systemPrompt,
    },
  };
}
