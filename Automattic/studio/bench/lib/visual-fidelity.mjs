import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';

import { STUDIO_PATH } from './studio-bench.mjs';
import { loadWordPressLibHelper } from './wordpress-helper-discovery.mjs';

const requireFromBench = createRequire(import.meta.url);
export const VISUAL_VIEWPORT = { width: 1440, height: 1100 };
const VISUAL_SCREENSHOT_DIAGNOSTIC_LIMIT = 5;
const VISUAL_PIXELMATCH_THRESHOLD = 0.1;
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

export async function loadVisualSurface(page, url) {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  await page.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => {});
  await page.waitForTimeout(300);
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

async function evaluateVisualSurface(page, groups) {
  return loadEditorCanvasProbes().summarizeVisibleSelectors(page, groups).then((summary) => summary.groups);
}

function visualSurfaceTotals(groups) {
  return loadFidelityComparisonHelper().visualSurfaceTotals(groups);
}

function visualSelectorComparisonDetails(result) {
  return loadFidelityComparisonHelper().visualSelectorComparisonDetails(result);
}

async function captureSelectorScreenshot(page, selector, screenshotPath) {
  try {
    const locator = page.locator(selector).first();
    if ((await locator.count()) === 0) {
      return '';
    }
    await locator.screenshot({ path: screenshotPath, timeout: 5_000 });
    return screenshotPath;
  } catch {
    return '';
  }
}

async function comparePngScreenshots(sourcePath, targetPath, diffPath) {
  return loadFidelityComparisonHelper().comparePngScreenshots(sourcePath, targetPath, diffPath);
}

async function captureVisualMismatchScreenshots(browser, result, mismatches, visualDir, targetSlug) {
  if (!mismatches.length) {
    return;
  }

  const screenshotsDir = path.join(visualDir, 'mismatch-screenshots');
  const urls = {
    source_static: result.surfaces.source_static?.url || '',
    wordpress_frontend: result.surfaces.wordpress_frontend?.url || '',
  };
  const pages = {};

  try {
    await mkdir(screenshotsDir, { recursive: true });
    for (const [surface, url] of Object.entries(urls)) {
      if (!url) {
        continue;
      }
      const page = await browser.newPage({ ignoreHTTPSErrors: true, viewport: VISUAL_VIEWPORT });
      await loadVisualSurface(page, url);
      pages[surface] = page;
    }

    for (const [index, mismatch] of mismatches.slice(0, VISUAL_SCREENSHOT_DIAGNOSTIC_LIMIT).entries()) {
      const screenshotSlug = safeSlug(
        `${targetSlug}-${index + 1}-${mismatch.group}-${mismatch.selector}`,
        `mismatch-${index + 1}`
      );
      for (const [surface, page] of Object.entries(pages)) {
        const screenshotPath = path.join(screenshotsDir, `${screenshotSlug}-${surface}.png`);
        const capturedPath = await captureSelectorScreenshot(page, mismatch.selector, screenshotPath);
        if (capturedPath) {
          mismatch.screenshots[surface] = capturedPath;
        }
      }
    }
  } catch (error) {
    result.diagnostic_warnings = [
      ...(result.diagnostic_warnings || []),
      `mismatch screenshots: ${error instanceof Error ? error.message : String(error)}`,
    ];
  } finally {
    await Promise.all(Object.values(pages).map((page) => page.close().catch(() => {})));
  }
}

function loadPixelDiffDependencies() {
  const playwrightCorePath = path.join(STUDIO_PATH, 'node_modules/playwright-core');
  const pixelmatch = requireFromBench(path.join(playwrightCorePath, 'lib/third_party/pixelmatch'));
  const { PNG } = requireFromBench(path.join(playwrightCorePath, 'lib/utilsBundle'));
  return { pixelmatch, PNG };
}

function padPngToSize(image, width, height, PNG) {
  if (image.width === width && image.height === height) {
    return image;
  }

  const padded = new PNG({ width, height });
  padded.data.fill(255);
  for (let y = 0; y < image.height; y++) {
    for (let x = 0; x < image.width; x++) {
      const sourceOffset = (y * image.width + x) * 4;
      const targetOffset = (y * width + x) * 4;
      image.data.copy(padded.data, targetOffset, sourceOffset, sourceOffset + 4);
    }
  }
  return padded;
}

async function compareVisualScreenshots(sourcePath, frontendPath, diffPath) {
  if (!sourcePath || !frontendPath) {
    return { pixel_diff_ratio: 0, pixel_diff_pixel_count: 0, pixel_count: 0, diff_artifact: '' };
  }

  const { pixelmatch, PNG } = loadPixelDiffDependencies();
  const source = PNG.sync.read(await readFile(sourcePath));
  const frontend = PNG.sync.read(await readFile(frontendPath));
  const width = Math.max(source.width, frontend.width);
  const height = Math.max(source.height, frontend.height);
  const sourcePixelCount = source.width * source.height;
  const sourcePadded = padPngToSize(source, width, height, PNG);
  const frontendPadded = padPngToSize(frontend, width, height, PNG);
  const diff = new PNG({ width, height });
  const pixelDiffCount = pixelmatch(sourcePadded.data, frontendPadded.data, diff.data, width, height, {
    threshold: VISUAL_PIXELMATCH_THRESHOLD,
  });

  await writeFile(diffPath, PNG.sync.write(diff));
  return {
    pixel_diff_ratio: sourcePixelCount > 0 ? pixelDiffCount / sourcePixelCount : 0,
    pixel_diff_pixel_count: pixelDiffCount,
    pixel_count: sourcePixelCount,
    diff_artifact: diffPath,
  };
}

function buildVisualDiagnostics(results, artifactPath) {
  return loadFidelityComparisonHelper().buildVisualDiagnostics(results, artifactPath);
}

function visualParity(sourceGroups, frontendGroups) {
  return loadFidelityComparisonHelper().visualParity(sourceGroups, frontendGroups);
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

      for (const surface of ['source_static', 'wordpress_frontend']) {
        const url = surfaceUrl(target, surface, importReport.reportPath, sitePath);
        const screenshotPath = path.join(visualDir, `${targetSlug}-${surface}.png`);
        const page = await browser.newPage({ ignoreHTTPSErrors: true, viewport: VISUAL_VIEWPORT });

        try {
          if (!url) {
            throw new Error(`Missing ${surface} render URL.`);
          }
          await loadVisualSurface(page, url);
          const probeGroups = await evaluateVisualSurface(page, groups);
          await page.screenshot({ path: screenshotPath, fullPage: true });
          result.surfaces[surface] = {
            url,
            screenshot: screenshotPath,
            probes: probeGroups,
            totals: visualSurfaceTotals(probeGroups),
          };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          result.errors.push(`${surface}: ${message}`);
          result.surfaces[surface] = { url, screenshot: '', probes: [], totals: visualSurfaceTotals([]), error: message };
        } finally {
          await page.close();
        }
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
      if (sourceScreenshot && frontendScreenshot) {
        result.pixel_diffs.source_vs_frontend_diagnostic = await comparePngScreenshots(
          sourceScreenshot,
          frontendScreenshot,
          path.join(visualDir, `${targetSlug}-source_static-vs-wordpress_frontend-diagnostic-diff.png`)
        );
      }

      result.parity = visualParity(
        result.surfaces.source_static?.probes || [],
        result.surfaces.wordpress_frontend?.probes || []
      );
      const pixelDiffPath = path.join(visualDir, `${targetSlug}-pixel-diff.png`);
      try {
        result.pixel_diff = await compareVisualScreenshots(
          result.surfaces.source_static?.screenshot || '',
          result.surfaces.wordpress_frontend?.screenshot || '',
          pixelDiffPath
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        result.errors.push(`pixel_diff: ${message}`);
        result.pixel_diff = {
          pixel_diff_ratio: 0,
          pixel_diff_pixel_count: 0,
          pixel_count: 0,
          diff_artifact: '',
          error: message,
        };
      }
      const { mismatches, optionalProbeAbsences } = visualSelectorComparisonDetails(result);
      result.diagnostics = {
        mismatch_count: mismatches.length,
        optional_probe_absent_count: optionalProbeAbsences.length,
        top_failing_groups: [],
        mismatches,
        optional_probe_absences: optionalProbeAbsences,
      };
      await captureVisualMismatchScreenshots(browser, result, mismatches, visualDir, targetSlug);
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
