import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import { wpCodeboxArtifactPath, wpCodeboxBrowserArtifacts } from './artifacts.mjs';

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
