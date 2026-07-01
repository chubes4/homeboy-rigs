import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  loadNodeWorkloadUtils,
  nodeWorkloadUtilsEnvVar,
} from './nodejs-workload-utils-loader.mjs';

function withEnv(env, callback) {
  const previous = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  try {
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    return callback();
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

test('Node workload-utils loader imports the module named by HOMEBOY_NODEJS_WORKLOAD_UTILS', async () => {
  assert.equal(nodeWorkloadUtilsEnvVar, 'HOMEBOY_NODEJS_WORKLOAD_UTILS');

  const dir = await mkdtemp(path.join(tmpdir(), 'nodejs-workload-utils-loader-'));
  const helperPath = path.join(dir, 'workload-utils.mjs');
  await writeFile(helperPath, `export const marker = 'explicit-env';\nexport function metric(value, fallback = 0) {\n  const number = Number(value ?? fallback);\n  return Number.isFinite(number) ? number : fallback;\n}\n`, 'utf8');

  const module = await withEnv(
    { HOMEBOY_NODEJS_WORKLOAD_UTILS: helperPath },
    () => loadNodeWorkloadUtils()
  );

  assert.equal(module.marker, 'explicit-env');
  assert.equal(module.metric(2.5), 2.5);
});

test('Node workload-utils loader reports actionable setup when no helper path is injected', async () => {
  await assert.rejects(
    () => withEnv(
      { HOMEBOY_NODEJS_WORKLOAD_UTILS: undefined },
      () => loadNodeWorkloadUtils()
    ),
    /homeboy extension setup nodejs[\s\S]*HOMEBOY_NODEJS_WORKLOAD_UTILS[\s\S]*does not discover local sibling checkouts/
  );
});
