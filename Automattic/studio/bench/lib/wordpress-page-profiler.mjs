import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import path from 'node:path';

import { requestProfilerPath } from './site-editor-timing-deltas.mjs';

const require = createRequire(import.meta.url);
const PAGE_PROFILER_FILENAME = 'page-profiler.js';

export const SITE_EDITOR_PAGE_SPEC = {
  id: 'site-editor',
  path: '/wp-admin/site-editor.php',
  ready: {
    selector: 'iframe[name="editor-canvas"]',
    frameName: 'editor-canvas',
    frameState: 'domcontentloaded',
    frameSelector: '[data-block]',
    timeout: 120000,
  },
  resources: {
    includeResourceSubstrings: ['/wp-json/', '/wp-admin/site-editor.php'],
  },
  timeout: 120000,
};

function round(value) {
  return typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : 0;
}

export function pageProfilerPath(options = {}) {
  const explicit = options.override || process.env.HOMEBOY_WORDPRESS_PAGE_PROFILER_PATH;
  if (explicit) {
    return explicit;
  }

  const profiler = options.profilerPath || requestProfilerPath();
  if (!profiler) {
    return '';
  }
  return path.join(path.dirname(profiler), PAGE_PROFILER_FILENAME);
}

export function loadWordPressPageProfiler(options = {}) {
  const profilerPath = pageProfilerPath(options);
  if (!profilerPath || !existsSync(profilerPath)) {
    return { path: profilerPath, module: null };
  }
  return { path: profilerPath, module: require(profilerPath) };
}

export function loadWordPressRequestProfiler(options = {}) {
  const profilerPath = options.override || requestProfilerPath();
  if (!profilerPath || !existsSync(profilerPath)) {
    return { path: profilerPath, module: null };
  }
  return { path: profilerPath, module: require(profilerPath) };
}

export function legacyResourceTimings(profileResult) {
  return (profileResult?.resources?.resources || [])
    .map((resource) => ({
      name: resource.url,
      url: resource.url,
      initiatorType: resource.initiatorType,
      kind: resource.kind,
      startMs: resource.startMs,
      startTime: resource.startMs,
      durationMs: resource.durationMs,
      duration: resource.durationMs,
      ttfbMs: resource.ttfbMs,
      transferSize: resource.transferSize,
      encodedBodySize: resource.encodedBodySize,
      decodedBodySize: resource.decodedBodySize,
    }))
    .sort((a, b) => b.durationMs - a.durationMs);
}

export function summarizeProfileResourceTimings(entries) {
  return (entries || [])
    .map((entry) => ({
      url: entry.url || entry.name,
      kind: entry.kind,
      initiatorType: entry.initiatorType,
      start_ms: round(entry.startMs ?? entry.startTime),
      duration_ms: round(entry.durationMs ?? entry.duration),
      ttfb_ms: round(entry.ttfbMs ?? entry.ttfb_ms),
      transfer_size: entry.transferSize || 0,
      encoded_body_size: entry.encodedBodySize || 0,
      decoded_body_size: entry.decodedBodySize || 0,
    }))
    .sort((a, b) => b.duration_ms - a.duration_ms);
}

export async function profileSiteEditorReady({ page, siteUrl, pageProfiler, wordpressProfilerRows = [], mark }) {
  if (!pageProfiler?.profileWordPressPage) {
    throw new Error('Homeboy WordPress page profiler is unavailable. Update homeboy-extensions or set HOMEBOY_WORDPRESS_PAGE_PROFILER_PATH.');
  }

  const profile = await pageProfiler.profileWordPressPage({
    page,
    baseUrl: siteUrl,
    spec: SITE_EDITOR_PAGE_SPEC,
    wordpressProfilerRows,
    mark,
  });

  return {
    status: profile.status,
    site_editor_ready_ms: profile.readyMs,
    duration_ms: profile.readyMs,
    marks: [],
    resourceTimings: legacyResourceTimings(profile),
    pageProfile: profile,
  };
}
