import { semanticMismatchFailureDetails } from './semantic-fidelity.mjs';

const VISUAL_EDITOR_PIXEL_DIFF_THRESHOLD = 0.05;
export const VISUAL_PIXEL_DIFF_THRESHOLD = 0.05;

function metric(value) {
  const number = Number(value ?? 0);
  return Number.isFinite(number) ? number : 0;
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
