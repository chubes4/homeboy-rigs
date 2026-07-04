/**
 * Studio Site Editor browser-vs-WordPress timing delta helpers.
 *
 * Studio-specific composition that consumes the generic correlator from
 * homeboy-extensions (`wordpress/lib/timing-correlator.js`). Kept here in
 * homeboy-rigs because the shape of "what a useful Site Editor diagnostic
 * summary looks like" is workload-level reporting, not a generic Homeboy
 * Extensions concern.
 *
 * The helpers are pure (no filesystem / network / browser dependencies) so
 * they can be unit-tested without booting Studio or Playground.
 */

import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import path from 'node:path';

import { setting } from './studio-bench.mjs';
import { wordpressHelperPath } from './wordpress-helper-discovery.mjs';

const require = createRequire(import.meta.url);

const TIMING_CORRELATOR_FILENAME = 'timing-correlator.js';

/**
 * Resolve the WordPress request profiler path used by the diagnostics
 * workload. Honors the `wordpress_request_profiler_path` Homeboy setting.
 *
 * @returns {string}
 */
export function requestProfilerPath() {
  return setting('wordpress_request_profiler_path') || wordpressHelperPath('requestProfiler');
}

/**
 * Resolve the WordPress timing correlator path. Honors the
 * `wordpress_timing_correlator_path` Homeboy setting; otherwise derives it
 * by sitting next to the request profiler (they ship together as part of
 * the homeboy-extensions WordPress lib).
 *
 * Pure: no filesystem checks. Use {@link loadTimingCorrelator} for the
 * load + existence-guard combo.
 *
 * @param {object} [options]
 * @param {string} [options.profilerPath] explicit profiler path (test seam)
 * @param {string} [options.override] explicit correlator path (test seam)
 * @returns {string}
 */
export function timingCorrelatorPath(options = {}) {
  const explicit = options.override ?? (setting('wordpress_timing_correlator_path') || wordpressHelperPath('timingCorrelator'));
  if (explicit) {
    return explicit;
  }
  const profiler = options.profilerPath ?? requestProfilerPath();
  if (!profiler) {
    return '';
  }
  return path.join(path.dirname(profiler), TIMING_CORRELATOR_FILENAME);
}

/**
 * Load the timing correlator module if available. Returns `{ path, module }`
 * where `module` is `null` if the file does not exist (the workload then
 * skips correlation rather than failing the run).
 *
 * @param {object} [options]
 * @returns {{ path: string, module: object|null }}
 */
export function loadTimingCorrelator(options = {}) {
  const correlatorPath = timingCorrelatorPath(options);
  if (!correlatorPath || !existsSync(correlatorPath)) {
    return { path: correlatorPath, module: null };
  }
  return { path: correlatorPath, module: require(correlatorPath) };
}

function compareDescByMagnitude(a, b) {
  const av = typeof a === 'number' ? Math.abs(a) : -Infinity;
  const bv = typeof b === 'number' ? Math.abs(b) : -Infinity;
  return bv - av;
}

function safeNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function pickRowFingerprint(row) {
  return {
    url: row.normalizedUrl || row.url,
    method: row.method,
    phase: row.phase,
    browser_duration_ms: safeNumber(row.browserDurationMs),
    browser_ttfb_ms: safeNumber(row.browserTtfbMs),
    wordpress_duration_ms: safeNumber(row.wordpressDurationMs),
    transport_delta_ms: safeNumber(row.transportDeltaMs),
    total_delta_ms: safeNumber(row.totalDeltaMs),
  };
}

function pickUnmatchedBrowser(entry) {
  return {
    url: entry.normalizedUrl || entry.url,
    method: entry.method,
    phase: entry.phase,
    initiator_type: entry.initiatorType,
    browser_duration_ms: safeNumber(entry.durationMs),
    browser_ttfb_ms: safeNumber(entry.ttfbMs),
  };
}

function pickUnmatchedWordPress(summary) {
  return {
    request_id: summary.requestId,
    uri: summary.uri,
    method: summary.method,
    wordpress_duration_ms: safeNumber(summary.durationMs),
    event_count: summary.eventCount,
  };
}

function aggregatePhase(rows) {
  const groups = new Map();
  for (const row of rows) {
    const phase = row.phase || '__unphased__';
    if (!groups.has(phase)) {
      groups.set(phase, {
        phase: row.phase,
        count: 0,
        max_transport_delta_ms: -Infinity,
        max_total_delta_ms: -Infinity,
        sum_transport_delta_ms: 0,
        sum_total_delta_ms: 0,
        transport_count: 0,
        total_count: 0,
      });
    }
    const group = groups.get(phase);
    group.count += 1;
    const transport = safeNumber(row.transportDeltaMs);
    const total = safeNumber(row.totalDeltaMs);
    if (transport !== undefined) {
      group.sum_transport_delta_ms += transport;
      group.transport_count += 1;
      if (transport > group.max_transport_delta_ms) {
        group.max_transport_delta_ms = transport;
      }
    }
    if (total !== undefined) {
      group.sum_total_delta_ms += total;
      group.total_count += 1;
      if (total > group.max_total_delta_ms) {
        group.max_total_delta_ms = total;
      }
    }
  }
  const out = [];
  for (const group of groups.values()) {
    out.push({
      phase: group.phase,
      count: group.count,
      avg_transport_delta_ms:
        group.transport_count > 0 ? group.sum_transport_delta_ms / group.transport_count : undefined,
      max_transport_delta_ms:
        group.max_transport_delta_ms === -Infinity ? undefined : group.max_transport_delta_ms,
      avg_total_delta_ms:
        group.total_count > 0 ? group.sum_total_delta_ms / group.total_count : undefined,
      max_total_delta_ms:
        group.max_total_delta_ms === -Infinity ? undefined : group.max_total_delta_ms,
    });
  }
  return out.sort((a, b) => (b.max_transport_delta_ms ?? -Infinity) - (a.max_transport_delta_ms ?? -Infinity));
}

function aggregateOverall(rows) {
  let count = 0;
  let transportCount = 0;
  let totalCount = 0;
  let sumTransport = 0;
  let sumTotal = 0;
  let maxTransport = -Infinity;
  let maxTotal = -Infinity;
  let largestTransportRow = null;
  for (const row of rows) {
    count += 1;
    const transport = safeNumber(row.transportDeltaMs);
    const total = safeNumber(row.totalDeltaMs);
    if (transport !== undefined) {
      transportCount += 1;
      sumTransport += transport;
      if (transport > maxTransport) {
        maxTransport = transport;
        largestTransportRow = row;
      }
    }
    if (total !== undefined) {
      totalCount += 1;
      sumTotal += total;
      if (total > maxTotal) {
        maxTotal = total;
      }
    }
  }
  return {
    count,
    avg_transport_delta_ms: transportCount > 0 ? sumTransport / transportCount : undefined,
    max_transport_delta_ms: maxTransport === -Infinity ? undefined : maxTransport,
    avg_total_delta_ms: totalCount > 0 ? sumTotal / totalCount : undefined,
    max_total_delta_ms: maxTotal === -Infinity ? undefined : maxTotal,
    largest_transport_delta: largestTransportRow ? pickRowFingerprint(largestTransportRow) : null,
  };
}

/**
 * Build a Site Editor browser-vs-WordPress timing delta summary.
 *
 * Designed to live next to the `wordpressRequests` and per-phase browser
 * resource timings already collected by the diagnostics workload. Accepts a
 * map of phase => raw browser PerformanceResourceTiming entries (annotated
 * with the phase the diagnostics workload was in when they fired) plus the
 * raw WordPress profiler rows.
 *
 * Returns a JSON-friendly summary intended to be embedded in the raw
 * artifact and to drive a small set of headline metrics.
 *
 * @param {object} input
 * @param {object[]} input.browserResourceTimings Each entry should be a
 *   browser timing object with a `phase` annotation when available.
 * @param {object[]} input.wordpressRequests Raw rows from the WordPress
 *   request profiler.
 * @param {object} [input.correlator] Module exporting
 *   `correlateBrowserAndWordPressTimings`. If absent, returns a stub
 *   summary that records why correlation was skipped.
 * @param {object} [options]
 * @param {number} [options.topCount=10] Number of rows to include in the
 *   `top_*` previews.
 * @returns {object}
 */
export function buildTimingDeltaSummary(input, options = {}) {
  const topCount = Math.max(1, Number(options.topCount ?? 10));
  const browserResourceTimings = Array.isArray(input?.browserResourceTimings)
    ? input.browserResourceTimings
    : [];
  const wordpressRequests = Array.isArray(input?.wordpressRequests) ? input.wordpressRequests : [];
  const correlator = input?.correlator;

  if (!correlator || typeof correlator.correlateBrowserAndWordPressTimings !== 'function') {
    return {
      available: false,
      reason: 'timing-correlator module not loaded',
      browser_resource_timing_count: browserResourceTimings.length,
      wordpress_request_event_count: wordpressRequests.length,
    };
  }

  const { correlated, unmatchedBrowser, unmatchedWordPress } =
    correlator.correlateBrowserAndWordPressTimings({
      browserTimings: browserResourceTimings,
      wordpressProfilerRows: wordpressRequests,
    });

  const overall = aggregateOverall(correlated);
  const phaseGroups = aggregatePhase(correlated);

  const topByTransport = correlated
    .filter((row) => safeNumber(row.transportDeltaMs) !== undefined)
    .slice()
    .sort((a, b) => compareDescByMagnitude(a.transportDeltaMs, b.transportDeltaMs))
    .slice(0, topCount)
    .map(pickRowFingerprint);

  const topByTotal = correlated
    .filter((row) => safeNumber(row.totalDeltaMs) !== undefined)
    .slice()
    .sort((a, b) => compareDescByMagnitude(a.totalDeltaMs, b.totalDeltaMs))
    .slice(0, topCount)
    .map(pickRowFingerprint);

  return {
    available: true,
    counts: {
      browser_resource_timings: browserResourceTimings.length,
      wordpress_request_events: wordpressRequests.length,
      correlated: correlated.length,
      unmatched_browser: unmatchedBrowser.length,
      unmatched_wordpress: unmatchedWordPress.length,
    },
    overall,
    by_phase: phaseGroups,
    top_by_transport_delta: topByTransport,
    top_by_total_delta: topByTotal,
    unmatched_browser_preview: unmatchedBrowser.slice(0, topCount).map(pickUnmatchedBrowser),
    unmatched_wordpress_preview: unmatchedWordPress.slice(0, topCount).map(pickUnmatchedWordPress),
  };
}

/**
 * Convenience: tag every browser resource timing entry with a phase label
 * so the correlator output stays grouped by Studio diagnostic phase.
 *
 * @param {object[]} entries
 * @param {string} phase
 * @returns {object[]}
 */
export function annotatePhase(entries, phase) {
  if (!Array.isArray(entries)) {
    return [];
  }
  return entries.map((entry) => ({ ...entry, phase }));
}

/**
 * Flatten a per-phase resource-timings map into a single array suitable for
 * {@link buildTimingDeltaSummary}. Phase order is preserved so unmatched
 * arrival-order pairing in the correlator stays meaningful.
 *
 * @param {Record<string, object[]>} byPhase
 * @returns {object[]}
 */
export function flattenPhasedResourceTimings(byPhase) {
  if (!byPhase || typeof byPhase !== 'object') {
    return [];
  }
  const out = [];
  for (const [phase, entries] of Object.entries(byPhase)) {
    out.push(...annotatePhase(entries, phase));
  }
  return out;
}
