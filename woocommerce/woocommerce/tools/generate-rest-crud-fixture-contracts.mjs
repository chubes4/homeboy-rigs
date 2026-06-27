#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readJson } from '../../../scripts/fuzz-manifest-helpers.mjs';

const FUZZ_FIXTURE_PLAN_SCHEMA = 'wp-codebox/fuzz-fixture-plan/v1';
const REST_MUTATION_FIXTURE_OPT_IN_SCHEMA = 'wp-codebox/rest-mutation-fixture-opt-in/v1';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.join(__dirname, '..');
const artifact = process.argv.find((arg) => arg.startsWith('--artifact='))?.split('=')[1] || 'all';

const payloadFixtures = readJson(packageRoot, 'manifests/rest-crud-payload-fixtures.json');
const routeFamilyCatalog = readJson(packageRoot, 'manifests/rest-crud-route-family-catalog.json');
const routeFamilies = new Map(routeFamilyCatalog.route_families.map((family) => [family.id, family]));

const fixturePlanRef = payloadFixtures.fixture_plan_manifest;
const optInsRef = payloadFixtures.rest_mutation_fixture_opt_ins_manifest;
const operations = payloadFixtures.families.flatMap((family) => buildFamilyOperations(family));

const fixturePlan = {
  schema: FUZZ_FIXTURE_PLAN_SCHEMA,
  id: 'woocommerce-rest-crud-fixture-plan',
  version: '1',
  operations,
  operationKinds: [...new Set(operations.map((operation) => operation.kind))],
  metadata: {
    source_manifest: 'manifests/rest-crud-payload-fixtures.json',
    route_family_catalog_manifest: payloadFixtures.route_family_catalog_manifest,
    owner_profile: payloadFixtures.owner_profile,
    readiness_level: payloadFixtures.readiness.level,
    runner_behavior: payloadFixtures.runner_behavior,
    proof_status: 'declared_contract',
    execution_enabled: false,
    blocker: 'Generic REST mutation runner, rollback/isolation artifacts, delete-boundary artifacts, and reviewer-facing evidence refs are required before execution.',
    operation_ready_refs: buildOperationReadyRefs(),
  },
};

const optIns = {
  schema: 'homeboy-rigs/woocommerce-rest-mutation-fixture-opt-ins/v1',
  id: 'woocommerce-rest-mutation-fixture-opt-ins',
  fixturePlanRef,
  optIns: buildOptIns(),
  metadata: {
    source_manifest: 'manifests/rest-crud-payload-fixtures.json',
    route_family_catalog_manifest: payloadFixtures.route_family_catalog_manifest,
    owner_profile: payloadFixtures.owner_profile,
    readiness_level: payloadFixtures.readiness.level,
    runner_behavior: payloadFixtures.runner_behavior,
    proof_status: 'declared_contract',
    execution_enabled: false,
    fixture_plan_schema: FUZZ_FIXTURE_PLAN_SCHEMA,
    opt_in_schema: REST_MUTATION_FIXTURE_OPT_IN_SCHEMA,
  },
};

if (artifact === 'fixture-plan') {
  writeJson(fixturePlan);
} else if (artifact === 'opt-ins') {
  writeJson(optIns);
} else if (artifact === 'all') {
  writeJson({ fixturePlan, optIns });
} else {
  throw new Error(`Unsupported artifact: ${artifact}`);
}

function buildFamilyOperations(family) {
  const operations = [];
  for (const operation of ['create', 'update', 'delete']) {
    const shapes = family.payload_shapes?.[operation] || [];
    if (shapes.length === 0) {
      continue;
    }
    operations.push({
      id: `${family.id}-${operation}`,
      kind: 'mutation',
      resource: {
        kind: family.id.slice(0, -1) || family.id,
        id: family.id,
        metadata: {
          fixture_family: family.id,
          fixture_scope: family.fixture_scope,
          route_family_ids: family.route_family_ids,
        },
      },
      method: methodForOperation(operation),
      target: `${family.namespace}:${family.route_family_ids.join('|')}`,
      input: {
        payload_shapes: shapes,
        namespace: family.namespace,
        roles: family.roles,
      },
      expected: {
        readiness_level: 'declared',
        execute: false,
        blocked_until: blockedUntilForOperation(family, operation),
      },
      metadata: {
        operation,
        safety_class: operation === 'delete' ? 'destructive' : 'isolated_mutation',
        rollback_required: true,
        delete_boundary_required: operation === 'delete',
        proof_status: 'declared_contract',
      },
    });
  }
  return operations;
}

function buildOptIns() {
  return payloadFixtures.families.flatMap((family) => family.route_family_ids.flatMap((routeFamilyId) => {
    const routeFamily = routeFamilies.get(routeFamilyId);
    if (!routeFamily) {
      throw new Error(`${family.id} references unknown route family ${routeFamilyId}`);
    }

    return routeFamily.routes.map((route) => ({
      schema: REST_MUTATION_FIXTURE_OPT_IN_SCHEMA,
      id: `${routeFamilyId}-${slugify(route)}-rest-mutation-fixture-opt-in`,
      route,
      methods: ['POST', 'PUT', 'PATCH', 'DELETE'],
      fixturePlanRef,
      metadata: {
        fixture_family: family.id,
        route_family_id: routeFamilyId,
        namespace: family.namespace,
        roles: family.roles,
        readiness_level: 'declared',
        execution_enabled: false,
        proof_status: 'declared_contract',
        blocker: 'Runner readiness plus rollback/isolation artifacts are required before create/update execution; delete-boundary artifacts are additionally required before delete execution.',
      },
    }));
  }));
}

function buildOperationReadyRefs() {
  return payloadFixtures.families.map((family) => ({
    family_id: family.id,
    readiness_level: 'declared',
    execution_enabled: false,
    proof_status: 'declared_contract',
    fixture_plan_schema: FUZZ_FIXTURE_PLAN_SCHEMA,
    opt_in_schema: REST_MUTATION_FIXTURE_OPT_IN_SCHEMA,
    operation_refs: ['create', 'update', 'delete'].map((operation) => ({
      operation,
      fixture_plan_ref: `${fixturePlanRef}#operations/${family.id}-${operation}`,
      opt_in_manifest_ref: optInsRef,
      execute: false,
    })),
  }));
}

function methodForOperation(operation) {
  if (operation === 'create') {
    return 'POST';
  }
  if (operation === 'delete') {
    return 'DELETE';
  }
  return 'PUT';
}

function blockedUntilForOperation(family, operation) {
  return family.blocked_operations?.[operation]
    || (operation === 'delete'
      ? 'delete-boundary rollback artifact contract is unavailable'
      : 'generic REST mutation runner has not emitted rollback/isolation artifacts');
}

function slugify(value) {
  return value
    .toLowerCase()
    .replace(/<([^>]+)>/g, '$1')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function writeJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}
