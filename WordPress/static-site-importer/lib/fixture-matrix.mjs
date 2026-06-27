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

const ACCEPTABLE_LOSS_CLASSES = new Set([
  'native_conversion',
  'editable_approximation',
  'preserved_runtime_island',
]);

const UNACCEPTABLE_LOSS_CLASSES = new Set([
  'unsupported_loss',
  'importer_materialization_bug',
  'invalid_block_output',
  'invalid_block_content',
  'missing_asset',
  'missing_output',
  'fixture_not_run',
  'fixture_failed',
]);

// Loss classes whose acceptability is conditional rather than automatic.
// `preserved_runtime_island` only earns an acceptable verdict when the finding
// carries an explicit signal that the interactive runtime/behavior was actually
// carried or mapped into the WordPress site. "Markup preserved, behavior dead"
// is a feature-parity failure, not an acceptable loss.
const RUNTIME_CARRIED_SIGNAL_KEYS = [
  'runtime_carried',
  'runtimeCarried',
  'runtime_mapped',
  'runtimeMapped',
  'runtime_mapping',
  'runtimeMapping',
];

const FIXTURE_CLASSES = [
  'marketing/static',
  'docs/blog',
  'ecommerce/catalog',
  'app/dashboard',
  'canvas/webgl/audio/runtime-heavy',
  'unknown',
];

const FIXTURE_CLASS_RULES = [
  {
    key: 'canvas/webgl/audio/runtime-heavy',
    patterns: [/\b(canvas|webgl|shader|three\.js|threejs|babylon|p5\.js|audio|webaudio|oscillator|animation|runtime target|runtime_dependency)\b/i],
  },
  {
    key: 'ecommerce/catalog',
    patterns: [/\b(ecommerce|e-commerce|commerce|catalog|product|products|shop|store|cart|checkout|price|sku|woocommerce|add to cart)\b/i],
  },
  {
    key: 'app/dashboard',
    patterns: [/\b(app|dashboard|admin|account|login|settings|analytics|chart|table|kanban|calendar|portal|workspace)\b/i],
  },
  {
    key: 'docs/blog',
    patterns: [/\b(docs|documentation|guide|manual|reference|blog|post|article|news|changelog|tutorial|markdown)\b/i],
  },
  {
    key: 'marketing/static',
    patterns: [/\b(marketing|landing|homepage|hero|pricing|feature|features|about|contact|portfolio|agency|brochure|static|simple site)\b/i],
  },
];

const FIXTURE_DIRECTORY_CLASSES = {
  'marketing-static': 'marketing/static',
  'docs-blog': 'docs/blog',
  'ecommerce-catalog': 'ecommerce/catalog',
  'app-dashboard': 'app/dashboard',
  'runtime-heavy': 'canvas/webgl/audio/runtime-heavy',
  'canvas-webgl-audio': 'canvas/webgl/audio/runtime-heavy',
  'edge-cases': 'unknown',
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
  const fixtureResults = matrix.fixtures.map((fixture) => attachFixtureTaxonomy(
    resultByFixture.get(fixture.id) || normalizeFixtureResult({ fixture_id: fixture.id, fixture_path: fixture.fixture_path, status: 'not_run' }),
    fixture,
  ));
  const findings = dedupeFindings(fixtureResults.flatMap((result) => findingsForFixtureResult(result, { matrix })));
  const actionableFindings = findings.filter(isActionableFinding);
  const grouped = groupFindings(actionableFindings);
  const acceptableActionableFindings = actionableFindings.filter((finding) => finding.loss_acceptance === 'acceptable');
  const unacceptableActionableFindings = actionableFindings.filter((finding) => finding.loss_acceptance !== 'acceptable');
  const gatedFixtureResults = fixtureResults.map((result) => applyFixtureQualityGate(result, findings));
  const lossClassCounts = countBy(findings, (finding) => finding.loss_class || 'unsupported_loss');
  const acceptanceCounts = countBy(findings, (finding) => finding.loss_acceptance || 'unacceptable');
  const classRollups = fixtureClassRollups(gatedFixtureResults, findings);
  const fanoutGroups = buildFanoutGroups(actionableFindings);

  return {
    schema: FIXTURE_MATRIX_RESULT_SCHEMA,
    matrix_id: matrix.id,
    fixture_root: matrix.fixture_root,
    summary: {
      fixture_count: matrix.fixtures.length,
      succeeded: gatedFixtureResults.filter((result) => result.status === 'passed').length,
      failed: gatedFixtureResults.filter((result) => result.status === 'failed').length,
      not_run: gatedFixtureResults.filter((result) => result.raw_status === 'not_run').length,
      finding_count: findings.length,
      actionable_finding_count: actionableFindings.length,
      non_actionable_finding_count: findings.length - actionableFindings.length,
      acceptable_finding_count: acceptanceCounts.acceptable || 0,
      unacceptable_finding_count: acceptanceCounts.unacceptable || 0,
      loss_classes: lossClassCounts,
      acceptable_loss_classes: Object.fromEntries(Object.entries(lossClassCounts).filter(([key]) => ACCEPTABLE_LOSS_CLASSES.has(key))),
      unacceptable_loss_classes: Object.fromEntries(Object.entries(lossClassCounts).filter(([key]) => UNACCEPTABLE_LOSS_CLASSES.has(key))),
      preserved_runtime_island_count: lossClassCounts.preserved_runtime_island || 0,
      groups: Object.fromEntries(Object.entries(grouped).map(([key, items]) => [key, items.length])),
      top_pattern_families: topPatternFamilies(actionableFindings),
      top_acceptable_pattern_families: topPatternFamilies(acceptableActionableFindings),
      top_unacceptable_pattern_families: topPatternFamilies(unacceptableActionableFindings),
      unacceptable_candidate_repos: candidateRepoRollups(unacceptableActionableFindings),
      fixture_exemplars: fixtureExemplars(actionableFindings),
      diagnostic_blind_spots: diagnosticBlindSpots(actionableFindings),
      fixture_classes: Object.fromEntries(Object.entries(classRollups).map(([key, row]) => [key, row.fixture_count])),
      classes: classRollups,
      quality_budgets: qualityBudgetSummaries(classRollups),
    },
    fixtures: gatedFixtureResults,
    findings,
    fanout_groups: fanoutGroups.map((group, index) => ({ ...group, index })),
  };
}

function applyFixtureQualityGate(result, findings) {
  const fixtureFindings = findings.filter((finding) => finding.fixture_id === result.fixture_id);
  const unacceptableFindings = fixtureFindings.filter((finding) => finding.loss_acceptance === 'unacceptable');
  const status = unacceptableFindings.length > 0 ? 'failed' : 'passed';
  return {
    ...result,
    raw_status: result.status,
    status,
    success: status === 'passed',
    quality_gate: {
      status,
      acceptable_finding_count: fixtureFindings.length - unacceptableFindings.length,
      unacceptable_finding_count: unacceptableFindings.length,
      loss_classes: countBy(fixtureFindings, (finding) => finding.loss_class || 'unsupported_loss'),
    },
  };
}

function attachFixtureTaxonomy(result, fixture) {
  const taxonomy = fixture.taxonomy || classifyFixture(fixture);
  const fixtureClass = normalizeFixtureClass(result.fixture_class) !== 'unknown' ? normalizeFixtureClass(result.fixture_class) : taxonomy.fixture_class;
  const productClass = normalizeFixtureClass(result.product_class) !== 'unknown' ? normalizeFixtureClass(result.product_class) : taxonomy.product_class;
  return {
    ...result,
    fixture_path: result.fixture_path || fixture.fixture_path,
    fixture_class: fixtureClass,
    product_class: productClass,
    taxonomy: {
      ...taxonomy,
      ...result.taxonomy,
      fixture_class: fixtureClass,
      product_class: productClass,
    },
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

export function classifyFixture(input = {}) {
  const explicit = normalizeFixtureClass(input.fixture_class || input.fixtureClass || input.product_class || input.productClass || input.class || input.taxonomy?.fixture_class || input.taxonomy?.product_class);
  if (explicit && explicit !== 'unknown') {
    return { fixture_class: explicit, product_class: explicit, signals: ['explicit_metadata'] };
  }

  const pathClass = classifyFixturePath(input);
  if (pathClass) {
    return { fixture_class: pathClass, product_class: pathClass, signals: ['directory_taxonomy'] };
  }

  const files = normalizeArray(input.files || input.fixture_files || input.fixtureFiles);
  const diagnostics = normalizeArray(input.diagnostics || input.findings || input.messages || input.runtime_target_gaps || input.runtimeTargetGaps);
  const text = [
    input.id,
    input.slug,
    input.label,
    input.name,
    input.description,
    input.directory,
    input.fixture_path,
    ...normalizeArray(input.tags),
    ...normalizeArray(input.categories),
    ...normalizeArray(input.keywords),
    ...files.map((file) => file.relative_path || file.path || file.name || ''),
    ...diagnostics.map((diagnostic) => diagnosticMessage(diagnostic)),
  ].filter(Boolean).join(' ');
  const scores = new Map(FIXTURE_CLASSES.map((key) => [key, 0]));
  const signals = [];

  for (const rule of FIXTURE_CLASS_RULES) {
    for (const pattern of rule.patterns) {
      if (pattern.test(text)) {
        scores.set(rule.key, scores.get(rule.key) + 3);
        signals.push(`${rule.key}:text`);
        break;
      }
    }
  }

  if (files.some((file) => /\.(js|mjs)$/i.test(file.relative_path || file.path || ''))) {
    scores.set('canvas/webgl/audio/runtime-heavy', scores.get('canvas/webgl/audio/runtime-heavy') + 1);
    signals.push('canvas/webgl/audio/runtime-heavy:script_file');
  }
  if (files.some((file) => /(^|\/)posts?\/|(^|\/)blog\/|\.md$/i.test(file.relative_path || file.path || ''))) {
    scores.set('docs/blog', scores.get('docs/blog') + 2);
    signals.push('docs/blog:content_path');
  }
  if (files.length > 0 && files.every((file) => !/\.(js|mjs)$/i.test(file.relative_path || file.path || ''))) {
    scores.set('marketing/static', scores.get('marketing/static') + 1);
    signals.push('marketing/static:static_files');
  }

  const ranked = [...scores.entries()]
    .filter(([key]) => key !== 'unknown')
    .sort((left, right) => right[1] - left[1] || FIXTURE_CLASSES.indexOf(left[0]) - FIXTURE_CLASSES.indexOf(right[0]));
  const [fixtureClass, score] = ranked[0] || ['unknown', 0];
  const normalized = score > 0 ? fixtureClass : 'unknown';
  return { fixture_class: normalized, product_class: normalized, signals: signals.slice(0, 8) };
}

function classifyFixturePath(input = {}) {
  const directory = input.directory || input.path || input.fixture_path || input.fixturePath;
  const root = input.root || input.fixture_root || input.fixtureRoot;
  const segments = [];

  if (directory && root) {
    const relative = path.relative(path.resolve(root), path.resolve(directory));
    if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) {
      segments.push(...relative.split(path.sep));
    }
  }

  for (const segment of segments) {
    const key = String(segment || '').trim().toLowerCase();
    if (Object.hasOwn(FIXTURE_DIRECTORY_CLASSES, key)) {
      return FIXTURE_DIRECTORY_CLASSES[key];
    }
  }

  return '';
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
  const countOnlyDiagnostic = isCountOnlyStaticSiteFixtureDiagnostic({ raw, result, kind, message, selector });
  const lossClass = countOnlyDiagnostic ? 'native_conversion' : classifyLossClass({ raw, kind, group_key: group.group_key, repair_bucket: repairBucket, message, result });
  const lossAcceptance = resolveLossAcceptance(lossClass, raw);
  return {
    id: raw.id || `${result.fixture_id || 'fixture'}:${group.group_key}:${index + 1}`,
    kind,
    category: raw.category || group.group_key,
    group_key: group.group_key,
    repair_bucket: repairBucket,
    severity: raw.severity || (result.status === 'failed' ? 'error' : 'warning'),
    fixture_id: result.fixture_id || '',
    fixture_class: result.fixture_class || result.taxonomy?.fixture_class || 'unknown',
    product_class: result.product_class || result.taxonomy?.product_class || result.fixture_class || 'unknown',
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
    loss_class: lossClass,
    loss_acceptance: lossAcceptance,
    acceptable_loss: lossAcceptance === 'acceptable',
    actionability: countOnlyDiagnostic ? 'count_only' : 'actionable',
    actionable: !countOnlyDiagnostic,
    artifact_refs: normalizeArray(raw.artifact_refs),
    raw,
  };
}

function isActionableFinding(finding) {
  return finding.actionable !== false;
}

function isCountOnlyStaticSiteFixtureDiagnostic({ raw, result, kind, message, selector }) {
  if (kind !== 'static_site_fixture_diagnostic' || selector) {
    return false;
  }

  const rawObject = raw && typeof raw === 'object' ? raw : {};
  const sourcePath = rawObject.source_path || rawObject.path;
  const sourceIsFixturePath = sourcePath && result?.fixture_path && path.resolve(String(sourcePath)) === path.resolve(String(result.fixture_path));
  const hasActionableContext = Boolean(
    rawObject.code
    || rawObject.type
    || rawObject.reason_code
    || rawObject.detail
    || (sourcePath && !sourceIsFixturePath)
    || rawObject.source?.selector
    || rawObject.source?.snippet
    || rawObject.observed?.output
  );
  return !hasActionableContext && /^\d+(?:\.\d+)?$/.test(String(message || '').trim());
}

function classifyLossClass({ raw, kind, group_key, repair_bucket, message, result }) {
  const explicit = normalizeLossClass(raw.loss_class || raw.lossClass || raw.classification?.loss_class || raw.classification?.lossClass || raw.acceptability || raw.quality_class || raw.qualityClass);
  if (explicit) {
    return explicit;
  }

  const haystack = [kind, group_key, repair_bucket, message, raw.reason, raw.detail].filter(Boolean).join(' ');
  if (/preserved[_\s-]+runtime[_\s-]+island|runtime island preserved|runtime[_\s-]+island/i.test(haystack)) {
    return 'preserved_runtime_island';
  }
  if (/native[_\s-]+conversion|converted natively|native block/i.test(haystack)) {
    return 'native_conversion';
  }
  if (/editable[_\s-]+approximation|editable approximation|approximation/i.test(haystack)) {
    return 'editable_approximation';
  }
  if (kind === 'fixture_not_run' || group_key === 'fixture_not_run') {
    return 'fixture_not_run';
  }
  if (kind === 'fixture_failed' || group_key === 'fixture_failed') {
    return 'fixture_failed';
  }
  if (group_key === 'invalid_block_content' || /invalid block|block validation/i.test(haystack)) {
    return 'invalid_block_content';
  }
  if (group_key === 'dropped_images' || group_key === 'broken_svg' || /missing asset|dropped image|missing image|asset.*missing/i.test(haystack)) {
    return 'missing_asset';
  }
  if (/missing output|output.*missing|empty output/i.test(haystack)) {
    return 'missing_output';
  }
  if (/materialization/i.test(haystack)) {
    return 'importer_materialization_bug';
  }
  if (result.status === 'failed') {
    return 'unsupported_loss';
  }
  return 'native_conversion';
}

function resolveLossAcceptance(lossClass, raw) {
  if (lossClass === 'preserved_runtime_island') {
    // Feature parity: a preserved interactive island is only acceptable when the
    // required runtime/behavior was actually carried or mapped. Absent that
    // explicit positive signal, the behavior is dead and the gate must fail.
    return hasRuntimeCarriedSignal(raw) ? 'acceptable' : 'unacceptable';
  }
  return ACCEPTABLE_LOSS_CLASSES.has(lossClass) ? 'acceptable' : 'unacceptable';
}

function hasRuntimeCarriedSignal(raw) {
  const rawObject = objectValue(raw);
  const classification = objectValue(rawObject.classification);
  return RUNTIME_CARRIED_SIGNAL_KEYS.some((key) => isTruthySignal(rawObject[key]) || isTruthySignal(classification[key]));
}

function isTruthySignal(value) {
  if (value === undefined || value === null) {
    return false;
  }
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    return !['', 'false', '0', 'no', 'none', 'null', 'undefined'].includes(normalized);
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) && value !== 0;
  }
  if (Array.isArray(value)) {
    return value.length > 0;
  }
  if (typeof value === 'object') {
    return Object.keys(value).length > 0;
  }
  return Boolean(value);
}

function normalizeFixture(input) {
  const directory = requiredDirectory(input.directory || input.path || input.fixture_path || input.fixturePath, 'fixture.directory');
  const root = input.root || input.fixture_root || input.fixtureRoot || path.dirname(directory);
  const relative = path.relative(path.resolve(root), path.resolve(directory));
  const id = slug(input.id || input.slug || (relative && !relative.startsWith('..') ? relative : path.basename(directory)));
  const files = input.files || input.fixture_files || input.fixtureFiles || collectFixtureFiles(directory, { maxFiles: input.maxFiles || input.max_files || 1000 });
  const taxonomy = normalizeFixtureTaxonomy(input.taxonomy) || classifyFixture({ ...input, id, directory, root, files });
  return {
    id,
    label: input.label || input.name || id,
    directory,
    fixture_path: directory,
    fixture_root: root,
    entrypoint: input.entrypoint || 'index.html',
    fixture_class: taxonomy.fixture_class,
    product_class: taxonomy.product_class,
    taxonomy,
  };
}

function normalizeFixtureTaxonomy(taxonomy) {
  if (!taxonomy || typeof taxonomy !== 'object') {
    return null;
  }
  const fixtureClassValue = taxonomy.fixture_class || taxonomy.fixtureClass || taxonomy.product_class || taxonomy.productClass;
  const productClassValue = taxonomy.product_class || taxonomy.productClass || taxonomy.fixture_class || taxonomy.fixtureClass;
  if (!fixtureClassValue && !productClassValue) {
    return null;
  }
  const fixtureClass = normalizeFixtureClass(fixtureClassValue);
  const productClass = normalizeFixtureClass(productClassValue);
  return {
    fixture_class: fixtureClass || 'unknown',
    product_class: productClass || fixtureClass || 'unknown',
    signals: normalizeArray(taxonomy.signals),
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
    fixture_class: normalizeFixtureClass(input.fixture_class || input.fixtureClass || input.product_class || input.productClass || input.taxonomy?.fixture_class) || 'unknown',
    product_class: normalizeFixtureClass(input.product_class || input.productClass || input.fixture_class || input.fixtureClass || input.taxonomy?.product_class) || 'unknown',
    taxonomy: input.taxonomy || {},
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

function dedupeFindings(findings) {
  const seen = new Set();
  return findings.filter((finding) => {
    const key = finding.selector || finding.source_snippet
      ? [finding.fixture_id, finding.source_path, finding.selector || finding.selector_family, finding.source_snippet, finding.loss_class].join('\u0000')
      : [finding.fixture_id, finding.loss_class, finding.kind, finding.group_key, finding.reason].join('\u0000');
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function countBy(values, keyCallback) {
  return values.reduce((counts, value) => {
    const key = keyCallback(value);
    counts[key] = (counts[key] || 0) + 1;
    return counts;
  }, {});
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

function buildFanoutGroups(findings) {
  const groups = new Map();
  for (const finding of findings) {
    const acceptance = finding.loss_acceptance === 'acceptable' ? 'acceptable' : 'unacceptable';
    const pattern = finding.pattern_family || patternFamily(finding);
    const candidateRepo = finding.candidate_repo || 'unknown';
    const key = `${acceptance}:${candidateRepo}:${pattern}`;
    const row = groups.get(key) || {
      group_key: key,
      acceptance,
      candidate_repo: candidateRepo,
      pattern_family: pattern,
      count: 0,
      top_pattern_families: [],
      fixture_exemplars: [],
      findings: [],
    };
    row.count += 1;
    row.findings.push(finding);
    groups.set(key, row);
  }

  return [...groups.values()]
    .map((group) => ({
      ...group,
      top_pattern_families: topPatternFamilies(group.findings, 5),
      fixture_exemplars: fixtureExemplars(group.findings, 5),
    }))
    .sort(fanoutGroupSort);
}

function fanoutGroupSort(left, right) {
  const acceptanceDelta = acceptanceRank(left.acceptance) - acceptanceRank(right.acceptance);
  if (acceptanceDelta !== 0) {
    return acceptanceDelta;
  }
  return right.count - left.count
    || genericBucketRank(left) - genericBucketRank(right)
    || left.candidate_repo.localeCompare(right.candidate_repo)
    || left.pattern_family.localeCompare(right.pattern_family);
}

function acceptanceRank(value) {
  return value === 'unacceptable' ? 0 : 1;
}

function genericBucketRank(group) {
  return group.pattern_family === 'static_site_import_quality:static_site_fixture_diagnostic:(none)' ? 1 : 0;
}

function candidateRepoRollups(findings, limit = 10) {
  const repos = new Map();
  for (const finding of findings) {
    const key = finding.candidate_repo || 'unknown';
    const row = repos.get(key) || {
      candidate_repo: key,
      count: 0,
      fixture_ids: [],
      loss_classes: {},
      repair_buckets: {},
      top_pattern_families: [],
      fixture_exemplars: [],
      findings: [],
    };
    row.count += 1;
    pushUnique(row.fixture_ids, finding.fixture_id, 10);
    row.loss_classes[finding.loss_class || 'unsupported_loss'] = (row.loss_classes[finding.loss_class || 'unsupported_loss'] || 0) + 1;
    row.repair_buckets[finding.repair_bucket || finding.group_key || 'static_site_import_quality'] = (row.repair_buckets[finding.repair_bucket || finding.group_key || 'static_site_import_quality'] || 0) + 1;
    row.findings.push(finding);
    row.top_pattern_families = topPatternFamilies(row.findings, 5);
    row.fixture_exemplars = fixtureExemplars(row.findings, 5);
    repos.set(key, row);
  }

  return [...repos.values()]
    .map(({ findings: _findings, ...row }) => row)
    .sort((left, right) => right.count - left.count || left.candidate_repo.localeCompare(right.candidate_repo))
    .slice(0, limit);
}

function fixtureClassRollups(fixtureResults, findings) {
  const byClass = {};
  for (const result of fixtureResults) {
    const key = normalizeFixtureClass(result.fixture_class) || 'unknown';
    const row = byClass[key] || classRollup(key);
    row.fixture_count += 1;
    row[result.status] = (row[result.status] || 0) + 1;
    if (result.raw_status === 'not_run' && result.status !== 'not_run') {
      row.not_run += 1;
    }
    byClass[key] = row;
  }

  for (const finding of findings) {
    const key = normalizeFixtureClass(finding.fixture_class) || 'unknown';
    const row = byClass[key] || classRollup(key);
    const bucket = finding.repair_bucket || finding.group_key || 'static_site_import_quality';
    row.finding_count += 1;
    row.loss_classes[finding.loss_class || 'unsupported_loss'] = (row.loss_classes[finding.loss_class || 'unsupported_loss'] || 0) + 1;
    if (finding.loss_acceptance === 'acceptable') {
      row.acceptable_finding_count += 1;
    } else {
      row.unacceptable_finding_count += 1;
    }
    row.repair_buckets[bucket] = (row.repair_buckets[bucket] || 0) + 1;
    row.candidate_repos[finding.candidate_repo || 'unknown'] = (row.candidate_repos[finding.candidate_repo || 'unknown'] || 0) + 1;
    byClass[key] = row;
  }

  return Object.fromEntries(Object.entries(byClass).sort(([left], [right]) => fixtureClassRank(left) - fixtureClassRank(right)));
}

function classRollup(key) {
  return {
    fixture_class: key,
    fixture_count: 0,
    passed: 0,
    failed: 0,
    not_run: 0,
    finding_count: 0,
    acceptable_finding_count: 0,
    unacceptable_finding_count: 0,
    loss_classes: {},
    repair_buckets: {},
    candidate_repos: {},
  };
}

function qualityBudgetSummaries(classRollups) {
  return Object.fromEntries(Object.entries(classRollups).map(([key, row]) => {
    const dominantRepairBuckets = Object.entries(row.repair_buckets)
      .map(([bucket, count]) => ({ bucket, count }))
      .sort((left, right) => right.count - left.count || left.bucket.localeCompare(right.bucket));
    return [key, {
      fixture_class: key,
      fixture_count: row.fixture_count,
      passed: row.passed,
      failed: row.failed,
      not_run: row.not_run,
      finding_count: row.finding_count,
      acceptable_finding_count: row.acceptable_finding_count,
      unacceptable_finding_count: row.unacceptable_finding_count,
      loss_classes: row.loss_classes,
      preserved_runtime_island_count: row.loss_classes.preserved_runtime_island || 0,
      findings_per_fixture: row.fixture_count ? Number((row.finding_count / row.fixture_count).toFixed(2)) : 0,
      dominant_repair_buckets: dominantRepairBuckets.slice(0, 5),
    }];
  }));
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

function normalizeFixtureClass(value) {
  const normalized = String(value || '').trim().toLowerCase().replace(/[_\s-]+/g, '/');
  const aliases = {
    marketing: 'marketing/static',
    static: 'marketing/static',
    marketingstatic: 'marketing/static',
    'marketing/static': 'marketing/static',
    docs: 'docs/blog',
    documentation: 'docs/blog',
    blog: 'docs/blog',
    'docs/blog': 'docs/blog',
    ecommerce: 'ecommerce/catalog',
    commerce: 'ecommerce/catalog',
    catalog: 'ecommerce/catalog',
    shop: 'ecommerce/catalog',
    'ecommerce/catalog': 'ecommerce/catalog',
    app: 'app/dashboard',
    dashboard: 'app/dashboard',
    'app/dashboard': 'app/dashboard',
    canvas: 'canvas/webgl/audio/runtime-heavy',
    webgl: 'canvas/webgl/audio/runtime-heavy',
    audio: 'canvas/webgl/audio/runtime-heavy',
    runtime: 'canvas/webgl/audio/runtime-heavy',
    'runtime/heavy': 'canvas/webgl/audio/runtime-heavy',
    'canvas/webgl/audio/runtime/heavy': 'canvas/webgl/audio/runtime-heavy',
    'canvas/webgl/audio/runtime-heavy': 'canvas/webgl/audio/runtime-heavy',
  };
  return aliases[normalized] || (FIXTURE_CLASSES.includes(normalized) ? normalized : 'unknown');
}

function normalizeLossClass(value) {
  const normalized = String(value || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  const aliases = {
    acceptable: 'native_conversion',
    native: 'native_conversion',
    native_conversion: 'native_conversion',
    editable: 'editable_approximation',
    editable_approximation: 'editable_approximation',
    preserved_runtime_island: 'preserved_runtime_island',
    runtime_island: 'preserved_runtime_island',
    unsupported: 'unsupported_loss',
    unsupported_loss: 'unsupported_loss',
    materialization_bug: 'importer_materialization_bug',
    importer_materialization_bug: 'importer_materialization_bug',
    invalid_block: 'invalid_block_content',
    invalid_block_output: 'invalid_block_output',
    invalid_block_content: 'invalid_block_content',
    missing_asset: 'missing_asset',
    missing_assets: 'missing_asset',
    missing_output: 'missing_output',
    fixture_not_run: 'fixture_not_run',
    not_run: 'fixture_not_run',
    fixture_failed: 'fixture_failed',
  };
  const lossClass = aliases[normalized] || normalized;
  return ACCEPTABLE_LOSS_CLASSES.has(lossClass) || UNACCEPTABLE_LOSS_CLASSES.has(lossClass) ? lossClass : '';
}

function fixtureClassRank(value) {
  const index = FIXTURE_CLASSES.indexOf(value);
  return index >= 0 ? index : FIXTURE_CLASSES.length;
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
