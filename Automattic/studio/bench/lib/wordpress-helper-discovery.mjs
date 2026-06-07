import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const WORDPRESS_HELPER_CONSUMER_FILENAME = 'wordpress-helper-consumer.js';

const WORDPRESS_LIB_HELPER_KEYS = new Map([
  ['block-quality.js', 'blockQuality'],
  ['editor-canvas-probes.js', 'editorCanvasProbes'],
  ['fixture-setup.js', 'fixtureSetup'],
  ['request-profiler.js', 'requestProfiler'],
  ['timing-correlator.js', 'timingCorrelator'],
  ['wordpress-bootstrap-timeline.js', 'bootstrapTimeline'],
]);

function resolveManifestPath(options = {}) {
  return options.manifestPath || process.env.HOMEBOY_WORDPRESS_HELPER_MANIFEST || '';
}

function localManifestForConsumerDiscovery(options = {}) {
  const manifestPath = resolveManifestPath(options);
  if (!manifestPath || !existsSync(manifestPath)) {
    return { path: manifestPath || '', manifest: null };
  }

  const module = require(manifestPath);
  const manifest = typeof module.getWordPressHelperManifest === 'function'
    ? module.getWordPressHelperManifest()
    : module.WORDPRESS_HELPER_MANIFEST;
  return { path: manifestPath, manifest: manifest || null };
}

export function wordpressHelperConsumerPath(options = {}) {
  const explicit = options.consumerPath || process.env.HOMEBOY_WORDPRESS_HELPER_CONSUMER;
  if (explicit) {
    return explicit;
  }

  const { manifest } = localManifestForConsumerDiscovery(options);
  return manifest?.extensionRoot
    ? path.join(manifest.extensionRoot, 'lib', WORDPRESS_HELPER_CONSUMER_FILENAME)
    : '';
}

export function loadWordPressHelperConsumer(options = {}) {
  const helperConsumerPath = wordpressHelperConsumerPath(options);
  if (!helperConsumerPath || !existsSync(helperConsumerPath)) {
    return { path: helperConsumerPath, module: null };
  }

  return { path: helperConsumerPath, module: require(helperConsumerPath) };
}

export function loadWordPressHelperManifest(options = {}) {
  const { module: helperConsumer } = loadWordPressHelperConsumer(options);
  if (typeof helperConsumer?.loadWordPressHelperManifest === 'function') {
    return helperConsumer.loadWordPressHelperManifest(options);
  }

  return localManifestForConsumerDiscovery(options);
}

export function wordpressHelperPath(key, options = {}) {
  const { module: helperConsumer } = loadWordPressHelperConsumer(options);
  if (typeof helperConsumer?.wordpressHelperPath === 'function') {
    return helperConsumer.wordpressHelperPath(key, options);
  }

  const explicit = options.override || (options.envVar ? process.env[options.envVar] : '');
  if (explicit) {
    return explicit;
  }

  const { manifest } = localManifestForConsumerDiscovery(options);
  return manifest?.helpers?.[key] || '';
}

export function wordpressLibHelperPath(fileName, options = {}) {
  const { module: helperConsumer } = loadWordPressHelperConsumer(options);
  if (typeof helperConsumer?.wordpressLibHelperPath === 'function') {
    return helperConsumer.wordpressLibHelperPath(fileName, options);
  }

  const explicit = options.override || (options.envVar ? process.env[options.envVar] : '');
  if (explicit) {
    return explicit;
  }

  const { manifest } = localManifestForConsumerDiscovery(options);
  const helperKey = options.helperKey || WORDPRESS_LIB_HELPER_KEYS.get(fileName);
  if (helperKey && manifest?.helpers?.[helperKey]) {
    return manifest.helpers[helperKey];
  }

  return manifest?.extensionRoot ? path.join(manifest.extensionRoot, 'lib', fileName) : '';
}

export function loadWordPressLibHelper(fileName, options = {}) {
  const { module: helperConsumer } = loadWordPressHelperConsumer(options);
  if (typeof helperConsumer?.loadWordPressLibHelper === 'function') {
    return helperConsumer.loadWordPressLibHelper(fileName, options);
  }

  const helperPath = wordpressLibHelperPath(fileName, options);
  if (!helperPath || !existsSync(helperPath)) {
    return { path: helperPath, module: null };
  }
  return { path: helperPath, module: require(helperPath) };
}
