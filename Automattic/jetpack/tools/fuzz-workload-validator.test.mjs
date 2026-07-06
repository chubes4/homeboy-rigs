import assert from 'node:assert/strict';
import test from 'node:test';
import { assertJetpackFuzzManifestReadinessContract } from './fuzz-workload-validator.mjs';

test('rejects executable readiness with optional artifacts', () => {
  assert.throws(
    () => assertJetpackFuzzManifestReadinessContract({
      schema: 'homeboy/fuzz-workload/v1',
      id: 'jetpack-fuzz',
      target: { type: 'wordpress-plugin', slug: 'jetpack', component: 'jetpack' },
      operations: ['route-inventory'],
      metadata: {
        readiness: { level: 'executable', coverage_contract: 'Jetpack executable fuzz contract.' },
      },
      cases: [
        {
          case_id: 'jetpack-fuzz:default',
          artifacts: [{ name: 'report', path: 'report.json', required: false }],
        },
      ],
      artifacts: { expected: [{ name: 'report', path: 'report.json', required: true }] },
    }, { file: 'jetpack-fuzz.json' })
  );
});
