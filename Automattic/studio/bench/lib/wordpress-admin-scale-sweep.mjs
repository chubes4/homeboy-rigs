import { readFile } from 'node:fs/promises';

import { wordpressResourceInclude } from './wordpress-page-profiler.mjs';

const DEFAULT_ADMIN_READY = { selector: '#wpbody-content, body.wp-admin', timeout: 120000 };

function pageIdFromPath(pagePath) {
  return String(pagePath || '')
    .replace(/^https?:\/\/[^/]+/i, '')
    .replace(/^\/+/, '')
    .replace(/[^A-Za-z0-9_.:-]+/g, '-')
    .replace(/^-|-$/g, '') || 'wordpress-admin-page';
}

function metricId(id) {
  return String(id || 'page')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '') || 'page';
}

export function normalizeWordPressAdminScaleSweepManifest(manifest, options = {}) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new Error('WordPress admin scale sweep manifest must be an object');
  }
  if (!Array.isArray(manifest.pages) || manifest.pages.length === 0) {
    throw new Error('WordPress admin scale sweep manifest requires a non-empty pages array');
  }

  const resourceInclude = options.resourceInclude || wordpressResourceInclude(options);

  return {
    ...manifest,
    pages: manifest.pages.map((page, index) => {
      if (!page || typeof page !== 'object' || Array.isArray(page)) {
        throw new Error(`WordPress admin scale sweep page ${index + 1} must be an object`);
      }
      if (!page.path || typeof page.path !== 'string') {
        throw new Error(`WordPress admin scale sweep page ${index + 1} requires a path`);
      }

      const id = page.id || pageIdFromPath(page.path);
      const ready = page.ready || DEFAULT_ADMIN_READY;
      return {
        ...page,
        id,
        metricId: metricId(id),
        label: page.label || id,
        ready,
        resources: {
          includeResourceSubstrings: resourceInclude,
          ...(page.resources || {}),
        },
        timeout: Number(page.timeout || ready.timeout || 120000),
        interactions: Array.isArray(page.interactions) ? page.interactions : [],
      };
    }),
  };
}

export async function loadWordPressAdminScaleSweepManifest(options = {}) {
  const rawJson = options.json || process.env.HOMEBOY_WORDPRESS_ADMIN_SCALE_SWEEP_MANIFEST_JSON;
  const manifestPath = options.path || process.env.HOMEBOY_WORDPRESS_ADMIN_SCALE_SWEEP_MANIFEST;
  if (rawJson) {
    return normalizeWordPressAdminScaleSweepManifest(JSON.parse(rawJson), options);
  }
  if (manifestPath) {
    return normalizeWordPressAdminScaleSweepManifest(JSON.parse(await readFile(manifestPath, 'utf8')), options);
  }

  return normalizeWordPressAdminScaleSweepManifest({
    pages: [
      { id: 'dashboard', path: '/wp-admin/index.php' },
      { id: 'plugins', path: '/wp-admin/plugins.php' },
      { id: 'themes', path: '/wp-admin/themes.php', ready: { selector: '.theme-browser, #wpbody-content', timeout: 120000 } },
      { id: 'posts', path: '/wp-admin/edit.php' },
      { id: 'add-post', path: '/wp-admin/post-new.php', ready: { selector: '.edit-post-layout, #editor, body.wp-admin', timeout: 120000 } },
    ],
  }, options);
}
