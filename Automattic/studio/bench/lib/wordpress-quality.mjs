import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { runCli as defaultRunCli } from './studio-bench.mjs';
import { collectLatestGeneratedTheme } from './design-gates.mjs';
import { loadWordPressHelperManifest, loadWordPressLibHelper } from './wordpress-helper-discovery.mjs';

export {
  collectGeneratedThemeUxGates,
  collectThemeBlockDocuments,
  hiddenEditorContentDiagnostics,
  reportedFreeformBlockCount,
  structuralSelectorDriftDiagnostics,
} from './design-gates.mjs';

function blockThemeQualityProbePath(options = {}) {
  const explicit = options.blockThemeQualityProbePath || process.env.HOMEBOY_WORDPRESS_BLOCK_THEME_QUALITY_PROBE;
  if (explicit) {
    return explicit;
  }

  const { manifest } = loadWordPressHelperManifest(options);
  return manifest?.extensionRoot
    ? path.join(manifest.extensionRoot, 'scripts', 'bench', 'lib', 'block-theme-quality-probe.php')
    : '';
}

function blockThemeQualityProbeCode(probePath) {
  const encodedPath = Buffer.from(probePath).toString('base64');
  return String.raw`
$homeboy_probe_path = base64_decode( '${encodedPath}', true );
if ( ! is_string( $homeboy_probe_path ) || ! is_readable( $homeboy_probe_path ) ) {
    fwrite( STDERR, 'Homeboy WordPress block theme quality probe is unavailable: ' . (string) $homeboy_probe_path );
    exit( 1 );
}
require_once $homeboy_probe_path;
$counts = homeboy_wordpress_collect_block_theme_quality( array(
    'target_post_titles' => array( 'Studio Code' ),
    'post_types'         => array( 'page', 'wp_template', 'wp_template_part' ),
) );
$counts['bfb_fallback_count'] = (int) get_option( 'studio_bfb_unsupported_fallback_count', 0 );
$counts['core_html_without_bfb_fallback'] = max( 0, $counts['core_html_blocks'] - $counts['bfb_fallback_count'] );
$counts['target_core_html_without_bfb_fallback'] = max( 0, $counts['target_core_html_blocks'] - $counts['bfb_fallback_count'] );
echo wp_json_encode( $counts, JSON_PRETTY_PRINT ) . PHP_EOL;
`;
}

export async function probeQuality(sitePath, options = {}) {
  const runCli = options.runCli || defaultRunCli;
  const probePath = blockThemeQualityProbePath(options);
  if (!probePath || !existsSync(probePath)) {
    throw new Error('Homeboy WordPress block theme quality helper is unavailable. Update homeboy-extensions or set HOMEBOY_WORDPRESS_HELPER_MANIFEST.');
  }
  const { stdout } = await runCli(['wp', '--path', sitePath, '--php-version', '8.3', 'eval', blockThemeQualityProbeCode(probePath)]);
  return parseQualityProbeOutput(stdout);
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

function parseQualityProbeOutput(stdout) {
  const jsonStart = stdout.indexOf('{');
  if (jsonStart === -1) {
    throw new Error(`quality probe did not emit JSON: ${stdout.slice(0, 1000)}`);
  }
  return JSON.parse(stdout.slice(jsonStart));
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
