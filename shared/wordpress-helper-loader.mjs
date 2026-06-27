import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);

const bootstrapCommand = 'homeboy extension setup wordpress';

function helperDiagnostic({ helperName, envVar, packageImport }) {
  const envLines = [
    `HOMEBOY_WORDPRESS_HELPER_MANIFEST=/path/to/homeboy-extension-wordpress/lib/helper-manifest.js`,
    `HOMEBOY_WORDPRESS_EXTENSION_ROOT=/path/to/homeboy-extension-wordpress`,
  ];

  if (envVar) {
    envLines.push(`${envVar}=/path/to/${helperName}.js`);
  }

  return [
    `Homeboy WordPress helper "${helperName}" is unavailable.`,
    packageImport ? `Missing fallback package import: ${packageImport}` : '',
    `Run ${bootstrapCommand}, then export one of:`,
    ...envLines.map((line) => `  ${line}`),
  ].filter(Boolean).join('\n');
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

function defaultHelperManifestPath() {
  const extensionRoot = process.env.HOMEBOY_WORDPRESS_EXTENSION_ROOT;
  if (extensionRoot) {
    return path.join(extensionRoot, 'lib', 'helper-manifest.js');
  }

  const home = process.env.HOME;
  if (!home) {
    return '';
  }

  const installedManifest = path.join(home, '.config', 'homeboy', 'extensions', 'wordpress', 'lib', 'helper-manifest.js');
  return existsSync(installedManifest) ? installedManifest : '';
}

export function loadWordPressHelperModule({ helperName, envVar, manifestFileName, packageImport }) {
  const explicit = envVar ? process.env[envVar] : '';
  if (explicit) {
    return requireHelper(explicit, `Failed to load ${envVar} at ${explicit}`);
  }

  const manifestPath = process.env.HOMEBOY_WORDPRESS_HELPER_MANIFEST || defaultHelperManifestPath();
  if (manifestPath) {
    const manifest = loadHelperManifest(manifestPath);
    if (manifest?.extensionRoot) {
      return requireHelper(
        path.join(manifest.extensionRoot, 'lib', manifestFileName),
        `Failed to load ${helperName} from HOMEBOY_WORDPRESS_HELPER_MANIFEST`
      );
    }
  }

  if (packageImport) {
    try {
      return require(packageImport);
    } catch (error) {
      if (error?.code !== 'MODULE_NOT_FOUND' || !String(error.message).includes(packageImport)) {
        throw error;
      }
    }
  }

  throw new Error(helperDiagnostic({ helperName, envVar, packageImport }));
}

export { bootstrapCommand as wordpressHelperBootstrapCommand };
