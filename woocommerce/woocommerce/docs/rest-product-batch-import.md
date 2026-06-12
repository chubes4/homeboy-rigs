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
- `opt_in_media_image_readback_guardrail`: when
  `WC_REST_BATCH_IMPORT_IMAGE_MODE` is set to `existing_attachment` or `remote`,
  sends image payloads through the product and variation REST batch routes,
  then verifies product image, gallery image, and variation image readback.

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

Media/image import cost scenarios are opt-in. The default rig environment sets
`WC_REST_BATCH_IMPORT_IMAGE_MODE=none`, keeping the no-image path as the hot
deterministic DB/write-path control. Supported modes:

- `none`: no image payloads. This is the smoke/hot default.
- `existing_attachment`: creates deterministic local attachment fixtures before
  timing, then sends existing attachment IDs in REST image payloads. This covers
  product-image association/readback cost without network variability.
- `remote`: sends `src` URLs in REST image payloads. This requires
  `WC_REST_BATCH_IMPORT_REMOTE_IMAGE_BASE` to point at a deterministic image
  endpoint and is intentionally excluded from default hot profiles.

Image/media metrics are reported separately from the generic write-path metrics:

- `media_image_mode`
- `media_images_per_product`
- `media_gallery_images_per_product`
- `media_simple_create_ms_per_product`
- `media_simple_update_ms_per_product`
- `media_variation_create_ms_per_product`
- `media_variation_update_ms_per_product`
- `media_simple_create_queries_per_product`
- `media_simple_update_queries_per_product`
- `media_variation_create_queries_per_product`
- `media_variation_update_queries_per_product`
- `media_attachment_row_delta`
- `media_attachment_meta_row_delta`
- `media_http_request_count`
- `media_simple_create_http_requests`
- `media_simple_update_http_requests`
- `media_variation_create_http_requests`
- `media_variation_update_http_requests`
- `media_rest_error_count`
- `media_simple_image_readback_mismatches`
- `media_simple_gallery_readback_mismatches`
- `media_variation_image_readback_mismatches`

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
  --setting-json 'bench_env={"WC_REST_BATCH_IMPORT_ITEMS":"2","WC_REST_BATCH_IMPORT_ATTRIBUTES":"1","WC_REST_BATCH_IMPORT_TERMS_PER_ATTRIBUTE":"2","WC_REST_BATCH_IMPORT_CATALOG_PRODUCTS":"0"}'
```

Small deterministic media smoke:

```sh
homeboy bench --rig woocommerce-performance \
  --scenario rest-product-batch-import \
  --iterations 1 \
  --shared-state /tmp/woocommerce-rest-product-batch-import-media-smoke \
  --setting-json 'bench_env={"WC_REST_BATCH_IMPORT_ITEMS":"2","WC_REST_BATCH_IMPORT_ATTRIBUTES":"1","WC_REST_BATCH_IMPORT_TERMS_PER_ATTRIBUTE":"2","WC_REST_BATCH_IMPORT_CATALOG_PRODUCTS":"0","WC_REST_BATCH_IMPORT_IMAGE_MODE":"existing_attachment","WC_REST_BATCH_IMPORT_IMAGES_PER_PRODUCT":"1","WC_REST_BATCH_IMPORT_GALLERY_IMAGES_PER_PRODUCT":"1"}'
```

Reviewer-scale evidence should use the offloaded Homeboy/bench path instead of
local benchmark loops on the Studio machine.
