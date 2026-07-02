import { existsSync } from 'node:fs';
import path from 'node:path';

export function resolveTestHomeboyWordPressHelperManifest() {
  if (process.env.HOMEBOY_WORDPRESS_HELPER_MANIFEST) {
    return process.env.HOMEBOY_WORDPRESS_HELPER_MANIFEST;
  }

  const candidates = [
    path.resolve(process.cwd(), '..', 'homeboy-extensions', 'wordpress', 'lib', 'helper-manifest.js'),
    path.resolve(process.cwd(), 'homeboy-extensions', 'wordpress', 'lib', 'helper-manifest.js'),
  ];

  const manifestPath = candidates.find((candidate) => existsSync(candidate));
  if (manifestPath) {
    return manifestPath;
  }

  throw new Error([
    'Homeboy WordPress helper manifest is required for fuzz validator tests.',
    'Set HOMEBOY_WORDPRESS_HELPER_MANIFEST=/path/to/homeboy-extensions/wordpress/lib/helper-manifest.js',
    'or run tests beside the CI checkout at ../homeboy-extensions.',
  ].join('\n'));
}
