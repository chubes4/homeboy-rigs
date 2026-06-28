import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  assertArtifactPostprocessWorkloadContract,
  assertFullSurfaceCoverageManifest,
} from '../../../scripts/fuzz-manifest-helpers.mjs';
import {
  assertWooRequiredFuzzProofContracts,
  wooRequiredFuzzProofContracts,
} from '../tools/fuzz-proof-contracts.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.join(__dirname, '..');
const repoRoot = path.join(packageRoot, '..', '..');

process.env.HOMEBOY_WORDPRESS_HELPER_MANIFEST = path.join(repoRoot, 'scripts/fixtures/homeboy-extension-wordpress/lib/helper-manifest.js');
delete process.env.HOMEBOY_WORDPRESS_FUZZ_MANIFEST_VALIDATOR;

const manifest = JSON.parse(readFileSync(path.join(__dirname, 'full-surface-coverage.json'), 'utf8'));
const performanceRig = JSON.parse(readFileSync(path.join(packageRoot, 'rigs/woocommerce-performance/rig.json'), 'utf8'));
const browserRig = JSON.parse(readFileSync(path.join(packageRoot, 'rigs/woocommerce-browser-coverage/rig.json'), 'utf8'));
const generatedRestCases = JSON.parse(readFileSync(path.join(packageRoot, 'fuzz/generated-rest-request-cases.json'), 'utf8'));
const codeboxFuzzSuiteWorkload = JSON.parse(readFileSync(path.join(packageRoot, 'fuzz/codebox-fuzz-suite-contract.json'), 'utf8'));
const codeboxFuzzSuiteManifest = JSON.parse(readFileSync(path.join(packageRoot, 'manifests/codebox-fuzz-suite-contract.json'), 'utf8'));
const dbApiFuzzCampaign = JSON.parse(readFileSync(path.join(packageRoot, 'manifests/db-api-fuzz-campaign.json'), 'utf8'));
const performanceHotspots = JSON.parse(readFileSync(path.join(packageRoot, 'fuzz/performance-hotspots-artifact-summary.json'), 'utf8'));
const restDbQueryProfileWorkload = JSON.parse(readFileSync(path.join(packageRoot, 'bench/rest-db-query-profile.workload.json'), 'utf8'));
const coverageGapReport = JSON.parse(readFileSync(path.join(packageRoot, 'fuzz/coverage-gap-report.json'), 'utf8'));
const coverageGapReportWorkload = JSON.parse(readFileSync(path.join(packageRoot, 'bench/coverage-gap-report.workload.json'), 'utf8'));
const performanceHotspotsWorkload = JSON.parse(readFileSync(path.join(packageRoot, 'bench/performance-hotspots-artifact-summary.workload.json'), 'utf8'));
const runtimePrepScript = readFileSync(path.join(packageRoot, 'tools/prepare-runtime-dependency.sh'), 'utf8');

const workloadIdFromPath = (workloadPath) => path.basename(workloadPath, path.extname(workloadPath));

const executableCoverageWorkloadIds = () => new Set([
  ...Object.values(performanceRig.bench_workloads?.wordpress || {}).flat().map((entry) => workloadIdFromPath(entry.path)),
  ...(performanceRig.fuzz_workloads?.wordpress || []).map((entry) => workloadIdFromPath(entry.path)),
  ...browserRig.trace_profiles['full-surface'],
]);

const expectedSafetyClassifications = new Set([
  'bounded_admin_fixture_mutation',
  'bounded_authenticated_read',
  'bounded_catalog_fixture_mutation',
  'browser_fixture_trace',
  'isolated_fixture_mutation',
  'network_guardrail_probe',
  'performance_observation',
  'read_only_inventory',
  'synthetic_checkout_mutation',
]);

test('full-surface manifest uses shared coverage-map and gap-report schema', () => {
  assertFullSurfaceCoverageManifest(manifest, { file: 'woocommerce full-surface coverage' });
});

test('full-surface executable workloads have coverage contract metadata', () => {
  const workloadIds = executableCoverageWorkloadIds();

  assert.ok(workloadIds.size > 0, 'expected executable full-surface workload ids');

  for (const workloadId of workloadIds) {
    const metadata = manifest.workloads?.[workloadId];
    assert.ok(metadata, `${workloadId} is missing manifest.workloads metadata`);
    assert.equal(typeof metadata.coverage_shape, 'string', `${workloadId} coverage_shape must be a string`);
    assert.ok(metadata.coverage_shape.length > 24, `${workloadId} coverage_shape should be reviewer-readable`);
    assert.equal(typeof metadata.surface, 'string', `${workloadId} surface must be a string`);
    assert.ok(expectedSafetyClassifications.has(metadata.safety?.classification), `${workloadId} has unknown safety classification`);
    assert.ok(Array.isArray(metadata.safety?.notes), `${workloadId} safety notes must be an array`);
    assert.ok(metadata.safety.notes.length > 0, `${workloadId} needs at least one safety note`);
    assert.ok(Array.isArray(metadata.artifact_expectations?.required), `${workloadId} required artifact expectations must be an array`);
    assert.ok(metadata.artifact_expectations.required.length > 0, `${workloadId} needs at least one required artifact expectation`);
  }
});

test('manifest workload metadata stays scoped to full-surface workload ids', () => {
  const workloadIds = executableCoverageWorkloadIds();

  assert.deepEqual(new Set(Object.keys(manifest.workloads)), workloadIds);
});

test('high-risk Woo fuzz manifests declare required proof contracts', () => {
  for (const workloadId of wooRequiredFuzzProofContracts.keys()) {
    const workloadPath = path.join(packageRoot, 'fuzz', `${workloadId}.json`);
    const workload = JSON.parse(readFileSync(workloadPath, 'utf8'));

    assertWooRequiredFuzzProofContracts(workload);
  }
});

test('fuzz workload metadata does not fall back to benchmark transcripts', () => {
  const fuzzWorkloadIds = new Set(
    performanceRig.fuzz_workloads.wordpress.map((entry) => workloadIdFromPath(entry.path))
  );

  for (const workloadId of fuzzWorkloadIds) {
    const optionalArtifacts = manifest.workloads[workloadId]?.artifact_expectations?.optional || [];
    assert.ok(
      !optionalArtifacts.includes('bench transcript'),
      `${workloadId} must not declare benchmark transcript fallback proof`
    );
  }
});

test('Woo Composer prep delegates to Homeboy dependency install primitive', () => {
  const composerRequirements = [
    ...performanceRig.pipeline.check,
    ...performanceRig.pipeline.fuzz_prepare,
  ].filter((step) => step.label === 'WooCommerce Composer package autoloader exists or can be prepared');

  assert.equal(composerRequirements.length, 2);
  for (const requirement of composerRequirements) {
    assert.match(requirement.prepare_command, /prepare-runtime-dependency\.sh" composer/);
  }

  assert.match(runtimePrepScript, /homeboy deps install --path "\$woocommerce_plugin_source"/);
  assert.doesNotMatch(runtimePrepScript, /composer --working-dir=.* install/);
});

test('generated REST request cases are driven by route inventory coverage semantics', () => {
  const contract = manifest.surfaces.rest_api.generated_request_cases;

  assert.equal(contract.workload, 'bench/generated-rest-request-cases.php');
  assert.deepEqual(contract.safe_methods, ['GET']);
  assert.deepEqual(
    new Set(contract.surfaces),
    new Set(['store_api', 'wc_rest_api', 'wc_admin_api', 'wc_analytics_api'])
  );
  assert.equal(contract.coverage_gap_artifact.schema, 'homeboy-rigs/woocommerce-rest-route-coverage-gap/v1');
  assert.deepEqual(
    new Set(contract.coverage_gap_artifact.required_fields),
    new Set(['surface_type', 'expected', 'covered', 'gaps', 'status', 'evidence_refs'])
  );
  assert.deepEqual(
    new Set(contract.coverage_gap_artifact.skip_reason_codes),
    new Set(['dynamic_path_parameter', 'no_safe_read_method'])
  );

  assert.equal(generatedRestCases.safety_class, 'read_only');
  assert.equal(generatedRestCases.workload.type, 'php');
  assert.equal(generatedRestCases.workload.path, '${package.root}/bench/generated-rest-request-cases.php');
  assert.equal(generatedRestCases.cases[0].intent.execute.type, 'php');
  assert.ok(
    manifest.workloads['generated-rest-request-cases'].artifact_expectations.required.includes('coverage gap artifact'),
    'generated REST workload must require the route coverage gap artifact'
  );
});

test('performance hotspot summary contract uses relative ranking instead of hard thresholds', () => {
  const artifactSchema = performanceHotspots.metadata.artifact_schema;

  assert.equal(artifactSchema.schema, 'homeboy/woocommerce-performance-hotspots-summary/v1');
  assert.equal(artifactSchema.ranking.mode, 'relative');
  assert.deepEqual(
    new Set(artifactSchema.ranking.surfaces),
    new Set(['checkout', 'cart', 'catalog', 'admin', 'api'])
  );
  assert.deepEqual(
    new Set(artifactSchema.ranking.required_fields),
    new Set(['rank', 'surface', 'relative_score', 'request_attribution', 'query_attribution', 'fixture_scale', 'run_refs'])
  );
  assert.equal(artifactSchema.threshold_policy, 'relative_ranking_only');
  assert.equal(performanceHotspots.thresholds, undefined, 'hotspot summary must not declare hardcoded thresholds');
});

test('REST DB query profile consumes generated request case artifacts with caps', () => {
  const profilerSteps = restDbQueryProfileWorkload.run.filter((step) => (
    step.type === 'rest-db-query-profiler'
  ));

  assert.equal(profilerSteps.length, 1);
  for (const step of profilerSteps) {
    assert.equal(step.rest_request_cases, undefined, `${step.type} must not fall back to hard-coded route cases`);
    assert.equal(step.rest_request_cases_source.type, 'artifact');
    assert.equal(step.rest_request_cases_source.schema, 'homeboy/wordpress-rest-request-cases/v1');
    assert.deepEqual(step.rest_request_cases_source.artifact_globs, ['generated-rest-request-cases/*.json']);
    assert.equal(step.rest_request_cases_source.maxRouteCases, 80);
    assert.equal(step.rest_request_cases_source.maxArtifactBytes, 1048576);
    assert.equal(step.sampleLimit, 50);
    assert.equal(step.fallback_policy, 'require_generated_rest_request_cases_artifact');
  }
});

test('coverage gap and hotspot reports declare the generic artifact postprocess contract', () => {
  assert.equal(coverageGapReport.metadata.readiness.level, 'executable');
  assert.equal(coverageGapReport.workload.path, '${package.root}/bench/coverage-gap-report.workload.json');
  assert.equal(coverageGapReport.workload.type, 'json');
  assert.equal(coverageGapReport.safety_class, 'read_only');
  assert.equal(coverageGapReport.artifacts.expected[0].name, 'coverage_gap_report');
  assertArtifactPostprocessWorkloadContract(coverageGapReportWorkload, {
    id: 'coverage-gap-report',
    action: 'coverage-gap-report',
    artifact: 'coverage_gap_report',
    outputPath: 'coverage-gap-report/coverage_gap_report.json',
    schema: 'homeboy-rigs/wordpress-coverage-gap-report/v1',
  });

  assert.equal(performanceHotspots.metadata.readiness.level, 'executable');
  assert.equal(performanceHotspots.workload.path, '${package.root}/bench/performance-hotspots-artifact-summary.workload.json');
  assert.equal(performanceHotspots.workload.type, 'json');
  assert.equal(performanceHotspots.safety_class, 'read_only');
  assert.equal(performanceHotspots.artifacts.expected[0].name, 'performance_hotspots_summary');
  assertArtifactPostprocessWorkloadContract(performanceHotspotsWorkload, {
    id: 'performance-hotspots-artifact-summary',
    action: 'performance-hotspots-summary',
    artifact: 'performance_hotspots_summary',
    outputPath: 'performance-hotspots-artifact-summary/performance_hotspots_summary.json',
    schema: 'homeboy/woocommerce-performance-hotspots-summary/v1',
  });
});

test('DB/API campaign consumes the declared Codebox fixture contract without proof refs', () => {
  assert.equal(dbApiFuzzCampaign.suite_manifest, 'manifests/codebox-fuzz-suite-contract.json');
  assert.equal(codeboxFuzzSuiteWorkload.metadata.fixture.suite_manifest, '${package.root}/manifests/codebox-fuzz-suite-contract.json');
  assert.equal(codeboxFuzzSuiteManifest.target.metadata.proof_bundle, undefined);
  assert.equal(codeboxFuzzSuiteManifest.target.metadata.proof_bundle_requirements.status, 'required_before_proven');
});
