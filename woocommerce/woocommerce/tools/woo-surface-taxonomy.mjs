export const wooSurfaceReadinessStates = [
  'read_only_executable',
  'isolated_mutation_executable',
  'synthetic_mutation_executable',
  'declared_mutation',
  'blocked_delete',
  'blocked_sensitive_mutation',
];

export const wooProductSurfaceTaxonomy = {
  products: {
    readiness: 'isolated_mutation_executable',
    operation_readiness: {
      create: 'isolated_mutation_executable',
      read: 'read_only_executable',
      update: 'isolated_mutation_executable',
      delete: 'blocked_delete',
    },
    owner_profile: 'product-rest-crud-fuzzer',
    route_families: ['products-collection', 'products-batch'],
    fixture_family: 'products',
    workloads: ['rest-product-batch-import', 'woocommerce-rest-route-inventory', 'generated-rest-request-cases'],
    blocked_by: ['wp-codebox/delete-boundary-artifact/v1'],
    notes: ['Product create/update has a Woo-owned isolated mutation workload; delete remains blocked by the route-family delete-boundary contract.'],
  },
  variations: {
    readiness: 'isolated_mutation_executable',
    operation_readiness: {
      create: 'isolated_mutation_executable',
      read: 'read_only_executable',
      update: 'isolated_mutation_executable',
      delete: 'blocked_delete',
    },
    owner_profile: 'product-rest-crud-fuzzer',
    route_families: ['product-variations-batch'],
    fixture_family: 'products',
    workloads: ['rest-product-batch-import', 'woocommerce-rest-route-inventory', 'generated-rest-request-cases'],
    blocked_by: ['wp-codebox/delete-boundary-artifact/v1'],
    notes: ['Variation create/update is covered through the product batch import workload; destructive delete needs generic delete-boundary artifacts before execution.'],
  },
  cart: {
    readiness: 'synthetic_mutation_executable',
    operation_readiness: {
      read: 'read_only_executable',
      session_mutation: 'synthetic_mutation_executable',
    },
    owner_profile: 'full-surface',
    workflows: ['browser cart scenario', 'cart session overwrite race'],
    workloads: ['cart-session-overwrite-race', 'frontend-rendering-request-coverage'],
    notes: ['Cart/session mutation is scoped to disposable fixture state and existing targeted workloads.'],
  },
  checkout: {
    readiness: 'synthetic_mutation_executable',
    operation_readiness: {
      read: 'read_only_executable',
      checkout_attempt: 'synthetic_mutation_executable',
    },
    owner_profile: 'full-surface',
    workflows: ['synthetic checkout', 'gateway compatibility matrix', 'shipping cache'],
    workloads: ['checkout-concurrent-create-order', 'checkout-gateway-compatibility-matrix', 'checkout-shipping-cache', 'frontend-rendering-request-coverage'],
    notes: ['Checkout mutations use synthetic fixture state and do not imply live payment fuzzing.'],
  },
  orders: declaredMutationSurface({
    owner_profile: 'product-rest-crud-fuzzer',
    route_families: ['orders-collection', 'orders-notes', 'orders-refunds'],
    fixture_family: 'orders',
    notes: ['Order payload fixtures are declared for generic mutation primitives; Rigs does not emulate order mutation cleanup.'],
  }),
  coupons: declaredMutationSurface({
    owner_profile: 'product-rest-crud-fuzzer',
    route_families: ['coupons-collection'],
    fixture_family: 'coupons',
    notes: ['Coupon create/update/delete fixtures stay declarative until generic rollback artifacts are emitted.'],
  }),
  customers: declaredMutationSurface({
    owner_profile: 'product-rest-crud-fuzzer',
    route_families: ['customers-collection'],
    fixture_family: 'customers',
    notes: ['Customer mutation needs generic identity fixture isolation and rollback proof artifacts before execution.'],
  }),
  settings: {
    readiness: 'blocked_sensitive_mutation',
    operation_readiness: {
      inventory: 'read_only_executable',
      mutation: 'blocked_sensitive_mutation',
    },
    owner_profile: 'full-surface',
    workflows: ['options/transients inventory', 'sensitive option skip classification'],
    workloads: ['options-transients-coverage', 'rollback-safe-options-transients-mutations'],
    blocked_by: ['wordpress.inventory-options-transients', 'wp-codebox/mutation-isolation-artifact/v1', 'homeboy/wordpress-rest-mutation-rollback-contract/v1'],
    sensitive_policy: 'credential-bearing, payment, tax, shipping, webhook, and marketplace settings must be skipped unless a generic sensitive-policy primitive classifies them safe in disposable fixture state.',
    notes: ['Settings are product-seasoning declarations only; aggressive setting mutation is blocked on generic sensitive-policy and rollback artifacts.'],
  },
  reports_admin_pages: {
    readiness: 'read_only_executable',
    operation_readiness: {
      read: 'read_only_executable',
      mutation: 'blocked_sensitive_mutation',
    },
    owner_profile: 'full-surface',
    workflows: ['safe admin GET enumeration', 'analytics admin browser scenario'],
    workloads: ['admin-page-coverage', 'frontend-rendering-request-coverage'],
    blocked_by: ['wp-codebox/mutation-isolation-artifact/v1', 'homeboy/wordpress-rest-mutation-rollback-contract/v1'],
    notes: ['Admin/report coverage is GET-only and records skipped destructive actions.'],
  },
  store_api: {
    readiness: 'read_only_executable',
    operation_readiness: {
      read: 'read_only_executable',
      cart_mutation: 'synthetic_mutation_executable',
      checkout_mutation: 'synthetic_mutation_executable',
    },
    owner_profile: 'db-api-performance-fuzzer',
    namespaces: ['wc/store/v1', 'wc/store/v2'],
    workloads: ['woocommerce-rest-route-inventory', 'generated-rest-request-cases', 'rest-db-query-profile', 'rest-schema-query-attribution'],
    notes: ['Store API coverage is generated safe-read/request profiling unless a separate synthetic checkout/cart workload owns the mutation.'],
  },
  rest_api: {
    readiness: 'read_only_executable',
    operation_readiness: {
      read: 'read_only_executable',
      create: 'declared_mutation',
      update: 'declared_mutation',
      delete: 'blocked_delete',
    },
    owner_profile: 'db-api-performance-fuzzer',
    namespaces: ['wc/v1', 'wc/v2', 'wc/v3', 'wc-admin', 'wc-analytics'],
    workloads: ['woocommerce-rest-route-inventory', 'generated-rest-request-cases', 'rest-permission-boundary-matrix', 'rest-namespace-generated-cases', 'rest-schema-query-attribution'],
    blocked_by: ['wordpress.rollback-safe-rest-mutation', 'wp-codebox/delete-boundary-artifact/v1'],
    notes: ['REST API full-namespace mutation remains constrained by per-family readiness and generic rollback/delete-boundary primitives.'],
  },
};

export const wooProductSurfaceIds = Object.keys(wooProductSurfaceTaxonomy);

export const wooSequencePackSurfaceIds = [
  'products',
  'variations',
  'cart',
  'checkout',
  'orders',
  'coupons',
  'reports_admin_pages',
  'store_api',
];

export const wooRelativeHotspotLabels = ['sequence', 'action', 'query', 'table', 'route', 'page'];

function declaredMutationSurface({ owner_profile, route_families, fixture_family, notes }) {
  return {
    readiness: 'declared_mutation',
    operation_readiness: {
      create: 'declared_mutation',
      read: 'read_only_executable',
      update: 'declared_mutation',
      delete: 'blocked_delete',
    },
    owner_profile,
    route_families,
    fixture_family,
    workloads: ['woocommerce-rest-route-inventory', 'generated-rest-request-cases', 'rest-schema-query-attribution'],
    blocked_by: ['wordpress.rollback-safe-rest-mutation', 'wp-codebox/fuzz-fixture-plan/v1', 'wp-codebox/rest-mutation-fixture-opt-in/v1', 'wp-codebox/mutation-isolation-artifact/v1', 'wp-codebox/delete-boundary-artifact/v1'],
    notes,
  };
}
