# SSI WooCommerce Store Fixture

This fixture is a static storefront used to validate Static Site Importer WooCommerce primitives before Studio consumes them.

The fixture is intentionally data-only:

- `products.json` declares the expected product manifest shape for the benchmark.
- `index.html`, `shop.html`, and `about.html` reference products by stable handles.
- `styles.css` provides local static styling and product card classes.

The benchmark must not seed products itself. Product validation is only meaningful once Static Site Importer provides manifest validation, WooCommerce product seeding, and product context forwarding.

Tracked dependencies:

- https://github.com/chubes4/static-site-importer/issues/111
- https://github.com/chubes4/static-site-importer/issues/112
- https://github.com/chubes4/static-site-importer/issues/113
