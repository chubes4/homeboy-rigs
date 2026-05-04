import { mkdir, writeFile } from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { artifactDir as studioArtifactDir, metric, runCli, safeResult, variant } from './lib/studio-bench.mjs';

async function createSite(sitePath) {
  return runCli([
    'site',
    'create',
    '--name',
    `Studio Bench ${variant()} Theme Page ${process.pid}`,
    '--path',
    sitePath,
    '--skip-browser',
    '--skip-log-details',
  ], { timeoutMs: 420000 });
}

async function siteStatus(sitePath) {
  return runCli(['site', 'status', '--path', sitePath, '--format', 'json'], { timeoutMs: 90000 });
}

async function stopSite(sitePath) {
  return runCli(['site', 'stop', '--path', sitePath], { allowFailure: true, timeoutMs: 90000 });
}

function parseStatus(stdout) {
  const parsed = JSON.parse(stdout);
  if (!parsed.siteUrl || !parsed.autoLoginUrl) {
    throw new Error(`site status missing siteUrl/autoLoginUrl: ${stdout.slice(0, 1000)}`);
  }
  return parsed;
}

function cookieHeader(jar) {
  return Object.entries(jar)
    .map(([key, value]) => `${key}=${value}`)
    .join('; ');
}

function absorbCookies(headers, jar) {
  for (const cookie of headers['set-cookie'] || []) {
    const pair = cookie.split(';', 1)[0];
    const eq = pair.indexOf('=');
    if (eq > 0) {
      jar[pair.slice(0, eq)] = pair.slice(eq + 1);
    }
  }
}

function fetchTimed(url, jar, redirects = 0) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const client = parsed.protocol === 'https:' ? https : http;
    const started = Date.now();
    let ttfbMs = 0;
    let bytes = 0;
    let bodyHead = '';
    const req = client.request(
      parsed,
      {
        method: 'GET',
        headers: {
          Accept: 'text/html,application/xhtml+xml',
          'User-Agent': 'homeboy-studio-admin-theme-page-bench/1.0',
          ...(Object.keys(jar).length ? { Cookie: cookieHeader(jar) } : {}),
        },
      },
      (res) => {
        ttfbMs = Date.now() - started;
        absorbCookies(res.headers, jar);

        const location = res.headers.location;
        if (location && [301, 302, 303, 307, 308].includes(res.statusCode || 0) && redirects < 8) {
          res.resume();
          const nextUrl = new URL(location, parsed).toString();
          fetchTimed(nextUrl, jar, redirects + 1).then(resolve, reject);
          return;
        }

        res.on('data', (chunk) => {
          bytes += chunk.length;
          if (bodyHead.length < 4000) {
            bodyHead += chunk.toString('utf8');
          }
        });
        res.on('end', () => {
          resolve({
            url,
            final_url: parsed.toString(),
            status: res.statusCode || 0,
            redirects,
            ttfb_ms: ttfbMs,
            total_ms: Date.now() - started,
            bytes,
            title: bodyHead.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1]?.trim() || '',
            login_form_seen: /id=["']loginform["']/.test(bodyHead) ? 1 : 0,
          });
        });
      }
    );
    req.setTimeout(120000, () => {
      req.destroy(new Error(`GET ${url} timed out after 120000ms`));
    });
    req.on('error', reject);
    req.end();
  });
}

async function loadAdminPages(status) {
  const jar = {};
  const login = await fetchTimed(status.autoLoginUrl, jar);
  const siteUrl = status.siteUrl.endsWith('/') ? status.siteUrl : `${status.siteUrl}/`;
  const themes = await fetchTimed(new URL('wp-admin/themes.php', siteUrl).toString(), jar);
  const addThemes = await fetchTimed(new URL('wp-admin/theme-install.php', siteUrl).toString(), jar);
  const addThemesWarm = await fetchTimed(new URL('wp-admin/theme-install.php', siteUrl).toString(), jar);

  return { login, themes, addThemes, addThemesWarm };
}

export default async function studioAdminThemePageBench() {
  const currentVariant = variant();
  const runId = `${currentVariant}-admin-theme-page-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const artifactDir = studioArtifactDir('studio-admin-theme-page-artifacts');
  const sitePath = path.join(artifactDir, 'sites', runId);
  await mkdir(path.dirname(sitePath), { recursive: true });

  const totalStarted = Date.now();
  const create = await createSite(sitePath);
  const statusResult = await siteStatus(sitePath);
  const status = parseStatus(statusResult.stdout);
  const pageLoads = await loadAdminPages(status);
  const stop = await stopSite(sitePath);
  const totalElapsedMs = Date.now() - totalStarted;

  const artifactFile = path.join(artifactDir, `result-${runId}.json`);
  await mkdir(artifactDir, { recursive: true });
  await writeFile(
    artifactFile,
    JSON.stringify(
      {
        variant: currentVariant,
        sitePath,
        siteUrl: status.siteUrl,
        timings: {
          site_create_ms: create.elapsedMs,
          site_status_ms: statusResult.elapsedMs,
          total_elapsed_ms: totalElapsedMs,
        },
        commands: {
          create: safeResult(create),
          status: safeResult(statusResult),
          stop: safeResult(stop),
        },
        pageLoads,
      },
      null,
      2
    )
  );

  return {
    metrics: {
      success_rate: 1,
      elapsed_ms: totalElapsedMs,
      site_create_ms: metric(create.elapsedMs),
      site_status_ms: metric(statusResult.elapsedMs),
      themes_status: metric(pageLoads.themes.status),
      themes_ttfb_ms: metric(pageLoads.themes.ttfb_ms),
      themes_total_ms: metric(pageLoads.themes.total_ms),
      themes_bytes: metric(pageLoads.themes.bytes),
      add_themes_status: metric(pageLoads.addThemes.status),
      add_themes_ttfb_ms: metric(pageLoads.addThemes.ttfb_ms),
      add_themes_total_ms: metric(pageLoads.addThemes.total_ms),
      add_themes_bytes: metric(pageLoads.addThemes.bytes),
      add_themes_warm_status: metric(pageLoads.addThemesWarm.status),
      add_themes_warm_ttfb_ms: metric(pageLoads.addThemesWarm.ttfb_ms),
      add_themes_warm_total_ms: metric(pageLoads.addThemesWarm.total_ms),
      add_themes_warm_bytes: metric(pageLoads.addThemesWarm.bytes),
      login_form_seen: metric(pageLoads.themes.login_form_seen + pageLoads.addThemes.login_form_seen),
      total_elapsed_ms: totalElapsedMs,
    },
    artifacts: {
      raw_result: artifactFile,
      site_path: sitePath,
    },
  };
}
