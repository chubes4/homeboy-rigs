import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);

const bootstrapCommand = 'homeboy extension setup wordpress';

function helperDiagnostic({ helperName, envVar }) {
  const envLines = [
    `HOMEBOY_WORDPRESS_HELPER_MANIFEST=/path/to/homeboy-extensions/wordpress/lib/helper-manifest.js`,
  ];

  if (envVar) {
    envLines.push(`${envVar}=/path/to/${helperName}.js`);
  }

  return [
    `Homeboy WordPress helper "${helperName}" is unavailable.`,
    `Run ${bootstrapCommand}, then inject one of the helper contract paths explicitly:`,
    ...envLines.map((line) => `  ${line}`),
    'This loader does not discover local sibling checkouts.',
  ].filter(Boolean).join('\n');
}

function invalidManifestDiagnostic({ helperName, manifestPath }) {
  return [
    `Homeboy WordPress helper "${helperName}" could not be resolved from HOMEBOY_WORDPRESS_HELPER_MANIFEST.`,
    `Manifest path: ${manifestPath}`,
    'Expected the manifest module to expose getWordPressHelperManifest() or WORDPRESS_HELPER_MANIFEST with an extensionRoot string.',
    `Run ${bootstrapCommand}, then inject the generated helper manifest path explicitly:`,
    '  HOMEBOY_WORDPRESS_HELPER_MANIFEST=/path/to/homeboy-extensions/wordpress/lib/helper-manifest.js',
  ].join('\n');
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
    if (typeof manifest?.extensionRoot !== 'string' || manifest.extensionRoot.trim() === '') {
      throw new Error(invalidManifestDiagnostic({ helperName, manifestPath }));
    }
    return requireHelper(
      path.join(manifest.extensionRoot, 'lib', manifestFileName),
      `Failed to load ${helperName} from HOMEBOY_WORDPRESS_HELPER_MANIFEST`
    );
  }

  throw new Error(helperDiagnostic({ helperName, envVar }));
}

export { bootstrapCommand as wordpressHelperBootstrapCommand };
