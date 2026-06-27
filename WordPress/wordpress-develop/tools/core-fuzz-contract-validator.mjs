export function validateWordPressCoreFuzzContract({ rel, root, workload }) {
  const failures = [];
  const isWordPressDevelopFuzz = rel.startsWith('WordPress/wordpress-develop/fuzz/')
    || (rel.startsWith('fuzz/') && root.endsWith('/WordPress/wordpress-develop'));

  if (isWordPressCoreFuzzWorkload(workload) && !isWordPressDevelopFuzz) {
    failures.push(`${rel}: WordPress Core fuzz workloads must live under WordPress/wordpress-develop/fuzz`);
  }

  if (!isWordPressDevelopFuzz) {
    return failures;
  }

  const semanticKeys = collectExpectedSemanticKeys(workload);

  if (workload.id === 'rest-api') {
    assertIncludesAll(failures, rel, workload, 'operations', [
      'rest-route-inventory',
      'generated-rest-case-plan',
      'request-case-execution',
      'permission-boundary-classification',
      'role-boundary-execution',
    ]);

    for (const semanticKey of ['fuzz.rest.route_inventory', 'fuzz.rest.generated_cases', 'fuzz.rest.permission_boundaries']) {
      if (!semanticKeys.has(semanticKey)) {
        failures.push(`${rel}: rest-api must declare expected artifact semantic key ${semanticKey}`);
      }
    }
  }

  if (workload.id === 'db-inventory-query-profile') {
    assertIncludesAll(failures, rel, workload, 'surface_ids', [
      'wordpress-core-database',
      'wordpress-core-rest-routes',
      'wordpress-core-options',
      'wordpress-core-postmeta',
      'wordpress-core-rewrites',
    ]);
    assertIncludesAll(failures, rel, workload, 'operations', [
      'schema-inventory',
      'rest-query-profile',
      'options-query-attribution',
      'postmeta-query-attribution',
      'rewrite-query-attribution',
    ]);

    for (const semanticKey of ['fuzz.db.schema_inventory', 'fuzz.db.rest_query_attribution', 'fuzz.db.options_postmeta_rewrite_attribution']) {
      if (!semanticKeys.has(semanticKey)) {
        failures.push(`${rel}: db-inventory-query-profile must declare expected artifact semantic key ${semanticKey}`);
      }
    }
  }

  if (workload.id === 'hooks-cron-options') {
    assertIncludesAll(failures, rel, workload, 'surface_ids', ['wordpress-core-options', 'wordpress-core-postmeta', 'wordpress-core-rewrites']);
    assertIncludesAll(failures, rel, workload, 'operations', ['option-inventory', 'transient-inventory', 'postmeta-inventory', 'rewrite-rule-inventory', 'rewrite-query-attribution']);

    if (!semanticKeys.has('fuzz.runtime.rewrite_postmeta_options_inventory')) {
      failures.push(`${rel}: hooks-cron-options must declare expected artifact semantic key fuzz.runtime.rewrite_postmeta_options_inventory`);
    }
  }

  return failures;
}

export function isWordPressCoreFuzzWorkload(workload) {
  const surfaceIds = Array.isArray(workload.surface_ids) ? workload.surface_ids : [];

  return workload.target?.type === 'wordpress-core'
    || workload.target?.component === 'wordpress-develop'
    || workload.metadata?.kind === 'wordpress-core-fuzz'
    || surfaceIds.some((surfaceId) => typeof surfaceId === 'string' && surfaceId.startsWith('wordpress-core-'));
}

function assertIncludesAll(failures, rel, workload, field, expectedValues) {
  const values = Array.isArray(workload[field]) ? workload[field] : [];
  for (const expectedValue of expectedValues) {
    if (!values.includes(expectedValue)) {
      failures.push(`${rel}: ${workload.id} must include ${expectedValue} in ${field}`);
    }
  }
}

function collectExpectedSemanticKeys(workload) {
  const expectedArtifacts = workload.artifacts?.expected;
  if (!Array.isArray(expectedArtifacts)) {
    return new Set();
  }

  return new Set(expectedArtifacts.map((artifact) => artifact?.semantic_key).filter(Boolean));
}
