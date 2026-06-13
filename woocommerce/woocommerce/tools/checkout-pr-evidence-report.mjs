#!/usr/bin/env node

import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const defaultMatrixPath = resolve(__dirname, 'checkout-pr-evidence-matrix.json');
const args = parseArgs(process.argv.slice(2));
const matrix = readJson(args.matrix || defaultMatrixPath);

process.stdout.write(renderReport(matrix));

function renderReport(data) {
	const lines = [];
	const blockedScenarios = Array.isArray(data.scenarios) ? data.scenarios.filter((scenario) => scenario.status === 'blocked') : [];
	lines.push(`# ${data.title}`);
	lines.push('');
	lines.push('## Links');
	lines.push('');
	lines.push(`- Homeboy Rigs tracker: ${data.issue}`);
	lines.push(`- WooCommerce issue: ${data.woocommerce_issue}`);
	lines.push(`- WooCommerce PR: ${data.woocommerce_pr}`);
	lines.push(`- Jorge review: ${data.review}`);
	lines.push(`- Old-fix guardrail failure run: ${data.old_fix_failure_run}`);
	lines.push('');
	lines.push('## Status');
	lines.push('');
	lines.push('- This is a proof-loop recipe, not final pass/fail evidence.');
	if (blockedScenarios.length > 0) {
		lines.push('- Blocked rows stay blocked until their prerequisite issues land and produce artifacts.');
	} else {
		lines.push('- All matrix rows are ready to run.');
	}
	lines.push('- The WooCommerce PR should avoid `Closes #62659` unless the true concurrent checkout row passes.');
	lines.push('');
	if (Array.isArray(data.reusable_capabilities) && data.reusable_capabilities.length > 0) {
		lines.push('## Reusable Capabilities');
		lines.push('');
		lines.push('| Capability | Source | Guidance |');
		lines.push('|---|---|---|');
		for (const capability of data.reusable_capabilities) {
			const source = `${capability.source} / ${capability.rig}`;
			const prs = Array.isArray(capability.merged_prs) && capability.merged_prs.length > 0 ? ` Merged PRs: ${capability.merged_prs.map((number) => `#${number}`).join(', ')}.` : '';
			lines.push(`| ${capability.title} | ${source} | ${capability.guidance}${prs} |`);
		}
		lines.push('');
	}
	lines.push('## Prerequisites');
	lines.push('');
	lines.push('| Status | Dependency | Link |');
	lines.push('|---|---|---|');
	for (const prerequisite of data.prerequisites) {
		lines.push(`| ${prerequisite.status} | ${prerequisite.title} | ${prerequisite.url} |`);
	}
	lines.push('');
	lines.push('## Run Slots');
	lines.push('');
	lines.push('| Slot | WooCommerce ref | Shared state | Expected interpretation |');
	lines.push('|---|---|---|---|');
	for (const run of data.runs) {
		lines.push(`| ${run.label} | ${run.woocommerce_ref} | \`${run.shared_state}\` | ${run.expected} |`);
	}
	lines.push('');
	if (Array.isArray(data.gateway_profiles) && data.gateway_profiles.length > 0) {
		lines.push('## Gateway Profiles');
		lines.push('');
		lines.push('| Profile | Dependency | Expected gateway IDs | Entrypoint | Status fields | Blockers |');
		lines.push('|---|---|---|---|---|---|');
		for (const profile of data.gateway_profiles) {
			const expectedGatewayIds = Array.isArray(profile.expected_gateway_ids) ? profile.expected_gateway_ids.join(', ') : '';
			const statusFields = profile.status_fields ? Object.entries(profile.status_fields).map(([key, value]) => `${key}=${value}`).join(', ') : '';
			const blockers = Array.isArray(profile.blocked_by) && profile.blocked_by.length > 0 ? profile.blocked_by.join(', ') : '';
			lines.push(`| ${profile.profile} | ${profile.dependency_slug} | ${expectedGatewayIds} | ${profile.entrypoint || 'WooCommerce core'} | ${statusFields} | ${blockers} |`);
		}
		lines.push('');
	}
	lines.push('## Evidence Matrix');
	lines.push('');
	lines.push('| Status | Scenario | Command | Old PR shape | Revised candidate |');
	lines.push('|---|---|---|---|---|');
	for (const scenario of data.scenarios) {
		const blockers = Array.isArray(scenario.blocked_by) ? scenario.blocked_by.join(', ') : '';
		const status = scenario.status === 'blocked' ? `blocked by ${blockers}` : scenario.status;
		lines.push(`| ${status} | ${scenario.label} | \`${scenario.command}\` | ${scenario.old_fix_expected} | ${scenario.candidate_expected} |`);
	}
	lines.push('');
	lines.push('## Command Recipe');
	lines.push('');
	lines.push('1. Check out the old PR shape in `~/Developer/woocommerce` and run `homeboy rig up woocommerce-performance`.');
	lines.push('2. Run every `ready` command with `<shared-state>` set to `/tmp/woocommerce-checkout-pr-65588-old-shape`.');
	lines.push('3. Check out the revised WooCommerce candidate and rerun the same commands with `<shared-state>` set to `/tmp/woocommerce-checkout-pr-65588-revised-candidate`.');
	if (blockedScenarios.length > 0) {
		lines.push('4. Keep blocked rows explicitly marked until their prerequisite artifacts exist, then add those artifacts under the same two shared-state roots and regenerate this report.');
	} else {
		lines.push('4. Regenerate this report from the two shared-state roots and copy the filled matrix into WooCommerce PR #65588 or its replacement PR.');
	}
	lines.push('');
	return `${lines.join('\n')}\n`;
}

function readJson(path) {
	if (!existsSync(path)) {
		throw new Error(`Matrix file does not exist: ${path}`);
	}
	return JSON.parse(readFileSync(path, 'utf8'));
}

function parseArgs(rawArgs) {
	const parsed = {};
	for (let index = 0; index < rawArgs.length; index++) {
		const arg = rawArgs[index];
		if (arg === '--matrix') {
			parsed.matrix = rawArgs[++index];
		}
	}
	return parsed;
}
