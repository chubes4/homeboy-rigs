export function resolveTestHomeboyWordPressHelperManifest() {
  if (process.env.HOMEBOY_WORDPRESS_HELPER_MANIFEST) {
    return process.env.HOMEBOY_WORDPRESS_HELPER_MANIFEST;
  }

  throw new Error([
    'Homeboy WordPress helper manifest is required for fuzz validator tests.',
    'Set HOMEBOY_WORDPRESS_HELPER_MANIFEST=/path/to/homeboy-extensions/wordpress/lib/helper-manifest.js.',
  ].join('\n'));
}
