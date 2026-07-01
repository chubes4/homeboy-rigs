const VISUAL_PIXEL_DIFF_THRESHOLD = 0.05;

function importerBlockQualityMetrics(importReport = {}) {
  const quality = importReport.report?.quality || {};
  return {
    importerCoreHtmlBlockCount: Number(quality.core_html_block_count || 0),
    importerFreeformBlockCount: Number(quality.freeform_block_count || 0),
    importerFallbackCount: Number(quality.fallback_count || 0),
  };
}

function importerBlockQualityFailureDetails(metrics = {}) {
  if (!metrics.importerCoreHtmlBlockCount && !metrics.importerFreeformBlockCount && !metrics.importerFallbackCount) {
    return [];
  }
  return [
    `importer block quality: core/html=${metrics.importerCoreHtmlBlockCount || 0}, freeform=${metrics.importerFreeformBlockCount || 0}, fallback=${metrics.importerFallbackCount || 0}`,
  ];
}

function visualEditorParityMetrics(visualComparison = {}) {
  return {
    visualEditorVsSourcePixelDiffRatio: Number(visualComparison.visual_editor_vs_source_pixel_diff_ratio || 0),
    visualEditorVsFrontendPixelDiffRatio: Number(visualComparison.visual_editor_vs_frontend_pixel_diff_ratio || 0),
    visualSourceVsFrontendPixelDiffRatio: Number(visualComparison.visual_source_vs_frontend_pixel_diff_ratio_diagnostic || 0),
    visualEditorParityErrorCount: Number(visualComparison.visual_editor_error_count || 0),
  };
}

function visualEditorParityFailureDetails(metrics = {}) {
  if (metrics.visualEditorVsSourcePixelDiffRatio <= VISUAL_PIXEL_DIFF_THRESHOLD) {
    return [];
  }
  if (metrics.visualSourceVsFrontendPixelDiffRatio > VISUAL_PIXEL_DIFF_THRESHOLD) {
    return [
      `editor and frontend both diverge from source (editor: ${metrics.visualEditorVsSourcePixelDiffRatio}, frontend: ${metrics.visualSourceVsFrontendPixelDiffRatio}) - conversion failed before editor concern`,
    ];
  }
  return [
    `editor render diverges from frontend (editor diff: ${metrics.visualEditorVsSourcePixelDiffRatio}, frontend diff: ${metrics.visualSourceVsFrontendPixelDiffRatio}) - likely block-validation or unscoped CSS`,
  ];
}

function visualPixelDiffFailureDetails(visualComparison = {}, options = {}) {
  const threshold = Number(options.visualPixelDiffThreshold || VISUAL_PIXEL_DIFF_THRESHOLD);
  const ratio = Number(visualComparison.pixel_diff_ratio || 0);
  return ratio > threshold ? [`visual pixel diff: ${ratio.toFixed(3)} (threshold: ${threshold.toFixed(3)})`] : [];
}

function evaluateMaterializedSiteQuality({ result = {}, semanticComparison = {}, importReport = {}, visualComparison = {} }) {
  const importerBlockQuality = importerBlockQualityMetrics(importReport);
  const visualEditorParity = visualEditorParityMetrics(visualComparison);
  const visualPixelDiffRatio = Number(visualComparison.pixel_diff_ratio || 0);
  const semanticMismatchCount = Number(semanticComparison.mismatch_count || 0);
  const failures = [
    semanticMismatchCount > 0,
    importerBlockQualityFailureDetails(importerBlockQuality).length > 0,
    visualEditorParityFailureDetails(visualEditorParity).length > 0,
    visualPixelDiffFailureDetails(visualComparison).length > 0,
    !result.success,
  ];
  const passed = !failures.some(Boolean);

  return {
    passed,
    semanticMismatchCount,
    importerBlockQuality,
    visualEditorParity,
    visualPixelDiffRatio,
    metrics: {
      success_rate: passed ? 1 : 0,
      agent_error_rate: passed ? 0 : 1,
    },
  };
}

module.exports = {
  evaluateMaterializedSiteQuality,
  importerBlockQualityMetrics,
  importerBlockQualityFailureDetails,
  visualEditorParityMetrics,
  visualEditorParityFailureDetails,
  visualPixelDiffFailureDetails,
};
