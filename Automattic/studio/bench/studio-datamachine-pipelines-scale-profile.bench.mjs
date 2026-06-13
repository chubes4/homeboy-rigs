import path from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function defaultPluginPath(envName, repoName) {
  if (process.env[envName]) {
    return process.env[envName];
  }
  const studioPluginPath = path.join('/Users/chubes/Studio/intelligence-chubes4/wp-content/plugins', repoName);
  if (existsSync(studioPluginPath)) {
    return studioPluginPath;
  }
  return path.join('/Users/chubes/Developer', repoName);
}

process.env.HOMEBOY_WORDPRESS_PAGE_PROFILE_ID ||= 'datamachine-pipelines-scale';
process.env.HOMEBOY_WORDPRESS_PAGE_PROFILE_LABEL ||= 'Data Machine Pipelines Scale Profile';
process.env.HOMEBOY_WORDPRESS_PAGE_PROFILE_PATH ||= '/wp-admin/admin.php?page=datamachine-pipelines';
process.env.HOMEBOY_WORDPRESS_PAGE_PROFILE_TIMEOUT ||= '180000';
process.env.HOMEBOY_WORDPRESS_PAGE_PROFILE_RESOURCE_INCLUDE ||= '/wp-json/datamachine/v1,/wp-admin/admin.php?page=datamachine-pipelines,/wp-content/plugins/data-machine';
process.env.HOMEBOY_WORDPRESS_PAGE_PROFILE_EXTENSION_MODULE ||= path.join(
  __dirname,
  'lib/datamachine-pipelines-scale-profile.mjs'
);

process.env.HOMEBOY_DATAMACHINE_PIPELINE_COUNT ||= '12';
process.env.HOMEBOY_DATAMACHINE_FLOWS_PER_PIPELINE ||= '8';
process.env.HOMEBOY_DATAMACHINE_STEPS_PER_FLOW ||= '6';
process.env.HOMEBOY_DATAMACHINE_CONFIG_PAYLOAD_SIZE ||= '1024';

if (!process.env.HOMEBOY_WORDPRESS_PAGE_PROFILE_PLUGINS_JSON) {
  process.env.HOMEBOY_WORDPRESS_PAGE_PROFILE_PLUGINS_JSON = JSON.stringify([
    {
      slug: 'agents-api',
      plugin: 'agents-api',
      path: defaultPluginPath('HOMEBOY_AGENTS_API_PLUGIN_PATH', 'agents-api'),
      activate: true,
      copy: true,
    },
    {
      slug: 'data-machine',
      plugin: 'data-machine',
      path: defaultPluginPath('HOMEBOY_DATAMACHINE_PLUGIN_PATH', 'data-machine'),
      activate: true,
      copy: true,
    },
  ]);
}

const { default: runWordPressPageDiagnostics } = await import('./studio-site-editor-diagnostics.bench.mjs');

export default async function studioDatamachinePipelinesScaleProfileBench() {
  return runWordPressPageDiagnostics();
}
