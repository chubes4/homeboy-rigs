import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);

const bootstrapCommand = 'homeboy extension setup wordpress';

function helperDiagnostic({ helperName }) {
  return [
    `Homeboy WordPress helper "${helperName}" is unavailable.`,
    `Run ${bootstrapCommand}, then inject the helper manifest path explicitly:`,
    '  HOMEBOY_WORDPRESS_HELPER_MANIFEST=/path/to/homeboy-extensions/wordpress/lib/helper-manifest.js',
  ].filter(Boolean).join('\n');
}

function invalidManifestDiagnostic({ helperName, manifestPath }) {
  return [
    `Homeboy WordPress helper "${helperName}" could not be resolved from HOMEBOY_WORDPRESS_HELPER_MANIFEST.`,
    `Manifest path: ${manifestPath}`,
    'Expected the manifest module to expose getWordPressHelperManifest() or WORDPRESS_HELPER_MANIFEST with an extensionRoot string.',
    `Run ${bootstrapCommand}, then inject the generated helper manifest path explicitly:`,
    '  HOMEBOY_WORDPRESS_HELPER_MANIFEST=/path/to/homeboy-extensions/wordpress/lib/helper-manifest.js',
  ].join('\n');
}

function requireHelper(filePath, context) {
  try {
    return require(filePath);
  } catch (error) {
    error.message = `${context}: ${error.message}`;
    throw error;
  }
}

function loadHelperManifest(manifestPath) {
  const manifestModule = requireHelper(manifestPath, `Failed to load HOMEBOY_WORDPRESS_HELPER_MANIFEST at ${manifestPath}`);
  return typeof manifestModule.getWordPressHelperManifest === 'function'
    ? manifestModule.getWordPressHelperManifest()
    : manifestModule.WORDPRESS_HELPER_MANIFEST;
}

export function loadWordPressHelperManifest(options = {}) {
  const manifestPath = options.manifestPath || process.env.HOMEBOY_WORDPRESS_HELPER_MANIFEST || '';
  if (manifestPath) {
    const manifest = loadHelperManifest(manifestPath);
    if (typeof manifest?.extensionRoot !== 'string' || manifest.extensionRoot.trim() === '') {
      throw new Error(invalidManifestDiagnostic({ helperName: options.helperName || 'wordpress-helper', manifestPath }));
    }
    return { path: manifestPath, manifest, found: true, reason: '' };
  }

  return { path: '', manifest: null, found: false, reason: 'HOMEBOY_WORDPRESS_HELPER_MANIFEST is not set' };
}

export function wordpressHelperPath(name, options = {}) {
  if (options.override) {
    return options.override;
  }

  const { manifest } = loadWordPressHelperManifest({ ...options, helperName: name });
  return manifest?.helpers?.[name] || '';
}

export function wordpressLibHelperPath(fileName, options = {}) {
  if (options.override) {
    return options.override;
  }

  const { manifest } = loadWordPressHelperManifest({ ...options, helperName: fileName });
  return manifest?.extensionRoot ? path.join(manifest.extensionRoot, 'lib', fileName) : '';
}

export function loadWordPressLibHelper(fileName, options = {}) {
  const helperPath = wordpressLibHelperPath(fileName, options);
  if (!helperPath) {
    return { path: '', module: null, found: false, reason: helperDiagnostic({ helperName: fileName }) };
  }

  return {
    path: helperPath,
    module: requireHelper(helperPath, `Failed to load ${fileName} from HOMEBOY_WORDPRESS_HELPER_MANIFEST`),
    found: true,
    reason: '',
  };
}

export function loadWordPressHelperModule({ helperName, manifestFileName }) {
  const helperPath = wordpressLibHelperPath(manifestFileName, { helperName });
  if (!helperPath) {
    throw new Error(helperDiagnostic({ helperName }));
  }

  return requireHelper(
    helperPath,
    `Failed to load ${helperName} from HOMEBOY_WORDPRESS_HELPER_MANIFEST`
  );
}

export { bootstrapCommand as wordpressHelperBootstrapCommand };
