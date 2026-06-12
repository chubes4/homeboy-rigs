# WooCommerce REST Product Batch Import

`rest-product-batch-import` is the WooCommerce REST batch workload for product
and variation create/update performance. It exercises `/wc/v3/products/batch`
and `/wc/v3/products/{product_id}/variations/batch` through the WP Codebox
WordPress bench runtime.

## Matrix Shape

The workload is matrix-ready through Homeboy core's existing settings matrix
primitive. Use dotted `bench_env.*` axes so each cell receives a typed
`bench_env` object without adding rig-specific runner behavior.

Supported axes:

- `bench_env.WC_REST_BATCH_IMPORT_FOCUS_PHASE`: `simple_create`,
  `simple_update`, `variation_create`, or `variation_update`.
- `bench_env.WC_REST_BATCH_IMPORT_ITEMS`: batch size, clamped to `1..100`.
- `bench_env.WC_REST_BATCH_IMPORT_ATTRIBUTES`: attributes per product/parent,
  clamped to `0..10`.
- `bench_env.WC_REST_BATCH_IMPORT_TERMS_PER_ATTRIBUTE`: terms per attribute,
  clamped to `1..50`.
- `bench_env.WC_REST_BATCH_IMPORT_CATALOG_PRODUCTS`: pre-existing catalog seed
  size, clamped to `0..10000`.

Each cell still executes all four REST phases so guardrails remain comparable,
then promotes the selected `WC_REST_BATCH_IMPORT_FOCUS_PHASE` into generic
`focused_phase_*` metrics for matrix ranking. The raw artifact records the exact
cell settings, per-phase rows, scenario labels, side-effect guardrails, hook
counters, query buckets, and REST status/error data.

Small matrix smoke:

```sh
homeboy bench matrix \
  --rig woocommerce-performance \
  --scenario rest-product-batch-import \
  --iterations 1 \
  --shared-state /tmp/woocommerce-rest-product-batch-import-matrix-smoke \
  --setting-matrix bench_env.WC_REST_BATCH_IMPORT_FOCUS_PHASE=simple_create,variation_create \
  --setting-matrix bench_env.WC_REST_BATCH_IMPORT_ITEMS=1,5 \
  --setting-matrix bench_env.WC_REST_BATCH_IMPORT_ATTRIBUTES=0,2 \
  --setting-matrix bench_env.WC_REST_BATCH_IMPORT_TERMS_PER_ATTRIBUTE=1,2 \
  --setting-matrix bench_env.WC_REST_BATCH_IMPORT_CATALOG_PRODUCTS=0
```

Hot slow-path discovery matrix:

```sh
homeboy bench matrix \
  --rig woocommerce-performance \
  --scenario rest-product-batch-import \
  --iterations 1 \
  --shared-state /tmp/woocommerce-rest-product-batch-import-matrix-hot \
  --setting-matrix bench_env.WC_REST_BATCH_IMPORT_FOCUS_PHASE=simple_create,simple_update,variation_create,variation_update \
  --setting-matrix bench_env.WC_REST_BATCH_IMPORT_ITEMS=5,25,100 \
  --setting-matrix bench_env.WC_REST_BATCH_IMPORT_ATTRIBUTES=0,2,5 \
  --setting-matrix bench_env.WC_REST_BATCH_IMPORT_TERMS_PER_ATTRIBUTE=1,10,50 \
  --setting-matrix bench_env.WC_REST_BATCH_IMPORT_CATALOG_PRODUCTS=0,1000,10000
```

Rank cells from the matrix JSON by `focused_phase_queries_per_item` or
`focused_phase_ms_per_item`. Reusable ranking/report helpers belong in
[Homeboy Extensions #1298](https://github.com/Extra-Chill/homeboy-extensions/issues/1298);
the WooCommerce rig emits the structured artifacts needed by that reporter now.

## Regression Guardrails

The workload now always runs these correctness scenarios while collecting the
existing performance counters:

- `reentrant_save_post_product_create_fanout`: installs a `save_post_product`
  listener that re-saves the product during create, matching common extension
  fanout behavior.
- `reentrant_save_post_product_variation_create_fanout`: installs a
  `save_post_product_variation` listener that re-saves each variation during
  create, covering variation-specific extension fanout behavior.
- `duplicate_meta_and_readback_correctness`: scans created simple products and
  variations for duplicate postmeta rows, then verifies simple product and
  variation stock values read back from WooCommerce match the REST update
  payload.
- `shared_product_and_variation_data_store_reuse`: forces product and variation datastore
  loading through shared instances using WooCommerce datastore filters, so
  create-state leaks across nested saves are visible.
- `preexisting_internal_meta_before_create_save_completes`: seeds stale
  `_stock`, `_manage_stock`, `_stock_status`, `_regular_price`, `_price`, and
  `_sku` rows from an early `save_post_product` hook, then verifies WooCommerce
  overwrites them to the canonical REST payload values without duplicate rows.
- `third_party_internal_meta_hook_adjacent_writes`: reacts to
  `added_post_meta` and `updated_post_meta` for Woo internal keys by writing
  adjacent plugin-owned meta, covering nested meta writes without a full product
  re-save.
- `variation_parent_sync_under_reentrant_save`: checks parent child lists,
  direct `post_parent` rows, child manage-stock/stock/status readback, and
  variation internal meta values after the parent/variation save cascade.
- `duplicate_sku_retry_guardrail`: replays a one-item create with an existing
  stable SKU and asserts it returns the expected create error without
  multiplying internal meta rows on the original product.

These scenarios are labeled in the JSON artifact under
`side_effects.scenario_labels` and exposed as metrics including:

- `scenario_reentrant_save_post_product`
- `scenario_shared_product_data_store`
- `scenario_preexisting_internal_meta`
- `scenario_third_party_meta_hooks`
- `scenario_variation_parent_sync_guardrail`
- `scenario_duplicate_sku_retry`
- `side_effect_reentrant_save_post_product_count`
- `side_effect_reentrant_save_post_product_variation_count`
- `side_effect_shared_product_data_store_loads`
- `side_effect_shared_variation_data_store_loads`
- `side_effect_preexisting_internal_meta_writes`
- `side_effect_third_party_adjacent_meta_writes`
- `side_effect_simple_duplicate_meta_row_count`
- `side_effect_variation_duplicate_meta_row_count`
- `side_effect_simple_internal_duplicate_meta_row_count`
- `side_effect_variation_internal_duplicate_meta_row_count`
- `side_effect_simple_internal_meta_value_mismatches`
- `side_effect_variation_internal_meta_value_mismatches`
- `side_effect_simple_sku_lookup_mismatches`
- `side_effect_variation_sku_lookup_mismatches`
- `side_effect_parent_missing_child_count`
- `side_effect_variation_post_parent_mismatches`
- `side_effect_duplicate_sku_retry_response_errors`
- `side_effect_duplicate_sku_retry_internal_meta_row_delta`
- `side_effect_simple_manage_stock_readback_mismatches`
- `side_effect_simple_stock_readback_mismatches`
- `side_effect_variation_manage_stock_readback_mismatches`

The run fails its side-effect invariant count when duplicate internal meta rows,
stale SKU/stock/price readback, missing SKU lookup rows, missing nested plugin
meta writes, broken variation parent sync, retry row multiplication, or missing
shared datastore reuse are observed.

This coverage exists to guard the WooCommerce REST batch import fast path before
fixing [WooCommerce PR #65595](https://github.com/woocommerce/woocommerce/pull/65595).
Related tracking context: [homeboy-rigs #227](https://github.com/chubes4/homeboy-rigs/issues/227),
[homeboy-rigs #228](https://github.com/chubes4/homeboy-rigs/issues/228),
[homeboy-rigs #229](https://github.com/chubes4/homeboy-rigs/issues/229), and
[Homeboy Extensions #1266](https://github.com/Extra-Chill/homeboy-extensions/issues/1266)
for the runner/workload infrastructure context.

## Commands

Prepare and check the rig:

```sh
homeboy rig up woocommerce-performance
homeboy rig check woocommerce-performance
```

Small correctness smoke:

```sh
homeboy bench --rig woocommerce-performance \
  --scenario rest-product-batch-import \
  --iterations 1 \
  --shared-state /tmp/woocommerce-rest-product-batch-import-smoke \
  --setting-json 'bench_env={"WC_REST_BATCH_IMPORT_ITEMS":"2","WC_REST_BATCH_IMPORT_ATTRIBUTES":"1","WC_REST_BATCH_IMPORT_TERMS_PER_ATTRIBUTE":"2","WC_REST_BATCH_IMPORT_CATALOG_PRODUCTS":"0","WC_REST_BATCH_IMPORT_FOCUS_PHASE":"variation_create"}'
```

Reviewer-scale evidence should use the offloaded Homeboy/bench path instead of
local benchmark loops on the Studio machine.
