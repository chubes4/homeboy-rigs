import { readFile } from 'node:fs/promises';

import { metric } from './studio-bench.mjs';

const DEFAULT_ADMIN_READY = { selector: '#wpbody-content, body.wp-admin', timeout: 120000 };
const DEFAULT_RESOURCE_INCLUDE = ['/wp-json/', '?rest_route=', '/wp-admin/', '/wp-content/', '/wp-includes/'];

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

export function normalizeWordPressAdminScaleSweepManifest(manifest) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new Error('WordPress admin scale sweep manifest must be an object');
  }
  if (!Array.isArray(manifest.pages) || manifest.pages.length === 0) {
    throw new Error('WordPress admin scale sweep manifest requires a non-empty pages array');
  }

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
          includeResourceSubstrings: DEFAULT_RESOURCE_INCLUDE,
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
    return normalizeWordPressAdminScaleSweepManifest(JSON.parse(rawJson));
  }
  if (manifestPath) {
    return normalizeWordPressAdminScaleSweepManifest(JSON.parse(await readFile(manifestPath, 'utf8')));
  }

  return normalizeWordPressAdminScaleSweepManifest({
    pages: [
      { id: 'dashboard', path: '/wp-admin/index.php' },
      { id: 'plugins', path: '/wp-admin/plugins.php' },
      { id: 'themes', path: '/wp-admin/themes.php', ready: { selector: '.theme-browser, #wpbody-content', timeout: 120000 } },
      { id: 'posts', path: '/wp-admin/edit.php' },
      { id: 'add-post', path: '/wp-admin/post-new.php', ready: { selector: '.edit-post-layout, #editor, body.wp-admin', timeout: 120000 } },
    ],
  });
}

function numberValue(...values) {
  for (const value of values) {
    const number = Number(value);
    if (Number.isFinite(number)) {
      return number;
    }
  }
  return 0;
}

function resourceUrl(resource) {
  return resource?.url || resource?.name || resource?.href || '';
}

function resourceDuration(resource) {
  return numberValue(resource?.durationMs, resource?.duration_ms, resource?.duration);
}

function resourceBytes(resource) {
  return numberValue(resource?.transferSize, resource?.transfer_size, resource?.encodedBodySize, resource?.encoded_body_size, resource?.decodedBodySize, resource?.decoded_body_size);
}

function isRestResource(resource) {
  const url = resourceUrl(resource);
  return url.includes('/wp-json/') || url.includes('?rest_route=');
}

function summarizeResources(resources = []) {
  const all = Array.isArray(resources) ? resources : [];
  const rest = all.filter(isRestResource);
  return {
    count: all.length,
    rest_count: rest.length,
    rest_bytes: rest.reduce((total, resource) => total + resourceBytes(resource), 0),
    slowest: all
      .slice()
      .sort((a, b) => resourceDuration(b) - resourceDuration(a))
      .slice(0, 20)
      .map((resource) => ({
        url: resourceUrl(resource),
        duration_ms: resourceDuration(resource),
        ttfb_ms: numberValue(resource?.ttfbMs, resource?.ttfb_ms),
        transfer_size: numberValue(resource?.transferSize, resource?.transfer_size),
        encoded_body_size: numberValue(resource?.encodedBodySize, resource?.encoded_body_size),
        resource_type: resource?.resourceType || resource?.initiatorType || resource?.kind || '',
      })),
  };
}

export function summarizeWordPressAdminScaleSweepPage({ pageSpec, profile, networkRequests = [], interactionResult, artifacts }) {
  const resources = summarizeResources(profile?.resources?.resources || profile?.resources || []);
  const failedRequests = networkRequests.filter((request) => request.failed || Number(request.status || 0) >= 400);
  const slowestNetwork = networkRequests
    .slice()
    .sort((a, b) => numberValue(b.duration_ms) - numberValue(a.duration_ms))
    .slice(0, 20);
  const interaction = profile?.interactions ?? interactionResult ?? null;
  const failures = [
    ...failedRequests.map((request) => ({
      type: 'request',
      url: request.url,
      status: request.status || 0,
      error: request.failure || '',
    })),
    ...(profile?.failure ? [{ type: 'profile', error: profile.failure }] : []),
    ...(interaction?.failed || interaction?.failure ? [{ type: 'interaction', error: interaction.failure || 'interaction failed' }] : []),
  ];

  return {
    id: pageSpec.id,
    metric_id: pageSpec.metricId || metricId(pageSpec.id),
    label: pageSpec.label || pageSpec.id,
    path: pageSpec.path,
    status: metric(profile?.status),
    ready_ms: metric(profile?.readyMs),
    resource_count: metric(profile?.resources?.count ?? resources.count),
    rest_count: metric(profile?.resources?.restCount ?? resources.rest_count),
    rest_bytes: metric(profile?.resources?.restBytes ?? resources.rest_bytes),
    failed_request_count: failedRequests.length,
    failure_count: failures.length,
    slowest_resource_ms: metric(resources.slowest[0]?.duration_ms),
    slowest_resources: resources.slowest,
    slowest_requests: slowestNetwork,
    failures,
    interaction,
    artifacts: artifacts || {},
    rawProfile: profile,
  };
}

export function buildWordPressAdminScaleSweepSummary(pages) {
  const rows = pages
    .map((page) => ({
      id: page.id,
      label: page.label,
      path: page.path,
      status: page.status,
      ready_ms: page.ready_ms,
      rest_count: page.rest_count,
      rest_bytes: page.rest_bytes,
      failed_request_count: page.failed_request_count,
      failure_count: page.failure_count,
      slowest_resource_ms: page.slowest_resource_ms,
    }))
    .sort((a, b) => {
      if (a.failure_count !== b.failure_count) {
        return b.failure_count - a.failure_count;
      }
      if (a.ready_ms !== b.ready_ms) {
        return b.ready_ms - a.ready_ms;
      }
      return b.slowest_resource_ms - a.slowest_resource_ms;
    });

  const requests = pages
    .flatMap((page) =>
      (page.slowest_requests || []).map((request) => ({
        page_id: page.id,
        url: request.url,
        method: request.method,
        status: request.status || 0,
        failed: Boolean(request.failed),
        duration_ms: metric(request.duration_ms),
        resource_type: request.resource_type || request.resourceType || '',
      }))
    )
    .sort((a, b) => {
      if (a.failed !== b.failed) {
        return a.failed ? -1 : 1;
      }
      return b.duration_ms - a.duration_ms;
    })
    .slice(0, 40);

  const pageTable = [
    '| Page | Status | Ready ms | REST | REST bytes | Failed requests | Slowest resource ms |',
    '|---|---:|---:|---:|---:|---:|---:|',
    ...rows.map((row) => `| ${row.id} | ${row.status} | ${Math.round(row.ready_ms)} | ${row.rest_count} | ${row.rest_bytes} | ${row.failed_request_count} | ${Math.round(row.slowest_resource_ms)} |`),
  ].join('\n');

  const requestTable = [
    '| Page | Status | Duration ms | URL |',
    '|---|---:|---:|---|',
    ...requests.slice(0, 15).map((request) => `| ${request.page_id} | ${request.status} | ${Math.round(request.duration_ms)} | ${String(request.url || '').replace(/\|/g, '%7C')} |`),
  ].join('\n');

  return {
    pages: rows,
    worst_requests: requests,
    markdown: `${pageTable}\n\n${requestTable}`,
  };
}
