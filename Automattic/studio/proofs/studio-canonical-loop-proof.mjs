#!/usr/bin/env node

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const defaultHostRequestPath = path.join(packageRoot, 'fixtures', 'studio-canonical-loop', 'host-request.json');
const execFileAsync = promisify(execFile);

function argValue(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? null : process.argv[index + 1] || null;
}

function hasArg(name) {
  return process.argv.includes(name);
}

function now() {
  return new Date().toISOString();
}

function artifactFile(artifact, filePath) {
  return artifact.files.find((file) => file.path === filePath);
}

function writeArtifactFile(artifact, filePath, content) {
  const file = artifactFile(artifact, filePath);
  if (!file) {
    throw new Error(`Artifact file not found: ${filePath}`);
  }
  file.content = content;
}

function createGeneratedArtifact(hostRequest) {
  return {
    schema: hostRequest.artifact_contract.schema,
    root: 'website',
    entrypoint: hostRequest.artifact_contract.entrypoint,
    files: [
      {
        path: 'website/index.html',
        mime_type: 'text/html',
        content: '<!doctype html>\n<html lang="en">\n<head>\n  <meta charset="utf-8">\n  <meta name="viewport" content="width=device-width, initial-scale=1">\n  <title>Canonical Loop Proof</title>\n  <link rel="stylesheet" href="assets/styles.css">\n</head>\n<body>\n  <main class="hero">\n    <p class="eyebrow">Fisiostetic rehab studio</p>\n    <h1>Move Better. Feel Stronger.</h1>\n    <p>Hands-on treatment, guided strength work, and a clear plan from first visit to full return.</p>\n    <a href="/contact/">Book an assessment</a>\n  </main>\n</body>\n</html>\n'
      },
      {
        path: 'website/assets/styles.css',
        mime_type: 'text/css',
        content: ':root { --bg: #f6f1e8; --ink: #17312b; --accent: #ce5f36; }\nbody { margin: 0; font-family: Inter, ui-sans-serif, system-ui, sans-serif; color: var(--ink); background: var(--bg); }\n.hero { min-height: 100vh; display: grid; align-content: center; gap: 1.25rem; width: min(960px, calc(100% - 40px)); margin: 0 auto; }\n.eyebrow { color: var(--accent); font-weight: 800; letter-spacing: .12em; text-transform: uppercase; }\nh1 { max-width: 760px; margin: 0; font-size: clamp(3rem, 8vw, 6.5rem); line-height: .9; }\np { max-width: 620px; font-size: 1.2rem; line-height: 1.55; }\na { color: var(--bg); background: var(--ink); width: max-content; padding: .9rem 1.2rem; border-radius: 999px; text-decoration: none; font-weight: 800; }\n'
      }
    ],
    provenance: {
      generated_by: 'stubbed-codebox-fanout',
      host_request_id: hostRequest.request_id,
      generated_at: now()
    }
  };
}

function materializeBlockTheme(artifact, generation) {
  const html = artifactFile(artifact, artifact.entrypoint)?.content || '';
  const css = artifactFile(artifact, 'website/assets/styles.css')?.content || '';
  const titleMatch = html.match(/<h1>(.*?)<\/h1>/i);

  return {
    slug: `canonical-loop-proof-${generation}`,
    files: [
      {
        path: 'style.css',
        content: `/*\nTheme Name: Canonical Loop Proof ${generation}\n*/\n${css}`
      },
      {
        path: 'templates/index.html',
        content: `<!-- wp:group {"tagName":"main","className":"canonical-loop-proof"} -->\n<main class="wp-block-group canonical-loop-proof">\n<!-- wp:heading {"level":1} -->\n<h1>${titleMatch?.[1] || 'Canonical Loop Proof'}</h1>\n<!-- /wp:heading -->\n<!-- wp:paragraph -->\n<p>Materialized from the canonical website artifact.</p>\n<!-- /wp:paragraph -->\n</main>\n<!-- /wp:group -->\n`
      },
      {
        path: 'theme.json',
        content: `${JSON.stringify({ version: 3, settings: { layout: { contentSize: '960px', wideSize: '1180px' } } }, null, 2)}\n`
      }
    ],
    diagnostics: {
      importer: 'static-site-importer-stub',
      fallback_blocks: 0,
      source_file_count: artifact.files.length,
      theme_file_count: 3,
      materialized_at: now()
    }
  };
}

async function writeJson(filePath, value) {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function materializeWithLocalWp(artifact, generation, outDir, hostRequest) {
  const requestDir = path.join(outDir, 'wp-cli-requests');
  await mkdir(requestDir, { recursive: true });

  const inputPath = path.join(requestDir, `ssi-import-${generation}.json`);
  const scriptPath = path.join(requestDir, `ssi-import-${generation}.php`);
  const reportPath = path.join(outDir, `ssi-import-report.${generation}.json`);
  const slug = `canonical-loop-proof-${generation}-${Date.now()}`.toLowerCase().replace(/[^a-z0-9_-]+/g, '-');
  const input = {
    artifact,
    slug,
    name: `Canonical Loop Proof ${generation}`,
    activate: false,
    overwrite: true,
    fail_on_quality: false,
    allow_missing_woocommerce: true,
    report: reportPath,
    source_metadata: {
      schema: 'studio/canonical-loop/source-metadata/v1',
      host_request_id: hostRequest.request_id,
      canonical_store: hostRequest.artifact_contract.canonical_store,
      proof_mode: 'local-wp'
    }
  };

  await writeJson(inputPath, input);
  await writeFile(scriptPath, `<?php
$input_path = ${JSON.stringify(inputPath)};
if ( '' === $input_path || ! file_exists( $input_path ) ) {
    fwrite( STDERR, "Missing SSI input JSON.\n" );
    exit( 2 );
}
$input = json_decode( file_get_contents( $input_path ), true );
if ( ! is_array( $input ) ) {
    fwrite( STDERR, "Invalid SSI input JSON.\n" );
    exit( 2 );
}
if ( ! function_exists( 'static_site_importer_ability_import_website_artifact' ) ) {
    fwrite( STDERR, "Static Site Importer website artifact ability callback is unavailable.\n" );
    exit( 3 );
}
$result = static_site_importer_ability_import_website_artifact( $input );
echo wp_json_encode( $result, JSON_PRETTY_PRINT ) . "\n";
if ( ! is_array( $result ) || empty( $result['success'] ) ) {
    exit( 4 );
}
`);

  const wpCli = argValue('--wp-cli') || 'studio';
  const wpArgs = wpCli === 'studio'
    ? ['wp', 'eval-file', scriptPath]
    : ['eval-file', scriptPath];
  const { stdout, stderr } = await execFileAsync(wpCli, wpArgs, { maxBuffer: 1024 * 1024 * 10 });
  const result = JSON.parse(stdout);
  const outputPath = path.join(outDir, `ssi-materialized-theme.${generation}.json`);
  await writeJson(outputPath, {
    schema: 'studio/canonical-loop/local-wp-ssi-materialization/v1',
    generation,
    slug,
    input: inputPath,
    report: reportPath,
    stdout: result,
    stderr: stderr.trim() || undefined
  });

  return {
    path: outputPath,
    slug,
    report: reportPath,
    result,
    diagnostics: result.import_report_summary || result.result?.import_report_summary || {}
  };
}

async function main() {
  const checkOnly = hasArg('--check');
  const mode = argValue('--mode') || 'stub';
  const hostRequestPath = argValue('--host-request') || defaultHostRequestPath;
  const outDir = path.resolve(argValue('--out') || path.join(os.tmpdir(), `studio-canonical-loop-proof-${process.pid}`));

  if (!['stub', 'local-wp'].includes(mode)) {
    throw new Error('Supported modes are stub and local-wp. Full live mode requires a Studio Native runtime with the Codebox handoff route installed.');
  }

  const hostRequest = JSON.parse(await readFile(hostRequestPath, 'utf8'));
  const requiredFields = ['schema', 'request_id', 'prompt', 'fanout', 'artifact_contract', 'user_change'];
  for (const field of requiredFields) {
    if (!hostRequest[field]) {
      throw new Error(`Host request fixture is missing ${field}`);
    }
  }

  if (checkOnly) {
    console.log('Studio canonical loop proof fixture passed validation.');
    return;
  }

  await mkdir(outDir, { recursive: true });

  const progress = {
    schema: 'studio/canonical-loop/progress/v1',
    run_id: `canonical-loop-${process.pid}-${Date.now()}`,
    mode,
    host_request: hostRequestPath,
    steps: []
  };

  function step(name, evidence = {}) {
    progress.steps.push({ name, status: 'ok', recorded_at: now(), ...evidence });
  }

  step('host_request_received', { request_id: hostRequest.request_id, fanout_targets: hostRequest.fanout.targets });

  const generatedArtifact = createGeneratedArtifact(hostRequest);
  const fanoutPath = path.join(outDir, 'codebox-fanout-artifact.json');
  await writeJson(fanoutPath, generatedArtifact);
  step('codebox_fanout_generation_stubbed', { artifact: fanoutPath, generated_files: generatedArtifact.files.map((file) => file.path) });

  const canonicalArtifact = structuredClone(generatedArtifact);
  canonicalArtifact.provenance.canonical_store = hostRequest.artifact_contract.canonical_store;
  canonicalArtifact.provenance.stored_at = now();
  const canonicalPath = path.join(outDir, 'studio-native-canonical-artifact.v1.json');
  await writeJson(canonicalPath, canonicalArtifact);
  step('studio_native_canonical_artifact_stored_stubbed', { artifact: canonicalPath });

  const firstTheme = mode === 'local-wp'
    ? await materializeWithLocalWp(canonicalArtifact, 'initial', outDir, hostRequest)
    : { path: path.join(outDir, 'ssi-materialized-theme.initial.json'), diagnostics: materializeBlockTheme(canonicalArtifact, 'initial').diagnostics, result: materializeBlockTheme(canonicalArtifact, 'initial') };
  if (mode === 'stub') {
    await writeJson(firstTheme.path, firstTheme.result);
  }
  step(mode === 'local-wp' ? 'ssi_materialized_block_theme_local_wp' : 'ssi_materialized_block_theme_stubbed', { theme: firstTheme.path, diagnostics: firstTheme.diagnostics });

  const mutatedArtifact = structuredClone(canonicalArtifact);
  const change = hostRequest.user_change;
  const changedFile = artifactFile(mutatedArtifact, change.file);
  if (!changedFile || !changedFile.content.includes(change.from)) {
    throw new Error(`User change target text not found in ${change.file}`);
  }
  writeArtifactFile(mutatedArtifact, change.file, changedFile.content.replace(change.from, change.to));
  mutatedArtifact.provenance.user_mutation = { operation: change.operation, file: change.file, mutated_at: now() };
  const mutatedPath = path.join(outDir, 'studio-native-canonical-artifact.v2.json');
  await writeJson(mutatedPath, mutatedArtifact);
  step('user_change_mutated_original_artifact_stubbed', { artifact: mutatedPath, change });

  const secondTheme = mode === 'local-wp'
    ? await materializeWithLocalWp(mutatedArtifact, 'reimport', outDir, hostRequest)
    : { path: path.join(outDir, 'ssi-materialized-theme.reimport.json'), diagnostics: materializeBlockTheme(mutatedArtifact, 'reimport').diagnostics, result: materializeBlockTheme(mutatedArtifact, 'reimport') };
  if (mode === 'stub') {
    await writeJson(secondTheme.path, secondTheme.result);
  }
  step(mode === 'local-wp' ? 'reimport_materialized_updated_theme_local_wp' : 'reimport_materialized_updated_theme_stubbed', { theme: secondTheme.path, diagnostics: secondTheme.diagnostics });

  const diagnostics = {
    schema: 'studio/canonical-loop/diagnostics/v1',
    real: mode === 'local-wp' ? [
      'Static Site Importer website artifact materialization through local WordPress/WP-CLI',
      'Reimport materialization through local WordPress/WP-CLI'
    ] : [],
    stubbed: [
      'Codebox/fanout generation',
      'Studio Native canonical artifact store',
      'User edit propagation back into the original artifact',
      ...(mode === 'local-wp' ? [] : [
        'Static Site Importer materialization in ephemeral Codebox/site',
        'Reimport execution'
      ])
    ],
    blockers: mode === 'local-wp' ? [
      'Codebox fanout generation is still stubbed by this local proof.',
      'Studio Native canonical artifact persistence is still filesystem-stubbed by this local proof.',
      'Full live mode requires a Studio Native runtime/site with the Codebox artifact-session route installed.',
      'Reviewer-facing artifact bundle links still need a durable publication surface.'
    ] : [
      'Host request API contract needs an executable endpoint and auth shape.',
      'Codebox fanout generation needs a durable artifact bundle contract for website artifacts.',
      'Studio Native needs a canonical website artifact store/read/update surface.',
      'SSI reimport needs an idempotent CLI or ability path that accepts the stored canonical artifact.',
      'Progress diagnostics need stable reviewer-facing artifact bundle links.'
    ],
    assertions: {
      canonical_artifact_schema_preserved: mutatedArtifact.schema === generatedArtifact.schema,
      user_change_reaches_reimport_theme: mode === 'local-wp'
        ? Boolean(JSON.stringify(secondTheme.result).includes(change.to) || JSON.stringify(secondTheme.diagnostics).includes(change.to))
        : secondTheme.result.files.some((file) => file.content.includes(change.to)),
      fallback_blocks: secondTheme.diagnostics.fallback_blocks ?? secondTheme.diagnostics.core_html_block_count ?? 0,
      local_wp_ssi_success: mode === 'local-wp' ? Boolean(firstTheme.result.success && secondTheme.result.success) : undefined
    }
  };
  const diagnosticsPath = path.join(outDir, 'diagnostics.json');
  await writeJson(diagnosticsPath, diagnostics);

  const progressPath = path.join(outDir, 'progress.json');
  await writeJson(progressPath, progress);

  const result = {
    schema: 'studio/canonical-loop/proof-result/v1',
    success: diagnostics.assertions.canonical_artifact_schema_preserved && diagnostics.assertions.user_change_reaches_reimport_theme,
    mode,
    artifacts: {
      progress: progressPath,
      diagnostics: diagnosticsPath,
      fanout_artifact: fanoutPath,
      canonical_artifact_v1: canonicalPath,
      canonical_artifact_v2: mutatedPath,
      initial_theme: firstTheme.path,
      reimport_theme: secondTheme.path
    },
    real_vs_stubbed: {
      real: diagnostics.real,
      stubbed: diagnostics.stubbed
    }
  };
  const resultPath = path.join(outDir, 'result.json');
  await writeJson(resultPath, result);

  console.log(JSON.stringify({ result: resultPath, progress: progressPath, diagnostics: diagnosticsPath, success: result.success }, null, 2));
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
