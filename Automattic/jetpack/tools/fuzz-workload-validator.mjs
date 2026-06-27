import assert from 'node:assert/strict';
import { fuzzManifestHasExecutableArtifactContract } from '../../../scripts/fuzz-manifest-helpers.mjs';

export function validateFuzzWorkload({ rel, root, workload }) {
  const isJetpackFuzz = rel.startsWith('Automattic/jetpack/fuzz/')
    || (rel.startsWith('fuzz/') && root.endsWith('/Automattic/jetpack'))
    || workload.target?.slug === 'jetpack'
    || workload.target?.component === 'jetpack';

  if (!isJetpackFuzz) {
    return [];
  }

  try {
    assertJetpackFuzzManifestReadinessContract(workload, { file: rel });
    return [];
  } catch (error) {
    return [error.message];
  }
}

export function assertJetpackFuzzManifestReadinessContract(manifest, { file = manifest.id } = {}) {
  assert.equal(manifest.target?.slug, 'jetpack', `${file} Jetpack manifest target.slug must be jetpack`);

  const readiness = manifest.metadata?.readiness;
  if (manifest.metadata?.generic_primitive?.status === 'blocked') {
    assert.ok(Array.isArray(readiness?.upstream_blockers) && readiness.upstream_blockers.length > 0, `${file} blocked generic primitive requires readiness upstream_blockers`);
  }

  if (readiness?.level === 'declared') {
    assert.ok(Array.isArray(readiness.upstream_blockers) && readiness.upstream_blockers.length > 0, `${file} declared Jetpack readiness requires upstream_blockers`);
  }

  if (fuzzManifestHasExecutableArtifactContract(manifest)) {
    assertAllArtifactsRequired(manifest, { file });
  }

  assertJetpackConnectedStateContract(manifest, { file });
}

function assertAllArtifactsRequired(manifest, { file } = {}) {
  for (const runnerCase of manifest.cases || []) {
    for (const artifact of runnerCase.artifacts || []) {
      assert.equal(artifact.required, true, `${file} executable Jetpack readiness requires case artifact ${artifact.name} to be required`);
    }
  }

  for (const artifact of manifest.artifacts?.expected || []) {
    assert.equal(artifact.required, true, `${file} executable Jetpack readiness requires expected artifact ${artifact.name} to be required`);
  }
}

function assertJetpackConnectedStateContract(manifest, { file } = {}) {
  const cases = manifest.cases || [];
  const coversConnectedState = manifest.operations?.some((operation) => typeof operation === 'string' && operation.includes('connected'))
    || cases.some((runnerCase) => runnerCase.inputs?.states?.includes('connected') || runnerCase.inputs?.fixture_states?.includes('connected'));

  if (!coversConnectedState) {
    return;
  }

  for (const runnerCase of cases) {
    const inputs = runnerCase.inputs || {};
    const skipReasonCodes = inputs.skip_reason_codes || [];

    assert.ok(skipReasonCodes.includes('connection_required'), `${file} connected-state cases must classify connection_required skips`);
    assert.ok(
      skipReasonCodes.includes('credential_unavailable') || skipReasonCodes.includes('external_service_required'),
      `${file} connected-state cases must classify credential or external-service blockers`
    );

    if (inputs.real_wpcom_credentials_allowed !== undefined) {
      assert.equal(inputs.real_wpcom_credentials_allowed, false, `${file} connected-state cases must not allow real WP.com credentials`);
    }

    if (manifest.operations?.includes('token-placeholder-serialization')) {
      assert.equal(inputs.secret_placeholders_only, true, `${file} token placeholder serialization requires secret_placeholders_only`);
    }
  }
}
