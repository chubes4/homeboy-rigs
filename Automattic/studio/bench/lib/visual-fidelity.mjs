import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';

import { STUDIO_PATH, expandHome, setting } from './studio-bench.mjs';
import { loadWordPressLibHelper } from './wordpress-helper-discovery.mjs';
import { runWpCodeboxRecipe as runWordPressRecipe } from '../../../../shared/wp-codebox/recipe.mjs';

const requireFromBench = createRequire(import.meta.url);
export const VISUAL_VIEWPORT = { width: 1440, height: 1100 };
const VISUAL_COMPARE_THRESHOLD = 0.1;
const VISUAL_COMPARE_EXPLAIN_SELECTOR_LIMIT = 20;
function loadFidelityComparisonHelper() {
  const { module } = loadWordPressLibHelper('fidelity-comparison.js');
  if (!module) {
    throw new Error('Homeboy WordPress fidelity comparison helper is unavailable. Update homeboy-extensions or set HOMEBOY_WORDPRESS_HELPER_MANIFEST.');
  }
  return module;
}

function comparisonTargets(importReport) {
  return loadFidelityComparisonHelper().comparisonTargets(importReport);
}

function safeSlug(value, fallback) {
  return loadFidelityComparisonHelper().safeSlug(value, fallback);
}

function surfaceUrl(target, surface, reportPath, sitePath) {
  return loadFidelityComparisonHelper().surfaceUrl(target, surface, reportPath, sitePath);
}

function visualProbeGroups(target) {
  return loadFidelityComparisonHelper().visualProbeGroups(target);
}

function wpCodeboxCliPath() {
  return expandHome(setting('studio_wp_codebox_cli_path') || '');
}

function loadEditorCanvasProbes() {
  const { module } = loadWordPressLibHelper('editor-canvas-probes.js');
  if (!module) {
    throw new Error('Homeboy WordPress editor canvas probes are unavailable. Update homeboy-extensions or set HOMEBOY_WORDPRESS_HELPER_MANIFEST.');
  }
  return module;
}

async function captureEditorScreenshot(page, url, screenshotPath) {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await loadEditorCanvasProbes().captureWordPressEditorCanvasScreenshot(page, screenshotPath, {
    url,
    waitUntil: 'domcontentloaded',
    timeoutMs: 30_000,
  });
}

function visualSurfaceTotals(groups) {
  return loadFidelityComparisonHelper().visualSurfaceTotals(groups);
}

function visualSelectorComparisonDetails(result) {
  return loadFidelityComparisonHelper().visualSelectorComparisonDetails(result);
}

async function comparePngScreenshots(sourcePath, targetPath, diffPath) {
  return loadFidelityComparisonHelper().comparePngScreenshots(sourcePath, targetPath, diffPath);
}

function buildVisualDiagnostics(results, artifactPath) {
  return loadFidelityComparisonHelper().buildVisualDiagnostics(results, artifactPath);
}

function visualParity(sourceGroups, frontendGroups) {
  return loadFidelityComparisonHelper().visualParity(sourceGroups, frontendGroups);
}

function explainSelectors(groups) {
  const selectors = [];
  const seen = new Set();
  for (const group of groups) {
    for (const selector of group.selectors || []) {
      if (!seen.has(selector)) {
        seen.add(selector);
        selectors.push(selector);
      }
    }
  }
  return selectors.slice(0, VISUAL_COMPARE_EXPLAIN_SELECTOR_LIMIT);
}

async function runWpCodeboxRecipe(recipePath, artifactsDir) {
  const cliPath = wpCodeboxCliPath();
  if (!cliPath) {
    throw new Error('Studio visual fidelity requires WP Codebox browser evidence. Set studio_wp_codebox_cli_path to the WP Codebox CLI entrypoint.');
  }

  const result = await runWordPressRecipe({
    recipeFile: recipePath,
    artifactsDir,
    bin: cliPath,
    cwd: path.dirname(recipePath),
  });
  const parsed = result.json || JSON.parse(result.stdout);
  if (parsed?.success === false) {
    throw new Error(parsed?.error?.message || 'WP Codebox visual compare failed.');
  }
  return parsed;
}

async function runWpCodeboxVisualCompare(target, visualDir, targetSlug, importReport, sitePath, groups) {
  const sourceUrl = surfaceUrl(target, 'source_static', importReport.reportPath, sitePath);
  const candidateUrl = surfaceUrl(target, 'wordpress_frontend', importReport.reportPath, sitePath);
  if (!sourceUrl || !candidateUrl) {
    throw new Error('Missing source_static or wordpress_frontend render URL.');
  }

  const artifactRoot = path.join(visualDir, `${targetSlug}-codebox-artifacts`);
  const recipePath = path.join(visualDir, `${targetSlug}-visual-compare.recipe.json`);
  const args = [
    `source-url=${sourceUrl}`,
    `candidate-url=${candidateUrl}`,
    'source-label=source_static',
    'candidate-label=wordpress_frontend',
    `viewport=${VISUAL_VIEWPORT.width}x${VISUAL_VIEWPORT.height}`,
    'full-page=true',
    'wait-for=load',
    `threshold=${VISUAL_COMPARE_THRESHOLD}`,
    'max-explanation-candidates=20',
    ...explainSelectors(groups).map((selector) => `explain-selector=${selector}`),
  ];
  const recipe = {
    schema: 'wp-codebox/workspace-recipe/v1',
    workflow: {
      steps: [{ command: 'wordpress.visual-compare', args }],
    },
    artifacts: { directory: artifactRoot },
  };
  await mkdir(visualDir, { recursive: true });
  await writeFile(recipePath, `${JSON.stringify(recipe, null, 2)}\n`);

  const output = await runWpCodeboxRecipe(recipePath, artifactRoot);
  const artifactDirectory = output?.artifacts?.directory || artifactRoot;
  const summaryPath = path.join(artifactDirectory, 'files', 'browser', 'visual-compare', 'visual-diff.json');
  const summary = JSON.parse(await readFile(summaryPath, 'utf8'));
  const explanationRef = summary.files?.visualExplanation || '';
  const explanation = explanationRef
    ? JSON.parse(await readFile(path.join(artifactDirectory, explanationRef), 'utf8'))
    : null;

  return { artifactDirectory, summaryPath, summary, explanation, sourceUrl, candidateUrl };
}

function visualSelectorProbe(selector, side, explanation) {
  const focused = (explanation?.selectors || []).find((item) => item.selector === selector)?.[side];
  const missing = (explanation?.missingSelectors || []).find((item) => item.selector === selector);
  const matched = Number(focused?.matched ?? (missing ? 0 : 0));
  const captured = Number(focused?.captured ?? 0);
  return {
    selector,
    count: matched,
    visible_count: matched > 0 ? 1 : 0,
    nonzero_bounding_box_count: captured > 0 ? 1 : 0,
    first_match: null,
    error: focused?.error || missing?.[`${side}Error`] || '',
  };
}

function groupsFromVisualExplanation(groups, side, explanation) {
  return groups.map((group) => {
    const selectors = (group.selectors || []).map((selector) => visualSelectorProbe(selector, side, explanation));
    return {
      name: group.name,
      selectors,
      selector_count: selectors.length,
      missing_selector_count: selectors.filter((selector) => selector.count === 0).length,
      errored_selector_count: selectors.filter((selector) => selector.error).length,
      matched_selector_count: selectors.filter((selector) => selector.count > 0).length,
      visible_selector_count: selectors.filter((selector) => selector.visible_count > 0).length,
      nonzero_bounding_box_selector_count: selectors.filter((selector) => selector.nonzero_bounding_box_count > 0).length,
    };
  });
}

function visualCompareSurface(compare, side, groups) {
  const label = side === 'source' ? 'source_static' : 'wordpress_frontend';
  const files = compare.summary.files || {};
  const screenshot = side === 'source' ? files.sourceScreenshot : files.candidateScreenshot;
  const probes = groupsFromVisualExplanation(groups, side, compare.explanation);
  return {
    url: side === 'source' ? compare.sourceUrl : compare.candidateUrl,
    screenshot: screenshot ? path.join(compare.artifactDirectory, screenshot) : '',
    probes,
    totals: visualSurfaceTotals(probes),
    visual_compare_artifact: compare.summaryPath,
    visual_explanation_artifact: files.visualExplanation ? path.join(compare.artifactDirectory, files.visualExplanation) : '',
  };
}

function visualComparePixelDiff(compare) {
  const files = compare.summary.files || {};
  const comparison = compare.summary.comparison || {};
  return {
    pixel_diff_ratio: Number(comparison.mismatchRatio || 0),
    pixel_diff_pixel_count: Number(comparison.mismatchPixels || 0),
    pixel_count: Number(comparison.totalPixels || 0),
    diff_artifact: files.diffScreenshot ? path.join(compare.artifactDirectory, files.diffScreenshot) : '',
    visual_diff_artifact: compare.summaryPath,
    visual_explanation_artifact: files.visualExplanation ? path.join(compare.artifactDirectory, files.visualExplanation) : '',
    status: compare.summary.status || '',
  };
}

async function emptyVisualComparison(artifactDir, error = '') {
  const visualDir = path.join(artifactDir, 'visual-comparisons');
  await mkdir(visualDir, { recursive: true });
  const diagnosticsPath = path.join(visualDir, 'visual-comparison-skipped.json');
  const diagnostics = {
    ...buildVisualDiagnostics([], diagnosticsPath),
    skipped: true,
    reason: error,
  };
  await writeFile(diagnosticsPath, JSON.stringify(diagnostics, null, 2));

  return {
    target_count: 0,
    checked_target_count: 0,
    error_count: error ? 1 : 0,
    visual_editor_vs_source_pixel_diff_ratio: 0,
    visual_editor_vs_frontend_pixel_diff_ratio: 0,
    visual_source_vs_frontend_pixel_diff_ratio_diagnostic: 0,
    visual_editor_parity_error_count: error ? 1 : 0,
    missing_selector_count: 0,
    visibility_mismatch_count: 0,
    nonzero_bounding_box_count: 0,
    nonzero_bounding_box_mismatch_count: 0,
    simple_probe_parity_mismatch_count: 0,
    nav_probe_parity_mismatch_count: 0,
    footer_probe_parity_mismatch_count: 0,
    hero_probe_parity_mismatch_count: 0,
    pixel_diff_ratio: 0,
    pixel_diff_pixel_count: 0,
    surfaces: ['source_static', 'wordpress_frontend', 'wordpress_editor'],
    editor_surface_ready: true,
    artifact_dir: visualDir,
    diagnostics_artifact: diagnosticsPath,
    error,
    results: [],
    diagnostics,
  };
}

export async function compareVisualFidelity(importReport, artifactDir, sitePath) {
  const targets = comparisonTargets(importReport);
  if (!targets.length) {
    return emptyVisualComparison(artifactDir, importReport?.error || 'No visual fidelity comparison targets found.');
  }
  if (!wpCodeboxCliPath()) {
    return emptyVisualComparison(
      artifactDir,
      'Studio visual fidelity requires WP Codebox browser evidence. Set studio_wp_codebox_cli_path to the WP Codebox CLI entrypoint.'
    );
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

      let visualCompare = null;
      try {
        visualCompare = await runWpCodeboxVisualCompare(target, visualDir, targetSlug, importReport, sitePath, groups);
        result.surfaces.source_static = visualCompareSurface(visualCompare, 'source', groups);
        result.surfaces.wordpress_frontend = visualCompareSurface(visualCompare, 'candidate', groups);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        result.errors.push(`wordpress.visual-compare: ${message}`);
        result.surfaces.source_static = { url: '', screenshot: '', probes: [], totals: visualSurfaceTotals([]), error: message };
        result.surfaces.wordpress_frontend = { url: '', screenshot: '', probes: [], totals: visualSurfaceTotals([]), error: message };
      }

      const editorUrl = surfaceUrl(target, 'wordpress_editor', importReport.reportPath, sitePath);
      const editorScreenshotPath = path.join(visualDir, `${targetSlug}-wordpress_editor.png`);
      const editorPage = await browser.newPage({ ignoreHTTPSErrors: true, viewport: VISUAL_VIEWPORT });

      try {
        if (!editorUrl) {
          throw new Error('Missing wordpress_editor render URL.');
        }
        await captureEditorScreenshot(editorPage, editorUrl, editorScreenshotPath);
        result.surfaces.wordpress_editor = {
          url: editorUrl,
          screenshot: editorScreenshotPath,
          probes: [],
          totals: visualSurfaceTotals([]),
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        result.errors.push(`wordpress_editor: ${message}`);
        result.surfaces.wordpress_editor = {
          url: editorUrl,
          screenshot: '',
          probes: [],
          totals: visualSurfaceTotals([]),
          error: message,
        };
      } finally {
        await editorPage.close();
      }

      result.pixel_diffs = {};
      const sourceScreenshot = result.surfaces.source_static?.screenshot || '';
      const frontendScreenshot = result.surfaces.wordpress_frontend?.screenshot || '';
      const editorScreenshot = result.surfaces.wordpress_editor?.screenshot || '';
      if (sourceScreenshot && editorScreenshot) {
        result.pixel_diffs.editor_vs_source = await comparePngScreenshots(
          sourceScreenshot,
          editorScreenshot,
          path.join(visualDir, `${targetSlug}-wordpress_editor-vs-source_static-diff.png`)
        );
      }
      if (frontendScreenshot && editorScreenshot) {
        result.pixel_diffs.editor_vs_frontend = await comparePngScreenshots(
          frontendScreenshot,
          editorScreenshot,
          path.join(visualDir, `${targetSlug}-wordpress_editor-vs-wordpress_frontend-diff.png`)
        );
      }
      result.pixel_diff = visualCompare
        ? visualComparePixelDiff(visualCompare)
        : { pixel_diff_ratio: 0, pixel_diff_pixel_count: 0, pixel_count: 0, diff_artifact: '' };
      if (visualCompare) {
        const comparison = visualCompare.summary.comparison || {};
        result.pixel_diffs.source_vs_frontend_diagnostic = {
          diff_path: result.pixel_diff?.diff_artifact || '',
          height: 0,
          mismatched_pixels: Number(comparison.mismatchPixels || 0),
          pixel_count: Number(comparison.totalPixels || 0),
          ratio: Number(comparison.mismatchRatio || 0),
          width: 0,
        };
      }

      result.parity = visualParity(
        result.surfaces.source_static?.probes || [],
        result.surfaces.wordpress_frontend?.probes || []
      );
      const { mismatches, optionalProbeAbsences } = visualSelectorComparisonDetails(result);
      result.diagnostics = {
        mismatch_count: mismatches.length,
        optional_probe_absent_count: optionalProbeAbsences.length,
        top_failing_groups: [],
        mismatches,
        optional_probe_absences: optionalProbeAbsences,
      };
      results.push(result);
    }
  } catch (error) {
    return emptyVisualComparison(artifactDir, `Visual comparison failed: ${error instanceof Error ? error.message : String(error)}`);
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
      summary.visual_editor_vs_source_pixel_diff_ratio = Math.max(
        summary.visual_editor_vs_source_pixel_diff_ratio,
        Number(result.pixel_diffs?.editor_vs_source?.ratio || 0)
      );
      summary.visual_editor_vs_frontend_pixel_diff_ratio = Math.max(
        summary.visual_editor_vs_frontend_pixel_diff_ratio,
        Number(result.pixel_diffs?.editor_vs_frontend?.ratio || 0)
      );
      summary.visual_source_vs_frontend_pixel_diff_ratio_diagnostic = Math.max(
        summary.visual_source_vs_frontend_pixel_diff_ratio_diagnostic,
        Number(result.pixel_diffs?.source_vs_frontend_diagnostic?.ratio || 0)
      );
      if (!result.pixel_diffs?.editor_vs_source) {
        summary.visual_editor_parity_error_count++;
      }
      if (!result.pixel_diffs?.editor_vs_frontend) {
        summary.visual_editor_parity_error_count++;
      }
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
      summary.pixel_diff_pixel_count += Number(result.pixel_diff?.pixel_diff_pixel_count || 0);
      summary.pixel_count += Number(result.pixel_diff?.pixel_count || 0);
      const pixelDiffRatio = Number(result.pixel_diff?.pixel_diff_ratio || 0);
      if (pixelDiffRatio > summary.pixel_diff_ratio) {
        summary.pixel_diff_ratio = pixelDiffRatio;
        summary.pixel_diff_artifact = result.pixel_diff?.diff_artifact || '';
      }
      return summary;
    },
    {
      target_count: targets.length,
      checked_target_count: 0,
      error_count: 0,
      visual_editor_vs_source_pixel_diff_ratio: 0,
      visual_editor_vs_frontend_pixel_diff_ratio: 0,
      visual_source_vs_frontend_pixel_diff_ratio_diagnostic: 0,
      visual_editor_parity_error_count: 0,
      missing_selector_count: 0,
      visibility_mismatch_count: 0,
      nonzero_bounding_box_count: 0,
      nonzero_bounding_box_mismatch_count: 0,
      simple_probe_parity_mismatch_count: 0,
      nav_probe_parity_mismatch_count: 0,
      footer_probe_parity_mismatch_count: 0,
      hero_probe_parity_mismatch_count: 0,
      pixel_diff_ratio: 0,
      pixel_diff_pixel_count: 0,
      pixel_count: 0,
      pixel_diff_artifact: '',
    }
  );
  const diagnosticsPath = path.join(visualDir, 'visual-comparison-mismatches.json');
  const diagnostics = buildVisualDiagnostics(results, diagnosticsPath);
  await writeFile(diagnosticsPath, JSON.stringify(diagnostics, null, 2));

  return {
    ...totals,
    surfaces: ['source_static', 'wordpress_frontend', 'wordpress_editor'],
    editor_surface_ready: true,
    artifact_dir: visualDir,
    diagnostics_artifact: diagnosticsPath,
    diagnostics,
    results,
  };
}
