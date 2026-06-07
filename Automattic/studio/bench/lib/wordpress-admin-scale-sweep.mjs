import { loadWordPressAdminPageScenarios } from './wordpress-page-profiler.mjs';

function loadAdminScaleSweepModule(options = {}) {
  const module = options.adminPageScenarios || loadWordPressAdminPageScenarios(options).module;
  if (!module?.normalizeWordPressAdminScaleSweepManifest || !module?.loadWordPressAdminScaleSweepManifest) {
    throw new Error('WordPress admin scale sweep helpers are unavailable. Update homeboy-extensions or set HOMEBOY_WORDPRESS_ADMIN_PAGE_SCENARIOS_PATH.');
  }
  return module;
}

export function normalizeWordPressAdminScaleSweepManifest(manifest, options = {}) {
  return loadAdminScaleSweepModule(options).normalizeWordPressAdminScaleSweepManifest(manifest, options);
}

export async function loadWordPressAdminScaleSweepManifest(options = {}) {
  return loadAdminScaleSweepModule(options).loadWordPressAdminScaleSweepManifest(options);
}
