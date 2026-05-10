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

export async function profileSiteEditorPage({ page, siteUrl, pageProfiler, wordpressProfilerRows = [], mark }) {
  if (!pageProfiler?.profileWordPressPage) {
    throw new Error('Homeboy WordPress page profiler is unavailable. Update homeboy-extensions or set HOMEBOY_WORDPRESS_PAGE_PROFILER_PATH.');
  }

  return pageProfiler.profileWordPressPage({
    page,
    baseUrl: siteUrl,
    spec: SITE_EDITOR_PAGE_SPEC,
    wordpressProfilerRows,
    mark,
  });
}
