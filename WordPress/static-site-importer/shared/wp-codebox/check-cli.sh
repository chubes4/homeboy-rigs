#!/usr/bin/env bash

set -euo pipefail

wp_codebox_bin=${HOMEBOY_WP_CODEBOX_BIN:-${HOMEBOY_SETTINGS_WP_CODEBOX_BIN:-${WP_CODEBOX_BIN:-}}}

case "$wp_codebox_bin" in
	'~'/*) wp_codebox_bin="$HOME/${wp_codebox_bin#~/}" ;;
esac

if [ -n "$wp_codebox_bin" ]; then
	test -f "$wp_codebox_bin" || {
		printf '%s\n' "Configured WP Codebox CLI not found: $wp_codebox_bin" >&2
		exit 1
	}
	exit 0
fi

command -v wp-codebox >/dev/null 2>&1 || {
	printf '%s\n' 'Missing WP Codebox CLI. Install wp-codebox or set HOMEBOY_WP_CODEBOX_BIN, HOMEBOY_SETTINGS_WP_CODEBOX_BIN, or WP_CODEBOX_BIN.' >&2
	exit 1
}
