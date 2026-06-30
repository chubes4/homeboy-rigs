#!/usr/bin/env node
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const coverageGapSchema = 'homeboy-rigs/wordpress-coverage-gap-report/v1';
export const hotspotSummarySchema = 'homeboy-rigs/woocommerce-performance-hotspots-summary/v1';
export const artifactPostprocessCommand = 'homeboy.artifact-postprocess';
const supportedCommands = new Set(['coverage-gap-report', 'performance-hotspots-summary']);

export function readArtifactTree(root, { maxArtifactBytes = 1024 * 1024 } = {}) {
  const artifacts = [];
  const visit = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        visit(entryPath);
        continue;
      }

      if (!entry.isFile() || !entry.name.endsWith('.json')) {
        continue;
      }

      const size = statSync(entryPath).size;
      if (size > maxArtifactBytes) {
        artifacts.push({ path: entryPath, skipped: true, reason: 'artifact_size_limit', size });
        continue;
      }

      artifacts.push({ path: entryPath, size, json: JSON.parse(readFileSync(entryPath, 'utf8')) });
    }
  };

  visit(root);
  return artifacts;
}

export function extractRestRequestCases(artifacts, { maxRouteCases = 80 } = {}) {
  return artifacts
    .filter((artifact) => artifact.json?.schema === 'homeboy/wordpress-rest-request-cases/v1')
    .flatMap((artifact) => (artifact.json.cases || []).map((requestCase) => ({
      id: requestCase.id,
      method: requestCase.method,
      path: requestCase.path,
      params: requestCase.params || {},
      source_artifact: artifact.path,
      surface: requestCase.metadata?.surface,
    })))
    .slice(0, maxRouteCases);
}

export function buildCoverageGapReport(artifacts) {
  const evidenceRefs = [];
  const expectedRoutes = new Set();
  const coveredRoutes = new Set();
  const explainedGapRoutes = new Set();
  const gaps = [];

  for (const artifact of artifacts) {
    if (artifact.skipped) {
      gaps.push({ artifact: artifact.path, reason_code: artifact.reason, size: artifact.size });
      continue;
    }

    const json = artifact.json;
    if (!json || typeof json !== 'object') {
      continue;
    }

    if (Array.isArray(json.routes)) {
      evidenceRefs.push(`artifact:${path.basename(artifact.path)}`);
      for (const route of json.routes) {
        if (route?.path) {
          expectedRoutes.add(route.path);
        }
      }
    }

    if (json.schema === 'homeboy/wordpress-rest-request-cases/v1') {
      evidenceRefs.push(`artifact:${path.basename(artifact.path)}`);
      for (const requestCase of json.cases || []) {
        if (requestCase?.path) {
          coveredRoutes.add(requestCase.path);
        }
      }
      for (const gap of json.coverage_gap?.gaps || []) {
        if (gap?.path) {
          explainedGapRoutes.add(gap.path);
        }
        gaps.push(gap);
      }
    }
  }

  for (const route of expectedRoutes) {
    if (!coveredRoutes.has(route) && !explainedGapRoutes.has(route)) {
      gaps.push({ path: route, reason_code: 'missing_generated_request_case' });
    }
  }

  return {
    schema: coverageGapSchema,
    surface_type: 'rest',
    expected: { rest_routes: expectedRoutes.size },
    covered: [...coveredRoutes].sort(),
    gaps: gaps.sort((a, b) => String(a.path || a.artifact || '').localeCompare(String(b.path || b.artifact || ''))),
    status: gaps.length === 0 ? 'covered' : 'partial',
    evidence_refs: [...new Set(evidenceRefs)].sort(),
  };
}

export function buildPerformanceHotspotsSummary(artifacts, {
  maxQuerySamples = 50,
  classifySurface = classifyGenericArtifactSurface,
} = {}) {
  const candidates = [];

  for (const artifact of artifacts) {
    if (artifact.skipped || !artifact.json || typeof artifact.json !== 'object') {
      continue;
    }

    const json = artifact.json;
    const workload = json.metadata?.workload || json.workload || path.basename(path.dirname(artifact.path)) || 'unknown';
    const surface = classifySurface(workload, json);
    const metrics = json.metrics || {};
    const querySamples = json.query_samples || json.samples || json.queries || [];
    const queryCount = Number(metrics.query_count ?? metrics.total_query_count ?? querySamples.length ?? 0);
    const elapsedMs = Number(metrics.total_elapsed_ms ?? metrics.elapsed_ms ?? metrics.duration_ms ?? 0);
    const relativeScore = queryCount + elapsedMs / 1000;

    if (relativeScore <= 0) {
      continue;
    }

    candidates.push({
      surface,
      relative_score: relativeScore,
      request_attribution: json.route || json.request || json.metadata?.coverage_shape || workload,
      query_attribution: querySamples.slice(0, maxQuerySamples),
      fixture_scale: json.fixture_scale || metrics.fixture_scale || json.metadata?.fixture_scale || 'unknown',
      run_refs: [json.run_id ? `run:${json.run_id}` : `artifact:${path.basename(artifact.path)}`],
    });
  }

  candidates.sort((a, b) => b.relative_score - a.relative_score);

  return {
    schema: hotspotSummarySchema,
    ranking: candidates.map((candidate, index) => ({
      rank: index + 1,
      ...candidate,
    })),
    threshold_policy: 'relative_ranking_only',
    evidence_refs: candidates.flatMap((candidate) => candidate.run_refs),
  };
}

export function classifyGenericArtifactSurface(workload, json) {
  return json.metadata?.surface || json.surface || json.metadata?.coverage_shape || workload || 'unknown';
}

export function classifyWooCommercePerformanceSurface(workload, json) {
  const haystack = `${workload} ${json.metadata?.coverage_shape || ''}`.toLowerCase();
  if (haystack.includes('checkout')) return 'checkout';
  if (haystack.includes('cart')) return 'cart';
  if (haystack.includes('catalog') || haystack.includes('layered')) return 'catalog';
  if (haystack.includes('admin')) return 'admin';
  return 'api';
}

export function writeJsonArtifact(outputPath, payload) {
  mkdirSync(path.dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(payload, null, 2)}\n`);
}

export function normalizeArtifactPostprocessStep(step) {
  if (!step || typeof step !== 'object' || Array.isArray(step)) {
    throw new Error('Artifact postprocess step must be an object');
  }
  if (step.command !== artifactPostprocessCommand) {
    throw new Error(`Unsupported artifact postprocess command: ${step.command}`);
  }

  const args = step.args;
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    throw new Error('Artifact postprocess step requires args');
  }
  if (typeof args.helper !== 'string' || args.helper.trim() === '') {
    throw new Error('Artifact postprocess args.helper must be a non-empty string');
  }
  if (!supportedCommands.has(args.action)) {
    throw new Error(`Unsupported artifact postprocess action: ${args.action}`);
  }

  const input = args.input;
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('Artifact postprocess args.input must be an object');
  }
  if (input.type !== 'artifact-root') {
    throw new Error(`Unsupported artifact postprocess input type: ${input.type}`);
  }
  if (typeof input.path !== 'string' || input.path.trim() === '') {
    throw new Error('Artifact postprocess args.input.path must be a non-empty string');
  }
  if (!Array.isArray(input.artifact_globs) || input.artifact_globs.length === 0) {
    throw new Error('Artifact postprocess args.input.artifact_globs must be a non-empty array');
  }

  const output = args.output;
  if (!output || typeof output !== 'object' || Array.isArray(output)) {
    throw new Error('Artifact postprocess args.output must be an object');
  }
  for (const field of ['artifact', 'path', 'kind', 'contentType', 'schema', 'semantic_key']) {
    if (typeof output[field] !== 'string' || output[field].trim() === '') {
      throw new Error(`Artifact postprocess args.output.${field} must be a non-empty string`);
    }
  }
  if (output.kind !== 'json') {
    throw new Error(`Unsupported artifact postprocess output kind: ${output.kind}`);
  }
  if (output.contentType !== 'application/json') {
    throw new Error(`Unsupported artifact postprocess output contentType: ${output.contentType}`);
  }
  if (output.schema === coverageGapSchema) {
    const requiredFields = output.required_fields || [];
    const expectedFields = ['surface_type', 'expected', 'covered', 'gaps', 'status', 'evidence_refs'];
    if (JSON.stringify(requiredFields) !== JSON.stringify(expectedFields)) {
      throw new Error(`Coverage gap output required_fields must be ${expectedFields.join(', ')}`);
    }
  }
  if (output.schema === hotspotSummarySchema) {
    const requiredFields = output.ranking?.required_fields || [];
    const expectedFields = ['rank', 'surface', 'relative_score', 'request_attribution', 'query_attribution', 'fixture_scale', 'run_refs'];
    if (output.ranking?.mode !== 'relative') {
      throw new Error('Performance hotspot output ranking.mode must be relative');
    }
    if (JSON.stringify(requiredFields) !== JSON.stringify(expectedFields)) {
      throw new Error(`Performance hotspot output ranking.required_fields must be ${expectedFields.join(', ')}`);
    }
  }

  return {
    command: args.action,
    inputRoot: input.path,
    outputPath: output.path,
    maxArtifactBytes: input.max_bytes ?? 1024 * 1024,
    maxQuerySamples: args.parameters?.maxQuerySamples ?? 50,
    outputSchema: output.schema,
  };
}

export function buildArtifactPostprocessPayload(step, { inputRoot } = {}) {
  const contract = normalizeArtifactPostprocessStep(step);
  const artifacts = readArtifactTree(inputRoot || contract.inputRoot, {
    maxArtifactBytes: contract.maxArtifactBytes,
  });
  const payload = contract.command === 'coverage-gap-report'
    ? buildCoverageGapReport(artifacts)
    : buildPerformanceHotspotsSummary(artifacts, {
      maxQuerySamples: contract.maxQuerySamples,
      classifySurface: classifyWooCommercePerformanceSurface,
    });

  if (payload.schema !== contract.outputSchema) {
    throw new Error(`Artifact postprocess output schema mismatch: expected ${contract.outputSchema}, received ${payload.schema}`);
  }

  return payload;
}

export function writeArtifactPostprocessPayload(step, { inputRoot, outputPath } = {}) {
  const contract = normalizeArtifactPostprocessStep(step);
  const payload = buildArtifactPostprocessPayload(step, { inputRoot });
  writeJsonArtifact(outputPath || contract.outputPath, payload);
  return payload;
}

async function main() {
  const [command, inputRoot, outputPath] = process.argv.slice(2);
  if (command === 'artifact-postprocess') {
    if (!inputRoot) {
      throw new Error('Usage: db-api-fuzzer-artifacts.mjs artifact-postprocess <step-json> [input-root] [output-json]');
    }
    const step = JSON.parse(readFileSync(inputRoot, 'utf8'));
    writeArtifactPostprocessPayload(step, { inputRoot: outputPath, outputPath: process.argv[5] });
    return;
  }

  if (!command || !inputRoot || !outputPath) {
    throw new Error('Usage: db-api-fuzzer-artifacts.mjs <coverage-gap-report|performance-hotspots-summary> <artifact-root> <output-json>');
  }
  if (!supportedCommands.has(command)) {
    throw new Error(`Unsupported command: ${command}`);
  }

  const artifacts = readArtifactTree(inputRoot);
  const payload = command === 'coverage-gap-report'
    ? buildCoverageGapReport(artifacts)
    : buildPerformanceHotspotsSummary(artifacts, { classifySurface: classifyWooCommercePerformanceSurface });
  writeJsonArtifact(outputPath, payload);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
