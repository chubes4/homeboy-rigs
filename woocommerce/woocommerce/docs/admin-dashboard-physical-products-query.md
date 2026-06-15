# Admin Dashboard Physical Products Query

`admin-dashboard-physical-products-query` captures the WooCommerce admin
dashboard onboarding path from the forum/Zendesk report tracked in
https://github.com/chubes4/homeboy-rigs/issues/224.

## Source Reports

- Zendesk: https://automattic.zendesk.com/agent/tickets/5428113
- Public forum: https://wordpress.org/support/topic/wp_query-get_posts-slow-query-on-dashboard/

## Workload Shape

The workload runs inside Homeboy Extensions' `wordpress.bench` runtime with the
WooCommerce checkout mounted as the runtime plugin. It:

- Seeds configurable simple products and `product_cat` terms.
- Writes deterministic `_virtual` metadata using `WC_ADMIN_DASHBOARD_PHYSICAL_PERCENT`.
- Sets WooCommerce onboarding state so the shipping task can see physical products.
- Exercises `Shipping::has_physical_products()` directly.
- Exercises the `WC_Admin_Dashboard_Setup` setup-widget PHP path when available.
- Records full dashboard request metrics as unavailable because the current
  `wordpress.bench` PHP workload API does not issue a real `wp-admin/index.php`
  HTTP request.
- Captures query strings, query counts, slowest query summaries, and matching
  `_virtual` product-query evidence when the tested WooCommerce branch emits it.

Current WooCommerce trunk may not emit the reported SQL because
`Shipping::has_physical_products()` now reads onboarding profile data directly.
That is expected and is recorded as `matching_query_count: 0` in the raw artifact
for branches where the SQL-backed path is absent.

## Commands

```bash
homeboy rig up woocommerce-performance
homeboy rig check woocommerce-performance
homeboy bench --rig woocommerce-performance \
  --scenario admin-dashboard-physical-products-query \
  --iterations 1 \
  --shared-state /tmp/woocommerce-admin-dashboard-products \
  --setting-json 'bench_env={"WC_ADMIN_DASHBOARD_PRODUCTS":"500","WC_ADMIN_DASHBOARD_TERMS":"20"}'
```

Use larger sweeps through `bench_env` when running in an offloaded Homeboy lab:

```bash
homeboy bench --rig woocommerce-performance \
  --scenario admin-dashboard-physical-products-query \
  --iterations 1 \
  --shared-state /tmp/woocommerce-admin-dashboard-products-5000x100 \
  --setting-json 'bench_env={"WC_ADMIN_DASHBOARD_PRODUCTS":"5000","WC_ADMIN_DASHBOARD_TERMS":"100","WC_ADMIN_DASHBOARD_PHYSICAL_PERCENT":"100"}'
```

## Metrics

The normalized metrics include:

- `direct_has_physical_products_ms`
- `dashboard_setup_widget_ms`
- `dashboard_request_available`, `dashboard_request_elapsed_ms`
- `matching_query_elapsed_ms`
- `matching_query_count`
- `total_query_count`
- `product_count`, `term_count`, `physical_product_count`, `virtual_product_count`
- `onboarding_product_types_physical`
- `woocommerce_version`

Raw JSON artifacts are written under
`$HOMEBOY_BENCH_SHARED_STATE/admin-dashboard-physical-products-query/` and include
the captured SQL snippets and call-site metadata where WordPress query logging
provides it.
