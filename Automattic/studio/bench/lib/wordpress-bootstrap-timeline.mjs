import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import path from 'node:path';

import { requestProfilerPath } from './site-editor-timing-deltas.mjs';
import { wordpressHelperPath } from './wordpress-helper-discovery.mjs';

const require = createRequire(import.meta.url);
const BOOTSTRAP_TIMELINE_FILENAME = 'wordpress-bootstrap-timeline.js';

function bootstrapTimelinePath(options = {}) {
  const explicit = options.override || wordpressHelperPath('bootstrapTimeline');
  if (explicit) {
    return explicit;
  }

  const profiler = options.profilerPath || requestProfilerPath();
  if (!profiler) {
    return '';
  }
  return path.join(path.dirname(profiler), BOOTSTRAP_TIMELINE_FILENAME);
}

function loadWordPressBootstrapTimeline(options = {}) {
  const helperPath = bootstrapTimelinePath(options);
  if (!helperPath || !existsSync(helperPath)) {
    throw new Error('Homeboy WordPress bootstrap timeline helper is unavailable. Update homeboy-extensions or set HOMEBOY_WORDPRESS_HELPER_MANIFEST.');
  }

  return require(helperPath);
}

function normalizeTimelineSummary(summary) {
  return (summary || []).map((request) => ({
    uri: request.uri || '',
    method: request.method || '',
    duration_ms: request.durationMs || 0,
    events: (request.events || []).map((event) => ({
      event: event.event,
      t_ms: event.tMs || 0,
      delta_from_previous_ms: event.deltaFromPreviousMs || 0,
    })),
  }));
}

export function instrumentIndexPhp(source, options = {}) {
  return loadWordPressBootstrapTimeline(options).instrumentIndexPhp(source, options);
}

export function instrumentWpSettingsPhp(source, options = {}) {
  return loadWordPressBootstrapTimeline(options).instrumentWpSettingsPhp(source, options);
}

export function installWordPressBootstrapTimeline(sitePath, options = {}) {
  return loadWordPressBootstrapTimeline(options).installWordPressBootstrapTimeline(sitePath, options);
}

export function uninstallWordPressBootstrapTimeline(sitePath, options = {}) {
  return loadWordPressBootstrapTimeline(options).uninstallWordPressBootstrapTimeline(sitePath, options);
}

export function collectWordPressBootstrapTimeline(sitePath, options = {}) {
  return loadWordPressBootstrapTimeline(options).collectWordPressBootstrapTimeline(sitePath, options);
}

export function summarizeWordPressBootstrapTimeline(rows, options = {}) {
  const helper = loadWordPressBootstrapTimeline(options);
  return normalizeTimelineSummary(helper.summarizeWordPressBootstrapTimeline(rows, options));
}
