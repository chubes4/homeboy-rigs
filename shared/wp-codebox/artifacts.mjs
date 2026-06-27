import { loadWordPressHelperModule } from '../wordpress-helper-loader.mjs';

function loadArtifactHelper() {
  return loadWordPressHelperModule({
    helperName: 'wp-codebox-artifacts',
    envVar: 'HOMEBOY_WP_CODEBOX_ARTIFACT_HELPER',
    manifestFileName: 'wp-codebox-artifacts.js',
    packageImport: 'homeboy-extension-wordpress/wp-codebox-artifacts',
  });
}

export function wpCodeboxArtifactPath(output, relativePath) {
  return loadArtifactHelper().resolveWpCodeboxManifestArtifactPath(output, relativePath);
}

export function wpCodeboxBrowserArtifacts(output, names) {
  return loadArtifactHelper().wpCodeboxBrowserArtifacts(output, names);
}
