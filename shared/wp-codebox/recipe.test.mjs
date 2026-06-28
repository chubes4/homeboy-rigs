import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { runWpCodeboxRecipe, DEFAULT_RECIPE_TIMEOUT_MS } from './recipe.mjs';
import { MAX_RETAINED_STRING_LENGTH } from '../bounds.mjs';

// Inject a fake recipe-run helper through the existing DI seam
// (HOMEBOY_WP_CODEBOX_RECIPE_HELPER) so these tests exercise the wrapper's
// watchdog / stderr-propagation / dedupe behavior without a real WP Codebox
// sandbox. Each call writes a uniquely named CJS helper so require() caching
// never serves a stale module across tests.
let helperSeq = 0;
function installFakeHelper(body) {
  const dir = mkdtempSync(path.join(tmpdir(), 'wp-codebox-recipe-helper-'));
  helperSeq += 1;
  const helperPath = path.join(dir, `helper-${helperSeq}.cjs`);
  writeFileSync(helperPath, body, 'utf8');
  process.env.HOMEBOY_WP_CODEBOX_RECIPE_HELPER = helperPath;
  return helperPath;
}

function clearHelper(previous) {
  if (previous === undefined) {
    delete process.env.HOMEBOY_WP_CODEBOX_RECIPE_HELPER;
  } else {
    process.env.HOMEBOY_WP_CODEBOX_RECIPE_HELPER = previous;
  }
}

test('watchdog kills a wedged recipe-run and surfaces a failed batch instead of hanging', async () => {
  const previous = process.env.HOMEBOY_WP_CODEBOX_RECIPE_HELPER;
  const flag = path.join(mkdtempSync(path.join(tmpdir(), 'recipe-watchdog-')), 'aborted.txt');
  // A wedged child: the helper never settles. A cooperating helper would kill the
  // OS child on abort; here it records that the wrapper aborted the signal.
  installFakeHelper(`
const fs = require('node:fs');
module.exports = {
  async runWpCodeboxRecipe(options) {
    options.signal.addEventListener('abort', () => {
      fs.writeFileSync(${JSON.stringify(flag)}, 'aborted');
    });
    return new Promise(() => {});
  },
};
`);
  try {
    const started = Date.now();
    await assert.rejects(
      () => runWpCodeboxRecipe({ recipeFile: '/tmp/batch-watchdog.json', artifactsDir: '/tmp/art', timeoutMs: 50 }),
      (error) => {
        assert.match(error.message, /exceeded 50ms wall cap/);
        // Numeric, GNU-timeout-style code so the bench records an integer
        // exit_status and a failed (not hung) batch.
        assert.equal(error.code, 124);
        assert.equal(error.killed, true);
        assert.equal(error.signal, 'SIGKILL');
        assert.equal(error.timeout_ms, 50);
        return true;
      }
    );
    // It rejected promptly rather than hanging on the never-settling child.
    assert.ok(Date.now() - started < 5000, 'watchdog rejected well before any hang');
    // The wrapper aborted the signal it handed the helper (cooperating-kill path).
    assert.equal(readFileSync(flag, 'utf8'), 'aborted');
  } finally {
    clearHelper(previous);
  }
});

test('a failing child stderr (and stdout tail) propagates into the thrown error, bounded', async () => {
  const previous = process.env.HOMEBOY_WP_CODEBOX_RECIPE_HELPER;
  const hugeStderr = 'E'.repeat(MAX_RETAINED_STRING_LENGTH + 500);
  installFakeHelper(`
module.exports = {
  async runWpCodeboxRecipe() {
    const error = new Error('Command failed: node index.js recipe-run');
    error.code = 7;
    error.stderr = ${JSON.stringify(hugeStderr)};
    error.stdout = 'partial stdout line';
    throw error;
  },
};
`);
  try {
    await assert.rejects(
      () => runWpCodeboxRecipe({ recipeFile: '/tmp/batch-stderr.json', artifactsDir: '/tmp/art' }),
      (error) => {
        // Real cause now in the message (#560), not just the command line.
        assert.match(error.message, /^Command failed: node index\.js recipe-run/);
        assert.match(error.message, /stderr:\nE{100}/);
        assert.match(error.message, /stdout \(tail\):\npartial stdout line/);
        // Bounded (#555): the message carries at most the cap + notice, not the
        // full oversized stderr.
        assert.ok(error.message.includes('…[truncated]'));
        assert.ok(!error.message.includes('E'.repeat(MAX_RETAINED_STRING_LENGTH + 1)));
        // Structured fields preserved so the bench's child-command failure is
        // unchanged.
        assert.equal(error.code, 7);
        assert.equal(error.stderr, hugeStderr);
        assert.equal(error.stdout, 'partial stdout line');
        return true;
      }
    );
  } finally {
    clearHelper(previous);
  }
});

test('the success path is an unchanged passthrough of the helper result', async () => {
  const previous = process.env.HOMEBOY_WP_CODEBOX_RECIPE_HELPER;
  installFakeHelper(`
const RESULT = { stdout: '{"ok":true}', stderr: '', json: { ok: true } };
module.exports = {
  async runWpCodeboxRecipe() { return RESULT; },
};
`);
  try {
    const result = await runWpCodeboxRecipe({ recipeFile: '/tmp/batch-ok.json', artifactsDir: '/tmp/art' });
    assert.deepEqual(result, { stdout: '{"ok":true}', stderr: '', json: { ok: true } });
  } finally {
    clearHelper(previous);
  }
});

test('duplicate-process guard: a concurrent run of the same batch does not spawn a second recipe-run', async () => {
  const previous = process.env.HOMEBOY_WP_CODEBOX_RECIPE_HELPER;
  const counter = path.join(mkdtempSync(path.join(tmpdir(), 'recipe-dedupe-')), 'count.txt');
  writeFileSync(counter, '0', 'utf8');
  installFakeHelper(`
const fs = require('node:fs');
module.exports = {
  async runWpCodeboxRecipe() {
    const next = Number(fs.readFileSync(${JSON.stringify(counter)}, 'utf8')) + 1;
    fs.writeFileSync(${JSON.stringify(counter)}, String(next));
    await new Promise((resolve) => setTimeout(resolve, 30));
    return { invoked: next };
  },
};
`);
  try {
    const recipeFile = '/tmp/batch-dedupe.json';
    const [first, second] = await Promise.all([
      runWpCodeboxRecipe({ recipeFile, artifactsDir: '/tmp/art' }),
      runWpCodeboxRecipe({ recipeFile, artifactsDir: '/tmp/art' }),
    ]);
    // The helper ran once; the second concurrent call reused the in-flight run.
    assert.equal(readFileSync(counter, 'utf8'), '1');
    assert.deepEqual(first, { invoked: 1 });
    assert.equal(first, second);

    // After the run settles the guard is cleared, so a later run is allowed.
    const third = await runWpCodeboxRecipe({ recipeFile, artifactsDir: '/tmp/art' });
    assert.equal(readFileSync(counter, 'utf8'), '2');
    assert.deepEqual(third, { invoked: 2 });
  } finally {
    clearHelper(previous);
  }
});

test('the watchdog default cap is a sane positive wall bound', () => {
  assert.ok(Number.isInteger(DEFAULT_RECIPE_TIMEOUT_MS));
  assert.ok(DEFAULT_RECIPE_TIMEOUT_MS > 0);
});
