import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { loadWordPressHelperModule } from './wordpress-helper-loader.mjs';

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

test('WordPress helper loader reports actionable setup when no helper contract is injected', () => {
  const isolatedHome = path.join(tmpdir(), 'wordpress-helper-loader-missing-home');

  assert.throws(
    () => withEnv({
      HOME: isolatedHome,
      HOMEBOY_WORDPRESS_HELPER_MANIFEST: undefined,
      HOMEBOY_WORDPRESS_FUZZ_MANIFEST_VALIDATOR: undefined,
    }, () => loadWordPressHelperModule({
      helperName: 'wordpress-fuzz-manifest-validator',
      envVar: 'HOMEBOY_WORDPRESS_FUZZ_MANIFEST_VALIDATOR',
      manifestFileName: 'wordpress-fuzz-manifest-validator.js',
    })),
    /homeboy extension setup wordpress[\s\S]*HOMEBOY_WORDPRESS_HELPER_MANIFEST[\s\S]*HOMEBOY_WORDPRESS_FUZZ_MANIFEST_VALIDATOR/
  );
});

test('WordPress helper loader does not use extension-root discovery or package imports', () => {
  assert.throws(
    () => withEnv({
      HOMEBOY_WORDPRESS_HELPER_MANIFEST: undefined,
      HOMEBOY_WORDPRESS_EXTENSION_ROOT: path.join(tmpdir(), 'homeboy-extension-wordpress'),
      HOMEBOY_WORDPRESS_FUZZ_MANIFEST_VALIDATOR: undefined,
    }, () => loadWordPressHelperModule({
      helperName: 'wordpress-fuzz-manifest-validator',
      envVar: 'HOMEBOY_WORDPRESS_FUZZ_MANIFEST_VALIDATOR',
      manifestFileName: 'wordpress-fuzz-manifest-validator.js',
    })),
    /HOMEBOY_WORDPRESS_HELPER_MANIFEST/
  );
});

test('WordPress helper loader resolves helpers through the manifest contract', async () => {
  const extensionRoot = await mkdtemp(path.join(tmpdir(), 'wordpress-helper-extension-'));
  const libRoot = path.join(extensionRoot, 'lib');
  const manifestPath = path.join(libRoot, 'helper-manifest.js');
  const helperPath = path.join(libRoot, 'example-helper.js');

  await mkdir(libRoot, { recursive: true });
  await writeFile(helperPath, `module.exports = { loaded: true };\n`, 'utf8');
  await writeFile(manifestPath, `
const path = require('node:path');
function getWordPressHelperManifest() {
  return { extensionRoot: path.resolve(__dirname, '..') };
}
module.exports = { getWordPressHelperManifest };
`, 'utf8');

  const helper = withEnv({
    HOMEBOY_WORDPRESS_HELPER_MANIFEST: manifestPath,
    HOMEBOY_WORDPRESS_FUZZ_MANIFEST_VALIDATOR: undefined,
  }, () => loadWordPressHelperModule({
    helperName: 'example-helper',
    envVar: 'HOMEBOY_WORDPRESS_FUZZ_MANIFEST_VALIDATOR',
    manifestFileName: 'example-helper.js',
  }));

  assert.equal(helper.loaded, true);
});
