import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);

function loadRecipeHelper() {
  const explicit = process.env.HOMEBOY_WP_CODEBOX_RECIPE_HELPER;
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
      return require(path.join(manifest.extensionRoot, 'lib', 'wp-codebox-recipe-helper.js'));
    }
  }

  return require('homeboy-extension-wordpress/wp-codebox-recipe-helper');
}

export function wpCodeboxBin(env = process.env) {
  return loadRecipeHelper().wpCodeboxBin({ env });
}

export function wpCodeboxCommand(bin = wpCodeboxBin()) {
  return loadRecipeHelper().wpCodeboxCommand(bin);
}

export async function runWpCodeboxRecipe(options) {
  return loadRecipeHelper().runWpCodeboxRecipe(options);
}
