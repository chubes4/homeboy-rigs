import { loadWordPressHelperModule } from '../wordpress-helper-loader.mjs';

function loadRecipeHelper() {
  return loadWordPressHelperModule({
    helperName: 'wp-codebox-recipe-helper',
    envVar: 'HOMEBOY_WP_CODEBOX_RECIPE_HELPER',
    manifestFileName: 'wp-codebox-recipe-helper.js',
    packageImport: 'homeboy-extension-wordpress/wp-codebox-recipe-helper',
  });
}

export function wpCodeboxBin(env = process.env) {
  return loadRecipeHelper().wpCodeboxBin({ env });
}

export function wpCodeboxCommand(bin = wpCodeboxBin()) {
  return loadRecipeHelper().wpCodeboxCommand(bin);
}

export async function runWpCodeboxRecipe(options) {
  return loadRecipeHelper().runWpCodeboxRecipe(options);
}
