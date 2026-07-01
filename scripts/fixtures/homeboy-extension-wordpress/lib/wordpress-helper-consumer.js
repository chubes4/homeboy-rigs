const path = require('node:path');

function loadWordPressHelperManifest() {
  const manifestModule = require('./helper-manifest.js');
  const manifest = typeof manifestModule.getWordPressHelperManifest === 'function'
    ? manifestModule.getWordPressHelperManifest()
    : manifestModule.WORDPRESS_HELPER_MANIFEST;
  return { path: path.join(__dirname, 'helper-manifest.js'), manifest, found: true };
}

function wordpressHelperPath(key, options = {}) {
  const { manifest } = loadWordPressHelperManifest(options);
  return manifest?.helpers?.[key] || '';
}

function wordpressLibHelperPath(fileName, options = {}) {
  const { manifest } = loadWordPressHelperManifest(options);
  return manifest?.extensionRoot ? path.join(manifest.extensionRoot, 'lib', fileName) : '';
}

function loadWordPressLibHelper(fileName, options = {}) {
  const helperPath = wordpressLibHelperPath(fileName, options);
  return helperPath ? { path: helperPath, module: require(helperPath), found: true } : { path: '', module: null, found: false };
}

module.exports = {
  loadWordPressHelperManifest,
  wordpressHelperPath,
  wordpressLibHelperPath,
  loadWordPressLibHelper,
};
