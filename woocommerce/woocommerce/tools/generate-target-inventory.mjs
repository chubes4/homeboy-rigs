#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  declaredFuzzIds,
  readJson,
} from '../../../scripts/fuzz-manifest-helpers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.join(__dirname, '..');

const rig = readJson(packageRoot, 'rigs/woocommerce-performance/rig.json');
const coverage = readJson(packageRoot, 'manifests/full-surface-coverage.json');
const restCrudRouteFamilyCatalog = readJson(packageRoot, 'manifests/rest-crud-route-family-catalog.json');
const restCrudPayloadFixtures = readJson(packageRoot, 'manifests/rest-crud-payload-fixtures.json');
const blockInventoryRenderingFuzz = readJson(packageRoot, 'manifests/block-inventory-rendering-fuzz.json');
const adminActionInventory = readJson(packageRoot, 'manifests/admin-action-inventory.json');
const dbApiHotspotArtifactIo = readJson(packageRoot, 'manifests/db-api-hotspot-artifact-io.json');

const declaredWorkloads = [...declaredFuzzIds(rig)].sort();

const productSurfaceTaxonomy = {
  products: {
    readiness: 'executable',
    owner_profile: 'product-rest-crud-fuzzer',
    route_families: ['products-collection', 'products-batch'],
    fixture_family: 'products',
    workloads: ['rest-product-batch-import', 'woocommerce-rest-route-inventory', 'generated-rest-request-cases'],
    notes: ['Product create/update has a Woo-owned executable workload; delete remains blocked by the route-family delete-boundary contract.'],
  },
  variations: {
    readiness: 'executable',
    owner_profile: 'product-rest-crud-fuzzer',
    route_families: ['product-variations-batch'],
    fixture_family: 'products',
    workloads: ['rest-product-batch-import', 'woocommerce-rest-route-inventory', 'generated-rest-request-cases'],
    notes: ['Variation create/update is covered through the product batch import workload; destructive delete needs generic delete-boundary artifacts before execution.'],
  },
  cart: {
    readiness: 'executable',
    owner_profile: 'full-surface',
    workflows: ['browser cart scenario', 'cart session overwrite race'],
    workloads: ['cart-session-overwrite-race', 'frontend-rendering-request-coverage'],
    notes: ['Cart/session mutation is scoped to disposable fixture state and existing targeted workloads.'],
  },
  checkout: {
    readiness: 'executable',
    owner_profile: 'full-surface',
    workflows: ['synthetic checkout', 'gateway compatibility matrix', 'shipping cache'],
    workloads: ['checkout-concurrent-create-order', 'checkout-gateway-compatibility-matrix', 'checkout-shipping-cache', 'frontend-rendering-request-coverage'],
    notes: ['Checkout mutations use synthetic fixture state and do not imply live payment fuzzing.'],
  },
  orders: {
    readiness: 'declared',
    owner_profile: 'product-rest-crud-fuzzer',
    route_families: ['orders-collection', 'orders-notes', 'orders-refunds'],
    fixture_family: 'orders',
    workloads: ['woocommerce-rest-route-inventory', 'generated-rest-request-cases', 'rest-schema-query-attribution'],
    blocked_by: ['wordpress.rollback-safe-rest-mutation', 'wp-codebox/fuzz-fixture-plan/v1', 'wp-codebox/rest-mutation-fixture-opt-in/v1', 'wp-codebox/mutation-isolation-artifact/v1', 'wp-codebox/delete-boundary-artifact/v1'],
    notes: ['Order payload fixtures are declared for generic mutation primitives; Rigs does not emulate order mutation cleanup.'],
  },
  coupons: {
    readiness: 'declared',
    owner_profile: 'product-rest-crud-fuzzer',
    route_families: ['coupons-collection'],
    fixture_family: 'coupons',
    workloads: ['woocommerce-rest-route-inventory', 'generated-rest-request-cases', 'rest-schema-query-attribution'],
    blocked_by: ['wordpress.rollback-safe-rest-mutation', 'wp-codebox/fuzz-fixture-plan/v1', 'wp-codebox/rest-mutation-fixture-opt-in/v1', 'wp-codebox/mutation-isolation-artifact/v1', 'wp-codebox/delete-boundary-artifact/v1'],
    notes: ['Coupon create/update/delete fixtures stay declarative until generic rollback artifacts are emitted.'],
  },
  customers: {
    readiness: 'declared',
    owner_profile: 'product-rest-crud-fuzzer',
    route_families: ['customers-collection'],
    fixture_family: 'customers',
    workloads: ['woocommerce-rest-route-inventory', 'generated-rest-request-cases', 'rest-schema-query-attribution'],
    blocked_by: ['wordpress.rollback-safe-rest-mutation', 'wp-codebox/fuzz-fixture-plan/v1', 'wp-codebox/rest-mutation-fixture-opt-in/v1', 'wp-codebox/mutation-isolation-artifact/v1', 'wp-codebox/delete-boundary-artifact/v1'],
    notes: ['Customer mutation needs generic identity fixture isolation and rollback proof artifacts before execution.'],
  },
  settings: {
    readiness: 'blocked',
    owner_profile: 'full-surface',
    workflows: ['options/transients inventory', 'sensitive option skip classification'],
    workloads: ['options-transients-coverage', 'rollback-safe-options-transients-mutations'],
    blocked_by: ['wordpress.inventory-options-transients', 'wp-codebox/mutation-isolation-artifact/v1', 'homeboy/wordpress-rest-mutation-rollback-contract/v1'],
    sensitive_policy: 'credential-bearing, payment, tax, shipping, webhook, and marketplace settings must be skipped unless a generic sensitive-policy primitive classifies them safe in disposable fixture state.',
    notes: ['Settings are product-seasoning declarations only; aggressive setting mutation is blocked on generic sensitive-policy and rollback artifacts.'],
  },
  reports_admin_pages: {
    readiness: 'executable',
    owner_profile: 'full-surface',
    workflows: ['safe admin GET enumeration', 'analytics admin browser scenario'],
    workloads: ['admin-page-coverage', 'frontend-rendering-request-coverage'],
    notes: ['Admin/report coverage is GET-only and records skipped destructive actions.'],
  },
  store_api: {
    readiness: 'executable',
    owner_profile: 'db-api-performance-fuzzer',
    namespaces: ['wc/store/v1', 'wc/store/v2'],
    workloads: ['woocommerce-rest-route-inventory', 'generated-rest-request-cases', 'rest-db-query-profile', 'rest-schema-query-attribution'],
    notes: ['Store API coverage is generated safe-read/request profiling unless a separate synthetic checkout/cart workload owns the mutation.'],
  },
  rest_api: {
    readiness: 'executable',
    owner_profile: 'db-api-performance-fuzzer',
    namespaces: ['wc/v1', 'wc/v2', 'wc/v3', 'wc-admin', 'wc-analytics'],
    workloads: ['woocommerce-rest-route-inventory', 'generated-rest-request-cases', 'rest-permission-boundary-matrix', 'rest-namespace-generated-cases', 'rest-schema-query-attribution'],
    notes: ['REST API full-namespace mutation remains constrained by per-family readiness and generic rollback/delete-boundary primitives.'],
  },
};

const inventory = {
  schema: 'homeboy-rigs/wordpress-target-inventory/v1',
  property: 'woocommerce/woocommerce',
  generator: 'tools/generate-target-inventory.mjs',
  description: 'Generated WooCommerce target inventory contract for WP Codebox/Homeboy Extensions primitives and Woo-owned artifact expectations.',
  runtime: {
    runner: 'wp-codebox',
    fixture_scope: 'disposable-wordpress',
    component: 'woocommerce',
    activation: 'woocommerce/woocommerce.php',
  },
  source_manifests: {
    full_surface: 'manifests/full-surface-coverage.json',
    rig: 'rigs/woocommerce-performance/rig.json',
    rest_crud_route_family_catalog: 'manifests/rest-crud-route-family-catalog.json',
    rest_crud_payload_fixtures: 'manifests/rest-crud-payload-fixtures.json',
    rest_crud_fixture_plan: 'manifests/rest-crud-fixture-plan.json',
    rest_crud_fixture_opt_ins: 'manifests/rest-crud-fixture-opt-ins.json',
    block_inventory_rendering_fuzz: 'manifests/block-inventory-rendering-fuzz.json',
    admin_action_inventory: 'manifests/admin-action-inventory.json',
    db_api_hotspot_artifact_io: 'manifests/db-api-hotspot-artifact-io.json',
    aggressive_isolated_fuzz_campaign: 'manifests/aggressive-isolated-fuzz-campaign.json',
  },
  discovery_manifests: {
    product_surface_taxonomy: {
      readiness_levels: ['declared', 'blocked', 'executable'],
      provenance: 'product-level seasoning only; execution and proof remain owned by generic WP Codebox/Homeboy primitives and reviewer-facing artifacts',
      surfaces: productSurfaceTaxonomy,
    },
    rest_route_families: {
      manifest: 'manifests/rest-crud-route-family-catalog.json',
      owner_profile: restCrudRouteFamilyCatalog.owner_profile,
      readiness: {
        level: 'declared',
        coverage_contract: 'REST route-family discovery is a Woo-owned inventory contract; executable/proven status requires the owning fuzz workloads to emit reviewer-facing artifacts.',
      },
      route_family_ids: restCrudRouteFamilyCatalog.route_families.map((family) => family.id),
      payload_fixture_manifest: restCrudRouteFamilyCatalog.payload_fixture_manifest,
    },
    rest_payload_fixtures: {
      manifest: 'manifests/rest-crud-payload-fixtures.json',
      owner_profile: restCrudPayloadFixtures.owner_profile,
      readiness: restCrudPayloadFixtures.readiness,
      family_ids: restCrudPayloadFixtures.families.map((family) => family.id),
      fixture_plan_manifest: restCrudPayloadFixtures.fixture_plan_manifest,
      rest_mutation_fixture_opt_ins_manifest: restCrudPayloadFixtures.rest_mutation_fixture_opt_ins_manifest,
    },
    blocks: {
      manifest: 'manifests/block-inventory-rendering-fuzz.json',
      owner_profile: blockInventoryRenderingFuzz.owner_profile,
      readiness: blockInventoryRenderingFuzz.readiness,
      owned_by: blockInventoryRenderingFuzz.owned_by,
    },
    admin_actions: {
      manifest: 'manifests/admin-action-inventory.json',
      owner_profile: adminActionInventory.owner_profile,
      readiness: {
        level: 'declared',
        coverage_contract: 'Admin action discovery is a Woo-owned inventory contract; executable/proven status requires the owning safe admin fuzz workloads to emit reviewer-facing artifacts.',
      },
      action_family_ids: adminActionInventory.action_families.map((family) => family.id),
    },
    db_api_hotspots: {
      manifest: 'manifests/db-api-hotspot-artifact-io.json',
      owner_profile: dbApiHotspotArtifactIo.owner_profile,
      readiness: dbApiHotspotArtifactIo.readiness,
      postprocess_command: dbApiHotspotArtifactIo.postprocess_command,
    },
  },
  inventory_primitives: {
    rest_routes: {
      command: 'wordpress.inventory-rest-routes',
      status: 'preferred',
      artifact_schema: 'homeboy/wordpress-rest-route-inventory/v1',
      workload_ids: coverage.coverage_profiles['full-surface'].rest_api,
    },
    admin_pages: {
      command: 'wordpress.fuzz-admin-pages',
      status: 'preferred',
      artifact_schema: coverage.surfaces.authenticated_admin_pages.enumeration_contract.artifact_expectations.schema,
      workload_ids: coverage.coverage_profiles['full-surface'].authenticated_admin_pages,
    },
    frontend_pages: {
      command: 'wordpress.trace-browser-coverage',
      status: 'preferred',
      artifact_schema: coverage.surfaces.frontend_rendering.coverage_artifact,
      workload_ids: coverage.coverage_profiles['full-surface'].frontend_rendering,
    },
    database: {
      command: 'wordpress.inventory-database',
      status: 'preferred',
      artifact_schema: coverage.surfaces.database.inventory_artifact,
      workload_ids: coverage.coverage_profiles['full-surface'].database,
    },
    blocks: {
      command: 'wordpress.inventory-blocks',
      status: 'preferred',
      artifact_schema: 'homeboy/wordpress-block-inventory/v1',
      workload_ids: coverage.coverage_profiles['full-surface'].frontend_rendering,
    },
    options_transients: {
      command: 'wordpress.inventory-options-transients',
      status: 'preferred',
      artifact_schema: coverage.surfaces.options_transients.coverage_artifact,
      workload_ids: coverage.coverage_profiles['full-surface'].options_transients,
    },
    performance_hotspots: {
      command: 'wordpress.summarize-performance-hotspots',
      status: 'preferred',
      artifact_schema: coverage.surfaces.performance_hotspots.coverage_artifact,
      workload_ids: coverage.coverage_profiles['full-surface'].performance_hotspots,
    },
  },
  targets: {
    rest_routes: {
      namespaces: ['wc/v1', 'wc/v2', 'wc/v3', 'wc/store/v1', 'wc/store/v2', 'wc-admin', 'wc-analytics'],
      required_sections: ['routes', 'namespaces', 'permission_boundaries', 'generated_safe_get_cases', 'query_attribution'],
      gap_report_sections: ['routes_without_generated_cases', 'routes_without_permission_boundary_cases', 'routes_without_query_attribution'],
    },
    admin_pages: {
      sources: coverage.surfaces.authenticated_admin_pages.enumeration_contract.sources,
      roles: Object.keys(coverage.surfaces.authenticated_admin_pages.enumeration_contract.roles),
      safe_methods: coverage.surfaces.authenticated_admin_pages.enumeration_contract.methods,
      skip_reason_codes: coverage.surfaces.authenticated_admin_pages.enumeration_contract.skip_reason_codes,
      required_sections: coverage.surfaces.authenticated_admin_pages.enumeration_contract.artifact_expectations.required,
    },
    frontend_pages: {
      scenarios: coverage.coverage_profiles['full-surface'].browser_requests,
      required_sections: ['pages', 'requests', 'assets', 'xhr_fetch', 'console', 'errors', 'skipped_destructive_actions'],
      gap_report_sections: ['pages_without_request_coverage', 'scenarios_without_artifacts', 'unexpected_failed_requests'],
    },
    database: {
      table_prefixes: ['woocommerce_', 'wc_', 'actionscheduler_'],
      required_sections: ['tables', 'columns', 'indexes', 'row_counts', 'query_profiles'],
      query_attribution_fields: ['request_case_id', 'route', 'method', 'query_type', 'table', 'stack_summary', 'caller_summary'],
    },
    blocks: {
      block_name_prefixes: blockInventoryRenderingFuzz.block_name_prefixes,
      frontend_contexts: blockInventoryRenderingFuzz.frontend_contexts,
      required_sections: ['registered_blocks', 'rendered_blocks', 'block_assets', 'block_rest_requests', 'block_query_profiles'],
    },
    options_transients: {
      option_prefixes: ['woocommerce_', 'woocommerce-', 'wc_', '_wc_', '_woocommerce_'],
      transient_prefixes: ['_transient_wc_', '_transient_timeout_wc_', '_site_transient_wc_', '_site_transient_timeout_wc_', '_transient_woocommerce_', '_transient_timeout_woocommerce_'],
      required_sections: ['options', 'transients', 'autoloaded_options', 'action_scheduler', 'lookup_tables', 'rollback_mutations'],
    },
    performance_hotspots: {
      workloads: coverage.coverage_profiles['full-surface'].performance_hotspots,
      focus_areas: ['checkout', 'cart_session', 'catalog_layered_navigation', 'admin_dashboard', 'rest_api', 'cache_invalidation', 'external_http'],
      required_sections: ['request_timing', 'query_counts', 'cache_invalidation', 'transient_growth', 'gateway_compatibility', 'external_http_guardrail'],
      artifact_io_manifest: 'manifests/db-api-hotspot-artifact-io.json',
    },
  },
  declared_fuzz_workloads: declaredWorkloads,
};

process.stdout.write(`${JSON.stringify(inventory, null, 2)}\n`);
