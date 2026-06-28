// Editor-validation recipe step for the Static Site Importer fixture matrix.
//
// Invokes the real `wp.blocks.validateBlock` editor-validation command
// (`wordpress.editor-validate-blocks`, wp-codebox #1597) against each imported
// fixture's content. This replaces the former `wordpress.editor-canvas-probe`
// step, which opened an EMPTY `post-new.php` and therefore never validated
// imported markup — it only reported whether the blank editor rendered any
// invalid-block DOM warnings (always none).
//
// The command accepts `content`/`content-file` to validate inline/file markup,
// or `target`/`post-id`/`post-type`/`url` to open a post. The matrix prefers the
// most concrete imported-content target a fixture carries, in priority order:
//   1. inline `content` (the imported post_content), if present;
//   2. a `content-file` path;
//   3. the imported `post-id`;
//   4. an explicit editor `url` (e.g. `post.php?post=<id>&action=edit`);
//   5. an explicit `target`;
//   6. otherwise bare `post-type`.
//
// LIVE-WIRING GAP (verified against wp-codebox editor-actions.ts
// `editorOpenTargetFromArgs`): a bare `post-type` with no concrete target does
// NOT open the most recently imported post. wp-codebox resolves it to
// `kind: post-new` → an EMPTY `post-new.php?post_type=<type>` editor, so the
// validation runs against zero blocks (`total_blocks: 0`) and proves nothing
// about imported markup. To assert real imported-output block validity, a
// fixture must carry one of (1)-(4) — most robustly the imported `post-id` (or
// an inline `content` snapshot of the imported post_content). Surfacing the
// imported post id out of the in-sandbox `validate-artifact` import step, then
// threading it into this step, is the remaining enablement for a true
// imported-content block-validity gate.
//
// `wait-selector`/`wait-timeout` are forwarded when provided. The per-block
// `{ name, isValid, issues }` results are read back out by
// `collectEditorValidationDiagnostics` / `collectEditorValidation`.

import {
  EDITOR_VALIDATE_BLOCKS_COMMAND,
  DEFAULT_EDITOR_VALIDATION_POST_TYPE,
} from '../shared/constants.mjs';

function present(value) {
  return value !== undefined && value !== null && String(value).trim() !== '';
}

export function editorBlockValidationStep(input = {}) {
  const fixture = input.fixture || {};

  const content = firstPresent([input.content, fixture.editor_content, fixture.editorContent, fixture.post_content, fixture.postContent, fixture.content]);
  const contentFile = firstPresent([input.contentFile, input.content_file, fixture.editor_content_file, fixture.editorContentFile, fixture.content_file]);
  const postId = firstPresent([input.postId, input.post_id, fixture.editor_post_id, fixture.editorPostId, fixture.post_id, fixture.postId]);
  const url = firstPresent([input.url, input.editorValidationUrl, input.editor_validation_url, fixture.editor_url, fixture.editorUrl]);
  const target = firstPresent([input.target, fixture.editor_target, fixture.editorTarget, fixture.target]);
  const postType = firstPresent([input.postType, input.post_type, fixture.editor_post_type, fixture.editorPostType, fixture.post_type, fixture.postType]) || DEFAULT_EDITOR_VALIDATION_POST_TYPE;

  const args = [];
  if (content !== undefined) {
    args.push(`content=${content}`);
  } else if (contentFile !== undefined) {
    args.push(`content-file=${contentFile}`);
  } else if (postId !== undefined) {
    args.push(`post-id=${postId}`);
  } else if (url !== undefined) {
    args.push(`url=${url}`);
  } else if (target !== undefined) {
    args.push(`target=${target}`);
  } else {
    args.push(`post-type=${postType}`);
  }

  const waitSelector = firstPresent([input.waitSelector, input.wait_selector, fixture.editor_wait_selector, fixture.editorWaitSelector]);
  if (waitSelector !== undefined) {
    args.push(`wait-selector=${waitSelector}`);
  }
  const waitTimeout = firstPresent([input.waitTimeout, input.wait_timeout, fixture.editor_wait_timeout, fixture.editorWaitTimeout]);
  if (waitTimeout !== undefined) {
    args.push(`wait-timeout=${waitTimeout}`);
  }

  return {
    command: EDITOR_VALIDATE_BLOCKS_COMMAND,
    args,
  };
}

function firstPresent(values) {
  for (const value of values) {
    if (present(value)) {
      return value;
    }
  }
  return undefined;
}
