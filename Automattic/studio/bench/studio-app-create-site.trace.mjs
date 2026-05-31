import { access, copyFile, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const STUDIO_PATH = process.env.HOMEBOY_COMPONENT_PATH;
const RESULTS_FILE = process.env.HOMEBOY_TRACE_RESULTS_FILE;
const ARTIFACT_DIR = process.env.HOMEBOY_TRACE_ARTIFACT_DIR || path.join(tmpdir(), 'studio-trace-artifacts');
const SCENARIO_ID = process.env.HOMEBOY_TRACE_SCENARIO || 'studio-app-create-site';
const COMPONENT_ID = process.env.HOMEBOY_COMPONENT_ID || 'studio';
const SITE_READY_TIMEOUT_MS = Number(process.env.STUDIO_TRACE_SITE_READY_TIMEOUT_MS || 300_000);
const CAPTURE_SEED_DB_PATH = process.env.STUDIO_TRACE_CAPTURE_SEED_DB_PATH;
const HELPER_DIR = process.env.HOMEBOY_TRACE_HELPER_DIR;
const HTTP_PROBE_HOST = process.env.STUDIO_TRACE_HTTP_PROBE_HOST || '127.0.0.1';
const HTTP_REQUEST_TIMEOUT_MS = Number(process.env.STUDIO_TRACE_HTTP_REQUEST_TIMEOUT_MS || 500);

if (!STUDIO_PATH) {
  throw new Error('HOMEBOY_COMPONENT_PATH is required');
}
if (!RESULTS_FILE) {
  throw new Error('HOMEBOY_TRACE_RESULTS_FILE is required');
}
if (!HELPER_DIR) {
  throw new Error('HOMEBOY_TRACE_HELPER_DIR is required');
}
if (!process.env.HOMEBOY_TRACE_ARTIFACT_DIR) {
  process.env.HOMEBOY_TRACE_ARTIFACT_DIR = ARTIFACT_DIR;
}

const playwright = require(require.resolve('playwright', { paths: [STUDIO_PATH] }));
const { findLatestBuild, parseElectronApp } = require(
  require.resolve('electron-playwright-helpers', { paths: [STUDIO_PATH] })
);
const { createTraceRecorder } = await import(pathToFileURL(`${HELPER_DIR}/timeline.mjs`).href);
const { parseLogLines, pollHttp: helperPollHttp, pollJsonFile } = await import(
  pathToFileURL(`${HELPER_DIR}/probes.mjs`).href
);

const recorder = createTraceRecorder({
  componentId: COMPONENT_ID,
  scenarioId: SCENARIO_ID,
  resultsFile: RESULTS_FILE,
});
const pendingEvents = new Set();
const seenCliMessages = new Set();

function event(source, name, data = {}) {
  const promise = recorder.recordEvent(source, name, data);
  return queuePending(promise);
}

function queuePending(promise) {
  pendingEvents.add(promise);
  promise.catch(() => {}).finally(() => pendingEvents.delete(promise));
  return promise;
}

// Studio-specific event naming keeps the existing trace phase presets stable.
function eventNameFromCliMessage(message) {
  return message
    .replace(/\u2026/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

async function captureCliEvents(chunk) {
  const text = chunk.toString();
  for (const line of text.split(/\r?\n/)) {
    captureHarnessEvent(line);
  }

  await parseLogLines(
    text,
    [
      {
        source: 'cli',
        event: 'cli.message',
        pattern:
          /^\[CLI - ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\]\s+(.*)$/i,
        data: (match) => ({ command_id: match[1], message: match[2] }),
      },
    ],
    (source, _name, data) => {
      if (data.message.startsWith('[HOMEBOY_TRACE] ')) {
        captureHarnessEvent(data.message);
        return null;
      }

      const eventName = eventNameFromCliMessage(data.message);
      const key = `${data.command_id}:${eventName}`;
      if (!eventName || seenCliMessages.has(key)) {
        return null;
      }

      seenCliMessages.add(key);
      return event(source, eventName, data);
    }
  );
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

async function installRendererStateProbe(mainWindow, siteName) {
  const result = await mainWindow.evaluate((name) => {
    if (window.__homeboyRendererStateProbeInstalled) {
      return { installed: true, alreadyInstalled: true };
    }

    const emit = (eventName, data = {}) => {
      console.log(`[HOMEBOY_TRACE] ${JSON.stringify({ source: 'renderer', event: eventName, data })}`);
    };

    window.ipcListener?.subscribe?.('site-event', (_event, siteEvent) => {
      const site = siteEvent?.site;
      if (site?.name === name || siteEvent?.running) {
        emit('site_event_received', {
          event: siteEvent?.event,
          siteId: siteEvent?.siteId,
          name: site?.name,
          running: siteEvent?.running,
          isAddingSite: site?.isAddingSite,
        });
      }
      if (siteEvent?.running) {
        emit('site_running_event_received', {
          event: siteEvent?.event,
          siteId: siteEvent?.siteId,
          name: site?.name,
          running: siteEvent?.running,
          isAddingSite: site?.isAddingSite,
        });
      }
    });

    const observer = new MutationObserver(() => {
      if (document.querySelector('[data-testid="site-status-running"]')) {
        emit('dom_status_running_seen');
        observer.disconnect();
      }
    });
    observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true });

    window.__homeboyRendererStateProbeInstalled = true;
    return { installed: true, alreadyInstalled: false };
  }, siteName);
  event('probe', 'renderer_state_probe_installed', result);
}

async function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withTimeout(promise, timeoutMs) {
  let timeout;
  try {
    return await Promise.race([
      promise,
      new Promise((resolve) => {
        timeout = setTimeout(resolve, timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

function extractStudioFailureMessage(log) {
  const startServerFailure = log.match(/Failed to start WordPress server: ([^\n]+)/);
  const createSiteFailure = log.match(/Error occurred in handler for 'createSite': \[CliCommandError: ([\s\S]*?)\n\s*\[Exit code\]/);
  const exitCode = log.match(/\[Exit code\] (\d+)/);

  if (startServerFailure) {
    return `${startServerFailure[0]}${exitCode ? ` (${exitCode[0]})` : ''}`;
  }
  if (createSiteFailure) {
    return `${createSiteFailure[1].replace(/\s+/g, ' ').trim()}${exitCode ? ` (${exitCode[0]})` : ''}`;
  }
  return null;
}

async function pollHttp(port, timeoutMs, getFailureMessage = () => null) {
  const result = await Promise.race([
    helperPollHttp(`http://${HTTP_PROBE_HOST}:${port}/`, {
      source: 'probe',
      intervalMs: 250,
      readyStatus: 200,
      requestTimeoutMs: HTTP_REQUEST_TIMEOUT_MS,
      timeoutMs,
      onEvent: (source, name, data) => {
        event(source, name, data);
        if (source === 'probe' && name === 'http.first_response') {
          event('probe', 'http_first_response', { port, status: data.status });
        }
        if (source === 'probe' && name === 'http.ready') {
          event('probe', 'http_ready', { port, status: data.status });
        }
        if (source === 'probe' && name === 'http.timeout') {
          event('probe', 'http_timeout', { port });
        }
      },
    }),
    waitForStudioFailure(getFailureMessage, timeoutMs),
  ]);
  if (result.status !== 'ready') {
    throw new Error(`HTTP did not become ready on port ${port}`);
  }
  return result;
}

async function waitForStudioFailure(getFailureMessage, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const failureMessage = getFailureMessage();
    if (failureMessage) {
      event('probe', 'studio_failure_detected', { message: failureMessage });
      throw new Error(failureMessage);
    }
    await wait(100);
  }
  return { status: 'timeout' };
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

async function pollSiteDetailsRunning(mainWindow, siteName, timeoutMs, getFailureMessage = () => null) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const failureMessage = getFailureMessage();
    if (failureMessage) {
      event('probe', 'studio_failure_detected', { message: failureMessage });
      throw new Error(failureMessage);
    }

    let site;
    try {
      site = await mainWindow.evaluate((name) => {
        return window.ipcApi
          .getSiteDetails()
          .then((sites) => sites.find((candidate) => candidate.name === name) || null)
          .catch(() => null);
      }, siteName);
    } catch (error) {
      const message = getFailureMessage();
      if (message) {
        event('probe', 'studio_failure_detected', { message });
        throw new Error(message);
      }
      throw error;
    }

    if (site?.running) {
      event('probe', 'site_details_running_true', { id: site.id, port: site.port });
      return site;
    }

    await wait(100);
  }

  event('probe', 'site_details_running_timeout', { site_name: siteName });
  const failureMessage = getFailureMessage();
  throw new Error(failureMessage || `Site details never reported running for ${siteName}`);
}

async function assertHttpEndpoint(port, pathName, label, acceptStatus = (status) => status >= 200 && status < 400) {
  const url = `http://${HTTP_PROBE_HOST}:${port}${pathName}`;
  const response = await fetch(url, {
    signal: AbortSignal.timeout(HTTP_REQUEST_TIMEOUT_MS),
  });
  event('probe', 'http_endpoint_checked', {
    label,
    path: pathName,
    status: response.status,
    finalUrl: response.url,
  });
  if (!acceptStatus(response.status)) {
    throw new Error(`${label} returned HTTP ${response.status}`);
  }
}

async function assertSiteHttpSurface(site) {
  const port = site?.port;
  if (!port) {
    throw new Error('Cannot validate site HTTP surface without a known port');
  }

  await assertHttpEndpoint(port, '/', 'frontend');
  await assertHttpEndpoint(port, '/wp-json/', 'REST API');
  await assertHttpEndpoint(port, '/wp-admin/', 'wp-admin');
}

async function captureSeedDatabase(site) {
  if (!CAPTURE_SEED_DB_PATH || !site?.path) {
    return;
  }

  const source = path.join(site.path, 'wp-content', 'database', '.ht.sqlite');
  await mkdir(path.dirname(CAPTURE_SEED_DB_PATH), { recursive: true });
  await copyFile(source, CAPTURE_SEED_DB_PATH);
  event('probe', 'seed_database_captured', { source, target: CAPTURE_SEED_DB_PATH });
}

async function pollCliConfig(cliConfigPath, siteName, timeoutMs) {
  const configFile = path.join(cliConfigPath, 'cli.json');
  const result = await pollJsonFile(configFile, {
    source: 'probe',
    intervalMs: 50,
    timeoutMs,
    select: (data) => {
      const sites = Array.isArray(data.sites) ? data.sites : [];
      return sites.find((candidate) => candidate.name === siteName) || null;
    },
    events: [
      {
        name: 'cli_config_site_seen',
        when: (site) => Boolean(site),
        data: (site) => ({ id: site.id, path: site.path, port: site.port, running: site.running }),
      },
      {
        name: 'cli_config_port_known',
        when: (site) => site?.port > 0,
        data: (site) => ({ id: site.id, port: site.port }),
        terminal: true,
      },
    ],
    onEvent: (source, name, data) => {
      if (name.startsWith('json.')) {
        return null;
      }
      return event(source, name, data);
    },
  });

  if (result.status === 'matched' && result.event === 'cli_config_port_known') {
    return result.value;
  }

  event('probe', 'cli_config_port_timeout', { site_name: siteName });
  return null;
}

function assertion(id, ok, message) {
  return recorder.recordAssertion(id, ok ? 'pass' : 'fail', message);
}

function addArtifact(label, filePath) {
  return recorder.addArtifact(label, filePath);
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
  await Promise.allSettled([...pendingEvents]);
  await recorder.writeTraceResults({ status, summary, failure });
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
      queuePending(captureCliEvents(chunk));
    });
    child.stderr?.on('data', (chunk) => {
      mainProcessLog += chunk.toString();
      queuePending(captureCliEvents(chunk));
    });

    event('desktop', 'first_window.wait_start');
    mainWindow = await electronApp.firstWindow({ timeout: 60_000 });
    event('desktop', 'first_window.ready', { title: await mainWindow.title() });
    await mainWindow.context().tracing.start({ screenshots: true, snapshots: true, sources: true });
    mainWindow.on('console', (message) => captureHarnessEvent(message.text()));
    await installIpcProbe(mainWindow);
    await installRendererStateProbe(mainWindow, siteName);

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
    const currentStudioFailure = () => extractStudioFailureMessage(mainProcessLog);
    const httpProbe = pollCliConfig(cliConfigPath, siteName, SITE_READY_TIMEOUT_MS).then((site) =>
      site?.port > 0 ? pollHttp(site.port, 60_000, currentStudioFailure) : undefined
    );

    await waitFor(mainWindow.getByText(siteName, { exact: true }).first(), 'site_shell');

    const siteContent = mainWindow.getByTestId('site-content');
    await siteDetailsSeenProbe;
    await httpProbe;
    const runningSite = await pollSiteDetailsRunning(
      mainWindow,
      siteName,
      SITE_READY_TIMEOUT_MS,
      currentStudioFailure
    );
    await siteContent
      .getByTestId('site-status-running')
      .or(siteContent.getByRole('button', { name: 'Running' }))
      .waitFor({ state: 'attached', timeout: SITE_READY_TIMEOUT_MS });
    event('ui', 'site.running_visible');
    await assertSiteHttpSurface(runningSite);
    await captureSeedDatabase(runningSite);

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
        await withTimeout(electronApp.evaluate(({ app }) => app.quit()), 5_000);
      } catch {
        // Process may already be gone.
      }
      try {
        await withTimeout(electronApp.close(), 5_000);
      } catch {
        // Playwright close can race with app quit.
      }
    }
    await rm(sessionPath, { recursive: true, force: true }).catch(() => {});
    if (process.env.STUDIO_TRACE_FORCE_EXIT_AFTER_RESULTS === '1') {
      process.exit(0);
    }
  }
}

await main();
