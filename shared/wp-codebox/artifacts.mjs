import { loadWordPressHelperModule } from '../wordpress-helper-loader.mjs';

function loadArtifactHelper() {
  return loadWordPressHelperModule({
    helperName: 'wp-codebox-artifacts',
    manifestFileName: 'wp-codebox-artifacts.js',
  });
}

export function wpCodeboxArtifactPath(output, relativePath) {
  return loadArtifactHelper().resolveWpCodeboxManifestArtifactPath(output, relativePath);
}

export function wpCodeboxBrowserArtifacts(output, names) {
  return loadArtifactHelper().wpCodeboxBrowserArtifacts(output, names);
}
