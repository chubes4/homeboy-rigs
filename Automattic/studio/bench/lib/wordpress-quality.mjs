import { readFile } from 'node:fs/promises';

import { runCli as defaultRunCli } from './studio-bench.mjs';
import { collectLatestGeneratedTheme } from './design-gates.mjs';
import { loadWordPressLibHelper } from './wordpress-helper-discovery.mjs';

export {
  collectGeneratedThemeUxGates,
  collectThemeBlockDocuments,
  hiddenEditorContentDiagnostics,
  reportedFreeformBlockCount,
  structuralSelectorDriftDiagnostics,
} from './design-gates.mjs';

export async function probeQuality(sitePath, options = {}) {
  const runCli = options.runCli || defaultRunCli;
  const { module: blockQuality } = loadWordPressLibHelper('block-quality.js', options);
  if (!blockQuality?.wordpressBlockQualityProbeCode || !blockQuality?.parseWordPressBlockQualityProbeOutput) {
    throw new Error('Homeboy WordPress block quality helper is unavailable. Update homeboy-extensions or set HOMEBOY_WORDPRESS_HELPER_MANIFEST.');
  }
  const { stdout } = await runCli([
    'wp',
    '--path',
    sitePath,
    '--php-version',
    '8.3',
    'eval',
    blockQuality.wordpressBlockQualityProbeCode({
      fallbackOptionNames: ['studio_bfb_unsupported_fallback_count'],
      postTypes: ['page', 'wp_template', 'wp_template_part'],
      targetPostTitles: ['Studio Code'],
    }),
  ]);
  const quality = blockQuality.parseWordPressBlockQualityProbeOutput(stdout);
  return {
    ...quality,
    bfb_fallback_count: quality.fallback_count || 0,
    core_html_without_bfb_fallback: quality.core_html_without_fallback || 0,
  };
}

export async function probePageQuality(sitePath, pageId, options = {}) {
  const runCli = options.runCli || defaultRunCli;
  const { module: blockQuality } = loadWordPressLibHelper('block-quality.js', options);
  if (!blockQuality?.wordpressPostBlockQualityProbeCode || !blockQuality?.parseWordPressBlockQualityProbeOutput) {
    throw new Error('Homeboy WordPress block quality helper is unavailable. Update homeboy-extensions or set HOMEBOY_WORDPRESS_HELPER_MANIFEST.');
  }
  const { stdout } = await runCli([
    'wp',
    '--path',
    sitePath,
    '--php-version',
    '8.3',
    'eval',
    blockQuality.wordpressPostBlockQualityProbeCode(pageId, {
      fallbackOptionNames: ['studio_bfb_unsupported_fallback_count'],
    }),
  ]);
  const quality = blockQuality.parseWordPressBlockQualityProbeOutput(stdout);
  return {
    ...quality,
    bfb_fallback_count: quality.fallback_count || 0,
    core_html_without_bfb_fallback: quality.core_html_without_fallback || 0,
  };
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
