// Fixture discovery, normalization, and taxonomy classification for the
// Static Site Importer fixture matrix.
//
// Extracted verbatim from the former `lib/fixture-matrix.mjs` monolith as part
// of the matrix modularization (Refs #242).

import fs from 'node:fs';
import path from 'node:path';

import {
  FIXTURE_MATRIX_SCHEMA,
  FIXTURE_CLASSES,
  FIXTURE_CLASS_RULES,
  FIXTURE_DIRECTORY_CLASSES,
} from './shared/constants.mjs';
import {
  normalizeArray,
  finiteNumber,
  diagnosticMessage,
  requiredDirectory,
  slug,
  fileType,
} from './shared/utils.mjs';

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

export function normalizeFixture(input) {
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

export function collectFixtureFiles(directory, options = {}) {
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

export function normalizeFixtureClass(value) {
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

export function fixtureClassRank(value) {
  const index = FIXTURE_CLASSES.indexOf(value);
  return index >= 0 ? index : FIXTURE_CLASSES.length;
}
