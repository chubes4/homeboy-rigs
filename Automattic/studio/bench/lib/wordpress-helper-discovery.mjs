import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);

function resolveManifestPath(options = {}) {
  return options.manifestPath || process.env.HOMEBOY_WORDPRESS_HELPER_MANIFEST || '';
}

function loadWordPressHelperConsumerModule(options = {}) {
  const explicit = options.consumerPath || process.env.HOMEBOY_WORDPRESS_HELPER_CONSUMER;
  if (explicit) {
    return require(explicit);
  }

  const manifestPath = resolveManifestPath(options);
  if (manifestPath) {
    const manifestModule = require(manifestPath);
    const manifest = typeof manifestModule.getWordPressHelperManifest === 'function'
      ? manifestModule.getWordPressHelperManifest()
      : manifestModule.WORDPRESS_HELPER_MANIFEST;
    if (manifest?.extensionRoot) {
      return require(path.join(manifest.extensionRoot, 'lib', 'wordpress-helper-consumer.js'));
    }
  }

  try {
    return require('homeboy-extension-wordpress/wordpress-helper-consumer');
  } catch (error) {
    if (error?.code !== 'MODULE_NOT_FOUND') {
      throw error;
    }
    return null;
  }
}

function missingHandle(resolvedPath = '', reason = 'WordPress helper consumer is unavailable') {
  return { path: resolvedPath, module: null, found: false, reason };
}

export function wordpressHelperConsumerPath(options = {}) {
  const explicit = options.consumerPath || process.env.HOMEBOY_WORDPRESS_HELPER_CONSUMER;
  if (explicit) {
    return explicit;
  }

  const consumer = loadWordPressHelperConsumerModule(options);
  if (!consumer) {
    return '';
  }
  const { manifest } = consumer.loadWordPressHelperManifest(options);
  return manifest?.extensionRoot ? path.join(manifest.extensionRoot, 'lib', 'wordpress-helper-consumer.js') : '';
}

export function loadWordPressHelperConsumer(options = {}) {
  const helperConsumerPath = wordpressHelperConsumerPath(options);
  const consumer = loadWordPressHelperConsumerModule(options);
  return consumer ? { path: helperConsumerPath, module: consumer } : missingHandle(helperConsumerPath);
}

export function loadWordPressHelperManifest(options = {}) {
  const consumer = loadWordPressHelperConsumerModule(options);
  return consumer
    ? consumer.loadWordPressHelperManifest(options)
    : { path: '', manifest: null, found: false, reason: 'WordPress helper consumer is unavailable' };
}

export function wordpressHelperPath(key, options = {}) {
  const explicit = options.override || (options.envVar ? process.env[options.envVar] : '');
  if (explicit) {
    return explicit;
  }
  return loadWordPressHelperConsumerModule(options)?.wordpressHelperPath(key, options) || '';
}

export function wordpressLibHelperPath(fileName, options = {}) {
  const explicit = options.override || (options.envVar ? process.env[options.envVar] : '');
  if (explicit) {
    return explicit;
  }
  return loadWordPressHelperConsumerModule(options)?.wordpressLibHelperPath(fileName, options) || '';
}

export function loadWordPressLibHelper(fileName, options = {}) {
  return loadWordPressHelperConsumerModule(options)?.loadWordPressLibHelper(fileName, options) || missingHandle(wordpressLibHelperPath(fileName, options));
}
