#!/usr/bin/env bash
set -euo pipefail

task="${1:-}"
woocommerce_component_source="${2:-}"

if [ -z "$task" ] || [ -z "$woocommerce_component_source" ]; then
  printf 'Usage: %s <composer|feature-config|admin-assets> <woocommerce-plugin-path>\n' "$0" >&2
  exit 2
fi

woocommerce_plugin_source="$woocommerce_component_source"
woocommerce_source_root="${HOMEBOY_SETTINGS_WP_CODEBOX_SOURCE_ROOT:-${HOMEBOY_SETTINGS_COMPONENTS_WOOCOMMERCE_EXTENSIONS_WORDPRESS_WP_CODEBOX_SOURCE_ROOT:-}}"
woocommerce_source_subpath="${HOMEBOY_SETTINGS_WP_CODEBOX_SOURCE_SUBPATH:-${HOMEBOY_SETTINGS_COMPONENTS_WOOCOMMERCE_EXTENSIONS_WORDPRESS_WP_CODEBOX_SOURCE_SUBPATH:-}}"
if [ -n "$woocommerce_source_root" ]; then
  woocommerce_plugin_source="$woocommerce_source_root"
  if [ -n "$woocommerce_source_subpath" ]; then
    woocommerce_plugin_source="$woocommerce_plugin_source/$woocommerce_source_subpath"
  fi
fi

case "$task" in
  composer)
    XDEBUG_MODE=off composer --working-dir="$woocommerce_plugin_source" install --no-interaction --no-progress
    if [ "$woocommerce_plugin_source" != "$woocommerce_component_source" ]; then
      mkdir -p "$woocommerce_component_source/vendor"
      cp "$woocommerce_plugin_source/vendor/autoload_packages.php" "$woocommerce_component_source/vendor/autoload_packages.php"
    fi
    ;;
  feature-config)
    php "$woocommerce_component_source/bin/generate-feature-config.php"
    if [ "$woocommerce_plugin_source" != "$woocommerce_component_source" ]; then
      php "$woocommerce_plugin_source/bin/generate-feature-config.php"
    fi
    ;;
  admin-assets)
    if [ -z "$woocommerce_source_root" ]; then
      woocommerce_source_root=$(cd "$woocommerce_component_source/../.." && pwd)
    fi
    cd "$woocommerce_source_root" || exit 1
    if [ ! -x "$woocommerce_component_source/client/admin/node_modules/.bin/wireit" ]; then
      pnpm install --frozen-lockfile
    fi
    pnpm --filter @woocommerce/plugin-woocommerce build:admin || [ -r "$woocommerce_component_source/assets/client/admin/wp-admin-scripts/command-palette.asset.php" ]
    ;;
  *)
    printf 'Unknown WooCommerce runtime dependency task: %s\n' "$task" >&2
    exit 2
    ;;
esac
