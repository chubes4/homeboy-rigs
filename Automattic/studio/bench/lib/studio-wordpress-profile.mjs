import { pathToFileURL } from 'node:url';

import {
  createStudioSite,
  expandHome,
  parseStudioSiteStatus,
  redact,
  stopStudioSite,
  studioSiteStatus,
  variant,
} from './studio-bench.mjs';
import {
  installStudioWordPressFixturePlugins,
  restoreStudioWordPressFixturePlugins,
} from './wordpress-fixture-plugins.mjs';

export async function createStudioWordPressProfileSite(sitePath, options = {}) {
  const wp = envValue(options.wpEnv, options.fallbackWpEnv);
  const php = envValue(options.phpEnv, options.fallbackPhpEnv);
  return createStudioSite(sitePath, {
    name: options.name || `Studio Bench ${variant()} ${options.nameSuffix || 'WordPress Profile'} ${process.pid}`,
    wp,
    php,
    timeoutMs: options.timeoutMs || 420000,
  });
}

export async function studioWordPressProfileSiteStatus(sitePath, options = {}) {
  return studioSiteStatus(sitePath, { timeoutMs: 90000, ...options });
}

export async function stopStudioWordPressProfileSite(sitePath, options = {}) {
  return stopStudioSite(sitePath, { timeoutMs: 90000, ...options });
}

export async function installStudioWordPressProfilePlugins(sitePath, options = {}) {
  return installStudioWordPressFixturePlugins(sitePath, options);
}

export async function restoreStudioWordPressProfilePlugins(installedPlugins) {
  return restoreStudioWordPressFixturePlugins(installedPlugins);
}

export async function loadStudioWordPressProfileExtensionModule(envVars = []) {
  const modulePath = expandHome(envValue(...envVars, ''));
  if (!modulePath) {
    return null;
  }
  return import(pathToFileURL(modulePath).href);
}

export function parseStudioWordPressProfileSiteStatus(statusResult) {
  const status = parseStudioSiteStatus(statusResult.stdout);
  if (!status.siteUrl || !status.autoLoginUrl) {
    throw new Error(`site status missing siteUrl/autoLoginUrl: ${redact(statusResult.stdout).slice(0, 1000)}`);
  }
  return status;
}

export function summarizeStudioWordPressRequests(entries = [], options = {}) {
  const byRequest = new Map();
  for (const entry of entries || []) {
    const id = entry.request_id || 'unknown';
    if (!byRequest.has(id)) {
      byRequest.set(id, []);
    }
    byRequest.get(id).push(entry);
  }

  return [...byRequest.values()]
    .map((events) => summarizeRequestEvents(events, options))
    .sort((a, b) => b.duration_ms - a.duration_ms)
    .slice(0, options.limit || 80);
}

function summarizeRequestEvents(events, options) {
  events.sort((a, b) => (a.t_ms || 0) - (b.t_ms || 0));
  const last = events[events.length - 1];
  const summary = {
    uri: redact(last?.uri || ''),
    method: last?.method,
    duration_ms: last?.t_ms || 0,
  };

  if (options.includeHttpUrls) {
    summary.http_urls = events
      .filter((event) => event.event === 'http.request.start')
      .map((event) => redact(event.data?.url || ''));
  }

  if (options.includeHooks) {
    summary.hooks = events
      .filter((event) => event.event === 'hook.stop')
      .sort((a, b) => (b.data?.duration_ms || 0) - (a.data?.duration_ms || 0))
      .slice(0, options.hookLimit || 8)
      .map((event) => ({ hook: event.data?.hook, duration_ms: event.data?.duration_ms }));
  }

  return summary;
}

function envValue(...envVars) {
  for (const envVar of envVars) {
    if (envVar && process.env[envVar]) {
      return process.env[envVar];
    }
  }
  return '';
}
