import { expandHome, runCli } from './studio-bench.mjs';
import { loadWordPressLibHelper } from './wordpress-helper-discovery.mjs';

function fixturePluginsFromEnv({ jsonEnv, pathsEnv, fallbackJsonEnv = '', fallbackPathsEnv = '' }) {
  const json = process.env[jsonEnv] || (fallbackJsonEnv ? process.env[fallbackJsonEnv] : '');
  if (json) {
    const parsed = JSON.parse(json);
    if (!Array.isArray(parsed)) {
      throw new Error(`${jsonEnv} must be an array`);
    }
    return parsed.map((plugin) => {
      if (typeof plugin === 'string') {
        return { path: expandHome(plugin) };
      }
      return { ...plugin, path: expandHome(plugin.path) };
    });
  }

  const paths = process.env[pathsEnv] || (fallbackPathsEnv ? process.env[fallbackPathsEnv] : '');
  if (!paths) {
    return [];
  }
  return paths
    .split(',')
    .map((pluginPath) => ({ path: expandHome(pluginPath.trim()) }))
    .filter((plugin) => plugin.path);
}

function loadFixtureSetupHelper() {
  const { path: helperPath, module: helper } = loadWordPressLibHelper('fixture-setup.js');
  if (!helper?.installWordPressFixturePlugins || !helper?.restoreWordPressFixturePlugins) {
    throw new Error(
      `Homeboy WordPress fixture setup helper is unavailable${helperPath ? ` at ${helperPath}` : ''}. ` +
        'Update homeboy-extensions or set HOMEBOY_WORDPRESS_HELPER_MANIFEST.'
    );
  }
  return helper;
}

function wpCliArgs(command) {
  return ['wp', ...String(command || '').trim().split(/\s+/).filter(Boolean)];
}

export async function installStudioWordPressFixturePlugins(sitePath, options = {}) {
  const plugins = fixturePluginsFromEnv(options);
  if (plugins.length === 0) {
    return [];
  }

  const helper = loadFixtureSetupHelper();
  return helper.installWordPressFixturePlugins({
    sitePath,
    plugins,
    activateTimeoutMs: Number(process.env[options.activateTimeoutEnv] || process.env.HOMEBOY_WORDPRESS_PAGE_PROFILE_PLUGIN_ACTIVATE_TIMEOUT_MS || 420000),
    runCli: (command, context = {}) => runCli(wpCliArgs(command), { cwd: sitePath, timeoutMs: context.timeoutMs }),
  });
}

export async function restoreStudioWordPressFixturePlugins(installedPlugins) {
  if (!installedPlugins.length) {
    return;
  }
  const helper = loadFixtureSetupHelper();
  await helper.restoreWordPressFixturePlugins(installedPlugins);
}
