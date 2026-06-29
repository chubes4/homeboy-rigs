import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { runWpCodeboxRecipe } from './recipe.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../..');

let helperSeq = 0;

function installFakeRecipeHelper(body) {
  const dir = mkdtempSync(path.join(tmpdir(), 'wp-codebox-recipe-contract-'));
  helperSeq += 1;
  const helperPath = path.join(dir, `helper-${helperSeq}.cjs`);
  writeFileSync(helperPath, body, 'utf8');
  process.env.HOMEBOY_WP_CODEBOX_RECIPE_HELPER = helperPath;
}

function walk(directory, files = []) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!['.git', '.datamachine', '.claude', 'node_modules', 'vendor'].includes(entry.name)) {
        walk(path.join(directory, entry.name), files);
      }
      continue;
    }

    if (entry.isFile() && /\.(?:json|md|mjs|js|sh)$/.test(entry.name)) {
      files.push(path.join(directory, entry.name));
    }
  }
  return files;
}

test('WP Codebox recipe adapter delegates duplicate concurrent runs upstream without Rigs dedupe', async () => {
  const previous = process.env.HOMEBOY_WP_CODEBOX_RECIPE_HELPER;
  const counter = path.join(mkdtempSync(path.join(tmpdir(), 'recipe-contract-')), 'count.txt');
  writeFileSync(counter, '0', 'utf8');
  installFakeRecipeHelper(`
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
    const recipeFile = '/tmp/batch-contract.json';
    const [first, second] = await Promise.all([
      runWpCodeboxRecipe({ recipeFile, artifactsDir: '/tmp/art' }),
      runWpCodeboxRecipe({ recipeFile, artifactsDir: '/tmp/art' }),
    ]);

    assert.equal(readFileSync(counter, 'utf8'), '2');
    assert.deepEqual(first, { invoked: 1 });
    assert.deepEqual(second, { invoked: 2 });
  } finally {
    if (previous === undefined) {
      delete process.env.HOMEBOY_WP_CODEBOX_RECIPE_HELPER;
    } else {
      process.env.HOMEBOY_WP_CODEBOX_RECIPE_HELPER = previous;
    }
  }
});

test('WP Codebox shared adapters do not carry quarantined generic helper behavior', () => {
  const forbidden = [
    /DEFAULT_RECIPE_TIMEOUT_MS/,
    /WATCHDOG_TIMEOUT_EXIT_CODE/,
    /inFlightRecipeRuns/,
    /Promise\.race/,
    /AbortController/,
    /command -v wp-codebox/,
    /files\/browser\/\*/,
    /packageImport/,
  ];

  for (const file of ['artifacts.mjs', 'browser-coverage-trace.mjs', 'recipe.mjs'].map((name) => path.join(__dirname, name))) {
    const rel = path.relative(repoRoot, file);
    const contents = readFileSync(file, 'utf8');
    for (const pattern of forbidden) {
      assert.doesNotMatch(contents, pattern, `${rel} must not contain ${pattern}`);
    }
  }
});

test('repo docs and manifests do not present smoke as proof', () => {
  const smokeProofPattern = /smoke[^\n.]{0,80}(proof|proven|evidence)|(?:proof|proven|evidence)[^\n.]{0,80}smoke/i;
  const negativeQualifier = /\bnot\b|\bno\b|\bwithout\b|\bonly\b|contract sanity/i;

  for (const file of walk(repoRoot)) {
    const rel = path.relative(repoRoot, file);
    if (rel === 'shared/wp-codebox/contract.test.mjs') {
      continue;
    }
    const lines = readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, index) => {
      if (smokeProofPattern.test(line) && !negativeQualifier.test(line)) {
        assert.fail(`${rel}:${index + 1} must not claim smoke as proof`);
      }
    });
  }
});
