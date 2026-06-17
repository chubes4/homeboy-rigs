import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const helperPath = path.join(await mkdtemp(path.join(tmpdir(), 'wp-codebox-artifact-helper-')), 'helper.cjs');
await writeFile(helperPath, `
const path = require('node:path');

function directory(output) {
  return output?.artifacts?.directory || output?.artifactsDir || '';
}

function files(output) {
  return output?.artifacts?.files || [];
}

function matches(entry, relativePath) {
  return [entry?.path, entry?.relativePath, entry?.relative_path, entry?.name]
    .filter(Boolean)
    .some((value) => value === relativePath || value.endsWith('/' + relativePath));
}

function resolveWpCodeboxManifestArtifactPath(output, relativePath) {
  const root = directory(output);
  if (!root) {
    return '';
  }
  const entry = files(output).find((candidate) => matches(candidate, relativePath));
  const entryPath = entry?.path || entry?.file || entry?.relativePath || entry?.relative_path || '';
  return entryPath ? (path.isAbsolute(entryPath) ? entryPath : path.join(root, entryPath)) : path.join(root, relativePath);
}

function wpCodeboxBrowserArtifacts(output, names) {
  return Object.fromEntries([
    ['directory', resolveWpCodeboxManifestArtifactPath(output, 'files/browser')],
    ...names.map((name) => [name, resolveWpCodeboxManifestArtifactPath(output, 'files/browser/' + name)]),
  ]);
}

module.exports = { resolveWpCodeboxManifestArtifactPath, wpCodeboxBrowserArtifacts };
`, 'utf8');

process.env.HOMEBOY_WP_CODEBOX_ARTIFACT_HELPER = helperPath;

const { wpCodeboxArtifactPath, wpCodeboxBrowserArtifacts } = await import('./artifacts.mjs');

test('WP Codebox artifact lookup falls back to current bundle layout', () => {
  const output = { artifacts: { directory: '/tmp/wp-codebox-artifacts' } };

  assert.equal(
    wpCodeboxArtifactPath(output, 'files/browser/summary.json'),
    path.join('/tmp/wp-codebox-artifacts', 'files/browser/summary.json')
  );
  assert.deepEqual(wpCodeboxBrowserArtifacts(output, ['summary.json', 'network.jsonl']), {
    directory: path.join('/tmp/wp-codebox-artifacts', 'files/browser'),
    'summary.json': path.join('/tmp/wp-codebox-artifacts', 'files/browser/summary.json'),
    'network.jsonl': path.join('/tmp/wp-codebox-artifacts', 'files/browser/network.jsonl'),
  });
});

test('WP Codebox artifact lookup prefers manifest file paths when present', () => {
  const output = {
    artifacts: {
      directory: '/tmp/wp-codebox-artifacts',
      files: [
        { path: 'browser/summary.actual.json', relativePath: 'files/browser/summary.json' },
        { path: '/external/browser/network.actual.json', relativePath: 'files/browser/network.jsonl' },
      ],
    },
  };

  assert.equal(
    wpCodeboxArtifactPath(output, 'files/browser/summary.json'),
    path.join('/tmp/wp-codebox-artifacts', 'browser/summary.actual.json')
  );
  assert.equal(
    wpCodeboxArtifactPath(output, 'files/browser/network.jsonl'),
    '/external/browser/network.actual.json'
  );
});
