import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

import { STUDIO_PATH } from './studio-bench.mjs';

const requireFromBench = createRequire(import.meta.url);
export const VISUAL_VIEWPORT = { width: 1440, height: 1100 };
const VISUAL_SCREENSHOT_DIAGNOSTIC_LIMIT = 5;

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function stringArray(value) {
  return asArray(value).filter((item) => typeof item === 'string' && item.trim() !== '');
}

function safeSlug(value, fallback) {
  const slug = String(value || fallback || 'target')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return slug || 'target';
}

function comparisonTargets(importReport) {
  return asArray(importReport?.report?.visual_fidelity?.comparison_targets).filter(
    (target) => target && typeof target === 'object'
  );
}

function resolveSourceStaticFile(sourceFile, reportPath, sitePath) {
  if (!sourceFile) {
    return '';
  }

  if (path.isAbsolute(sourceFile)) {
    const wordpressRoot = '/wordpress';
    if (sitePath && (sourceFile === wordpressRoot || sourceFile.startsWith(`${wordpressRoot}/`))) {
      return path.join(sitePath, sourceFile.slice(wordpressRoot.length));
    }

    return sourceFile;
  }

  return path.resolve(path.dirname(reportPath), sourceFile);
}

function surfaceUrl(target, surface, reportPath, sitePath) {
  const surfaces = target?.comparison_hooks?.render_surfaces || {};
  const configured = surfaces[surface]?.url || '';
  if (surface === 'source_static') {
    const sourceFile = configured || target?.source_file || '';
    if (!sourceFile) {
      return '';
    }
    const absoluteSource = resolveSourceStaticFile(sourceFile, reportPath, sitePath);
    return pathToFileURL(absoluteSource).toString();
  }

  if (surface === 'wordpress_frontend') {
    return configured || target?.wordpress_url || '';
  }

  return configured;
}

function visualProbeGroups(target) {
  const hooks = target?.comparison_hooks || {};
  const layoutProbes = hooks.layout_probes && typeof hooks.layout_probes === 'object' ? hooks.layout_probes : {};
  const groups = [];
  const seen = new Set();

  function add(name, selectors) {
    const normalizedSelectors = stringArray(selectors);
    if (!normalizedSelectors.length || seen.has(name)) {
      return;
    }
    seen.add(name);
    groups.push({ name, selectors: normalizedSelectors });
  }

  for (const [name, probe] of Object.entries(layoutProbes)) {
    add(name, probe?.selectors);
  }

  add('hero_probe', hooks.hero);
  add('visible_chrome', hooks.visible_chrome);
  add('footer_chrome', ['footer', '.site-footer', '[class*=footer]']);

  return groups;
}

export async function loadVisualSurface(page, url) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  await page.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => {});
  await page.waitForTimeout(300);
}

async function evaluateVisualSurface(page, groups) {
  const evaluatedGroups = [];

  for (const group of groups) {
    const selectors = [];

    for (const selector of group.selectors) {
      try {
        const matches = await page.$$eval(selector, (elements) =>
          elements.map((element) => {
            const rect = element.getBoundingClientRect();
            const style = window.getComputedStyle(element);
            const visible =
              rect.width > 0 &&
              rect.height > 0 &&
              style.display !== 'none' &&
              style.visibility !== 'hidden' &&
              Number(style.opacity || '1') > 0;

            return {
              visible,
              boundingBox: {
                x: Math.round(rect.x),
                y: Math.round(rect.y),
                width: Math.round(rect.width),
                height: Math.round(rect.height),
              },
              text: String(element.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 160),
            };
          })
        );
        selectors.push({
          selector,
          count: matches.length,
          visible_count: matches.filter((match) => match.visible).length,
          nonzero_bounding_box_count: matches.filter(
            (match) => match.boundingBox.width > 0 && match.boundingBox.height > 0
          ).length,
          first_match: matches[0] || null,
        });
      } catch (error) {
        selectors.push({
          selector,
          count: 0,
          visible_count: 0,
          nonzero_bounding_box_count: 0,
          error: error instanceof Error ? error.message : String(error),
          first_match: null,
        });
      }
    }

    evaluatedGroups.push({
      name: group.name,
      selectors,
      selector_count: selectors.length,
      missing_selector_count: selectors.filter((item) => item.count === 0).length,
      errored_selector_count: selectors.filter((item) => item.error).length,
      matched_selector_count: selectors.filter((item) => item.count > 0).length,
      visible_selector_count: selectors.filter((item) => item.visible_count > 0).length,
      nonzero_bounding_box_selector_count: selectors.filter((item) => item.nonzero_bounding_box_count > 0).length,
    });
  }

  return evaluatedGroups;
}

function visualSurfaceTotals(groups) {
  return groups.reduce(
    (totals, group) => {
      totals.selector_count += group.selector_count;
      totals.missing_selector_count += group.missing_selector_count;
      totals.errored_selector_count += group.errored_selector_count;
      totals.matched_selector_count += group.matched_selector_count;
      totals.visible_selector_count += group.visible_selector_count;
      totals.nonzero_bounding_box_selector_count += group.nonzero_bounding_box_selector_count;
      return totals;
    },
    {
      selector_count: 0,
      missing_selector_count: 0,
      errored_selector_count: 0,
      matched_selector_count: 0,
      visible_selector_count: 0,
      nonzero_bounding_box_selector_count: 0,
    }
  );
}

function visualSelectorSummary(selector) {
  const firstMatch = selector?.first_match || null;
  return {
    count: Number(selector?.count || 0),
    visible_count: Number(selector?.visible_count || 0),
    nonzero_bounding_box_count: Number(selector?.nonzero_bounding_box_count || 0),
    first_bounding_box: firstMatch?.boundingBox || null,
    first_visible: firstMatch?.visible === true,
    first_visible_text: firstMatch?.text || '',
    error: selector?.error || '',
  };
}

function visualMismatchReason(sourceSelector, frontendSelector) {
  if (sourceSelector?.error || frontendSelector?.error) {
    return 'selector_error';
  }
  if (sourceSelector.visible_count === 0 && frontendSelector.visible_count === 0) {
    return 'missing_on_both_surfaces';
  }
  if (sourceSelector.count === 0 && frontendSelector.count === 0) {
    return 'missing_on_both_surfaces';
  }
  if (sourceSelector.count === 0) {
    return 'missing_from_source_static';
  }
  if (frontendSelector.count === 0) {
    return 'missing_from_wordpress_frontend';
  }

  const sourceVisible = sourceSelector.visible_count > 0;
  const frontendVisible = frontendSelector.visible_count > 0;
  if (sourceVisible !== frontendVisible) {
    return sourceVisible ? 'hidden_on_wordpress_frontend' : 'hidden_on_source_static';
  }

  const sourceNonzero = sourceSelector.nonzero_bounding_box_count > 0;
  const frontendNonzero = frontendSelector.nonzero_bounding_box_count > 0;
  if (sourceNonzero !== frontendNonzero) {
    return sourceNonzero ? 'zero_sized_on_wordpress_frontend' : 'zero_sized_on_source_static';
  }

  return '';
}

function visualMismatchSeverity(reason) {
  const severities = {
    selector_error: 100,
    missing_from_wordpress_frontend: 90,
    missing_from_source_static: 80,
    hidden_on_wordpress_frontend: 60,
    hidden_on_source_static: 50,
    zero_sized_on_wordpress_frontend: 40,
    zero_sized_on_source_static: 30,
  };
  return severities[reason] || 0;
}

function visualGroupMismatchSummary(groupName, mismatches) {
  const reasons = {};
  for (const mismatch of mismatches) {
    reasons[mismatch.reason] = (reasons[mismatch.reason] || 0) + 1;
  }
  return {
    group: groupName,
    mismatch_count: mismatches.length,
    reasons,
    top_selectors: mismatches.slice(0, 5).map((mismatch) => ({
      selector: mismatch.selector,
      reason: mismatch.reason,
      source_count: mismatch.source.count,
      frontend_count: mismatch.frontend.count,
      source_visible_count: mismatch.source.visible_count,
      frontend_visible_count: mismatch.frontend.visible_count,
    })),
  };
}

function visualSelectorComparisonDetail(sourceGroup, sourceSelector, frontendSelector, reason) {
  return {
    group: sourceGroup.name,
    selector: sourceSelector.selector,
    reason,
    severity: visualMismatchSeverity(reason),
    source: visualSelectorSummary(sourceSelector),
    frontend: visualSelectorSummary(frontendSelector),
    screenshots: {},
  };
}

function visualSelectorComparisonDetails(result) {
  const sourceGroups = result.surfaces.source_static?.probes || [];
  const frontendGroups = result.surfaces.wordpress_frontend?.probes || [];
  const frontendGroupsByName = new Map(frontendGroups.map((group) => [group.name, group]));
  const mismatches = [];
  const optionalProbeAbsences = [];

  for (const sourceGroup of sourceGroups) {
    const frontendGroup = frontendGroupsByName.get(sourceGroup.name);
    if (!frontendGroup) {
      continue;
    }

    const frontendSelectors = new Map(frontendGroup.selectors.map((selector) => [selector.selector, selector]));
    for (const sourceSelector of sourceGroup.selectors) {
      const frontendSelector = frontendSelectors.get(sourceSelector.selector);
      if (!frontendSelector) {
        continue;
      }

      const reason = visualMismatchReason(sourceSelector, frontendSelector);
      if (!reason) {
        continue;
      }

      const detail = visualSelectorComparisonDetail(sourceGroup, sourceSelector, frontendSelector, reason);
      if (reason === 'missing_on_both_surfaces') {
        optionalProbeAbsences.push(detail);
        continue;
      }

      mismatches.push(detail);
    }
  }

  mismatches.sort(
    (a, b) => b.severity - a.severity || a.group.localeCompare(b.group) || a.selector.localeCompare(b.selector)
  );
  optionalProbeAbsences.sort((a, b) => a.group.localeCompare(b.group) || a.selector.localeCompare(b.selector));
  return { mismatches, optionalProbeAbsences };
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

function buildVisualDiagnostics(results, artifactPath) {
  const targetSummaries = [];
  const allMismatches = [];
  const allOptionalProbeAbsences = [];

  for (const result of results) {
    const mismatches = asArray(result.diagnostics?.mismatches);
    const optionalProbeAbsences = asArray(result.diagnostics?.optional_probe_absences);
    const byGroup = new Map();

    for (const mismatch of mismatches) {
      if (!byGroup.has(mismatch.group)) {
        byGroup.set(mismatch.group, []);
      }
      byGroup.get(mismatch.group).push(mismatch);
      allMismatches.push({
        target: result.source_filename || String(result.wordpress_page_id || ''),
        ...mismatch,
      });
    }

    for (const absence of optionalProbeAbsences) {
      allOptionalProbeAbsences.push({
        target: result.source_filename || String(result.wordpress_page_id || ''),
        ...absence,
      });
    }

    targetSummaries.push({
      source_filename: result.source_filename || '',
      wordpress_page_id: result.wordpress_page_id || null,
      mismatch_count: mismatches.length,
      optional_probe_absent_count: optionalProbeAbsences.length,
      top_failing_groups: [...byGroup.entries()]
        .map(([groupName, groupMismatches]) => visualGroupMismatchSummary(groupName, groupMismatches))
        .sort((a, b) => b.mismatch_count - a.mismatch_count || a.group.localeCompare(b.group))
        .slice(0, 5),
      top_failing_selectors: mismatches.slice(0, 10).map((mismatch) => ({
        group: mismatch.group,
        selector: mismatch.selector,
        reason: mismatch.reason,
        source_count: mismatch.source.count,
        frontend_count: mismatch.frontend.count,
        source_first_bounding_box: mismatch.source.first_bounding_box,
        frontend_first_bounding_box: mismatch.frontend.first_bounding_box,
        source_first_visible_text: mismatch.source.first_visible_text,
        frontend_first_visible_text: mismatch.frontend.first_visible_text,
        screenshots: mismatch.screenshots,
      })),
    });
  }

  const topFailingGroups = new Map();
  for (const mismatch of allMismatches) {
    const key = `${mismatch.target || 'target'}:${mismatch.group}`;
    if (!topFailingGroups.has(key)) {
      topFailingGroups.set(key, []);
    }
    topFailingGroups.get(key).push(mismatch);
  }

  return {
    artifact: artifactPath,
    mismatch_count: allMismatches.length,
    optional_probe_absent_count: allOptionalProbeAbsences.length,
    top_failing_groups: [...topFailingGroups.entries()]
      .map(([, mismatches]) => ({
        target: mismatches[0]?.target || '',
        ...visualGroupMismatchSummary(mismatches[0]?.group || '', mismatches),
      }))
      .sort((a, b) => b.mismatch_count - a.mismatch_count || a.group.localeCompare(b.group))
      .slice(0, 10),
    targets: targetSummaries,
    mismatches: allMismatches,
    optional_probe_absences: allOptionalProbeAbsences,
  };
}

function visualParity(sourceGroups, frontendGroups) {
  const frontendByName = new Map(frontendGroups.map((group) => [group.name, group]));
  const groupComparisons = [];
  let missingSelectorCount = 0;
  let visibilityMismatchCount = 0;
  let nonzeroBoundingBoxMismatchCount = 0;
  let simpleProbeParityMismatchCount = 0;
  const simpleProbeFamilies = {
    nav: new Set(['nav_chrome']),
    footer: new Set(['footer_chrome']),
    hero: new Set(['hero_region', 'hero_probe']),
  };
  const simpleProbeNames = new Set(Object.values(simpleProbeFamilies).flatMap((names) => [...names]));
  const simpleProbeMismatches = { nav: 0, footer: 0, hero: 0 };

  for (const sourceGroup of sourceGroups) {
    const frontendGroup = frontendByName.get(sourceGroup.name);
    if (!frontendGroup) {
      continue;
    }

    const frontendSelectors = new Map(frontendGroup.selectors.map((selector) => [selector.selector, selector]));
    for (const sourceSelector of sourceGroup.selectors) {
      const frontendSelector = frontendSelectors.get(sourceSelector.selector);
      if (!frontendSelector) {
        continue;
      }

      const sourceVisible = sourceSelector.visible_count > 0;
      const frontendVisible = frontendSelector.visible_count > 0;
      const sourceNonzero = sourceSelector.nonzero_bounding_box_count > 0;
      const frontendNonzero = frontendSelector.nonzero_bounding_box_count > 0;

      if (sourceSelector.count === 0 || frontendSelector.count === 0) {
        missingSelectorCount++;
      }
      if (sourceVisible !== frontendVisible) {
        visibilityMismatchCount++;
      }
      if (sourceNonzero !== frontendNonzero) {
        nonzeroBoundingBoxMismatchCount++;
      }
    }

    const sourceGroupVisible = sourceGroup.visible_selector_count > 0;
    const frontendGroupVisible = frontendGroup.visible_selector_count > 0;
    const simpleProbeMismatch = simpleProbeNames.has(sourceGroup.name) && sourceGroupVisible !== frontendGroupVisible;
    if (simpleProbeMismatch) {
      simpleProbeParityMismatchCount++;
      for (const [family, names] of Object.entries(simpleProbeFamilies)) {
        if (names.has(sourceGroup.name)) {
          simpleProbeMismatches[family]++;
        }
      }
    }

    groupComparisons.push({
      name: sourceGroup.name,
      source_visible: sourceGroupVisible,
      frontend_visible: frontendGroupVisible,
      source_nonzero_bounding_box: sourceGroup.nonzero_bounding_box_selector_count > 0,
      frontend_nonzero_bounding_box: frontendGroup.nonzero_bounding_box_selector_count > 0,
      simple_probe_parity: simpleProbeNames.has(sourceGroup.name) ? !simpleProbeMismatch : null,
    });
  }

  return {
    missing_selector_count: missingSelectorCount,
    visibility_mismatch_count: visibilityMismatchCount,
    nonzero_bounding_box_mismatch_count: nonzeroBoundingBoxMismatchCount,
    simple_probe_parity_mismatch_count: simpleProbeParityMismatchCount,
    simple_probe_mismatches: simpleProbeMismatches,
    groups: groupComparisons,
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
    missing_selector_count: 0,
    visibility_mismatch_count: 0,
    nonzero_bounding_box_count: 0,
    nonzero_bounding_box_mismatch_count: 0,
    simple_probe_parity_mismatch_count: 0,
    nav_probe_parity_mismatch_count: 0,
    footer_probe_parity_mismatch_count: 0,
    hero_probe_parity_mismatch_count: 0,
    surfaces: ['source_static', 'wordpress_frontend'],
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
      return summary;
    },
    {
      target_count: targets.length,
      checked_target_count: 0,
      error_count: 0,
      missing_selector_count: 0,
      visibility_mismatch_count: 0,
      nonzero_bounding_box_count: 0,
      nonzero_bounding_box_mismatch_count: 0,
      simple_probe_parity_mismatch_count: 0,
      nav_probe_parity_mismatch_count: 0,
      footer_probe_parity_mismatch_count: 0,
      hero_probe_parity_mismatch_count: 0,
    }
  );
  const diagnosticsPath = path.join(visualDir, 'visual-comparison-mismatches.json');
  const diagnostics = buildVisualDiagnostics(results, diagnosticsPath);
  await writeFile(diagnosticsPath, JSON.stringify(diagnostics, null, 2));

  return {
    ...totals,
    surfaces: ['source_static', 'wordpress_frontend'],
    editor_surface_ready: true,
    artifact_dir: visualDir,
    diagnostics_artifact: diagnosticsPath,
    diagnostics,
    results,
  };
}
