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

export async function probeQuality(sitePath, options = {}) {
  const runCli = options.runCli || defaultRunCli;
  const { stdout } = await runCli(['wp', '--path', sitePath, '--php-version', '8.3', 'eval', QUALITY_PROBE]);
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
