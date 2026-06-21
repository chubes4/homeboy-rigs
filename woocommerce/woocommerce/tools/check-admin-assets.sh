#!/usr/bin/env bash
set -euo pipefail

woocommerce_path="${1:-}"

if [ -z "$woocommerce_path" ]; then
	printf '%s\n' 'Usage: check-admin-assets.sh /path/to/plugins/woocommerce' >&2
	exit 2
fi

admin_scripts_dir="$woocommerce_path/assets/client/admin/wp-admin-scripts"

has_registry=0
for registry in "$admin_scripts_dir"/*.asset.php "$admin_scripts_dir"/*.min.asset.php; do
	if [ -r "$registry" ]; then
		has_registry=1
		break
	fi
done

if [ "$has_registry" -ne 1 ]; then
	printf '%s\n' "WooCommerce admin asset registries are missing from $admin_scripts_dir" >&2
	printf '%s\n' 'Use a packaged WooCommerce plugin checkout or build the WooCommerce admin assets before running admin coverage/full-surface rigs.' >&2
	exit 1
fi
