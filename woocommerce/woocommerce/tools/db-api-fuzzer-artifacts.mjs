import path from 'node:path';

export const coverageGapSchema = 'homeboy-rigs/wordpress-coverage-gap-report/v1';
export const hotspotSummarySchema = 'homeboy-rigs/woocommerce-performance-hotspots-summary/v1';
export const artifactPostprocessCommand = 'homeboy.artifact-postprocess';

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
