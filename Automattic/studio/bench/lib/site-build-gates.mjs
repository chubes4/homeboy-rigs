import { semanticMismatchFailureDetails } from './semantic-fidelity.mjs';
import { loadWordPressLibHelper } from './wordpress-helper-discovery.mjs';

export const VISUAL_PIXEL_DIFF_THRESHOLD = 0.05;

function materializedSiteQualityHelper(options = {}) {
  const { module } = loadWordPressLibHelper('materialized-site-quality.js', {
    ...options,
    helperKey: 'materializedSiteQuality',
  });
  if (!module?.evaluateMaterializedSiteQuality) {
    throw new Error('Homeboy WordPress materialized site quality helper is unavailable. Update homeboy-extensions or set HOMEBOY_WORDPRESS_HELPER_MANIFEST.');
  }
  return module;
}

export function importerBlockQualityMetrics(importReport, options = {}) {
  return materializedSiteQualityHelper(options).importerBlockQualityMetrics(importReport);
}

export function importerBlockQualityFailureDetails(importerBlockQuality, options = {}) {
  return materializedSiteQualityHelper(options).importerBlockQualityFailureDetails(importerBlockQuality);
}

export function visualEditorParityMetrics(visualComparison, options = {}) {
  return materializedSiteQualityHelper(options).visualEditorParityMetrics(visualComparison);
}

export function visualEditorParityFailureDetails(visualEditorParity, options = {}) {
  return materializedSiteQualityHelper(options).visualEditorParityFailureDetails(visualEditorParity, options);
}

export function visualPixelDiffFailureDetails(visualComparison, options = {}) {
  return materializedSiteQualityHelper(options).visualPixelDiffFailureDetails(visualComparison, options);
}

export function agentSuccessGate(result, semanticComparison, importReport, visualComparison, options = {}) {
  const helper = materializedSiteQualityHelper(options);
  const gate = helper.evaluateMaterializedSiteQuality(
    {
      result,
      semanticComparison,
      importReport,
      visualComparison,
      semanticMismatchFailureDetails,
    },
    options
  );

  return {
    agentSucceeded: gate.passed,
    semanticMismatchCount: gate.semanticMismatchCount,
    semanticFailureDetails: gate.semanticMismatchCount > 0 ? semanticMismatchFailureDetails(semanticComparison) : [],
    importerBlockQuality: gate.importerBlockQuality,
    importerBlockQualityFailureDetails: helper.importerBlockQualityFailureDetails(gate.importerBlockQuality),
    visualEditorParity: gate.visualEditorParity,
    visualEditorFailureDetails: helper.visualEditorParityFailureDetails(gate.visualEditorParity, options),
    visualPixelDiffRatio: gate.visualPixelDiffRatio,
    visualPixelDiffFailureDetails: helper.visualPixelDiffFailureDetails(visualComparison, options),
    metrics: gate.metrics,
  };
}
