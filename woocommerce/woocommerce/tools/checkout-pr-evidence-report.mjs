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
	lines.push('- Blocked rows stay blocked until their prerequisite issues land and produce artifacts.');
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
	lines.push('## Evidence Matrix');
	lines.push('');
	lines.push('| Status | Scenario | Command | Old PR shape | Revised candidate |');
	lines.push('|---|---|---|---|---|');
	for (const scenario of data.scenarios) {
		const status = scenario.status === 'blocked' ? `blocked by ${scenario.blocked_by.join(', ')}` : scenario.status;
		lines.push(`| ${status} | ${scenario.label} | \`${scenario.command}\` | ${scenario.old_fix_expected} | ${scenario.candidate_expected} |`);
	}
	lines.push('');
	lines.push('## Command Recipe');
	lines.push('');
	lines.push('1. Check out the old PR shape in `~/Developer/woocommerce` and run `homeboy rig up woocommerce-performance`.');
	lines.push('2. Run every `ready` command with `<shared-state>` set to `/tmp/woocommerce-checkout-pr-65588-old-shape`.');
	lines.push('3. Check out the revised WooCommerce candidate and rerun the same commands with `<shared-state>` set to `/tmp/woocommerce-checkout-pr-65588-revised-candidate`.');
	lines.push('4. After #268-#272 and HBEX #1321 land, add their artifacts under the same two shared-state roots and regenerate this report.');
	lines.push('5. Copy the filled matrix into WooCommerce PR #65588 or its replacement PR, keeping blocked rows explicitly marked instead of inferred.');
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
