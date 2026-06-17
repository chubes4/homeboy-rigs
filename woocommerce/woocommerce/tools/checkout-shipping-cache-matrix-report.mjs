#!/usr/bin/env node

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const defaultMatrixPath = resolve(__dirname, 'checkout-shipping-cache-matrix.json');
const args = parseArgs(process.argv.slice(2));
const matrix = readJson(args.matrix || defaultMatrixPath);
const baselineRuns = readRuns(args.baseline || args.input);
const candidateRuns = readRuns(args.candidate);
const hasComparison = baselineRuns.length > 0 && candidateRuns.length > 0;
const hasSingleSet = baselineRuns.length > 0 && !hasComparison;

process.stdout.write(renderReport());

function renderReport() {
	const lines = [];
	lines.push(`# ${matrix.title}`);
	lines.push('');
	lines.push('## Issue Links');
	lines.push('');
	for (const issue of matrix.issues || []) {
		lines.push(`- ${issue}`);
	}
	lines.push('');
	lines.push('## Status');
	lines.push('');
	if (hasComparison) {
		lines.push('- Mode: baseline/candidate comparison from real workload artifacts.');
	} else if (hasSingleSet) {
		lines.push('- Mode: single artifact set. Baseline/candidate red-green deltas are omitted until comparison exports are available.');
	} else {
		lines.push('- Mode: planned matrix only. No baseline or candidate values are present.');
	}
	for (const note of matrix.status_notes || []) {
		lines.push(`- ${note}`);
	}
	lines.push('');
	lines.push('## Matrix Knobs');
	lines.push('');
	lines.push('| Profile | Cart items | Packages | Total churn runs | Command settings |');
	lines.push('|---|---:|---:|---:|---|');
	for (const row of matrix.matrix_knobs || []) {
		const settings = `bench_env={"WC_SHIPPING_CACHE_CART_ITEMS":"${row.cart_items}","WC_SHIPPING_CACHE_PACKAGES":"${row.packages}","WC_SHIPPING_CACHE_TOTAL_CHURN_RUNS":"${row.total_churn_runs}"}`;
		lines.push(`| ${row.profile} | ${row.cart_items} | ${row.packages} | ${row.total_churn_runs} | \`${settings}\` |`);
	}
	lines.push('');
	lines.push('## Timing Evidence');
	lines.push('');
	lines.push(...renderTimingTable());
	lines.push('');
	lines.push('## Call-Count Evidence');
	lines.push('');
	lines.push(...renderCallTable());
	lines.push('');
	lines.push('## Cache Invalidation Controls');
	lines.push('');
	lines.push('| Control | Expected cache behavior | Current coverage |');
	lines.push('|---|---|---|');
	for (const control of matrix.controls || []) {
		lines.push(`| ${control.control} | ${control.expected_cache_behavior} | ${control.current_coverage} |`);
	}
	lines.push('');
	return `${lines.join('\n')}\n`;
}

function renderTimingTable() {
	if (!hasSingleSet && !hasComparison) {
		return [
			'| Status | Cart items | Packages | Cold ms | Warm p50 ms | Total churn p50 ms | Rehash p50 ms |',
			'|---|---:|---:|---:|---:|---:|---:|',
			...(matrix.matrix_knobs || []).map((row) => `| pending | ${row.cart_items} | ${row.packages} |  |  |  |  |`),
		];
	}

	if (hasComparison) {
		return [
			'| Run | Cart items | Packages | Baseline warm p50 ms | Candidate warm p50 ms | Warm delta | Baseline total churn p50 ms | Candidate total churn p50 ms | Total churn delta |',
			'|---|---:|---:|---:|---:|---:|---:|---:|---:|',
			...pairRuns(baselineRuns, candidateRuns).map(({ baseline, candidate }) => renderTimingComparisonRow(baseline, candidate)),
		];
	}

	return [
		'| Run | Cart items | Packages | Cold ms | Warm p50 ms | Total churn p50 ms | Rehash p50 ms |',
		'|---|---:|---:|---:|---:|---:|---:|',
		...baselineRuns.map((run) => {
			const metrics = run.metrics;
			return `| ${run.label} | ${metrics.cart_items ?? ''} | ${metrics.actual_package_count ?? metrics.configured_package_target ?? ''} | ${formatNumber(metrics.cold_shipping_ms)} | ${formatNumber(metrics.warm_shipping_p50_ms)} | ${formatNumber(metrics.total_churn_shipping_p50_ms)} | ${formatNumber(metrics.rehash_shipping_p50_ms)} |`;
		}),
	];
}

function renderCallTable() {
	if (!hasSingleSet && !hasComparison) {
		return [
			'| Status | Cart items | Packages | Cold rate calls | Warm rate calls | Total churn rate calls | Rehash rate calls |',
			'|---|---:|---:|---:|---:|---:|---:|',
			...(matrix.matrix_knobs || []).map((row) => `| pending | ${row.cart_items} | ${row.packages} |  |  |  |  |`),
		];
	}

	if (hasComparison) {
		return [
			'| Run | Cart items | Packages | Baseline warm calls | Candidate warm calls | Warm call delta | Baseline total churn calls | Candidate total churn calls | Total churn call delta |',
			'|---|---:|---:|---:|---:|---:|---:|---:|---:|',
			...pairRuns(baselineRuns, candidateRuns).map(({ baseline, candidate }) => renderCallComparisonRow(baseline, candidate)),
		];
	}

	return [
		'| Run | Cart items | Packages | Cold rate calls | Warm rate calls | Total churn rate calls | Rehash rate calls |',
		'|---|---:|---:|---:|---:|---:|---:|',
		...baselineRuns.map((run) => {
			const metrics = run.metrics;
			return `| ${run.label} | ${metrics.cart_items ?? ''} | ${metrics.actual_package_count ?? metrics.configured_package_target ?? ''} | ${metrics.cold_rate_calculation_calls ?? ''} | ${metrics.warm_rate_calculation_calls ?? ''} | ${metrics.total_churn_rate_calculation_calls ?? ''} | ${metrics.rehash_rate_calculation_calls ?? ''} |`;
		}),
	];
}

function renderTimingComparisonRow(baseline, candidate) {
	const base = baseline.metrics;
	const next = candidate.metrics;
	return `| ${candidate.label} | ${next.cart_items ?? base.cart_items ?? ''} | ${next.actual_package_count ?? base.actual_package_count ?? ''} | ${formatNumber(base.warm_shipping_p50_ms)} | ${formatNumber(next.warm_shipping_p50_ms)} | ${formatDelta(base.warm_shipping_p50_ms, next.warm_shipping_p50_ms)} | ${formatNumber(base.total_churn_shipping_p50_ms)} | ${formatNumber(next.total_churn_shipping_p50_ms)} | ${formatDelta(base.total_churn_shipping_p50_ms, next.total_churn_shipping_p50_ms)} |`;
}

function renderCallComparisonRow(baseline, candidate) {
	const base = baseline.metrics;
	const next = candidate.metrics;
	return `| ${candidate.label} | ${next.cart_items ?? base.cart_items ?? ''} | ${next.actual_package_count ?? base.actual_package_count ?? ''} | ${base.warm_rate_calculation_calls ?? ''} | ${next.warm_rate_calculation_calls ?? ''} | ${formatDelta(base.warm_rate_calculation_calls, next.warm_rate_calculation_calls)} | ${base.total_churn_rate_calculation_calls ?? ''} | ${next.total_churn_rate_calculation_calls ?? ''} | ${formatDelta(base.total_churn_rate_calculation_calls, next.total_churn_rate_calculation_calls)} |`;
}

function readRuns(input) {
	if (!input || !existsSync(input)) {
		return [];
	}

	const files = collectJsonFiles(input);
	return files.map((file) => {
		const payload = JSON.parse(readFileSync(file, 'utf8'));
		return {
			file,
			label: payload.run_id || basename(file, '.json'),
			metrics: payload.metrics || payload.results?.scenarios?.[0]?.metrics || {},
		};
	});
}

function collectJsonFiles(input) {
	if (input.endsWith('.json')) {
		return [input];
	}
	const direct = join(input, 'checkout-shipping-cache');
	const searchRoot = existsSync(direct) ? direct : input;
	return readdirSafe(searchRoot)
		.filter((entry) => entry.endsWith('.json'))
		.map((entry) => join(searchRoot, entry));
}

function readdirSafe(directory) {
	try {
		return readdirSync(directory);
	} catch {
		return [];
	}
}

function readJson(path) {
	if (!existsSync(path)) {
		throw new Error(`Matrix file does not exist: ${path}`);
	}
	return JSON.parse(readFileSync(path, 'utf8'));
}

function pairRuns(baseline, candidate) {
	return candidate.map((candidateRun, index) => ({
		baseline: baseline[index] || { metrics: {}, label: 'missing-baseline' },
		candidate: candidateRun,
	}));
}

function formatNumber(value) {
	if (typeof value !== 'number' || !Number.isFinite(value)) {
		return '';
	}
	return value.toFixed(2);
}

function formatDelta(before, after) {
	if (typeof before !== 'number' || typeof after !== 'number' || !Number.isFinite(before) || !Number.isFinite(after)) {
		return '';
	}
	const delta = after - before;
	const marker = delta <= 0 ? 'green' : 'red';
	return `${marker} ${delta >= 0 ? '+' : ''}${delta.toFixed(2)}`;
}

function parseArgs(rawArgs) {
	const parsed = {};
	for (let i = 0; i < rawArgs.length; i++) {
		const arg = rawArgs[i];
		if (arg === '--input' || arg === '--baseline' || arg === '--candidate' || arg === '--matrix') {
			parsed[arg.slice(2)] = rawArgs[++i];
		}
	}
	return parsed;
}
