// Editor-validation recipe step (#537) for the Static Site Importer fixture
// matrix.
//
// Extracted verbatim from the former `lib/fixture-matrix.mjs` monolith as part
// of the matrix modularization (Refs #242).

import {
  EDITOR_INVALID_BLOCK_SELECTOR_GROUP,
  EDITOR_INVALID_BLOCK_SELECTORS,
  DEFAULT_EDITOR_VALIDATION_URL,
} from '../shared/constants.mjs';

// Compose the existing `wordpress.editor-canvas-probe` recipe command into an
// editor-validation step. The probe opens the imported post in the real block
// editor canvas and reports DOM matches for the invalid-block warning selectors,
// which is exactly the surface Gutenberg renders for JS save-comparison
// failures. No new wp-codebox capability is introduced — the invalid-block
// signal is read back out of the probe's `selectorSummary` by
// `collectEditorValidationDiagnostics`.
export function editorBlockValidationStep(input = {}) {
  const fixture = input.fixture || {};
  const url = input.url || input.editorValidationUrl || fixture.editor_url || fixture.editorUrl || DEFAULT_EDITOR_VALIDATION_URL;
  const selectorGroups = [{ name: EDITOR_INVALID_BLOCK_SELECTOR_GROUP, selectors: EDITOR_INVALID_BLOCK_SELECTORS }];
  return {
    command: 'wordpress.editor-canvas-probe',
    args: [
      `url=${url}`,
      `selector-groups-json=${JSON.stringify(selectorGroups)}`,
    ],
  };
}
