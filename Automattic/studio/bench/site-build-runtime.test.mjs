import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

process.env.HOMEBOY_COMPONENT_PATH ||= '/tmp/homeboy-rigs-test-component';

const workloadUtilsDir = await mkdtemp(path.join(os.tmpdir(), 'homeboy-node-workload-utils-'));
const workloadUtilsPath = path.join(workloadUtilsDir, 'workload-utils.mjs');
await writeFile(workloadUtilsPath, `
import os from 'node:os';
import path from 'node:path';

export function artifactDir(name, options = {}) {
  return path.join(options.sharedState || process.env.HOMEBOY_BENCH_SHARED_STATE || os.tmpdir(), name);
}

export function expandHome(value) {
  if (!value) return value;
  if (value === '~') return os.homedir();
  if (value.startsWith('~/')) return path.join(os.homedir(), value.slice(2));
  return value;
}

export function metric(value, fallback = 0) {
  const number = Number(value ?? fallback);
  return Number.isFinite(number) ? number : fallback;
}

export function redactText(value) {
  return String(value || '');
}

export async function sanitizeArtifactFile(file) {
  return { path: file };
}

export function safeResult(result) {
  return result;
}

export function setting(key, fallback = '') {
  try {
    const settings = JSON.parse(process.env.HOMEBOY_SETTINGS_JSON || '{}');
    if (settings && settings[key] !== undefined && settings[key] !== null) return String(settings[key]);
  } catch {}
  return process.env['HOMEBOY_SETTINGS_' + String(key).toUpperCase()] || fallback;
}

export function runNode() {
  throw new Error('runNode is not used by these unit tests.');
}
`);
process.env.HOMEBOY_NODEJS_WORKLOAD_UTILS ||= workloadUtilsPath;

const invocationRuntimeHelper = `data:text/javascript,${encodeURIComponent(`
export function resolveHomeboyInvocationRuntime({ namespace }) {
  const state = process.env.HOMEBOY_INVOCATION_STATE_DIR ? process.env.HOMEBOY_INVOCATION_STATE_DIR + '/' + namespace : null;
  const artifact = process.env.HOMEBOY_INVOCATION_ARTIFACT_DIR ? process.env.HOMEBOY_INVOCATION_ARTIFACT_DIR + '/' + namespace : null;
  const tmp = process.env.HOMEBOY_INVOCATION_TMP_DIR ? process.env.HOMEBOY_INVOCATION_TMP_DIR + '/' + namespace : null;
  const env = {
    HOMEBOY_INVOCATION_NAMESPACE: namespace,
    HOMEBOY_INVOCATION_STATE_DIR: state,
    HOMEBOY_INVOCATION_ARTIFACT_DIR: artifact,
    HOMEBOY_INVOCATION_TMP_DIR: tmp,
    TMPDIR: tmp,
    TMP: tmp,
    TEMP: tmp,
    HOME: state + '/home',
    XDG_CONFIG_HOME: state + '/config',
    XDG_CACHE_HOME: state + '/cache',
    XDG_DATA_HOME: state + '/data',
    XDG_STATE_HOME: state,
  };
  return {
    isolated: true,
    namespace,
    invocationId: process.env.HOMEBOY_INVOCATION_ID || null,
    baseDirs: {
      state: process.env.HOMEBOY_INVOCATION_STATE_DIR || null,
      artifact: process.env.HOMEBOY_INVOCATION_ARTIFACT_DIR || null,
      tmp: process.env.HOMEBOY_INVOCATION_TMP_DIR || null,
    },
    dirs: { state, artifact, tmp },
    portRange: {
      base: Number(process.env.HOMEBOY_INVOCATION_PORT_BASE),
      max: Number(process.env.HOMEBOY_INVOCATION_PORT_MAX),
    },
    env,
    childEnv(extra = {}) {
      return { ...env, ...extra };
    },
    async prepareDirs() {},
    assertPort(port) { return Number(port); },
  };
}
`)}`;

async function withEnv(values, callback) {
  const previous = {};
  for (const key of Object.keys(values)) {
    previous[key] = process.env[key];
    if (values[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = values[key];
    }
  }

  try {
    return await callback();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

const { INVOCATION_NAMESPACE, createFreshSite, createInvocationRuntime, siteStatus } = await import(
  './lib/site-build-runtime.mjs'
);

test('invocation runtime seam exposes generic isolated state only', async () => {
  await withEnv(
    {
      HOMEBOY_NODEJS_INVOCATION_RUNTIME_HELPER: invocationRuntimeHelper,
      HOMEBOY_INVOCATION_ID: 'inv-seam-test',
      HOMEBOY_INVOCATION_STATE_DIR: '/tmp/inv-seam/state',
      HOMEBOY_INVOCATION_ARTIFACT_DIR: '/tmp/inv-seam/artifacts',
      HOMEBOY_INVOCATION_TMP_DIR: '/tmp/inv-seam/tmp',
      HOMEBOY_INVOCATION_PORT_BASE: '22000',
      HOMEBOY_INVOCATION_PORT_MAX: '22009',
    },
    async () => {
      const runtime = await createInvocationRuntime({ namespace: INVOCATION_NAMESPACE });

      assert.equal(runtime.invocationId, 'inv-seam-test');
      assert.equal(runtime.stateDir, '/tmp/inv-seam/state/studio-agent-site-build');
      assert.equal(runtime.artifactDir, '/tmp/inv-seam/artifacts/studio-agent-site-build');
      assert.equal(runtime.tmpDir, '/tmp/inv-seam/tmp/studio-agent-site-build');
      assert.equal(runtime.portBase, 22000);
      assert.equal(runtime.portMax, 22009);
      assert.equal(runtime.cliConfigDir, undefined);
      assert.equal(runtime.appDataDir, undefined);
      assert.equal(runtime.processManagerHome, undefined);

      assert.deepEqual(runtime.childEnv({ EXTRA_ENV: 'extra-value' }), {
        HOMEBOY_INVOCATION_NAMESPACE: 'studio-agent-site-build',
        HOMEBOY_INVOCATION_STATE_DIR: '/tmp/inv-seam/state/studio-agent-site-build',
        HOMEBOY_INVOCATION_ARTIFACT_DIR: '/tmp/inv-seam/artifacts/studio-agent-site-build',
        HOMEBOY_INVOCATION_TMP_DIR: '/tmp/inv-seam/tmp/studio-agent-site-build',
        TMPDIR: '/tmp/inv-seam/tmp/studio-agent-site-build',
        TMP: '/tmp/inv-seam/tmp/studio-agent-site-build',
        TEMP: '/tmp/inv-seam/tmp/studio-agent-site-build',
        HOME: '/tmp/inv-seam/state/studio-agent-site-build/home',
        XDG_CONFIG_HOME: '/tmp/inv-seam/state/studio-agent-site-build/config',
        XDG_CACHE_HOME: '/tmp/inv-seam/state/studio-agent-site-build/cache',
        XDG_DATA_HOME: '/tmp/inv-seam/state/studio-agent-site-build/data',
        XDG_STATE_HOME: '/tmp/inv-seam/state/studio-agent-site-build',
        EXTRA_ENV: 'extra-value',
      });
    }
  );
});

test('site-build CLI wrappers pass resolved invocation env objects', async () => {
  await withEnv(
    {
      HOMEBOY_NODEJS_INVOCATION_RUNTIME_HELPER: invocationRuntimeHelper,
      HOMEBOY_INVOCATION_ID: 'inv-env-test',
      HOMEBOY_INVOCATION_STATE_DIR: '/tmp/inv-env/state',
      HOMEBOY_INVOCATION_ARTIFACT_DIR: '/tmp/inv-env/artifacts',
      HOMEBOY_INVOCATION_TMP_DIR: '/tmp/inv-env/tmp',
      HOMEBOY_INVOCATION_PORT_BASE: '21000',
      HOMEBOY_INVOCATION_PORT_MAX: '21009',
      STUDIO_CALLER_ENV: 'caller-value',
    },
    async () => {
      const calls = [];
      await createFreshSite('/tmp/example-site', {
        env: { EXTRA_CREATE_ENV: 'create-value' },
        async createStudioSite(sitePath, options) {
          calls.push({ name: 'createFreshSite', sitePath, options });
        },
      });

      const status = await siteStatus('/tmp/example-site', {
        env: { EXTRA_STATUS_ENV: 'status-value' },
        async studioSiteStatusJson(sitePath, options) {
          calls.push({ name: 'siteStatus', sitePath, options });
          return { ok: true };
        },
      });

      assert.deepEqual(status, { ok: true });
      assert.equal(calls.length, 2);

      for (const call of calls) {
        assert.equal(call.sitePath, '/tmp/example-site');
        assert.equal(typeof call.options.env, 'object');
        assert.equal(typeof call.options.env.then, 'undefined');
        assert.equal(call.options.env.STUDIO_CALLER_ENV, 'caller-value');
        assert.equal(call.options.env.HOMEBOY_INVOCATION_NAMESPACE, 'studio-agent-site-build');
        assert.equal(call.options.env.HOMEBOY_INVOCATION_STATE_DIR, '/tmp/inv-env/state/studio-agent-site-build');
        assert.equal(call.options.env.HOMEBOY_INVOCATION_ARTIFACT_DIR, '/tmp/inv-env/artifacts/studio-agent-site-build');
        assert.equal(call.options.env.HOMEBOY_INVOCATION_TMP_DIR, '/tmp/inv-env/tmp/studio-agent-site-build');
        assert.equal(call.options.env.HOME, '/tmp/inv-env/state/studio-agent-site-build/home');
        assert.equal(call.options.env.XDG_CONFIG_HOME, '/tmp/inv-env/state/studio-agent-site-build/config');
        assert.equal(call.options.env.XDG_CACHE_HOME, '/tmp/inv-env/state/studio-agent-site-build/cache');
        assert.equal(call.options.env.XDG_DATA_HOME, '/tmp/inv-env/state/studio-agent-site-build/data');
        assert.equal(call.options.env.XDG_STATE_HOME, '/tmp/inv-env/state/studio-agent-site-build');
        assert.equal(call.options.env.E2E, '1');
        assert.equal(call.options.env.E2E_CLI_CONFIG_PATH, '/tmp/inv-env/state/studio-agent-site-build/cli-config');
        assert.equal(call.options.env.E2E_APP_DATA_PATH, '/tmp/inv-env/state/studio-agent-site-build/appdata');
        assert.equal(call.options.env.STUDIO_PROCESS_MANAGER_HOME, '/tmp/inv-env/state/studio-agent-site-build/daemon');
      }

      assert.equal(calls[0].options.env.EXTRA_CREATE_ENV, 'create-value');
      assert.equal(calls[1].options.env.EXTRA_STATUS_ENV, 'status-value');
    }
  );
});
