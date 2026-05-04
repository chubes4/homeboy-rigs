import { readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

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
  return generatedThemes[0] || { themeRoot: '', themeSlug: '', reportPath, error: 'No Static Site Importer report found.' };
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

export async function collectDesignFingerprint(sitePath) {
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
