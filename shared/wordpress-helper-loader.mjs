import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);

const bootstrapCommand = 'homeboy extension setup wordpress';

function helperDiagnostic({ helperName, envVar }) {
  const envLines = [
    `HOMEBOY_WORDPRESS_HELPER_MANIFEST=/path/to/homeboy-extension-wordpress/lib/helper-manifest.js`,
  ];

  if (envVar) {
    envLines.push(`${envVar}=/path/to/${helperName}.js`);
  }

  return [
    `Homeboy WordPress helper "${helperName}" is unavailable.`,
    `Run ${bootstrapCommand}, then export one of the injected helper contracts:`,
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

export function loadWordPressHelperModule({ helperName, envVar, manifestFileName }) {
  const explicit = envVar ? process.env[envVar] : '';
  if (explicit) {
    return requireHelper(explicit, `Failed to load ${envVar} at ${explicit}`);
  }

  const manifestPath = process.env.HOMEBOY_WORDPRESS_HELPER_MANIFEST;
  if (manifestPath) {
    const manifest = loadHelperManifest(manifestPath);
    if (manifest?.extensionRoot) {
      return requireHelper(
        path.join(manifest.extensionRoot, 'lib', manifestFileName),
        `Failed to load ${helperName} from HOMEBOY_WORDPRESS_HELPER_MANIFEST`
      );
    }
  }

  throw new Error(helperDiagnostic({ helperName, envVar }));
}

export { bootstrapCommand as wordpressHelperBootstrapCommand };
