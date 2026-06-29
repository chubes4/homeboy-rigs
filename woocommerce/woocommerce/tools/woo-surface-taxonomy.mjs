export const wooSurfaceReadinessStates = [
  'read_only_executable',
  'targeted_workload_executable',
  'generic_mutation_declared',
  'synthetic_mutation_executable',
  'destructive_mutation_declared',
  'sensitive_mutation_declared',
  'declared_mutation',
];

export const wooProductSurfaceTaxonomy = {
  products: {
    readiness: 'targeted_workload_executable',
    operation_readiness: {
      create: 'targeted_workload_executable',
      read: 'read_only_executable',
      update: 'targeted_workload_executable',
      delete: 'destructive_mutation_declared',
    },
    owner_profile: 'product-rest-crud-fuzzer',
    route_families: ['products-collection', 'products-batch'],
    fixture_family: 'products',
    workloads: ['rest-product-batch-import', 'woocommerce-rest-route-inventory', 'generated-rest-request-cases'],
    blocked_by: [],
    notes: ['Product create/update has targeted executable coverage through rest-product-batch-import; generic fixture-plan mutation and delete execution remain declared-only while the fixture plan says execute:false.'],
  },
  variations: {
    readiness: 'targeted_workload_executable',
    operation_readiness: {
      create: 'targeted_workload_executable',
      read: 'read_only_executable',
      update: 'targeted_workload_executable',
      delete: 'destructive_mutation_declared',
    },
    owner_profile: 'product-rest-crud-fuzzer',
    route_families: ['product-variations-batch'],
    fixture_family: 'products',
    workloads: ['rest-product-batch-import', 'woocommerce-rest-route-inventory', 'generated-rest-request-cases'],
    blocked_by: [],
    notes: ['Variation create/update has targeted executable coverage through rest-product-batch-import; generic fixture-plan mutation and delete execution remain declared-only while the fixture plan says execute:false.'],
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
    notes: ['Order create/update/delete are generic fixture-plan declarations only while the fixture plan says execute:false; read coverage is executable through generated safe requests and schema/query attribution.'],
  }),
  coupons: declaredMutationSurface({
    owner_profile: 'product-rest-crud-fuzzer',
    route_families: ['coupons-collection'],
    fixture_family: 'coupons',
    notes: ['Coupon create/update/delete are generic fixture-plan declarations only while the fixture plan says execute:false; read coverage is executable through generated safe requests and schema/query attribution.'],
  }),
  customers: declaredMutationSurface({
    owner_profile: 'product-rest-crud-fuzzer',
    route_families: ['customers-collection'],
    fixture_family: 'customers',
    notes: ['Customer create/update/delete are generic fixture-plan declarations only while the fixture plan says execute:false; read coverage is executable through generated safe requests and schema/query attribution.'],
  }),
  settings: {
    readiness: 'read_only_executable',
    operation_readiness: {
      inventory: 'read_only_executable',
      mutation: 'sensitive_mutation_declared',
    },
    owner_profile: 'full-surface',
    workflows: ['options/transients inventory', 'sensitive option skip classification'],
    workloads: ['options-transients-coverage', 'rollback-safe-options-transients-mutations'],
    blocked_by: [],
    sensitive_policy: 'credential-bearing, payment, tax, shipping, webhook, and marketplace settings must be skipped unless a generic sensitive-policy primitive classifies them safe in disposable fixture state.',
    notes: ['Settings mutation remains declared-only until generic policy-classified safe settings produce rollback and reviewer-facing artifacts.'],
  },
  reports_admin_pages: {
    readiness: 'read_only_executable',
    operation_readiness: {
      read: 'read_only_executable',
      mutation: 'sensitive_mutation_declared',
    },
    owner_profile: 'full-surface',
    workflows: ['safe admin GET enumeration', 'analytics admin browser scenario'],
    workloads: ['admin-page-coverage', 'frontend-rendering-request-coverage'],
    blocked_by: [],
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
      create: 'generic_mutation_declared',
      update: 'generic_mutation_declared',
      delete: 'destructive_mutation_declared',
    },
    owner_profile: 'db-api-performance-fuzzer',
    namespaces: ['wc/v1', 'wc/v2', 'wc/v3', 'wc-admin', 'wc-analytics'],
    workloads: ['woocommerce-rest-route-inventory', 'generated-rest-request-cases', 'rest-permission-boundary-matrix', 'rest-namespace-generated-cases', 'rest-schema-query-attribution'],
    blocked_by: ['Generic REST fixture plan keeps create/update/delete operations execute:false.'],
    notes: ['REST API full-namespace mutation is declared-only while the generic fixture plan keeps create/update/delete operations execute:false; safe read coverage remains executable.'],
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
    readiness: 'read_only_executable',
    operation_readiness: {
      create: 'generic_mutation_declared',
      read: 'read_only_executable',
      update: 'generic_mutation_declared',
      delete: 'destructive_mutation_declared',
    },
    owner_profile,
    route_families,
    fixture_family,
    workloads: ['woocommerce-rest-route-inventory', 'generated-rest-request-cases', 'rest-schema-query-attribution'],
    blocked_by: ['Generic REST fixture plan keeps create/update/delete operations execute:false.'],
    notes,
  };
}
