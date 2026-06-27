#!/usr/bin/env node

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const variantsPath = path.join(repoRoot, 'Automattic/studio/rigs/studio-agent-model-comparison.variants.json');
const checkOnly = process.argv.includes('--check');

function requiredString(object, key, context) {
  if (typeof object?.[key] !== 'string' || object[key] === '') {
    throw new Error(`${context}: missing required string ${key}`);
  }
  return object[key];
}

function stableJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function rigFromVariant(variant, shared) {
  const id = requiredString(variant, 'id', 'variant');

  return {
    id,
    description: requiredString(variant, 'description', id),
    components: {
      studio: {
        path: requiredString(variant, 'studio_path', id),
        branch: requiredString(variant, 'studio_branch', id),
        extensions: {
          nodejs: {
            studio_bench_variant: requiredString(variant, 'studio_bench_variant', id),
            studio_agent_model: requiredString(variant, 'studio_agent_model', id),
          },
        },
      },
    },
    resources: shared.resources,
    bench: shared.bench,
    bench_workloads: shared.bench_workloads,
    pipeline: shared.pipeline,
  };
}

const data = JSON.parse(await readFile(variantsPath, 'utf8'));
const variants = Array.isArray(data.variants) ? data.variants : [];
const shared = data.shared || {};
const ids = new Set();
const failures = [];
const rigs = [];
const trunkEquivalentBranches = new Set(['trunk', 'main', 'origin/trunk', 'origin/main']);

if (variants.length === 0) {
  throw new Error(`${variantsPath}: variants must contain at least one variant`);
}

for (const variant of variants) {
  const rig = rigFromVariant(variant, shared);
  const expectedDescriptionRef = rig.components.studio.branch.endsWith('/main') || rig.components.studio.branch === 'main'
    ? 'main'
    : 'trunk';

  if (ids.has(rig.id)) {
    throw new Error(`${variantsPath}: duplicate variant id ${rig.id}`);
  }
  ids.add(rig.id);

  if (rig.id.endsWith('-trunk')) {
    const description = rig.description.toLowerCase();
    if (!trunkEquivalentBranches.has(rig.components.studio.branch)) {
      failures.push(`${rig.id}: reserved *-trunk variants must use a trunk/main-equivalent studio_branch, got ${rig.components.studio.branch}`);
    }
    if (!description.includes(expectedDescriptionRef)) {
      failures.push(`${rig.id}: description must mention ${expectedDescriptionRef} to match studio_branch ${rig.components.studio.branch}`);
    }
  }

  rigs.push(rig);
}

if (failures.length > 0) {
  console.error('Generated Studio agent model rig metadata is invalid:');
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}

for (const rig of rigs) {
  const rigPath = path.join(repoRoot, 'Automattic/studio/rigs', rig.id, 'rig.json');
  const next = stableJson(rig);

  if (checkOnly) {
    const current = existsSync(rigPath) ? await readFile(rigPath, 'utf8') : '';
    if (current !== next) {
      failures.push(path.relative(repoRoot, rigPath));
    }
    continue;
  }

  await mkdir(path.dirname(rigPath), { recursive: true });
  await writeFile(rigPath, next);
}

if (failures.length > 0) {
  console.error('Generated Studio agent model rigs are stale:');
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  console.error('Run `node scripts/generate-studio-agent-model-rigs.mjs` and commit the results.');
  process.exit(1);
}

console.log(checkOnly ? 'Studio agent model rigs are up to date.' : 'Generated Studio agent model rigs.');
