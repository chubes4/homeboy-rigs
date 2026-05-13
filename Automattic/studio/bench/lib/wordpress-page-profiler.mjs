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
    frameFunction: () =>
      document.querySelectorAll('[data-block]').length > 0 &&
      !document.querySelector('.components-spinner') &&
      !document.querySelector('.is-loading') &&
      !document.querySelector('.wp-block-editor__loading'),
    timeout: 120000,
  },
  resources: {
    includeResourceSubstrings: ['/wp-json/', '/wp-admin/site-editor.php'],
  },
  timeout: 120000,
};

export function wordpressResourceInclude(options = {}) {
  const pageProfiler = options.pageProfiler || loadWordPressPageProfiler(options).module;
  if (!Array.isArray(pageProfiler?.DEFAULT_RESOURCE_INCLUDE)) {
    throw new Error('Homeboy WordPress page profiler must export DEFAULT_RESOURCE_INCLUDE. Update homeboy-extensions.');
  }
  return pageProfiler.DEFAULT_RESOURCE_INCLUDE;
}

export function wordpressPageProfilerSpec(options = {}) {
  const rawSpec = process.env.HOMEBOY_WORDPRESS_PAGE_PROFILE_SPEC_JSON;
  if (rawSpec) {
    return JSON.parse(rawSpec);
  }

  const pathValue = process.env.HOMEBOY_WORDPRESS_PAGE_PROFILE_PATH;
  if (!pathValue) {
    return SITE_EDITOR_PAGE_SPEC;
  }

  const id = process.env.HOMEBOY_WORDPRESS_PAGE_PROFILE_ID ||
    pathValue.replace(/^\/+/, '').replace(/[^A-Za-z0-9_.:-]+/g, '-').replace(/^-|-$/g, '') ||
    'wordpress-page';
  const selector = process.env.HOMEBOY_WORDPRESS_PAGE_PROFILE_READY_SELECTOR;
  const timeout = Number(process.env.HOMEBOY_WORDPRESS_PAGE_PROFILE_TIMEOUT || 120000);
  const ready = selector
    ? { selector, timeout }
    : { state: process.env.HOMEBOY_WORDPRESS_PAGE_PROFILE_READY_STATE || 'domcontentloaded' };

  return {
    id,
    label: process.env.HOMEBOY_WORDPRESS_PAGE_PROFILE_LABEL || id,
    path: pathValue,
    ready,
    resources: {
      includeResourceSubstrings: process.env.HOMEBOY_WORDPRESS_PAGE_PROFILE_RESOURCE_INCLUDE
        ? process.env.HOMEBOY_WORDPRESS_PAGE_PROFILE_RESOURCE_INCLUDE.split(',').map((value) => value.trim()).filter(Boolean)
        : wordpressResourceInclude(options),
    },
    timeout,
  };
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

export async function profileWordPressPage({ page, siteUrl, pageProfiler, pageSpec, wordpressProfilerRows = [], mark }) {
  if (!pageProfiler?.profileWordPressPage) {
    throw new Error('Homeboy WordPress page profiler is unavailable. Update homeboy-extensions or set HOMEBOY_WORDPRESS_PAGE_PROFILER_PATH.');
  }

  return pageProfiler.profileWordPressPage({
    page,
    baseUrl: siteUrl,
    spec: pageSpec || wordpressPageProfilerSpec(),
    wordpressProfilerRows,
    mark,
  });
}
