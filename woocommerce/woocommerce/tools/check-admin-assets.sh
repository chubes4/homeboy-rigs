#!/usr/bin/env bash
set -euo pipefail

woocommerce_path="${1:-}"

if [ -z "$woocommerce_path" ]; then
	printf '%s\n' 'Usage: check-admin-assets.sh /path/to/plugins/woocommerce' >&2
	exit 2
fi

admin_scripts_dir="$woocommerce_path/assets/client/admin/wp-admin-scripts"
jetpack_connection_js="$woocommerce_path/vendor/automattic/jetpack-connection/dist/jetpack-connection.js"

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

if [ ! -r "$jetpack_connection_js" ]; then
	printf '%s\n' "WooCommerce Jetpack connection build output is missing: $jetpack_connection_js" >&2
	printf '%s\n' 'Install/build WooCommerce dependencies before running admin coverage/full-surface rigs.' >&2
	exit 1
fi
