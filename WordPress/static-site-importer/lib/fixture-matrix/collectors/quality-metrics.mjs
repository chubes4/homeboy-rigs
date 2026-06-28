// Editor-quality metrics (#541): block-composition extraction, per-fixture and
// aggregate native-conversion scoring, and the opt-in native-rate gate for the
// Static Site Importer fixture matrix.
//
// Extracted verbatim from the former `lib/fixture-matrix.mjs` monolith as part
// of the matrix modularization (Refs #242).

import {
  NATIVE_BLOCK_NAMESPACES,
  CORE_HTML_BLOCK_NAME,
  NON_NATIVE_FALLBACK_BLOCK_NAMES,
  LOW_NATIVE_CONVERSION_KIND,
  EDITOR_BLOCK_INVALID_KIND,
} from '../shared/constants.mjs';
import {
  objectValue,
  numberValue,
  firstNumber,
  compactObject,
  qualityRatio,
} from '../shared/utils.mjs';
import { normalizeDiagnosticFinding } from '../findings.mjs';

export function collectQualityMetrics(payload) {
  return compactObject({
    ...(payload.quality_metrics || payload.qualityMetrics || {}),
    ...(payload.quality || {}),
    ...(payload.import_report?.report?.quality || payload.importReport?.report?.quality || payload.report?.quality || {}),
  });
}

// Surface the transformer's generic block-composition breakdown from whatever
// import-artifact slot carries it (a `block_type_counts` / `detectBlockTypes`
// map, or the nested conversion-report copy SSI preserves). Returns a normalized
// `{ block_total, native_block_count, core_html_block_count, block_type_counts,
// source }` shape, or null when no block-composition data is present (never
// fabricated). When an explicit per-block-type breakdown is unavailable but
// total/fallback counts are, it derives the composition from those counts.
export function collectBlockComposition(payload) {
  const breakdown = collectBlockTypeBreakdown(payload);
  if (breakdown && breakdown.total > 0) {
    return {
      block_total: breakdown.total,
      native_block_count: breakdown.native,
      core_html_block_count: breakdown.core_html,
      block_type_counts: breakdown.counts,
      source: 'block_type_breakdown',
    };
  }
  return blockCompositionFromQualityCounts(payload);
}

function collectBlockTypeBreakdown(payload) {
  for (const source of blockTypeBreakdownSources(payload)) {
    const counts = normalizeBlockTypeCounts(source);
    if (counts) {
      return summarizeBlockTypeCounts(counts);
    }
  }
  return null;
}

function blockTypeBreakdownSources(payload) {
  const object = objectValue(payload);
  const quality = collectQualityMetrics(object);
  const importReport = objectValue(object.import_report || object.importReport || object.report);
  const blocksEngine = objectValue(importReport.blocks_engine || importReport.blocksEngine || object.blocks_engine || object.blocksEngine);
  const conversionReport = objectValue(blocksEngine.conversion_report || blocksEngine.conversionReport);
  return [
    object.block_type_counts,
    object.blockTypeCounts,
    object.block_types,
    object.blockTypes,
    object.detected_block_types,
    object.detectedBlockTypes,
    object.detect_block_types,
    quality.block_type_counts,
    quality.blockTypeCounts,
    conversionReport.block_type_counts,
    conversionReport.blockTypeCounts,
    conversionReport.block_types,
    conversionReport.blockTypes,
  ];
}

// Normalize any block-type breakdown — a `{ name: count }` map, a list of block
// names, or a list of `{ name, count }`-shaped rows — into a single
// `{ name: count }` map. Returns null when nothing usable is present.
function normalizeBlockTypeCounts(value) {
  if (!value) {
    return null;
  }
  const counts = {};
  if (Array.isArray(value)) {
    for (const entry of value) {
      if (typeof entry === 'string') {
        const name = normalizeBlockName(entry);
        if (name) {
          counts[name] = (counts[name] || 0) + 1;
        }
      } else if (entry && typeof entry === 'object') {
        const name = normalizeBlockName(entry.name || entry.block || entry.block_name || entry.blockName || entry.type);
        if (!name) {
          continue;
        }
        const count = firstNumber([entry.count, entry.occurrences, entry.total, entry.instances, entry.value]);
        counts[name] = (counts[name] || 0) + (Number.isFinite(count) ? count : 1);
      }
    }
  } else if (typeof value === 'object') {
    for (const [key, raw] of Object.entries(value)) {
      const name = normalizeBlockName(key);
      const count = Number(raw);
      if (name && Number.isFinite(count)) {
        counts[name] = (counts[name] || 0) + count;
      }
    }
  }
  return Object.keys(counts).length > 0 ? counts : null;
}

function summarizeBlockTypeCounts(counts) {
  let total = 0;
  let native = 0;
  let coreHtml = 0;
  for (const [name, value] of Object.entries(counts)) {
    const count = numberValue(value);
    total += count;
    if (name === CORE_HTML_BLOCK_NAME) {
      coreHtml += count;
    }
    if (isNativeBlockName(name)) {
      native += count;
    }
  }
  return { total, native, core_html: coreHtml, counts };
}

// Best-effort fallback when no per-block-type breakdown exists but SSI's quality
// report carries a total block count plus the fallback counts. Native blocks are
// approximated as the non-fallback remainder (total minus core/html and
// core/freeform). Returns null when no total block count is available.
function blockCompositionFromQualityCounts(payload) {
  const object = objectValue(payload);
  const quality = collectQualityMetrics(object);
  const importReport = objectValue(object.import_report || object.importReport || object.report);
  const blocksEngine = objectValue(importReport.blocks_engine || importReport.blocksEngine || object.blocks_engine || object.blocksEngine);
  const conversionReport = objectValue(blocksEngine.conversion_report || blocksEngine.conversionReport);
  const total = firstNumber([
    quality.block_count,
    quality.total_block_count,
    quality.blockCount,
    object.block_count,
    object.blockCount,
    conversionReport.block_count,
  ]);
  if (!Number.isFinite(total) || total <= 0) {
    return null;
  }
  const coreHtml = numberValue(quality.core_html_block_count ?? quality.coreHtmlBlockCount ?? object.core_html_block_count);
  const freeform = numberValue(quality.freeform_block_count ?? quality.freeformBlockCount ?? object.freeform_block_count);
  return {
    block_total: total,
    native_block_count: Math.max(0, total - coreHtml - freeform),
    core_html_block_count: coreHtml,
    block_type_counts: null,
    source: 'quality_counts',
  };
}

function normalizeBlockName(value) {
  return String(value || '').trim().toLowerCase();
}

// Generic block-namespace classification: a block is native/editable when it
// belongs to a core or known Automattic namespace and is not a non-native
// fallback wrapper. No per-fixture knowledge is involved.
function isNativeBlockName(name) {
  const normalized = normalizeBlockName(name);
  if (!normalized || NON_NATIVE_FALLBACK_BLOCK_NAMES.has(normalized)) {
    return false;
  }
  const namespace = normalized.includes('/') ? normalized.split('/')[0] : '';
  return NATIVE_BLOCK_NAMESPACES.includes(namespace);
}

// Per-fixture editor-quality score. `native_conversion_rate` and
// `core_html_fallback_ratio` come from the generic block composition;
// `editor_invalid_count` reuses the #537 `editor_block_invalid` findings.
export function computeFixtureEditorQuality(result, findings) {
  const composition = objectValue(result.block_composition);
  const blockTotal = numberValue(composition.block_total);
  const editorInvalidCount = findings.filter((finding) => finding.fixture_id === result.fixture_id
    && (finding.loss_class === 'editor_block_invalid' || finding.kind === EDITOR_BLOCK_INVALID_KIND)).length;
  const scored = blockTotal > 0;
  return compactObject({
    scored,
    source: result.block_composition ? (composition.source || 'unknown') : 'none',
    block_total: blockTotal,
    native_block_count: numberValue(composition.native_block_count),
    core_html_block_count: numberValue(composition.core_html_block_count),
    native_conversion_rate: scored ? qualityRatio(composition.native_block_count, blockTotal) : null,
    core_html_fallback_ratio: scored ? qualityRatio(composition.core_html_block_count, blockTotal) : null,
    editor_invalid_count: editorInvalidCount,
  });
}

export function attachFixtureEditorQuality(result, editorQuality) {
  return { ...result, editor_quality: editorQuality || computeFixtureEditorQuality(result, []) };
}

// Roll the per-fixture editor-quality scores into one aggregate. Rates are
// recomputed from summed block totals (not an average of per-fixture rates) so
// the aggregate stays a true native/total ratio across the corpus.
export function aggregateEditorQuality(editorQualityList, nativeRateGate = { minNativeRate: 0 }) {
  let blockTotal = 0;
  let native = 0;
  let coreHtml = 0;
  let editorInvalid = 0;
  let scored = 0;
  for (const editorQuality of editorQualityList) {
    blockTotal += numberValue(editorQuality.block_total);
    native += numberValue(editorQuality.native_block_count);
    coreHtml += numberValue(editorQuality.core_html_block_count);
    editorInvalid += numberValue(editorQuality.editor_invalid_count);
    if (editorQuality.scored) {
      scored += 1;
    }
  }
  return {
    scored_fixture_count: scored,
    block_total: blockTotal,
    native_block_count: native,
    core_html_block_count: coreHtml,
    editor_invalid_count: editorInvalid,
    native_conversion_rate: qualityRatio(native, blockTotal),
    core_html_fallback_ratio: qualityRatio(coreHtml, blockTotal),
    native_rate_gate: {
      enabled: nativeRateGate.minNativeRate > 0,
      min_native_rate: nativeRateGate.minNativeRate || 0,
    },
  };
}

export function normalizeNativeRateGateOptions(options) {
  const source = objectValue(options);
  let minNativeRate = firstNumber([source.minNativeRate, source.min_native_rate]);
  if (!Number.isFinite(minNativeRate) || minNativeRate < 0) {
    minNativeRate = 0;
  }
  // Allow the threshold to be expressed as a percentage (e.g. 80) or a ratio.
  if (minNativeRate > 1) {
    minNativeRate = minNativeRate / 100;
  }
  return { minNativeRate };
}

// Opt-in gate: when a positive minimum native-conversion rate is configured,
// every scored fixture below it earns an unacceptable `low_native_conversion`
// finding so it fails the same quality gate as other unacceptable losses.
export function buildNativeRateGateFindings(fixtureResults, editorQualityByFixture, nativeRateGate) {
  const findings = [];
  for (const result of fixtureResults) {
    const editorQuality = editorQualityByFixture.get(result.fixture_id);
    if (!editorQuality || !editorQuality.scored || editorQuality.native_conversion_rate === null) {
      continue;
    }
    if (editorQuality.native_conversion_rate >= nativeRateGate.minNativeRate) {
      continue;
    }
    const ratePercent = (editorQuality.native_conversion_rate * 100).toFixed(1);
    const minPercent = (nativeRateGate.minNativeRate * 100).toFixed(1);
    findings.push(normalizeDiagnosticFinding({
      kind: LOW_NATIVE_CONVERSION_KIND,
      loss_class: 'low_native_conversion',
      native_conversion_rate: editorQuality.native_conversion_rate,
      min_native_rate: nativeRateGate.minNativeRate,
      block_total: editorQuality.block_total,
      native_block_count: editorQuality.native_block_count,
      core_html_block_count: editorQuality.core_html_block_count,
      message: `Native conversion rate ${ratePercent}% is below the ${minPercent}% minimum (${editorQuality.native_block_count}/${editorQuality.block_total} native blocks, ${editorQuality.core_html_block_count} core/html).`,
    }, result, findings.length));
  }
  return findings;
}

export function accumulateEditorQuality(target, editorQuality) {
  const source = objectValue(editorQuality);
  target.block_total += numberValue(source.block_total);
  target.native_block_count += numberValue(source.native_block_count);
  target.core_html_block_count += numberValue(source.core_html_block_count);
  target.editor_invalid_count += numberValue(source.editor_invalid_count);
  if (source.scored) {
    target.scored_fixture_count += 1;
  }
}

export function finalizeEditorQuality(accumulator) {
  const blockTotal = numberValue(accumulator.block_total);
  return {
    ...accumulator,
    native_conversion_rate: qualityRatio(accumulator.native_block_count, blockTotal),
    core_html_fallback_ratio: qualityRatio(accumulator.core_html_block_count, blockTotal),
  };
}
