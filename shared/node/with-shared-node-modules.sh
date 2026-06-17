#!/usr/bin/env bash

set -euo pipefail

if [ "$#" -lt 2 ]; then
	printf '%s\n' 'Usage: with-shared-node-modules.sh <component-path> <command> [args...]' >&2
	exit 2
fi

component_path=$1
shift
shared_node_modules=${HOMEBOY_SHARED_NODE_MODULES_PATH:-${HOMEBOY_SETTINGS_SHARED_NODE_MODULES_PATH:-$component_path/node_modules}}

case "$component_path" in
	'~'/*) component_path="$HOME/${component_path#~/}" ;;
esac

case "$shared_node_modules" in
	'~'/*) shared_node_modules="$HOME/${shared_node_modules#~/}" ;;
esac

test -d "$component_path" || {
	printf '%s\n' "Missing component checkout: expected $component_path." >&2
	exit 1
}

cd "$component_path"

if [ ! -e node_modules ]; then
	test -d "$shared_node_modules" || {
		printf '%s\n' "Missing shared node_modules: expected $shared_node_modules. Set HOMEBOY_SHARED_NODE_MODULES_PATH or HOMEBOY_SETTINGS_SHARED_NODE_MODULES_PATH." >&2
		exit 1
	}
	ln -s "$shared_node_modules" node_modules
	trap 'rm node_modules' EXIT
fi

"$@"
