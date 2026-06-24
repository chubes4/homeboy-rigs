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
const blockInventoryRenderingFuzz = readJson(packageRoot, 'manifests/block-inventory-rendering-fuzz.json');
const adminActionInventory = readJson(packageRoot, 'manifests/admin-action-inventory.json');
const dbApiHotspotArtifactIo = readJson(packageRoot, 'manifests/db-api-hotspot-artifact-io.json');

const declaredWorkloads = [...declaredFuzzIds(rig)].sort();

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
    block_inventory_rendering_fuzz: 'manifests/block-inventory-rendering-fuzz.json',
    admin_action_inventory: 'manifests/admin-action-inventory.json',
    db_api_hotspot_artifact_io: 'manifests/db-api-hotspot-artifact-io.json',
  },
  discovery_manifests: {
    rest_route_families: {
      manifest: 'manifests/rest-crud-route-family-catalog.json',
      owner_profile: restCrudRouteFamilyCatalog.owner_profile,
      readiness: 'declared_inventory',
      route_family_ids: restCrudRouteFamilyCatalog.route_families.map((family) => family.id),
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
      readiness: 'declared_inventory',
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
