import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { runCli as defaultRunCli } from './studio-bench.mjs';

export const QUALITY_PROBE = String.raw`
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

export function pageQualityProbeCode(pageId) {
  const encodedPageId = Buffer.from(String(pageId)).toString('base64');

  return String.raw`
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

$page_id = absint( base64_decode( '${encodedPageId}' ) );
$post = get_post( $page_id );
if ( ! $post ) {
    fwrite( STDERR, 'Inserted page not found: ' . $page_id );
    exit( 1 );
}

$content = (string) $post->post_content;
$counts = array(
    'posts_seen' => '' === trim( $content ) ? 0 : 1,
    'posts_with_blocks' => false !== strpos( $content, '<!-- wp:' ) ? 1 : 0,
    'total_blocks' => 0,
    'core_html_blocks' => 0,
    'serialized_block_comments' => substr_count( $content, '<!-- wp:' ),
    'bfb_fallback_count' => (int) get_option( 'studio_bfb_unsupported_fallback_count', 0 ),
    'stored_content_hash' => hash( 'sha256', $content ),
    'stored_content_bytes' => strlen( $content ),
    'stored_content_preview' => substr( $content, 0, 2000 ),
);

if ( '' !== trim( $content ) ) {
    bench_count_blocks( parse_blocks( $content ), $counts );
}

echo wp_json_encode( $counts, JSON_PRETTY_PRINT ) . PHP_EOL;
`;
}

export async function probeQuality(sitePath, options = {}) {
  const runCli = options.runCli || defaultRunCli;
  const { stdout } = await runCli(['wp', '--path', sitePath, '--php-version', '8.3', 'eval', QUALITY_PROBE]);
  return parseQualityProbeOutput(stdout);
}

export async function probePageQuality(sitePath, pageId, options = {}) {
  const runCli = options.runCli || defaultRunCli;
  const { stdout } = await runCli(['wp', '--path', sitePath, '--php-version', '8.3', 'eval', pageQualityProbeCode(pageId)]);
  return parseQualityProbeOutput(stdout);
}

function parseQualityProbeOutput(stdout) {
  const jsonStart = stdout.indexOf('{');
  if (jsonStart === -1) {
    throw new Error(`quality probe did not emit JSON: ${stdout.slice(0, 1000)}`);
  }
  return JSON.parse(stdout.slice(jsonStart));
}

export async function collectThemeBlockDocuments(sitePath) {
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

export async function collectLatestGeneratedTheme(sitePath) {
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

export async function collectLatestImportReport(sitePath) {
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

function numericMetric(value) {
  const number = Number(value ?? 0);
  return Number.isFinite(number) ? number : 0;
}

function metricKeyPart(value) {
  return String(value || '')
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase();
}

export function importerTimingMetrics(importReport) {
  const report = importReport?.report || {};
  const performance = report.performance || {};
  const timings = performance.timings && typeof performance.timings === 'object' ? performance.timings : {};
  const fragments = report.conversion_fragments && typeof report.conversion_fragments === 'object'
    ? report.conversion_fragments
    : {};
  const metrics = {
    importer_performance_total_ms: numericMetric(performance.total_ms),
  };

  for (const [key, value] of Object.entries(timings)) {
    metrics[`importer_phase_${metricKeyPart(key)}`] = numericMetric(value);
  }

  for (const [source, fragment] of Object.entries(fragments)) {
    const sourceKey = metricKeyPart(source || 'fragment');
    const fragmentTimings = fragment?.timings && typeof fragment.timings === 'object' ? fragment.timings : {};
    metrics[`importer_fragment_${sourceKey}_html_bytes`] = numericMetric(fragment?.html_bytes);
    metrics[`importer_fragment_${sourceKey}_block_bytes`] = numericMetric(fragment?.block_bytes);
    metrics[`importer_fragment_${sourceKey}_fallback_count`] = numericMetric(fragment?.fallback_count);
    metrics[`importer_fragment_${sourceKey}_content_loss_count`] = numericMetric(fragment?.content_loss_count);

    for (const [key, value] of Object.entries(fragmentTimings)) {
      metrics[`importer_fragment_${sourceKey}_${metricKeyPart(key)}`] = numericMetric(value);
    }
  }

  return metrics;
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

function cssRules(cssFiles) {
  const rules = [];
  for (const file of cssFiles) {
    const content = typeof file.content === 'string' ? file.content : '';
    for (const match of content.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const selector = match[1].trim().replace(/\s+/g, ' ');
      if (!selector || selector.startsWith('@')) {
        continue;
      }
      rules.push({
        source: file.source,
        selector,
        declarations: match[2].trim().replace(/\s+/g, ' '),
      });
    }
  }
  return rules;
}

function structuralSelectorTarget(selector) {
  const normalizedSelector = String(selector || '')
    .replace(/::?[a-z-]+(?:\([^)]*\))?/gi, '')
    .trim();
  const match = normalizedSelector.match(
    /(?:^|[\s>+~])(?<tag>header|main|nav|footer|section|article|aside)(?<compound>(?:[#.][-_a-zA-Z0-9]+)*)/i
  );
  if (!match?.groups) {
    return null;
  }

  const compound = match.groups.compound || '';
  const id = compound.match(/#([-_a-zA-Z0-9]+)/)?.[1] || '';
  const classes = [...compound.matchAll(/\.([-_a-zA-Z0-9]+)/g)].map((classMatch) => classMatch[1]);
  const text = `${match.groups.tag} ${id} ${classes.join(' ')} ${selector}`;
  const heroLike = /\bhero\b/i.test(text);
  if (!id && classes.length === 0) {
    return null;
  }

  return {
    tag: match.groups.tag.toLowerCase(),
    id,
    classes,
    hero_like: heroLike,
  };
}

function hasMaterialStructuralLayout(declarations, target) {
  const layoutPattern = /(?:display\s*:\s*(?:grid|flex)|grid-template|flex(?:-direction|-wrap)?\s*:|align-items\s*:|justify-content\s*:|min-height\s*:|height\s*:\s*(?:\d+(?:vh|dvh|svh)|100%)|padding(?:-[a-z]+)?\s*:|background(?:-|\s*:)|position\s*:\s*(?:relative|absolute|fixed|sticky))/i;
  return target?.hero_like === true && layoutPattern.test(String(declarations || ''));
}

function htmlAttributeTokens(attributes, name) {
  const values = [];
  const pattern = new RegExp(`\\b${name}\\s*=\\s*(["'])(.*?)\\1`, 'gi');
  for (const match of String(attributes || '').matchAll(pattern)) {
    values.push(...String(match[2] || '').split(/\s+/).filter(Boolean));
  }
  return values;
}

function markupHasId(markup, id) {
  if (!id) {
    return true;
  }
  const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return (
    new RegExp(`\\bid\\s*=\\s*(["'])${escaped}\\1`, 'i').test(markup) ||
    new RegExp(`"anchor"\\s*:\\s*"${escaped}"`, 'i').test(markup)
  );
}

function markupHasClasses(markup, classes) {
  const classValues = [];
  const pattern = /\bclass(?:Name)?\s*=\s*(["'])(.*?)\1/gi;
  for (const match of String(markup || '').matchAll(pattern)) {
    classValues.push(...String(match[2] || '').split(/\s+/).filter(Boolean));
  }
  return classes.every((className) => classValues.includes(className));
}

function markupHasStructuralTarget(markup, target) {
  const tagPattern = new RegExp(`<${target.tag}\\b([^>]*)>`, 'gi');
  for (const match of String(markup || '').matchAll(tagPattern)) {
    const attributes = match[1] || '';
    const ids = htmlAttributeTokens(attributes, 'id');
    const classes = htmlAttributeTokens(attributes, 'class');
    const idMatches = !target.id || ids.includes(target.id);
    const classesMatch = target.classes.every((className) => classes.includes(className));
    if (idMatches && classesMatch) {
      return true;
    }
  }
  return false;
}

function structuralSelectorDriftReason(markup, target) {
  if (target.id && !markupHasId(markup, target.id)) {
    return 'missing_generated_dom_id';
  }
  if (target.classes.length > 0 && !markupHasClasses(markup, target.classes)) {
    return 'missing_generated_dom_class';
  }
  return 'generated_dom_tag_drift';
}

export function structuralSelectorDriftDiagnostics(cssFiles, generatedDocuments) {
  const generatedMarkup = generatedDocuments.map((document) => document.content || '').join('\n');
  const materialSelectors = [];
  const missingSelectors = [];

  for (const rule of cssRules(cssFiles)) {
    for (const selector of splitSelectorList(rule.selector)) {
      const target = structuralSelectorTarget(selector);
      if (!target || !hasMaterialStructuralLayout(rule.declarations, target)) {
        continue;
      }

      const diagnostic = {
        source: rule.source,
        selector,
        expected_tag: target.tag,
        expected_id: target.id,
        expected_classes: target.classes,
        declarations: rule.declarations.slice(0, 300),
      };
      materialSelectors.push(diagnostic);
      if (!markupHasStructuralTarget(generatedMarkup, target)) {
        missingSelectors.push({
          ...diagnostic,
          reason: structuralSelectorDriftReason(generatedMarkup, target),
        });
      }
    }
  }

  return {
    source_structural_selector_count: materialSelectors.length,
    missing_structural_selector_count: missingSelectors.length,
    source_structural_selectors: materialSelectors.slice(0, 25),
    missing_structural_selectors: missingSelectors.slice(0, 25),
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
  const sourceRoot = path.join(sitePath, 'tmp/static-site');
  const sourceCssFiles = await collectCssFiles(sourceRoot);
  const sourceCssFileContents = [];
  for (const file of sourceCssFiles) {
    sourceCssFileContents.push({ source: path.relative(sourceRoot, file), content: await readIfExists(file) });
  }
  const structuralSelectorDrift = structuralSelectorDriftDiagnostics(sourceCssFileContents, documents);

  if (freeform.count !== importerFreeformCount) {
    reasons.push('freeform_report_count_mismatch');
  }
  if (hiddenEditorContent.missing_editor_override_count > 0) {
    reasons.push('css_hidden_editor_content_without_override');
  }
  if (structuralSelectorDrift.missing_structural_selector_count > 0) {
    reasons.push('source_css_structural_selector_drift');
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
    source_css_file_count: sourceCssFiles.length,
    source_css_structural_selector_count: structuralSelectorDrift.source_structural_selector_count,
    source_css_missing_structural_selector_count: structuralSelectorDrift.missing_structural_selector_count,
    source_css_missing_structural_selectors: structuralSelectorDrift.missing_structural_selectors,
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

export function agentAuthoredBlockMetrics(result) {
  const toolCalls = Array.isArray(result?.toolCalls) ? result.toolCalls : [];
  const writeCalls = toolCalls.filter((item) => item && item.name === 'Write');
  let agentAuthoredWpHtmlOpeners = 0;
  let agentAuthoredWpBlockComments = 0;
  let agentAuthoredWpHtmlWriteCalls = 0;

  for (const call of writeCalls) {
    const content = typeof call?.input?.content === 'string' ? call.input.content : '';
    const wpHtmlOpeners = countRegex(content, /<!--\s+wp:html\b/g);
    agentAuthoredWpHtmlOpeners += wpHtmlOpeners;
    agentAuthoredWpBlockComments += countRegex(content, /<!--\s+\/?wp:/g);
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

function countRegex(value, pattern) {
  return typeof value === 'string' ? (value.match(pattern) || []).length : 0;
}

function metric(value) {
  const number = Number(value ?? 0);
  return Number.isFinite(number) ? number : 0;
}
