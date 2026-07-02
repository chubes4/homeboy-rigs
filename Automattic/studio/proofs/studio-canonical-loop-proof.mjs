#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const defaultHostRequestPath = path.join(packageRoot, 'fixtures', 'studio-canonical-loop', 'host-request.json');

function argValue(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? null : process.argv[index + 1] || null;
}

function hasArg(name) {
  return process.argv.includes(name);
}

function assertContract(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function validateHostRequest(hostRequest) {
  const requiredFields = ['schema', 'request_id', 'prompt', 'fanout', 'artifact_contract', 'user_change', 'progress_contract'];
  for (const field of requiredFields) {
    assertContract(Boolean(hostRequest[field]), `Host request fixture is missing ${field}`);
  }

  assertContract(hostRequest.schema === 'studio/canonical-loop/host-request/v1', 'Unexpected host request schema');
  assertContract(Array.isArray(hostRequest.fanout.targets) && hostRequest.fanout.targets.length > 0, 'Fanout targets must be non-empty');
  assertContract(Boolean(hostRequest.fanout.evidence_ref), 'Fanout evidence_ref is required');
  assertContract(hostRequest.artifact_contract.source_of_truth === true, 'Artifact contract must mark the canonical artifact as source_of_truth');
  assertContract(hostRequest.artifact_contract.requires_provenance === true, 'Artifact contract must require provenance');
  assertContract(Array.isArray(hostRequest.progress_contract.required_artifacts), 'Progress contract required_artifacts must be an array');
}

async function main() {
  const checkOnly = hasArg('--check');
  const mode = argValue('--mode') || 'live';
  const hostRequestPath = argValue('--host-request') || defaultHostRequestPath;
  const hostRequest = JSON.parse(await readFile(hostRequestPath, 'utf8'));
  validateHostRequest(hostRequest);

  if (checkOnly) {
    console.log('Studio canonical loop contract fixture passed validation. No runtime proof was executed.');
    return;
  }

  if (mode !== 'live') {
    throw new Error('Stubbed Studio canonical loop proof modes have been retired. Use --check for fixture validation, or --mode live with a real Studio Native runtime and durable reviewer-facing evidence refs.');
  }

  const runtimeUrl = argValue('--runtime-url') || process.env.STUDIO_NATIVE_RUNTIME_URL;
  if (!runtimeUrl) {
    throw new Error('Live Studio canonical loop proof requires --runtime-url or STUDIO_NATIVE_RUNTIME_URL. Refusing to synthesize fake Studio Native runtime evidence.');
  }

  const durableEvidenceRef = argValue('--durable-evidence-ref') || process.env.STUDIO_CANONICAL_LOOP_DURABLE_EVIDENCE_REF;
  if (!durableEvidenceRef) {
    throw new Error('Live Studio canonical loop proof requires --durable-evidence-ref or STUDIO_CANONICAL_LOOP_DURABLE_EVIDENCE_REF. Refusing to emit local-only proof artifacts as reviewer-facing evidence.');
  }

  throw new Error('Live Studio canonical loop proof is not implemented in this harness yet. Wire real host request execution, Codebox fanout, Studio Native canonical persistence, SSI materialization, and durable artifact publication before this proof can pass.');
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
