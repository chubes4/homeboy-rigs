# WooCommerce REST Product Batch Import

`rest-product-batch-import` is the WooCommerce REST batch workload for product
and variation create/update performance. It exercises `/wc/v3/products/batch`
and `/wc/v3/products/{product_id}/variations/batch` through the WP Codebox
WordPress bench runtime.

## Regression Guardrails

The workload now always runs these correctness scenarios while collecting the
existing performance counters:

- `reentrant_save_post_product_create_fanout`: installs a `save_post_product`
  listener that re-saves the product during create, matching common extension
  fanout behavior.
- `duplicate_meta_and_readback_correctness`: scans created simple products and
  variations for duplicate postmeta rows, then verifies simple product stock
  values read back from WooCommerce match the REST update payload.
- `shared_product_and_variation_data_store_reuse`: forces product and variation datastore
  loading through shared instances using WooCommerce datastore filters, so
  create-state leaks across nested saves are visible.

These scenarios are labeled in the JSON artifact under
`side_effects.scenario_labels` and exposed as metrics including:

- `scenario_reentrant_save_post_product`
- `scenario_shared_product_data_store`
- `side_effect_reentrant_save_post_product_count`
- `side_effect_shared_product_data_store_loads`
- `side_effect_shared_variation_data_store_loads`
- `side_effect_simple_duplicate_meta_row_count`
- `side_effect_variation_duplicate_meta_row_count`
- `side_effect_simple_manage_stock_readback_mismatches`
- `side_effect_simple_stock_readback_mismatches`

The run fails its side-effect invariant count when duplicate meta rows, shadowed
stock readback, or missing shared datastore reuse are observed.

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
  --setting-json 'bench_env={"WC_REST_BATCH_IMPORT_ITEMS":"2","WC_REST_BATCH_IMPORT_ATTRIBUTES":"1","WC_REST_BATCH_IMPORT_TERMS_PER_ATTRIBUTE":"2","WC_REST_BATCH_IMPORT_CATALOG_PRODUCTS":"0"}'
```

Reviewer-scale evidence should use the offloaded Homeboy/bench path instead of
local benchmark loops on the Studio machine.
