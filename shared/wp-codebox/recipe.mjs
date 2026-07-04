import { loadWordPressHelperModule } from '../wordpress-helper-loader.mjs';

function loadRecipeHelper() {
  return loadWordPressHelperModule({
    helperName: 'wp-codebox-recipe-helper',
    manifestFileName: 'wp-codebox-recipe-helper.js',
  });
}

export function wpCodeboxBin(env = process.env) {
  return loadRecipeHelper().wpCodeboxBin({ env });
}

export function wpCodeboxCommand(bin = wpCodeboxBin()) {
  return loadRecipeHelper().wpCodeboxCommand(bin);
}

export async function runWpCodeboxRecipe(options = {}) {
  return loadRecipeHelper().runWpCodeboxRecipe(options);
}
