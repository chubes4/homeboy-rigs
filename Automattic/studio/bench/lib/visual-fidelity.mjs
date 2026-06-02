import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import zlib from 'node:zlib';

import { STUDIO_PATH } from './studio-bench.mjs';
import { asArray, comparisonTargets, safeSlug, stringArray, surfaceUrl } from './fidelity-targets.mjs';
import { loadWordPressLibHelper } from './wordpress-helper-discovery.mjs';

const requireFromBench = createRequire(import.meta.url);
export const VISUAL_VIEWPORT = { width: 1440, height: 1100 };
const VISUAL_SCREENSHOT_DIAGNOSTIC_LIMIT = 5;
const VISUAL_PIXELMATCH_THRESHOLD = 0.1;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

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

function crc32(buffer) {
  if (!crc32.table) {
    crc32.table = Array.from({ length: 256 }, (_, index) => {
      let value = index;
      for (let bit = 0; bit < 8; bit++) {
        value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
      }
      return value >>> 0;
    });
  }

  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = crc32.table[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data = Buffer.alloc(0)) {
  const typeBuffer = Buffer.from(type, 'ascii');
  const chunk = Buffer.concat([typeBuffer, data]);
  const output = Buffer.alloc(12 + data.length);
  output.writeUInt32BE(data.length, 0);
  typeBuffer.copy(output, 4);
  data.copy(output, 8);
  output.writeUInt32BE(crc32(chunk), 8 + data.length);
  return output;
}

function decodePng(buffer) {
  if (!buffer.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    throw new Error('Unsupported PNG signature.');
  }

  let offset = PNG_SIGNATURE.length;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  const idat = [];

  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    offset += 12 + length;

    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
  }

  if (bitDepth !== 8 || ![0, 2, 4, 6].includes(colorType)) {
    throw new Error(`Unsupported PNG format: bitDepth=${bitDepth} colorType=${colorType}.`);
  }

  const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[colorType];
  const bytesPerPixel = channels;
  const stride = width * channels;
  const inflated = zlib.inflateSync(Buffer.concat(idat));
  const data = new Uint8ClampedArray(width * height * 4);
  let inputOffset = 0;
  let previous = Buffer.alloc(stride);

  for (let y = 0; y < height; y++) {
    const filter = inflated[inputOffset++];
    const row = Buffer.from(inflated.subarray(inputOffset, inputOffset + stride));
    inputOffset += stride;

    for (let x = 0; x < stride; x++) {
      const left = x >= bytesPerPixel ? row[x - bytesPerPixel] : 0;
      const up = previous[x] || 0;
      const upperLeft = x >= bytesPerPixel ? previous[x - bytesPerPixel] || 0 : 0;
      let value = row[x];

      if (filter === 1) {
        value += left;
      } else if (filter === 2) {
        value += up;
      } else if (filter === 3) {
        value += Math.floor((left + up) / 2);
      } else if (filter === 4) {
        const p = left + up - upperLeft;
        const pa = Math.abs(p - left);
        const pb = Math.abs(p - up);
        const pc = Math.abs(p - upperLeft);
        value += pa <= pb && pa <= pc ? left : pb <= pc ? up : upperLeft;
      } else if (filter !== 0) {
        throw new Error(`Unsupported PNG row filter: ${filter}.`);
      }

      row[x] = value & 0xff;
    }

    for (let x = 0; x < width; x++) {
      const source = x * channels;
      const target = (y * width + x) * 4;
      if (colorType === 0) {
        data[target] = row[source];
        data[target + 1] = row[source];
        data[target + 2] = row[source];
        data[target + 3] = 255;
      } else if (colorType === 2) {
        data[target] = row[source];
        data[target + 1] = row[source + 1];
        data[target + 2] = row[source + 2];
        data[target + 3] = 255;
      } else if (colorType === 4) {
        data[target] = row[source];
        data[target + 1] = row[source];
        data[target + 2] = row[source];
        data[target + 3] = row[source + 1];
      } else {
        data[target] = row[source];
        data[target + 1] = row[source + 1];
        data[target + 2] = row[source + 2];
        data[target + 3] = row[source + 3];
      }
    }

    previous = row;
  }

  return { width, height, data };
}

function encodePng({ width, height, data }) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;

  const rows = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    const rowOffset = y * (width * 4 + 1);
    rows[rowOffset] = 0;
    Buffer.from(data.buffer, data.byteOffset + y * width * 4, width * 4).copy(rows, rowOffset + 1);
  }

  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk('IHDR', header),
    pngChunk('IDAT', zlib.deflateSync(rows)),
    pngChunk('IEND'),
  ]);
}

function normalizePng(image, width, height) {
  if (image.width === width && image.height === height) {
    return image.data;
  }

  const normalized = new Uint8ClampedArray(width * height * 4);
  normalized.fill(255);
  for (let y = 0; y < image.height; y++) {
    for (let x = 0; x < image.width; x++) {
      const source = (y * image.width + x) * 4;
      const target = (y * width + x) * 4;
      normalized[target] = image.data[source];
      normalized[target + 1] = image.data[source + 1];
      normalized[target + 2] = image.data[source + 2];
      normalized[target + 3] = image.data[source + 3];
    }
  }
  return normalized;
}

function comparePixels(sourceData, targetData, diffData) {
  let mismatched = 0;
  for (let index = 0; index < sourceData.length; index += 4) {
    const delta = Math.max(
      Math.abs(sourceData[index] - targetData[index]),
      Math.abs(sourceData[index + 1] - targetData[index + 1]),
      Math.abs(sourceData[index + 2] - targetData[index + 2]),
      Math.abs(sourceData[index + 3] - targetData[index + 3])
    );

    if (delta > 26) {
      mismatched++;
      diffData[index] = 255;
      diffData[index + 1] = 0;
      diffData[index + 2] = 0;
      diffData[index + 3] = 255;
    } else {
      const gray = Math.round((sourceData[index] + sourceData[index + 1] + sourceData[index + 2]) / 3);
      diffData[index] = gray;
      diffData[index + 1] = gray;
      diffData[index + 2] = gray;
      diffData[index + 3] = 80;
    }
  }
  return mismatched;
}

async function comparePngScreenshots(sourcePath, targetPath, diffPath) {
  const sourceImage = decodePng(await readFile(sourcePath));
  const targetImage = decodePng(await readFile(targetPath));
  const width = Math.max(sourceImage.width, targetImage.width);
  const height = Math.max(sourceImage.height, targetImage.height);
  const sourceData = normalizePng(sourceImage, width, height);
  const targetData = normalizePng(targetImage, width, height);
  const diffData = new Uint8ClampedArray(width * height * 4);
  const mismatchedPixels = comparePixels(sourceData, targetData, diffData);

  await writeFile(diffPath, encodePng({ width, height, data: diffData }));
  return {
    diff_path: diffPath,
    height,
    mismatched_pixels: mismatchedPixels,
    pixel_count: width * height,
    ratio: width > 0 && height > 0 ? mismatchedPixels / (width * height) : 1,
    width,
  };
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
