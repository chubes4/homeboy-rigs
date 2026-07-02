#!/usr/bin/env node

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const recipePath = join(root, 'docs/wave3-fuzz-proof-recipes.json');
const localOnlyPattern = /(?:localhost|127\.0\.0\.1|file:\/\/|\/Users\/|https?:\/\/localhost|https?:\/\/127\.0\.0\.1)/i;
const requiredPhases = [
  'campaign_manifest',
  'campaign_dispatch',
  'resources_indexed',
  'artifacts_outcome_envelope',
  'cleanup_inspection',
];

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function commandsForPhase(phase) {
  return [phase.command, ...(phase.commands || [])].filter(Boolean);
}

function assertCommandContains(command, fragments, context) {
  for (const fragment of fragments) {
    assert.ok(command.includes(fragment), `${context} must include ${fragment}`);
  }
}

const recipes = readJson(recipePath);

assert.equal(recipes.schema, 'homeboy-rigs/wave3-fuzz-proof-recipes/v1');
assert.deepEqual(recipes.required_phase_order, requiredPhases);
assert.ok(Array.isArray(recipes.recipes) && recipes.recipes.length >= 2, 'expected generic and product recipes');
assert.ok(recipes.recipes.some((recipe) => recipe.kind === 'generic'), 'expected one generic recipe');
assert.ok(recipes.recipes.some((recipe) => recipe.kind === 'product'), 'expected one product recipe');

for (const recipe of recipes.recipes) {
  assert.ok(recipe.id, 'recipe id is required');
  assert.ok(recipe.rig, `${recipe.id} must declare a rig`);
  assert.ok(recipe.campaign_manifest, `${recipe.id} must declare a campaign manifest`);
  assert.ok(existsSync(join(root, recipe.campaign_manifest)), `${recipe.id} campaign manifest must exist`);
  assert.equal(recipe.proof_status, 'not_proven_until_reviewer_refs_exist');
  assert.deepEqual(recipe.phases.map((phase) => phase.id), requiredPhases, `${recipe.id} phase order drifted`);
  assert.ok(recipe.blockers_to_proven?.length > 0, `${recipe.id} must list proof blockers`);

  const serialized = JSON.stringify(recipe);
  assert.ok(!localOnlyPattern.test(serialized), `${recipe.id} contains local-only reviewer evidence`);

  const dispatch = recipe.phases.find((phase) => phase.id === 'campaign_dispatch');
  assertCommandContains(dispatch.command, [
    'homeboy fuzz run-campaign',
    `--rig ${recipe.rig}`,
    '--request-id',
    '--seed 3',
    '--tracker-ref',
    '--required-artifact canonical_fuzz_envelope',
    '--required-artifact homeboy_fuzz_coverage',
    '--lab-only',
    '--runner',
    '--detach-after-handoff',
    '--output',
  ], `${recipe.id} campaign dispatch command`);
  assert.ok(
    dispatch.command.includes(`--campaign-workload ${recipe.workload}`) ||
      dispatch.command.includes(`--campaign-manifest ${recipe.campaign_manifest}`),
    `${recipe.id} campaign dispatch command must consume a campaign workload or manifest`,
  );
  assert.ok(!dispatch.command.includes('homeboy fuzz plan'), `${recipe.id} must not use plan-only proof`);
  assert.ok(!dispatch.command.includes('homeboy fuzz run --'), `${recipe.id} must use run-campaign`);

  const resources = recipe.phases.find((phase) => phase.id === 'resources_indexed');
  assertCommandContains(resources.command, [
    'homeboy runs resources',
    '--file',
    `--run-id ${recipe.run_id}`,
    '--output',
  ], `${recipe.id} resources command`);
  assert.ok(!resources.command.includes('homeboy rig show'), `${recipe.id} resources must use persisted run resources`);

  const artifactPhase = recipe.phases.find((phase) => phase.id === 'artifacts_outcome_envelope');
  assert.equal(artifactPhase.required_outcome_schema, 'homeboy/run-outcome-envelope/v1');
  const artifactCommands = commandsForPhase(artifactPhase).join('\n');
  assertCommandContains(artifactCommands, [
    `homeboy runs watch ${recipe.run_id}`,
    `homeboy runs evidence ${recipe.run_id}`,
    `homeboy runs artifacts ${recipe.run_id}`,
    'homeboy runs refs',
    `--rig ${recipe.rig}`,
    '--tracker-ref',
    '--output',
  ], `${recipe.id} artifact commands`);

  const cleanup = recipe.phases.find((phase) => phase.id === 'cleanup_inspection');
  assertCommandContains(cleanup.command, [
    'homeboy cleanup worktrees',
    '--output',
  ], `${recipe.id} cleanup command`);
  assert.ok(!cleanup.command.includes('--apply'), `${recipe.id} cleanup inspection must not apply cleanup`);
}

console.log(`Validated ${recipes.recipes.length} Wave 3 proof recipes from ${relative(process.cwd(), recipePath)}`);
