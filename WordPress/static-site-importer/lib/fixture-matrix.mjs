import fs from 'node:fs';
import path from 'node:path';

export const FIXTURE_MATRIX_SCHEMA = 'homeboy-rigs/static-site-importer-fixture-matrix/v1';
export const FIXTURE_MATRIX_RESULT_SCHEMA = 'homeboy-rigs/static-site-importer-fixture-matrix-result/v1';
export const WEBSITE_ARTIFACT_SCHEMA = 'blocks-engine/php-transformer/site-artifact/v1';

const DEFAULT_ENTRYPOINT = 'website/index.html';
const DEFAULT_IMPORTER_SLUG = 'static-site-importer';
const DEFAULT_FINDING_GROUPS = {
  button_style_loss: {
    patterns: [/default gray button/i, /button.*gray/i, /button.*style/i],
    candidate_repo: 'blocks-engine',
    repair_mode: 'transformer-style-parity',
  },
  broken_svg: {
    patterns: [/broken svg/i, /svg.*broken/i, /svg.*missing/i],
    candidate_repo: 'blocks-engine',
    repair_mode: 'svg-transformer-parity',
  },
  dropped_images: {
    patterns: [/dropped image/i, /missing image/i, /image.*missing/i, /asset.*missing/i],
    candidate_repo: 'static-site-importer',
    repair_mode: 'asset-materialization',
  },
  invalid_block_content: {
    patterns: [/unexpected or invalid content/i, /invalid block/i, /block validation/i],
    candidate_repo: 'blocks-engine',
    repair_mode: 'block-validation-parity',
  },
  runtime_target_gap: {
    patterns: [/runtime_dependency_target_missing/i, /html_canvas_runtime_fallback/i, /canvas/i, /animation/i, /script target/i],
    candidate_repo: 'blocks-engine',
    repair_mode: 'runtime-dom-target-parity',
  },
};

export function discoverFixtures(root, options = {}) {
  const fixtureRoot = requiredDirectory(root || options.fixtureRoot || options.fixture_root, 'fixtureRoot');
  const entrypoint = options.entrypoint || 'index.html';
  const maxDepth = finiteNumber(options.maxDepth ?? options.max_depth, 2);
  const fixtures = [];

  visitFixtureDirectory(fixtureRoot, 0, maxDepth, (directory) => {
    const entryPath = path.join(directory, entrypoint);
    if (!fs.existsSync(entryPath) || !fs.statSync(entryPath).isFile()) {
      return;
    }

    fixtures.push(normalizeFixture({ root: fixtureRoot, directory, entrypoint }));
  });

  return fixtures.sort((left, right) => left.id.localeCompare(right.id));
}

export function createFixtureMatrix(input = {}) {
  const fixtures = normalizeArray(input.fixtures || discoverFixtures(input.fixture_root || input.fixtureRoot, input))
    .map((fixture) => normalizeFixture(fixture));
  return {
    schema: FIXTURE_MATRIX_SCHEMA,
    id: input.id || input.run_id || input.runId || 'static-site-importer-fixture-matrix',
    fixture_root: input.fixture_root || input.fixtureRoot || fixtures[0]?.fixture_root || '',
    entrypoint: input.entrypoint || 'index.html',
    count: fixtures.length,
    fixtures,
    artifacts: {
      result: input.result_artifact || input.resultArtifact || 'static-site-fixture-matrix-result.json',
      summary: input.summary_artifact || input.summaryArtifact || 'summary.json',
      findings: input.findings_artifact || input.findingsArtifact || 'finding-packets.json',
    },
  };
}

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
    },
  };
}

export function buildFixtureMatrixRecipe(input = {}) {
  const matrix = input.matrix || createFixtureMatrix(input);
  const artifactsDirectory = input.artifactsDirectory || input.artifacts_directory || '/artifacts/static-site-importer-fixture-matrix';
  const playgroundArtifactsDirectory = input.playgroundArtifactsDirectory || input.playground_artifacts_directory;
  const commandArtifactsDirectory = playgroundArtifactsDirectory || artifactsDirectory;
  const importer = normalizeStaticSiteImporterPlugin(input);
  const mounts = normalizeArray(input.mounts);
  const extraPlugins = [importer.extraPlugin, ...normalizeArray(input.extraPlugins || input.extra_plugins)];

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
        ...matrix.fixtures.map((fixture) => ({
          command: 'wordpress.wp-cli',
          args: [
            `command=static-site-importer validate-artifact --artifact=${shellToken(path.join(commandArtifactsDirectory, fixture.id, 'artifact.json'))} --slug=${shellToken(fixture.id)} --name=${shellToken(fixture.label)} --allow-missing-woocommerce --allow-failure`,
          ],
        })),
      ],
    },
    artifacts: {
      directory: artifactsDirectory,
    },
  };
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

export function normalizeFixtureMatrixResult(input = {}) {
  const matrix = input.matrix || createFixtureMatrix(input);
  const results = normalizeArray(input.results || input.fixture_results || input.fixtureResults).map(normalizeFixtureResult);
  const resultByFixture = new Map(results.map((result) => [result.fixture_id, result]));
  const fixtureResults = matrix.fixtures.map((fixture) => resultByFixture.get(fixture.id) || normalizeFixtureResult({ fixture_id: fixture.id, fixture_path: fixture.fixture_path, status: 'not_run' }));
  const findings = fixtureResults.flatMap((result) => findingsForFixtureResult(result, { matrix }));
  const grouped = groupFindings(findings);

  return {
    schema: FIXTURE_MATRIX_RESULT_SCHEMA,
    matrix_id: matrix.id,
    fixture_root: matrix.fixture_root,
    summary: {
      fixture_count: matrix.fixtures.length,
      succeeded: fixtureResults.filter((result) => result.status === 'passed').length,
      failed: fixtureResults.filter((result) => result.status === 'failed').length,
      not_run: fixtureResults.filter((result) => result.status === 'not_run').length,
      finding_count: findings.length,
      groups: Object.fromEntries(Object.entries(grouped).map(([key, items]) => [key, items.length])),
      top_pattern_families: topPatternFamilies(findings),
      fixture_exemplars: fixtureExemplars(findings),
      diagnostic_blind_spots: diagnosticBlindSpots(findings),
    },
    fixtures: fixtureResults,
    findings,
    fanout_groups: Object.entries(grouped).map(([group_key, items], index) => ({
      group_key,
      index,
      count: items.length,
      top_pattern_families: topPatternFamilies(items, 5),
      fixture_exemplars: fixtureExemplars(items, 5),
      findings: items,
    })),
  };
}

export function collectFixtureMatrixRunResults(input = {}) {
  const matrix = input.matrix || createFixtureMatrix(input);
  const outputDirectory = requiredString(input.outputDirectory || input.output_directory, 'outputDirectory');
  const codeboxOutput = input.codeboxOutput || input.codebox_output || readJsonFileIfExists(input.outputFile || input.output_file) || null;
  const codeboxError = input.codeboxError || input.codebox_error || null;
  const runtimePayloads = collectRuntimePayloads(codeboxOutput);
  const results = matrix.fixtures.map((fixture) => {
    const fixtureArtifactsDirectory = path.join(outputDirectory, fixture.id);
    const payloads = [
      ...runtimePayloads.filter((payload) => fixtureIdentity(payload) === fixture.id),
      ...readFixturePayloadFiles(fixtureArtifactsDirectory),
    ];
    return normalizeCollectedFixtureResult({ fixture, payloads, fixtureArtifactsDirectory, codeboxError });
  });

  return normalizeFixtureMatrixResult({ matrix, results });
}

export function writeFixtureMatrixArtifacts(input = {}) {
  const outputDirectory = requiredString(input.outputDirectory || input.output_directory, 'outputDirectory');
  const matrix = input.matrix || createFixtureMatrix(input);
  const result = input.result || normalizeFixtureMatrixResult({ ...input, matrix });

  fs.mkdirSync(outputDirectory, { recursive: true });
  for (const fixture of matrix.fixtures) {
    const fixtureDirectory = path.join(outputDirectory, fixture.id);
    fs.mkdirSync(fixtureDirectory, { recursive: true });
    writeJsonFile(path.join(fixtureDirectory, 'artifact.json'), buildFixtureArtifact(fixture, input));
  }

  writeJsonFile(path.join(outputDirectory, 'matrix.json'), matrix);
  writeFixtureMatrixResultArtifacts({ outputDirectory, matrix, result });

  return {
    matrix,
    result,
    artifact_refs: [
      artifactRef('matrix', path.join(outputDirectory, 'matrix.json'), 'matrix'),
      artifactRef('result', path.join(outputDirectory, 'static-site-fixture-matrix-result.json'), 'diagnostic'),
      artifactRef('summary', path.join(outputDirectory, 'summary.json'), 'summary'),
      artifactRef('finding-packets', path.join(outputDirectory, 'finding-packets.json'), 'diagnostic'),
    ],
  };
}

export function writeFixtureMatrixResultArtifacts(input = {}) {
  const outputDirectory = requiredString(input.outputDirectory || input.output_directory, 'outputDirectory');
  const matrix = input.matrix || createFixtureMatrix(input);
  const result = input.result || normalizeFixtureMatrixResult({ ...input, matrix });
  writeJsonFile(path.join(outputDirectory, 'static-site-fixture-matrix-result.json'), result);
  writeJsonFile(path.join(outputDirectory, 'summary.json'), result.summary);
  writeJsonFile(path.join(outputDirectory, 'finding-packets.json'), result.findings);
  return result;
}

export function classifyStaticSiteFinding(input = {}) {
  const haystack = [input.kind, input.type, input.code, input.category, input.repair_bucket, input.group_key, input.message, input.reason, input.detail]
    .filter(Boolean)
    .join(' ');
  for (const [group_key, group] of Object.entries(DEFAULT_FINDING_GROUPS)) {
    if (group.patterns.some((pattern) => pattern.test(haystack))) {
      return { group_key, candidate_repo: group.candidate_repo, repair_mode: group.repair_mode };
    }
  }
  return {
    group_key: DEFAULT_FINDING_GROUPS[input.group_key] ? input.group_key : 'static_site_import_quality',
    candidate_repo: input.candidate_repo || 'static-site-importer',
    repair_mode: input.repair_mode || 'import-validation',
  };
}

function findingsForFixtureResult(result, context = {}) {
  const diagnostics = normalizeArray(result.diagnostics || result.findings || result.messages);
  const findings = diagnostics.map((diagnostic, index) => normalizeDiagnosticFinding(diagnostic, result, index));
  if (result.status === 'failed' && findings.length === 0) {
    findings.push(normalizeDiagnosticFinding({ kind: 'fixture_failed', message: result.error || 'Static-site fixture validation failed without a structured diagnostic.' }, result, 0));
  }
  if (context.matrix?.fixtures?.some((fixture) => fixture.id === result.fixture_id) && result.status === 'not_run') {
    findings.push(normalizeDiagnosticFinding({ kind: 'fixture_not_run', message: 'Static-site fixture was discovered but did not produce a validation result.' }, result, 0));
  }
  return findings;
}

function normalizeDiagnosticFinding(diagnostic, result, index) {
  const raw = diagnostic && typeof diagnostic === 'object' ? diagnostic : { message: String(diagnostic || '') };
  const rawSource = objectValue(raw.source);
  const rawObserved = objectValue(raw.observed);
  const rawExpected = objectValue(raw.expected);
  const rawReproduction = objectValue(raw.reproduction_context || raw.reproductionContext);
  const message = raw.message || raw.reason || raw.detail || rawObserved.reason_code || rawExpected.outcome || raw.code || result.error || '';
  const group = classifyStaticSiteFinding({ ...raw, message });
  const kind = raw.kind || raw.code || raw.type || rawObserved.reason_code || 'static_site_fixture_diagnostic';
  const selector = raw.selector || rawSource.selector || rawReproduction.selector || '';
  const sourcePath = raw.source_path || raw.path || rawSource.path || rawReproduction.source_path || result.fixture_path || '';
  const repairBucket = raw.repair_bucket || group.group_key;
  return {
    id: raw.id || `${result.fixture_id || 'fixture'}:${group.group_key}:${index + 1}`,
    kind,
    category: raw.category || group.group_key,
    group_key: group.group_key,
    repair_bucket: repairBucket,
    severity: raw.severity || (result.status === 'failed' ? 'error' : 'warning'),
    fixture_id: result.fixture_id || '',
    path: sourcePath,
    source_path: sourcePath,
    selector,
    selector_family: selectorFamily(selector),
    pattern_family: patternFamily({ ...raw, kind, group_key: group.group_key, repair_bucket: repairBucket, selector }),
    reason: message,
    source_snippet: raw.source_html_preview || raw.html_excerpt || rawSource.snippet || '',
    observed_output: raw.emitted_block_preview || rawObserved.output || '',
    observed_block_name: raw.block_name || rawObserved.block_name || '',
    repair_mode: raw.repair_mode || group.repair_mode,
    candidate_repo: raw.candidate_repo || group.candidate_repo,
    artifact_refs: normalizeArray(raw.artifact_refs),
    raw,
  };
}

function normalizeFixture(input) {
  const directory = requiredDirectory(input.directory || input.path || input.fixture_path || input.fixturePath, 'fixture.directory');
  const root = input.root || input.fixture_root || input.fixtureRoot || path.dirname(directory);
  const relative = path.relative(path.resolve(root), path.resolve(directory));
  const id = slug(input.id || input.slug || (relative && !relative.startsWith('..') ? relative : path.basename(directory)));
  return {
    id,
    label: input.label || input.name || id,
    directory,
    fixture_path: directory,
    fixture_root: root,
    entrypoint: input.entrypoint || 'index.html',
  };
}

function normalizeFixtureResult(input) {
  let status = input.status || 'not_run';
  if (!input.status && input.success === true) {
    status = 'passed';
  } else if (!input.status && input.success === false) {
    status = 'failed';
  }
  return {
    fixture_id: input.fixture_id || input.fixtureId || input.id || '',
    fixture_path: input.fixture_path || input.fixturePath || input.path || '',
    status,
    success: status === 'passed',
    error: input.error || input.message || '',
    ssi_validation: input.ssi_validation || input.ssiValidation || null,
    import_report: input.import_report || input.importReport || null,
    quality_metrics: input.quality_metrics || input.qualityMetrics || {},
    blocks_engine_diagnostics: normalizeArray(input.blocks_engine_diagnostics || input.blocksEngineDiagnostics),
    invalid_block_counts: input.invalid_block_counts || input.invalidBlockCounts || {},
    missing_assets: normalizeArray(input.missing_assets || input.missingAssets),
    runtime_target_gaps: normalizeArray(input.runtime_target_gaps || input.runtimeTargetGaps),
    diagnostics: normalizeArray(input.diagnostics || input.findings || input.messages),
    artifact_refs: normalizeArray(input.artifact_refs || input.artifactRefs),
    artifacts: input.artifacts || {},
    raw: input,
  };
}

function normalizeCollectedFixtureResult({ fixture, payloads, fixtureArtifactsDirectory, codeboxError }) {
  const merged = mergeObjects(payloads);
  const diagnostics = collectFixtureDiagnostics(merged);
  const error = firstString([
    merged.error,
    merged.message && isFailurePayload(merged) ? merged.message : '',
    codeboxError && payloads.length === 0 ? codeboxError.message || String(codeboxError) : '',
  ]);
  const success = inferFixtureSuccess(merged, diagnostics, error, payloads.length);
  return normalizeFixtureResult({
    fixture_id: fixture.id,
    fixture_path: fixture.fixture_path,
    status: fixtureStatus(payloads.length, error, success),
    success,
    error,
    ssi_validation: merged.ssi_validation || merged.ssiValidation || merged.validation || merged.static_site_importer || null,
    import_report: merged.import_report || merged.importReport || merged.report || null,
    quality_metrics: collectQualityMetrics(merged),
    blocks_engine_diagnostics: collectBlocksEngineDiagnostics(merged),
    invalid_block_counts: collectInvalidBlockCounts(merged),
    missing_assets: collectMissingAssets(merged),
    runtime_target_gaps: collectRuntimeTargetGaps(merged),
    diagnostics,
    artifact_refs: collectFixtureArtifactRefs(merged, fixtureArtifactsDirectory),
    artifacts: merged.artifacts || {},
    raw: { payloads },
  });
}

function collectFixtureDiagnostics(payload) {
  const diagnostics = [
    ...normalizeArray(payload.diagnostics),
    ...normalizeArray(payload.fixture_diagnostics?.diagnostics || payload.fixtureDiagnostics?.diagnostics),
    ...normalizeArray(payload.findings),
    ...collectFindingPacketDiagnostics(payload),
    ...normalizeArray(payload.messages),
    ...normalizeArray(payload.errors),
    ...normalizeArray(payload.warnings),
    ...normalizeArray(payload.upstream_gaps || payload.upstreamGaps).map((gap) => ({ kind: 'upstream_gap', ...objectValue(gap), message: diagnosticMessage(gap) || gap.missing || 'Upstream capability gap detected.' })),
    ...collectBlocksEngineDiagnostics(payload),
    ...collectRuntimeTargetGaps(payload).map((gap) => ({ kind: 'runtime_target_gap', ...objectValue(gap), message: diagnosticMessage(gap) || 'Runtime target gap detected.' })),
    ...collectMissingAssets(payload).map((asset) => ({ kind: missingAssetKind(asset), ...objectValue(asset), message: diagnosticMessage(asset) || 'Missing imported asset.' })),
  ];
  const invalidBlockCount = Object.values(collectInvalidBlockCounts(payload)).reduce((sum, value) => sum + numberValue(value), 0);
  if (invalidBlockCount > 0) {
    diagnostics.push({ kind: 'invalid_block_content', message: `${invalidBlockCount} invalid block${invalidBlockCount === 1 ? '' : 's'} reported by SSI validation.` });
  }
  return dedupeDiagnostics(diagnostics);
}

function collectFindingPacketDiagnostics(payload) {
  return [
    ...normalizeArray(payload.finding_packets?.packets || payload.findingPackets?.packets),
    ...normalizeArray(payload.import_report?.finding_packets?.packets || payload.importReport?.finding_packets?.packets),
    ...normalizeArray(payload.report?.finding_packets?.packets),
  ];
}

function topPatternFamilies(findings, limit = 10) {
  const families = new Map();
  for (const finding of findings) {
    const key = finding.pattern_family || patternFamily(finding);
    const row = families.get(key) || {
      key,
      count: 0,
      repair_bucket: finding.repair_bucket || finding.group_key || '',
      kind: finding.kind || '',
      candidate_repo: finding.candidate_repo || '',
      fixture_ids: [],
      selectors: [],
      exemplars: [],
    };
    row.count += 1;
    pushUnique(row.fixture_ids, finding.fixture_id, 5);
    pushUnique(row.selectors, finding.selector, 5);
    if (row.exemplars.length < 3) {
      row.exemplars.push(fixtureExemplar(finding));
    }
    families.set(key, row);
  }
  return [...families.values()]
    .sort((left, right) => right.count - left.count || left.key.localeCompare(right.key))
    .slice(0, limit);
}

function fixtureExemplars(findings, limit = 10) {
  const exemplars = [];
  const seen = new Set();
  for (const finding of findings) {
    const exemplar = fixtureExemplar(finding);
    const key = [exemplar.pattern_family, exemplar.fixture_id, exemplar.selector, exemplar.source_path].join('\u0000');
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    exemplars.push(exemplar);
    if (exemplars.length >= limit) {
      break;
    }
  }
  return exemplars;
}

function fixtureExemplar(finding) {
  return compactObject({
    fixture_id: finding.fixture_id,
    pattern_family: finding.pattern_family || patternFamily(finding),
    repair_bucket: finding.repair_bucket || finding.group_key,
    kind: finding.kind,
    candidate_repo: finding.candidate_repo,
    source_path: finding.source_path || finding.path,
    selector: finding.selector,
    selector_family: finding.selector_family || selectorFamily(finding.selector),
    reason: finding.reason,
    source_snippet: finding.source_snippet,
    observed_block_name: finding.observed_block_name,
    observed_output: finding.observed_output,
  });
}

function diagnosticBlindSpots(findings) {
  const spots = [];
  const genericFindings = findings.filter((finding) => isGenericFinding(finding));
  const missingSourceContext = findings.filter((finding) => !finding.selector && !finding.source_snippet && !finding.observed_output);
  if (genericFindings.length > 0) {
    spots.push(blindSpot('generic_finding_family', genericFindings, 'Findings need a specific type, repair bucket, or reason code before fanout.'));
  }
  if (missingSourceContext.length > 0) {
    spots.push(blindSpot('missing_source_context', missingSourceContext, 'Findings need selector, source snippet, or observed block output for direct transformer repair.'));
  }
  return spots;
}

function blindSpot(kind, findings, recommendation) {
  return {
    kind,
    count: findings.length,
    recommendation,
    exemplars: fixtureExemplars(findings, 5),
  };
}

function isGenericFinding(finding) {
  return ['static_site_fixture_diagnostic', 'import_diagnostic', 'diagnostic'].includes(finding.kind)
    || ['static_site_import_quality'].includes(finding.group_key)
    || !finding.reason;
}

function patternFamily(finding) {
  return [
    finding.repair_bucket || finding.group_key || 'static_site_import_quality',
    finding.kind || 'diagnostic',
    selectorFamily(finding.selector),
  ].join(':');
}

function selectorFamily(selector) {
  const value = String(selector || '').trim();
  if (!value) {
    return '(none)';
  }

  const firstToken = value.split(/\s+|\s*[>+~]\s*/).find(Boolean) || value;
  if (firstToken.startsWith('#')) {
    return `id:${firstToken.slice(1).split(/[:.#[\]]/)[0] || '(unknown)'}`;
  }
  if (firstToken.startsWith('.')) {
    return `class:${firstToken.slice(1).split(/[:.#[\]]/)[0] || '(unknown)'}`;
  }
  if (firstToken.startsWith('[')) {
    return `attr:${firstToken.slice(1).split(/[=\]]/)[0] || '(unknown)'}`;
  }

  return firstToken.split(/[:.#[\]]/)[0] || firstToken;
}

function pushUnique(values, value, limit) {
  if (!value || values.includes(value) || values.length >= limit) {
    return;
  }
  values.push(value);
}

function dedupeDiagnostics(diagnostics) {
  const seen = new Set();
  return diagnostics.filter((diagnostic) => {
    const normalized = objectValue(diagnostic);
    const key = [normalized.kind || normalized.code || normalized.type || normalized.reason_code, normalized.message || normalized.reason, normalized.path || normalized.source_path, normalized.selector]
      .map((part) => String(part || ''))
      .join('\u0000');
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function collectFixtureArtifactRefs(payload, fixtureArtifactsDirectory) {
  const refs = [...normalizeArray(payload.artifact_refs || payload.artifactRefs), ...normalizeArray(payload.artifacts?.refs)];
  for (const [key, value] of Object.entries(payload.artifacts || {})) {
    if (value && typeof value === 'object' && !Array.isArray(value) && (value.path || value.file || value.href)) {
      refs.push({ artifact_id: key, kind: value.kind || key, ...value });
    } else if (typeof value === 'string') {
      refs.push({ artifact_id: key, kind: key, path: value });
    }
  }
  for (const fileName of ['artifact.json', 'validation-result.json', 'import-report.json']) {
    const filePath = path.join(fixtureArtifactsDirectory, fileName);
    if (fs.existsSync(filePath)) {
      refs.push(artifactRef(fileName.replace(/\.json$/, ''), filePath, fileName === 'artifact.json' ? 'input' : 'diagnostic'));
    }
  }
  return refs;
}

function collectRuntimePayloads(value) {
  const payloads = [];
  visitRuntimePayloads(value, '', payloads, new Set());
  return payloads;
}

function visitRuntimePayloads(value, inheritedFixtureId, payloads, seen) {
  if (!value || typeof value !== 'object' || seen.has(value)) {
    return;
  }
  seen.add(value);
  const fixtureId = fixtureIdentity(value) || inheritedFixtureId;
  if (fixtureId && hasPayloadData(value)) {
    payloads.push({ fixture_id: fixtureId, ...value });
  }
  for (const key of ['stdout', 'stderr', 'output', 'result']) {
    for (const parsed of parseJsonPayloadsFromText(value[key])) {
      payloads.push({ fixture_id: fixtureId, ...parsed });
    }
  }
  for (const child of Array.isArray(value) ? value : Object.values(value)) {
    visitRuntimePayloads(child, fixtureId, payloads, seen);
  }
}

function hasPayloadData(value) {
  return ['status', 'success', 'ok', 'passed', 'error', 'diagnostics', 'findings', 'summary', 'artifacts', 'upstream_gaps', 'runtime_target_gaps', 'blocks_engine', 'import_report']
    .some((key) => Object.hasOwn(value, key));
}

function readFixturePayloadFiles(directory) {
  return ['validation-result.json', 'result.json', 'import-report.json', 'quality.json', 'blocks-engine-diagnostics.json']
    .map((fileName) => readJsonFileIfExists(path.join(directory, fileName)))
    .filter(Boolean);
}

function fixtureIdentity(payload) {
  return payload?.fixture_id
    || payload?.fixtureId
    || payload?.fixture?.id
    || payload?.fixture?.slug
    || payload?.fixture_diagnostics?.fixture?.slug
    || payload?.fixtureDiagnostics?.fixture?.slug
    || payload?.request?.import_args?.slug
    || payload?.request?.importArgs?.slug
    || payload?.metadata?.fixture_id
    || payload?.metadata?.fixtureId
    || '';
}

function collectFixtureFiles(directory, options = {}) {
  const maxFiles = finiteNumber(options.maxFiles ?? options.max_files, 1000);
  const files = [];
  const visit = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (entry.name === '.git' || entry.name === 'node_modules') {
        continue;
      }
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        visit(entryPath);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      const relativePath = path.relative(directory, entryPath).replace(/\\/g, '/');
      const stat = fs.statSync(entryPath);
      files.push({ relative_path: relativePath, absolute_path: entryPath, type: fileType(relativePath), bytes: stat.size });
      if (files.length > maxFiles) {
        throw new Error(`Fixture ${directory} has more than ${maxFiles} files.`);
      }
    }
  };
  visit(directory);
  return files.sort((left, right) => left.relative_path.localeCompare(right.relative_path));
}

function visitFixtureDirectory(directory, depth, maxDepth, callback) {
  callback(directory);
  if (depth >= maxDepth) {
    return;
  }
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && entry.name !== '.git' && entry.name !== 'node_modules') {
      visitFixtureDirectory(path.join(directory, entry.name), depth + 1, maxDepth, callback);
    }
  }
}

function collectQualityMetrics(payload) {
  return compactObject({
    ...(payload.quality_metrics || payload.qualityMetrics || {}),
    ...(payload.quality || {}),
    ...(payload.import_report?.report?.quality || payload.importReport?.report?.quality || payload.report?.quality || {}),
  });
}

function collectInvalidBlockCounts(payload) {
  const quality = collectQualityMetrics(payload);
  return compactObject({
    invalid_block_count: payload.invalid_block_count || payload.invalidBlockCount || quality.invalid_block_count,
    invalid_blocks: payload.invalid_blocks || payload.invalidBlocks || quality.invalid_blocks,
    editor_invalid_blocks: payload.editor_invalid_blocks || payload.editorInvalidBlocks || quality.editor_invalid_blocks,
  });
}

function collectMissingAssets(payload) {
  return [
    ...normalizeArray(payload.missing_assets || payload.missingAssets),
    ...normalizeArray(payload.dropped_images || payload.droppedImages),
    ...normalizeArray(payload.import_report?.missing_assets || payload.importReport?.missing_assets),
    ...normalizeArray(payload.report?.missing_assets),
  ];
}

function collectRuntimeTargetGaps(payload) {
  return [
    ...normalizeArray(payload.runtime_target_gaps || payload.runtimeTargetGaps),
    ...normalizeArray(payload.runtime_targets_missing || payload.runtimeTargetsMissing),
    ...normalizeArray(payload.blocks_engine?.runtime_target_gaps || payload.blocksEngine?.runtimeTargetGaps),
  ];
}

function collectBlocksEngineDiagnostics(payload) {
  return [
    ...normalizeArray(payload.blocks_engine_diagnostics || payload.blocksEngineDiagnostics),
    ...normalizeArray(payload.blocks_engine?.diagnostics || payload.blocksEngine?.diagnostics),
    ...normalizeArray(payload.transformer_diagnostics || payload.transformerDiagnostics),
  ];
}

function groupFindings(findings) {
  return findings.reduce((groups, finding) => {
    const key = finding.group_key || 'static_site_import_quality';
    groups[key] = groups[key] || [];
    groups[key].push(finding);
    return groups;
  }, {});
}

function inferFixtureSuccess(payload, diagnostics, error, payloadCount) {
  if (payload.success === true || payload.ok === true || payload.passed === true) {
    return diagnostics.length === 0 && !error;
  }
  if (payload.success === false || payload.ok === false || payload.passed === false || payload.status === 'failed' || payload.status === 'error') {
    return false;
  }
  if (payload.status === 'passed' || payload.status === 'success') {
    return diagnostics.length === 0 && !error;
  }
  return payloadCount > 0 && diagnostics.length === 0 && !error;
}

function fixtureStatus(payloadCount, error, success) {
  if (payloadCount === 0 && !error) {
    return 'not_run';
  }
  return success ? 'passed' : 'failed';
}

function isFailurePayload(payload) {
  return payload.success === false || payload.ok === false || payload.status === 'failed' || payload.status === 'error';
}

function fileType(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === '.html' || extension === '.htm') return 'text/html';
  if (extension === '.css') return 'text/css';
  if (extension === '.js' || extension === '.mjs') return 'application/javascript';
  if (extension === '.svg') return 'image/svg+xml';
  if (extension === '.png') return 'image/png';
  if (extension === '.jpg' || extension === '.jpeg') return 'image/jpeg';
  if (extension === '.webp') return 'image/webp';
  return 'application/octet-stream';
}

function isImagePath(filePath) {
  return /\.(png|jpe?g|gif|webp|svg)$/i.test(filePath);
}

function isTextPayloadType(type) {
  return typeof type === 'string' && (type.startsWith('text/') || type === 'application/javascript' || type === 'application/json' || type === 'image/svg+xml');
}

function normalizeArray(value) {
  if (Array.isArray(value)) return value;
  if (value === undefined || value === null || value === '') return [];
  return [value];
}

function mergeObjects(values) {
  return values.reduce((merged, value) => deepMerge(merged, value && typeof value === 'object' && !Array.isArray(value) ? value : {}), {});
}

function deepMerge(left, right) {
  const output = { ...left };
  for (const [key, value] of Object.entries(right)) {
    if (Array.isArray(value)) {
      output[key] = [...normalizeArray(output[key]), ...value];
    } else if (value && typeof value === 'object' && !Array.isArray(value) && output[key] && typeof output[key] === 'object' && !Array.isArray(output[key])) {
      output[key] = deepMerge(output[key], value);
    } else if (value !== undefined && value !== null && value !== '') {
      output[key] = value;
    }
  }
  return output;
}

function compactObject(value) {
  return Object.fromEntries(Object.entries(value || {}).filter(([, item]) => item !== undefined && item !== null && item !== ''));
}

function objectValue(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function numberValue(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function firstString(values) {
  return values.map((value) => String(value || '').trim()).find(Boolean) || '';
}

function diagnosticMessage(value) {
  if (typeof value === 'string') {
    return value;
  }
  return value?.message || value?.reason || value?.detail || value?.path || value?.target || value?.selector || '';
}

function missingAssetKind(value) {
  const message = diagnosticMessage(value);
  return /\.svg(?:\b|$)/i.test(message) ? 'broken_svg' : 'dropped_images';
}

function readJsonFileIfExists(filePath) {
  if (!filePath || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    return {
      status: 'failed',
      error: `Unable to parse JSON artifact ${filePath}: ${error.message}`,
      artifact_refs: [artifactRef('unparseable-json', filePath, 'diagnostic')],
    };
  }
}

function parseJsonPayloadsFromText(text) {
  if (typeof text !== 'string' || !text.trim()) {
    return [];
  }
  const payloads = [];
  const trimmed = text.trim();
  const candidates = new Set([trimmed, ...text.split(/\r?\n/).map((line) => line.trim())]);
  const firstObject = trimmed.indexOf('{');
  const lastObject = trimmed.lastIndexOf('}');
  if (firstObject >= 0 && lastObject > firstObject) {
    candidates.add(trimmed.slice(firstObject, lastObject + 1));
  }
  for (const candidate of candidates) {
    if (!candidate || !candidate.startsWith('{')) continue;
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        payloads.push(parsed);
      }
    } catch {
      // WP-CLI output may mix human text and JSON; non-JSON lines are ignored.
    }
  }
  return payloads;
}

function requiredString(value, name) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`${name} must be a non-empty string.`);
  }
  return value;
}

function requiredDirectory(value, name) {
  const directory = requiredString(value, name);
  if (!fs.existsSync(directory) || !fs.statSync(directory).isDirectory()) {
    throw new Error(`${name} must be an existing directory: ${directory}`);
  }
  return path.resolve(directory);
}

function finiteNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function writeJsonFile(filePath, payload) {
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`);
}

function artifactRef(artifact_id, filePath, kind) {
  return { schema: 'homeboy/artifact-ref/v1', artifact_id, kind, path: filePath };
}

function slug(value) {
  return String(value || 'fixture')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'fixture';
}

function shellToken(value) {
  const text = String(value || '');
  return /^[A-Za-z0-9_./:@=-]+$/.test(text) ? text : `'${text.replace(/'/g, "'\\''")}'`;
}
