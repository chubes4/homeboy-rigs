#!/usr/bin/env bash

set -u

usage() {
	printf '%s\n' 'Usage: woocommerce-feature-config.sh check|prepare <woocommerce-dir> [phase]' >&2
	exit 2
}

mode="${1:-}"
woocommerce_dir="${2:-}"
phase="${3:-rig up}"

if [ -z "$mode" ] || [ -z "$woocommerce_dir" ]; then
	usage
fi

case "$mode" in
	check)
		test -d "$woocommerce_dir" || {
			printf '%s\n' "Cannot check WooCommerce generated feature config because $woocommerce_dir is missing. Pass homeboy bench --path /path/to/plugins/woocommerce or update components.woocommerce.path."
			exit 1
		}

		test -f "$woocommerce_dir/includes/react-admin/feature-config.php" || {
			test -f "$woocommerce_dir/bin/generate-feature-config.php" && command -v php >/dev/null 2>&1
		} || {
			printf '%s\n' 'Missing WooCommerce generated feature config: includes/react-admin/feature-config.php is absent. Ensure PHP is available, then run: homeboy rig up woocommerce-performance'
			exit 1
		}
		;;
	prepare)
		cd "$woocommerce_dir" || {
			printf '%s\n' "Missing WooCommerce runner checkout: expected $woocommerce_dir before $phase. Pass homeboy bench --path /path/to/plugins/woocommerce or update components.woocommerce.path."
			exit 1
		}

		if [ -f includes/react-admin/feature-config.php ]; then
			printf '%s\n' 'WooCommerce feature config already generated.'
			exit 0
		fi

		if [ ! -f bin/generate-feature-config.php ] || ! command -v php >/dev/null 2>&1; then
			printf '%s\n' 'Missing WooCommerce generated feature config: includes/react-admin/feature-config.php is absent. Ensure PHP is available, then run: homeboy rig up woocommerce-performance'
			exit 1
		fi

		php bin/generate-feature-config.php
		;;
	*)
		usage
		;;
esac
