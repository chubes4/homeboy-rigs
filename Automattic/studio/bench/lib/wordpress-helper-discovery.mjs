import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);

export function loadWordPressHelperManifest(options = {}) {
  const manifestPath = options.manifestPath || process.env.HOMEBOY_WORDPRESS_HELPER_MANIFEST;
  if (!manifestPath || !existsSync(manifestPath)) {
    return { path: manifestPath || '', manifest: null };
  }

  const module = require(manifestPath);
  const manifest = typeof module.getWordPressHelperManifest === 'function'
    ? module.getWordPressHelperManifest()
    : module.WORDPRESS_HELPER_MANIFEST;
  return { path: manifestPath, manifest: manifest || null };
}

export function wordpressHelperPath(key, options = {}) {
  const explicit = options.override || (options.envVar ? process.env[options.envVar] : '');
  if (explicit) {
    return explicit;
  }

  const { manifest } = loadWordPressHelperManifest(options);
  return manifest?.helpers?.[key] || '';
}

export function wordpressLibHelperPath(fileName, options = {}) {
  const explicit = options.override || (options.envVar ? process.env[options.envVar] : '');
  if (explicit) {
    return explicit;
  }

  const { manifest } = loadWordPressHelperManifest(options);
  return manifest?.extensionRoot ? path.join(manifest.extensionRoot, 'lib', fileName) : '';
}

export function loadWordPressLibHelper(fileName, options = {}) {
  const helperPath = wordpressLibHelperPath(fileName, options);
  if (!helperPath || !existsSync(helperPath)) {
    return { path: helperPath, module: null };
  }
  return { path: helperPath, module: require(helperPath) };
}
