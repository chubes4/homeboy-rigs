#!/usr/bin/env node

import { mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

function argValue(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? null : process.argv[index + 1] || null;
}

function now() {
  return new Date().toISOString();
}

function normalizeBaseUrl(value) {
  if (!value) {
    throw new Error('Studio Native runtime URL is required. Pass --url or set STUDIO_NATIVE_RUNTIME_URL.');
  }

  const url = new URL(value);
  url.pathname = url.pathname.replace(/\/+$/, '/');
  url.search = '';
  url.hash = '';
  return url;
}

function defaultOutDir(name) {
  const artifactRoot = process.env.HOMEBOY_INVOCATION_ARTIFACT_DIR
    || process.env.HOMEBOY_TRACE_ARTIFACT_DIR
    || process.env.HOMEBOY_BENCH_ARTIFACT_DIR;

  return path.join(artifactRoot || os.tmpdir(), `${name}-${process.pid}`);
}

async function fetchText(url) {
  const response = await fetch(url, { redirect: 'follow' });
  const body = await response.text();
  return { response, body };
}

async function fetchJson(url) {
  const { response, body } = await fetchText(url);
  let json = null;
  try {
    json = JSON.parse(body);
  } catch (error) {
    throw new Error(`Expected JSON from ${url}, got HTTP ${response.status}: ${body.slice(0, 200)}`);
  }
  return { response, json };
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function main() {
  const baseUrl = normalizeBaseUrl(argValue('--url') || process.env.STUDIO_NATIVE_RUNTIME_URL);
  const outDir = path.resolve(argValue('--out') || defaultOutDir('studio-native-live-runtime-open'));
  await mkdir(outDir, { recursive: true });

  const homepage = await fetchText(baseUrl);
  assert(homepage.response.ok, `Studio Native runtime homepage did not open: HTTP ${homepage.response.status}`);

  const restUrl = new URL('/wp-json/', baseUrl);
  const rest = await fetchJson(restUrl);
  assert(rest.response.ok, `WordPress REST index did not open: HTTP ${rest.response.status}`);
  const routes = rest.json.routes && typeof rest.json.routes === 'object' ? Object.keys(rest.json.routes) : [];
  const requiredRoutes = [
    '/studio-native/v1/status',
    '/studio-native-agentic-ui/v1/chat',
    '/studio-native-agentic-ui/v1/runs/(?P<run_id>[^/]+)/events',
    '/studio-native/v1/browser-codebox/artifacts',
    '/studio-native/v1/projects/(?P<project_id>\\d+)/codebox/artifact-session',
    '/studio-native/v1/codebox/browser-contained-site/open-or-create',
    '/wp-codebox/v1/browser-provider-request',
    '/wp-codebox/v1/browser-blueprint-ref'
  ];

  const missingRoutes = requiredRoutes.filter((route) => !routes.includes(route));
  assert(missingRoutes.length === 0, `Studio Native runtime is missing required route(s): ${missingRoutes.join(', ')}`);

  const statusUrl = new URL('/wp-json/studio-native/v1/status', baseUrl);
  const status = await fetchJson(statusUrl);
  assert(
    status.response.ok || status.response.status === 401,
    `Studio Native status route was not reachable: HTTP ${status.response.status}`
  );

  const result = {
    schema: 'studio-native/live-runtime-open-proof/v1',
    success: true,
    checked_at: now(),
    runtime_url: baseUrl.toString(),
    assertions: {
      homepage_opened: true,
      rest_index_opened: true,
      studio_native_status_reachable: true,
      studio_native_status_auth_required: status.response.status === 401,
      required_routes_present: true
    },
    required_routes: requiredRoutes,
    route_count: routes.length,
    status: status.json
  };

  const resultPath = path.join(outDir, 'studio-native-live-runtime-open.json');
  await writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify({ success: true, result: resultPath, runtime_url: baseUrl.toString() }, null, 2));
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
