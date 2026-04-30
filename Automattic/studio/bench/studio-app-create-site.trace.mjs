import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const STUDIO_PATH = process.env.HOMEBOY_COMPONENT_PATH;
const RESULTS_FILE = process.env.HOMEBOY_TRACE_RESULTS_FILE;
const ARTIFACT_DIR = process.env.HOMEBOY_TRACE_ARTIFACT_DIR || path.join(tmpdir(), 'studio-trace-artifacts');
const SCENARIO_ID = process.env.HOMEBOY_TRACE_SCENARIO || 'studio-app-create-site';
const COMPONENT_ID = process.env.HOMEBOY_COMPONENT_ID || 'studio';
const SITE_READY_TIMEOUT_MS = Number(process.env.STUDIO_TRACE_SITE_READY_TIMEOUT_MS || 300_000);

if (!STUDIO_PATH) {
  throw new Error('HOMEBOY_COMPONENT_PATH is required');
}
if (!RESULTS_FILE) {
  throw new Error('HOMEBOY_TRACE_RESULTS_FILE is required');
}

const playwright = require(require.resolve('playwright', { paths: [STUDIO_PATH] }));
const { findLatestBuild, parseElectronApp } = require(
  require.resolve('electron-playwright-helpers', { paths: [STUDIO_PATH] })
);

const timeline = [];
const assertions = [];
const artifacts = [];
const startedAt = performance.now();
const seenCliMessages = new Set();

function timestampMs() {
  return Math.round(performance.now() - startedAt);
}

function event(source, name, data = {}) {
  const entry = { t_ms: timestampMs(), source, event: name, data };
  timeline.push(entry);
  return entry;
}

// Local observation helpers preserve the current trace behavior until the Node.js
// Homeboy extension ships reusable trace probes.
function eventNameFromCliMessage(message) {
  return message
    .replace(/\u2026/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function captureCliEvents(chunk) {
  for (const line of chunk.toString().split(/\r?\n/)) {
    const match = line.match(
      /^\[CLI - ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\]\s+(.*)$/i
    );
    if (!match) {
      continue;
    }
    const [, commandId, message] = match;
    const eventName = eventNameFromCliMessage(message);
    const key = `${commandId}:${eventName}`;
    if (!eventName || seenCliMessages.has(key)) {
      continue;
    }
    seenCliMessages.add(key);
    event('cli', eventName, { command_id: commandId, message });
  }
}

function captureHarnessEvent(text) {
  const prefix = '[HOMEBOY_TRACE] ';
  if (!text.startsWith(prefix)) {
    return;
  }
  try {
    const item = JSON.parse(text.slice(prefix.length));
    if (!item || typeof item.source !== 'string' || typeof item.event !== 'string') {
      return;
    }
    event(item.source, item.event, item.data || {});
  } catch {
    // Ignore non-contract console noise.
  }
}

async function installIpcProbe(mainWindow) {
  const result = await mainWindow.evaluate(() => {
    const api = window.ipcApi;
    if (!api || api.__homeboyTraceInstalled) {
      return { installed: Boolean(api?.__homeboyTraceInstalled), wrapped: [] };
    }

    const summarize = (value) => {
      if (!value || typeof value !== 'object') {
        return value;
      }
      if (Array.isArray(value)) {
        return { length: value.length };
      }
      return {
        id: value.id,
        name: value.name,
        path: value.path,
        port: value.port,
        running: value.running,
        isAddingSite: value.isAddingSite,
      };
    };

    const emit = (eventName, data = {}) => {
      console.log(`[HOMEBOY_TRACE] ${JSON.stringify({ source: 'ipc', event: eventName, data })}`);
    };

    const wrapped = [];
    for (const name of ['createSite', 'startServer']) {
      if (typeof api[name] !== 'function') {
        continue;
      }
      const original = api[name].bind(api);
      api[name] = async (...args) => {
        emit(`${name}.invoke`, { args: args.map(summarize) });
        try {
          const result = await original(...args);
          emit(`${name}.resolve`, { result: summarize(result) });
          return result;
        } catch (error) {
          emit(`${name}.reject`, { message: error instanceof Error ? error.message : String(error) });
          throw error;
        }
      };
      wrapped.push(name);
    }

    api.__homeboyTraceInstalled = true;
    return { installed: true, wrapped };
  });
  event('probe', result.installed ? 'ipc_probe_installed' : 'ipc_probe_unavailable', {
    wrapped: result.wrapped,
  });
}

async function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function pollHttp(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let sawResponse = false;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/`, {
        signal: AbortSignal.timeout(500),
      });
      if (!sawResponse) {
        event('probe', 'http_first_response', { port, status: response.status });
        sawResponse = true;
      }
      if (response.status >= 200 && response.status < 400) {
        event('probe', 'http_ready', { port, status: response.status });
        return;
      }
      await wait(250);
    } catch {
      await wait(100);
    }
  }
  event('probe', 'http_timeout', { port });
}

async function pollSiteDetailsSeen(mainWindow, siteName, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let seenPort;

  while (Date.now() < deadline) {
    const site = await mainWindow.evaluate((name) => {
      return window.ipcApi
        .getSiteDetails()
        .then((sites) => sites.find((candidate) => candidate.name === name) || null)
        .catch(() => null);
    }, siteName);

    if (site) {
      event('probe', 'site_details_seen', {
        id: site.id,
        path: site.path,
        port: site.port,
        running: site.running,
        isAddingSite: site.isAddingSite,
      });
      if (site.port > 0 && site.port !== seenPort) {
        seenPort = site.port;
        event('probe', 'site_port_known', { id: site.id, port: site.port });
      }
      return site;
    }

    await wait(100);
  }

  event('probe', 'site_details_seen_timeout', { site_name: siteName });
  return null;
}

async function pollSiteDetailsRunning(mainWindow, siteName, timeoutMs) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const site = await mainWindow.evaluate((name) => {
      return window.ipcApi
        .getSiteDetails()
        .then((sites) => sites.find((candidate) => candidate.name === name) || null)
        .catch(() => null);
    }, siteName);

    if (site?.running) {
      event('probe', 'site_details_running_true', { id: site.id, port: site.port });
      return site;
    }

    await wait(100);
  }

  event('probe', 'site_details_running_timeout', { site_name: siteName });
  return null;
}

async function pollCliConfig(cliConfigPath, siteName, timeoutMs) {
  const configFile = path.join(cliConfigPath, 'cli.json');
  const deadline = Date.now() + timeoutMs;
  let seenSite = false;
  let seenPort;

  while (Date.now() < deadline) {
    try {
      const data = JSON.parse(await readFile(configFile, 'utf8'));
      const sites = Array.isArray(data.sites) ? data.sites : [];
      const site = sites.find((candidate) => candidate.name === siteName);
      if (site && !seenSite) {
        seenSite = true;
        event('probe', 'cli_config_site_seen', {
          id: site.id,
          path: site.path,
          port: site.port,
          running: site.running,
        });
      }
      if (site?.port > 0 && site.port !== seenPort) {
        seenPort = site.port;
        event('probe', 'cli_config_port_known', { id: site.id, port: site.port });
        return site;
      }
    } catch {
      // Config file may not exist yet or may be mid-write.
    }
    await wait(50);
  }

  event('probe', 'cli_config_port_timeout', { site_name: siteName });
  return null;
}

function assertion(id, ok, message) {
  const item = { id, status: ok ? 'pass' : 'fail', message };
  assertions.push(item);
  return item;
}

function relativeArtifact(filePath) {
  return path.relative(ARTIFACT_DIR, filePath);
}

function addArtifact(label, filePath) {
  artifacts.push({ label, path: relativeArtifact(filePath) });
}

async function captureArtifacts(mainWindow, mainProcessLog, suffix = '') {
  if (mainWindow) {
    try {
      const tracePath = path.join(ARTIFACT_DIR, `playwright-trace${suffix}.zip`);
      await mainWindow.context().tracing.stop({ path: tracePath });
      addArtifact('Playwright trace', tracePath);
    } catch {
      // Tracing may not have started or may already be stopped.
    }

    try {
      const screenshotPath = path.join(ARTIFACT_DIR, `window${suffix}.png`);
      await mainWindow.screenshot({ path: screenshotPath, fullPage: true });
      addArtifact('Window screenshot', screenshotPath);
    } catch {
      // Screenshots are best-effort evidence, not the trace's pass/fail source.
    }
  }

  if (mainProcessLog) {
    const logPath = path.join(ARTIFACT_DIR, `main-process${suffix}.log`);
    await writeFile(logPath, mainProcessLog.slice(-200_000));
    addArtifact('Main process log', logPath);
  }
}

async function writeResults(status, summary, failure) {
  const envelope = {
    component_id: COMPONENT_ID,
    scenario_id: SCENARIO_ID,
    status,
    summary,
    timeline,
    assertions,
    artifacts,
  };
  if (failure) {
    envelope.failure = failure;
  }
  await mkdir(path.dirname(RESULTS_FILE), { recursive: true });
  await writeFile(RESULTS_FILE, JSON.stringify(envelope, null, 2));
}

async function waitFor(locator, eventName, timeout = 120_000) {
  event('ui', `${eventName}.wait_start`);
  await locator.waitFor({ state: 'visible', timeout });
  event('ui', `${eventName}.visible`);
}

async function main() {
  await mkdir(ARTIFACT_DIR, { recursive: true });

  const runId = `studio-trace-${process.pid}-${Date.now()}-${randomUUID()}`;
  const sessionPath = path.join(tmpdir(), runId);
  const appDataPath = path.join(sessionPath, 'appData');
  const homePath = path.join(sessionPath, 'home');
  const cliConfigPath = path.join(sessionPath, 'cliConfig');
  const sharedConfigPath = path.join(sessionPath, 'sharedConfig');
  const studioAppDataPath = path.join(appDataPath, 'Studio');
  const siteName = `Trace Site ${process.pid}`;
  let electronApp;
  let mainWindow;
  let mainProcessLog = '';

  try {
    event('scenario', 'start', { studio_path: STUDIO_PATH });

    const outDir = path.join(STUDIO_PATH, 'apps/studio/out');
    try {
      await access(outDir);
    } catch {
      throw new Error(
        `Packaged Studio app not found at ${outDir}. Build it before tracing with: npm -w studio-app run package`
      );
    }
    const latestBuild = findLatestBuild(outDir);
    const appInfo = parseElectronApp(latestBuild);
    let executablePath = appInfo.executable;
    if (appInfo.platform === 'win32') {
      executablePath = executablePath.replace('Squirrel.exe', 'Studio.exe');
    }
    event('desktop', 'package.resolved', { executable_path: executablePath, main: appInfo.main });

    await mkdir(studioAppDataPath, { recursive: true });
    await mkdir(homePath, { recursive: true });
    await mkdir(cliConfigPath, { recursive: true });
    await mkdir(sharedConfigPath, { recursive: true });
    await writeFile(
      path.join(studioAppDataPath, 'appdata-v1.json'),
      JSON.stringify(
        {
          version: 1,
          sites: [],
          snapshots: [],
          betaFeatures: { studioSitesCli: true },
        },
        null,
        2
      )
    );
    event('desktop', 'session.prepared', { session_path: sessionPath });

    event('desktop', 'app_launch_start');
    electronApp = await playwright._electron.launch({
      args: [appInfo.main],
      executablePath,
      env: {
        ...process.env,
        E2E: 'true',
        E2E_APP_DATA_PATH: appDataPath,
        E2E_HOME_PATH: homePath,
        E2E_CLI_CONFIG_PATH: cliConfigPath,
        E2E_SHARED_CONFIG_PATH: sharedConfigPath,
      },
      timeout: 60_000,
    });
    event('desktop', 'app_launch_complete');

    const child = electronApp.process();
    child.stdout?.on('data', (chunk) => {
      mainProcessLog += chunk.toString();
      captureCliEvents(chunk);
    });
    child.stderr?.on('data', (chunk) => {
      mainProcessLog += chunk.toString();
      captureCliEvents(chunk);
    });

    event('desktop', 'first_window.wait_start');
    mainWindow = await electronApp.firstWindow({ timeout: 60_000 });
    event('desktop', 'first_window.ready', { title: await mainWindow.title() });
    await mainWindow.context().tracing.start({ screenshots: true, snapshots: true, sources: true });
    mainWindow.on('console', (message) => captureHarnessEvent(message.text()));
    await installIpcProbe(mainWindow);

    await waitFor(mainWindow.getByTestId('onboarding-welcome-title'), 'onboarding');
    await mainWindow.getByTestId('onboarding').getByRole('button', { name: 'Skip' }).click();
    event('ui', 'onboarding.skip_clicked');

    await mainWindow.getByTestId('create-site-option-button').click();
    event('ui', 'create_site.option_clicked');

    await mainWindow.getByTestId('site-name-input').fill(siteName);
    event('ui', 'create_site.name_filled', { site_name: siteName });

    await mainWindow.getByTestId('stepper-action-button').click();
    event('ui', 'create_site.submit_clicked');
    const siteDetailsSeenProbe = pollSiteDetailsSeen(mainWindow, siteName, SITE_READY_TIMEOUT_MS).catch(() => {});
    const httpProbe = pollCliConfig(cliConfigPath, siteName, SITE_READY_TIMEOUT_MS)
      .then((site) => (site?.port > 0 ? pollHttp(site.port, 60_000) : undefined))
      .catch(() => {});

    await waitFor(mainWindow.getByText(siteName, { exact: true }).first(), 'site_shell');

    const siteContent = mainWindow.getByTestId('site-content');
    await siteDetailsSeenProbe;
    await httpProbe;
    await pollSiteDetailsRunning(mainWindow, siteName, SITE_READY_TIMEOUT_MS);
    await siteContent
      .getByTestId('site-status-running')
      .or(siteContent.getByRole('button', { name: 'Running' }))
      .waitFor({ state: 'attached', timeout: SITE_READY_TIMEOUT_MS });
    event('ui', 'site.running_visible');

    await captureArtifacts(mainWindow, mainProcessLog);

    assertion('app-launched', true, 'Electron app launched and first window opened.');
    assertion('site-created-running', true, `Site "${siteName}" became visible and running.`);
    await writeResults('pass', 'Studio app opened, created a site, and reached running state.');
  } catch (error) {
    const message = error instanceof Error ? error.stack || error.message : String(error);
    event('scenario', 'error', { message: String(message).slice(0, 2000) });
    assertion('trace-completed', false, message.split('\n')[0] || 'Trace failed.');
    await captureArtifacts(mainWindow, mainProcessLog, '-failure');
    await writeResults('error', 'Studio app create-site trace failed.', message);
    throw error;
  } finally {
    if (electronApp) {
      try {
        await electronApp.evaluate(({ app }) => app.quit());
      } catch {
        // Process may already be gone.
      }
      try {
        await electronApp.close();
      } catch {
        // Playwright close can race with app quit.
      }
    }
    await rm(sessionPath, { recursive: true, force: true }).catch(() => {});
  }
}

await main();
