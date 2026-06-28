// WP Codebox recipe building (import + editor-validation + visual-parity steps)
// and fixture-artifact construction for the Static Site Importer fixture matrix.
//
// Extracted verbatim from the former `lib/fixture-matrix.mjs` monolith as part
// of the matrix modularization (Refs #242).

import fs from 'node:fs';
import path from 'node:path';

import {
  WEBSITE_ARTIFACT_SCHEMA,
  DEFAULT_ENTRYPOINT,
  DEFAULT_IMPORTER_SLUG,
  VISUAL_PARITY_SOURCE_SUBDIR,
} from '../shared/constants.mjs';
import {
  normalizeArray,
  isTextPayloadType,
  isImagePath,
  requiredString,
  shellToken,
} from '../shared/utils.mjs';
import { createFixtureMatrix, normalizeFixture, collectFixtureFiles } from '../fixtures.mjs';
import { editorBlockValidationStep } from './editor-validation-step.mjs';
import { visualParityCompareStep, normalizeVisualParityRecipeOptions } from './visual-parity-step.mjs';

export function buildFixtureArtifact(fixture, options = {}) {
  const normalized = normalizeFixture(fixture);
  const files = collectFixtureFiles(normalized.directory, options);
  const artifactFiles = files.map((file) => {
    const payload = fs.readFileSync(file.absolute_path);
    const artifactFile = {
      path: `website/${file.relative_path}`,
      source_path: file.absolute_path,
      type: file.type,
      bytes: file.bytes,
    };
    if (isTextPayloadType(file.type)) {
      artifactFile.content = payload.toString('utf8');
    } else {
      artifactFile.content_base64 = payload.toString('base64');
    }
    return artifactFile;
  });

  return {
    schema: WEBSITE_ARTIFACT_SCHEMA,
    entrypoint: DEFAULT_ENTRYPOINT,
    entry_path: DEFAULT_ENTRYPOINT,
    files: artifactFiles,
    summary: {
      file_count: artifactFiles.length,
      entry_path: DEFAULT_ENTRYPOINT,
      has_css: artifactFiles.some((file) => file.path.endsWith('.css')),
      has_js: artifactFiles.some((file) => file.path.endsWith('.js')),
      has_images: artifactFiles.some((file) => isImagePath(file.path)),
    },
    source_metadata: {
      fixture_id: normalized.id,
      fixture_path: normalized.directory,
      fixture_entrypoint: normalized.entrypoint,
      fixture_class: normalized.fixture_class,
      fixture_tags: normalized.tags,
      fixture_complexity: normalized.complexity,
    },
  };
}

// Stage a fixture's ORIGINAL static source (index.html + css/js/images) into the
// matrix artifacts tree so the in-sandbox WordPress origin can serve it for the
// visual-parity `source-url`. Files land at
// `<fixtureDirectory>/<VISUAL_PARITY_SOURCE_SUBDIR>/<relative_path>`, preserving
// each fixture's own relative asset layout so the served page resolves its CSS,
// JS, and images exactly as the original did. The fixture's `artifact.json`
// import payload is unchanged; this is a parallel, web-servable copy of the raw
// source. Returns the list of staged relative paths. Without this, `source-url`
// points at an unserved path and the visual-compare source capture hangs to the
// 120s timeout (the #563 visual-parity gap).
export function stageFixtureSource(fixture, fixtureDirectory, options = {}) {
  const normalized = normalizeFixture(fixture);
  const files = collectFixtureFiles(normalized.directory, options);
  const sourceRoot = path.join(fixtureDirectory, VISUAL_PARITY_SOURCE_SUBDIR);
  const staged = [];
  for (const file of files) {
    const destination = path.join(sourceRoot, file.relative_path);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(file.absolute_path, destination);
    staged.push(file.relative_path);
  }
  return staged;
}

export function buildFixtureMatrixRecipe(input = {}) {
  const matrix = input.matrix || createFixtureMatrix(input);
  const artifactsDirectory = input.artifactsDirectory || input.artifacts_directory || '/artifacts/static-site-importer-fixture-matrix';
  const playgroundArtifactsDirectory = input.playgroundArtifactsDirectory || input.playground_artifacts_directory;
  const commandArtifactsDirectory = playgroundArtifactsDirectory || artifactsDirectory;
  const importer = normalizeStaticSiteImporterPlugin(input);
  const mounts = normalizeArray(input.mounts);
  const extraPlugins = [importer.extraPlugin, ...normalizeArray(input.extraPlugins || input.extra_plugins)];
  const editorValidationEnabled = input.editorValidation !== false && input.editor_validation !== false;
  // Real-content validation options forwarded to the editor-validate-blocks step.
  // No empty-post default: when nothing concrete is provided, the step opens the
  // most recently imported post (by post-type) so it validates imported content.
  const editorValidationOptions = {
    url: input.editorValidationUrl || input.editor_validation_url,
    postType: input.editorValidationPostType || input.editor_validation_post_type,
    target: input.editorValidationTarget || input.editor_validation_target,
    waitSelector: input.editorValidationWaitSelector || input.editor_validation_wait_selector,
    waitTimeout: input.editorValidationWaitTimeout || input.editor_validation_wait_timeout,
  };
  const visualParityEnabled = input.visualParity !== false && input.visual_parity !== false;
  // Keep the visual-parity `source-url` base aligned with where the staged source
  // is actually served from. The staged source lives in the artifacts dir mounted
  // into the sandbox at `playgroundArtifactsDirectory`; its WordPress-served web
  // path is that target with the docroot (`/wordpress`) prefix stripped. When the
  // operator hasn't pinned an explicit source base url, derive it from the mount
  // target so a custom uploads path still resolves.
  const derivedSourceBaseUrl = playgroundArtifactsDirectory
    ? wordpressServedPath(playgroundArtifactsDirectory)
    : '';
  const visualParityRecipeOptions = normalizeVisualParityRecipeOptions({
    ...(derivedSourceBaseUrl ? { sourceBaseUrl: derivedSourceBaseUrl } : {}),
    ...input,
  });

  if (playgroundArtifactsDirectory) {
    mounts.push({
      source: artifactsDirectory,
      target: playgroundArtifactsDirectory,
      mode: 'readwrite',
    });
  }

  return {
    schema: 'wp-codebox/workspace-recipe/v1',
    runtime: {
      wp: input.wordpressVersion || input.wordpress_version || 'latest',
      blueprint: input.blueprint || {},
    },
    inputs: {
      mounts,
      extra_plugins: extraPlugins,
    },
    workflow: {
      steps: [
        importer.activationStep,
        ...matrix.fixtures.flatMap((fixture) => [
          {
            command: 'wordpress.wp-cli',
            args: [
              `command=static-site-importer validate-artifact --artifact=${shellToken(path.join(commandArtifactsDirectory, fixture.id, 'artifact.json'))} --slug=${shellToken(fixture.id)} --name=${shellToken(fixture.label)} --allow-missing-woocommerce --allow-failure`,
            ],
          },
          ...(editorValidationEnabled ? [editorBlockValidationStep({ fixture, ...editorValidationOptions })] : []),
          ...(visualParityEnabled ? [visualParityCompareStep({ fixture, ...visualParityRecipeOptions })] : []),
        ]),
      ],
    },
    artifacts: {
      directory: artifactsDirectory,
    },
  };
}

// Convert an in-sandbox WordPress filesystem path into its web-served path by
// stripping the docroot prefix. WP Codebox installs WordPress at `/wordpress`, so
// `/wordpress/wp-content/uploads/foo` is served at `/wp-content/uploads/foo`. A
// path already rooted at `/wp-content` (no `/wordpress` prefix) is returned as-is.
export function wordpressServedPath(filesystemPath, docroot = '/wordpress') {
  const normalized = `/${String(filesystemPath).replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '')}`;
  const prefix = `${docroot.replace(/\/+$/, '')}/`;
  return normalized.startsWith(prefix) ? `/${normalized.slice(prefix.length)}` : normalized;
}

export function normalizeStaticSiteImporterPlugin(input = {}) {
  const source = requiredString(input.staticSiteImporterPath || input.static_site_importer_path, 'staticSiteImporterPath');
  const slugValue = input.staticSiteImporterSlug || input.static_site_importer_slug || DEFAULT_IMPORTER_SLUG;
  const pluginFile = input.staticSiteImporterPlugin || input.static_site_importer_plugin || `${slugValue}/${slugValue}.php`;
  return {
    extraPlugin: {
      source,
      slug: slugValue,
      activate: true,
    },
    activationStep: {
      command: 'wordpress.wp-cli',
      args: [`command=plugin activate ${pluginFile}`],
    },
  };
}
