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
  return materializedSiteQualityHelper().agentAuthoredBlockMetrics(result);
}

export function nativeBlockQualityMetrics(quality, authoredBlocks, editorValidation, importReport) {
  return materializedSiteQualityHelper().nativeBlockQualityMetrics(quality, authoredBlocks, editorValidation, importReport);
}

function materializedSiteQualityHelper(options = {}) {
  const { module } = loadWordPressLibHelper('materialized-site-quality.js', {
    ...options,
    helperKey: 'materializedSiteQuality',
  });
  if (!module?.nativeBlockQualityMetrics || !module?.agentAuthoredBlockMetrics) {
    throw new Error('Homeboy WordPress materialized site quality helper is unavailable. Update homeboy-extensions or set HOMEBOY_WORDPRESS_HELPER_MANIFEST.');
  }
  return module;
}
