const path = require('node:path');

function getWordPressHelperManifest() {
  return { extensionRoot: path.resolve(__dirname, '..') };
}

module.exports = { getWordPressHelperManifest };
