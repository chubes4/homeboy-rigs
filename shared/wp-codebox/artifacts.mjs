import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);

function loadArtifactHelper() {
  const explicit = process.env.HOMEBOY_WP_CODEBOX_ARTIFACT_HELPER;
  if (explicit) {
    return require(explicit);
  }

  const manifestPath = process.env.HOMEBOY_WORDPRESS_HELPER_MANIFEST;
  if (manifestPath) {
    const manifestModule = require(manifestPath);
    const manifest = typeof manifestModule.getWordPressHelperManifest === 'function'
      ? manifestModule.getWordPressHelperManifest()
      : manifestModule.WORDPRESS_HELPER_MANIFEST;
    if (manifest?.extensionRoot) {
      return require(path.join(manifest.extensionRoot, 'lib', 'wp-codebox-artifacts.js'));
    }
  }

  return require('homeboy-extension-wordpress/wp-codebox-artifacts');
}

export function wpCodeboxArtifactPath(output, relativePath) {
  return loadArtifactHelper().resolveWpCodeboxManifestArtifactPath(output, relativePath);
}

export function wpCodeboxBrowserArtifacts(output, names) {
  return loadArtifactHelper().wpCodeboxBrowserArtifacts(output, names);
}
