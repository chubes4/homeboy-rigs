#!/usr/bin/env node

import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const defaultMatrixPath = resolve(__dirname, 'checkout-pr-evidence-matrix.json');
const args = parseArgs(process.argv.slice(2));
const matrix = readJson(args.matrix || defaultMatrixPath);
const checkoutStatuses = new Set([
	'ready',
	'passed',
	'failed',
	'blocked_dependency_provider',
	'blocked_credentials',
	'blocked_external_account',
	'unsupported_checkout_surface',
	'build_failed',
	'missing_gateway',
	'fatal',
]);

process.stdout.write(renderReport(matrix));

function renderReport(data) {
	const lines = [];
	validateStatuses(data);
	const scenarios = Array.isArray(data.scenarios) ? data.scenarios : [];
	const gatewayProfiles = Array.isArray(data.gateway_profiles) ? data.gateway_profiles : [];
	const blockedStatuses = new Set([
		'blocked_dependency_provider',
		'blocked_credentials',
		'blocked_external_account',
		'unsupported_checkout_surface',
		'build_failed',
		'missing_gateway',
		'fatal',
	]);
	const readyScenarios = scenarios.filter((scenario) => scenario.status === 'ready');
	const passedScenarios = scenarios.filter((scenario) => scenario.status === 'passed');
	const failedScenarios = scenarios.filter((scenario) => scenario.status === 'failed');
	const blockedScenarios = scenarios.filter((scenario) => blockedStatuses.has(scenario.status));
	const readyGatewayProfiles = gatewayProfiles.filter((profile) => profile.status === 'ready');
	const passedGatewayProfiles = gatewayProfiles.filter((profile) => profile.status === 'passed');
	const failedGatewayProfiles = gatewayProfiles.filter((profile) => profile.status === 'failed');
	const blockedGatewayProfiles = gatewayProfiles.filter((profile) => blockedStatuses.has(profile.status));
	const proofScenarios = scenarios.filter((scenario) => !blockedStatuses.has(scenario.status));
	const trueConcurrentScenario = scenarios.find((scenario) => scenario.id === 'true_concurrent_checkout');
	const criticalSafe = proofScenarios.length > 0 && proofScenarios.every((scenario) => scenario.status === 'passed') && trueConcurrentScenario?.status === 'passed' && readyGatewayProfiles.length === 0 && failedGatewayProfiles.length === 0;
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
	lines.push(`- Critical checkout safety claim: **${criticalSafe ? 'allowed' : 'not allowed'}**.`);
	lines.push('- This is a proof-loop recipe until every `ready` critical row has produced `passed` artifacts and every blocked profile is explicitly scoped.');
	lines.push('- `blocked_credentials`, `blocked_external_account`, `unsupported_checkout_surface`, `build_failed`, `missing_gateway`, and `fatal` are not Woo checkout passes.');
	lines.push('- The WooCommerce PR should avoid `Closes #62659` unless the true concurrent checkout row is `passed`.');
	lines.push('');
	lines.push('| Category | Count | Interpretation |');
	lines.push('|---|---:|---|');
	lines.push(`| Harness readiness | ${readyScenarios.length + readyGatewayProfiles.length} | Runnable rows still need artifacts before reviewer-facing safety claims. |`);
	lines.push(`| Plugin/account blockers | ${blockedScenarios.length + blockedGatewayProfiles.length} | Scoped blockers; not checkout pass/fail evidence. |`);
	lines.push(`| Actual Woo checkout failures | ${failedScenarios.length + failedGatewayProfiles.length} | Behavioral failures that block the safety claim. |`);
	lines.push(`| Successful atomicity proof | ${passedScenarios.length + passedGatewayProfiles.length} | Rows with generated pass artifacts. |`);
	lines.push('');
	if (data.status_contract) {
		lines.push('## Status Contract');
		lines.push('');
		lines.push(`- Readiness issue: ${data.status_contract.readiness_issue}`);
		lines.push(`- Safety gate: ${data.status_contract.safety_gate}`);
		lines.push('');
		lines.push('| Status | Meaning |');
		lines.push('|---|---|');
		for (const status of data.status_contract.allowed_statuses || []) {
			lines.push(`| ${status} | ${statusMeaning(status)} |`);
		}
		lines.push('');
	}
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
	if (gatewayProfiles.length > 0) {
		lines.push('## Gateway Profiles');
		lines.push('');
		lines.push('| Profile | Status | Dependency | Expected gateway IDs | Discovery patterns | Entrypoint | Checkout surfaces | Safe settings | Boundary | Artifact | Scope | Blockers |');
		lines.push('|---|---|---|---|---|---|---|---|---|---|---|---|');
		for (const profile of gatewayProfiles) {
			const expectedGatewayIds = Array.isArray(profile.expected_gateway_ids) ? profile.expected_gateway_ids.join(', ') : '';
			const discoveryPatterns = Array.isArray(profile.discovery_patterns) ? profile.discovery_patterns.join(', ') : '';
			const checkoutSurfaces = Array.isArray(profile.checkout_surfaces) ? profile.checkout_surfaces.join(', ') : '';
			const safeSettings = profile.safe_settings ? Object.keys(profile.safe_settings).join(', ') : '';
			const boundary = profile.readiness_boundary ? `${profile.readiness_boundary}; ${profile.credential_boundary || 'unknown'}` : '';
			const blockers = Array.isArray(profile.blocked_by) && profile.blocked_by.length > 0 ? profile.blocked_by.join(', ') : '';
			lines.push(`| ${profile.profile} | ${profile.status} | ${profile.dependency_slug} | ${expectedGatewayIds} | ${discoveryPatterns} | ${profile.entrypoint || 'WooCommerce core'} | ${checkoutSurfaces} | ${safeSettings} | ${boundary} | ${profile.artifact || 'pending'} | ${profile.scope || ''} | ${blockers} |`);
		}
		lines.push('');
	}
	lines.push('## Evidence Matrix');
	lines.push('');
	lines.push('| Status | Scenario | Command | Artifact | Old PR shape | Revised candidate |');
	lines.push('|---|---|---|---|---|---|');
	for (const scenario of scenarios) {
		const blockers = Array.isArray(scenario.blocked_by) ? scenario.blocked_by.join(', ') : '';
		const status = blockers ? `${scenario.status} (${blockers})` : scenario.status;
		lines.push(`| ${status} | ${scenario.label} | \`${scenario.command}\` | ${scenario.artifact || 'pending'} | ${scenario.old_fix_expected} | ${scenario.candidate_expected} |`);
	}
	lines.push('');
	lines.push('## Command Recipe');
	lines.push('');
	lines.push('1. Check out the old PR shape in `~/Developer/woocommerce` and run `homeboy rig up woocommerce-performance`.');
	lines.push('2. Run every `ready` command with `<shared-state>` set to `/tmp/woocommerce-checkout-pr-65588-old-shape`.');
	lines.push('3. Check out the revised WooCommerce candidate and rerun the same commands with `<shared-state>` set to `/tmp/woocommerce-checkout-pr-65588-revised-candidate`.');
	if (blockedScenarios.length > 0 || blockedGatewayProfiles.length > 0 || readyScenarios.length > 0 || readyGatewayProfiles.length > 0) {
		lines.push('4. Keep `ready` rows as not-yet-safe until pass artifacts exist; keep blocked rows explicitly scoped until their prerequisite artifacts exist.');
	} else {
		lines.push('4. Regenerate this report from the two shared-state roots and copy the filled matrix into WooCommerce PR #65588 or its replacement PR.');
	}
	lines.push('');
	return `${lines.join('\n')}\n`;
}

function statusMeaning(status) {
	switch (status) {
		case 'ready':
			return 'Harness/profile can run, but no pass artifact has been attached yet.';
		case 'passed':
			return 'Generated artifact proves the scoped checkout behavior passed.';
		case 'failed':
			return 'Generated artifact shows an actual Woo checkout behavior failure.';
		case 'blocked_dependency_provider':
			return 'Plugin/dependency materialization is blocking readiness; not checkout pass/fail evidence.';
		case 'blocked_credentials':
			return 'Required test credentials are missing; not checkout pass/fail evidence.';
		case 'blocked_external_account':
			return 'External gateway account setup is missing; not checkout pass/fail evidence.';
		case 'unsupported_checkout_surface':
			return 'Gateway does not support the checkout surface under test; scoped out, not a pass.';
		case 'build_failed':
			return 'Plugin artifact preparation failed and must be shown as blocker evidence.';
		case 'missing_gateway':
			return 'Expected Woo gateway ID was not registered after setup.';
		case 'fatal':
			return 'Unstructured or fatal pre-dispatch failure that must not be hidden.';
		default:
			return 'Unknown status.';
	}
}

function validateStatuses(data) {
	const rows = [
		...(Array.isArray(data.gateway_profiles) ? data.gateway_profiles.map((row) => ['gateway_profiles', row]) : []),
		...(Array.isArray(data.scenarios) ? data.scenarios.map((row) => ['scenarios', row]) : []),
	];
	for (const [section, row] of rows) {
		if (!checkoutStatuses.has(row.status)) {
			throw new Error(`${section} row ${row.id || row.profile || row.label || 'unknown'} has unsupported status: ${row.status}`);
		}
	}
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
