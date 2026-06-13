#!/usr/bin/env bash

set -u

usage() {
	printf '%s\n' 'Usage: woocommerce-composer-dependencies.sh check|prepare <woocommerce-dir> [phase]' >&2
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
			printf '%s\n' "Cannot check WooCommerce Composer dependencies because $woocommerce_dir is missing. Pass homeboy bench --path /path/to/plugins/woocommerce or update components.woocommerce.path."
			exit 1
		}

		test -f "$woocommerce_dir/vendor/autoload_packages.php" || command -v composer >/dev/null 2>&1 || {
			printf '%s\n' 'Missing WooCommerce Composer dependencies: vendor/autoload_packages.php is absent and composer is not available. Install Composer on the runner, then run: homeboy rig up woocommerce-performance'
			exit 1
		}
		;;
	prepare)
		cd "$woocommerce_dir" || {
			printf '%s\n' "Missing WooCommerce runner checkout: expected $woocommerce_dir before $phase. Pass homeboy bench --path /path/to/plugins/woocommerce or update components.woocommerce.path."
			exit 1
		}

		if [ -f vendor/autoload_packages.php ]; then
			printf '%s\n' 'WooCommerce Composer dependencies already prepared.'
			exit 0
		fi

		command -v composer >/dev/null 2>&1 || {
			printf '%s\n' 'Missing WooCommerce Composer dependencies: vendor/autoload_packages.php is absent and composer is not available. Install Composer on the runner, then run: homeboy rig up woocommerce-performance'
			exit 1
		}

		XDEBUG_MODE=off composer install --no-interaction --no-progress
		;;
	*)
		usage
		;;
esac
