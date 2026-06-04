#!/usr/bin/env node

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const root = process.argv[2] ? join(process.cwd(), process.argv[2]) : process.cwd();
const ignoredDirectories = new Set([
	'.git',
	'.claude',
	'.datamachine',
	'.opencode',
	'node_modules',
	'vendor',
]);
const conflictMarkerPattern = /^(<<<<<<<|=======|>>>>>>>)($|\s)/;
const jsonFiles = [];
const phpFiles = [];
const failures = [];

if (!existsSync(root)) {
	console.error(`Lint root does not exist: ${root}`);
	process.exit(1);
}

function walk(directory) {
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		if (entry.isDirectory()) {
			if (!ignoredDirectories.has(entry.name)) {
				walk(join(directory, entry.name));
			}
			continue;
		}

		if (!entry.isFile()) {
			continue;
		}

		const file = join(directory, entry.name);
		const relativePath = relative(root, file);
		checkConflictMarkers(file, relativePath);

		if (entry.name.endsWith('.json')) {
			jsonFiles.push(file);
		}
		if (entry.name.endsWith('.php')) {
			phpFiles.push(file);
		}
	}
}

function checkConflictMarkers(file, relativePath) {
	const lines = readFileSync(file, 'utf8').split(/\r?\n/);
	lines.forEach((line, index) => {
		if (conflictMarkerPattern.test(line)) {
			failures.push(`${relativePath}:${index + 1}: unresolved conflict marker: ${line}`);
		}
	});
}

function validateJson(file) {
	try {
		JSON.parse(readFileSync(file, 'utf8'));
	} catch (error) {
		failures.push(`${relative(root, file)}: invalid JSON: ${error.message}`);
	}
}

function lintPhp(file) {
	const result = spawnSync('php', ['-l', file], { encoding: 'utf8' });
	if (result.status !== 0) {
		const output = `${result.stdout || ''}${result.stderr || ''}`.trim();
		failures.push(`${relative(root, file)}: PHP syntax check failed${output ? `: ${output}` : ''}`);
	}
}

walk(root);
jsonFiles.forEach(validateJson);

const hasPhp = (() => {
	try {
		execFileSync('php', ['-v'], { stdio: 'ignore' });
		return true;
	} catch {
		return false;
	}
})();

if (hasPhp) {
	phpFiles.forEach(lintPhp);
} else {
	console.warn(`PHP not found; skipped syntax checks for ${phpFiles.length} PHP file(s).`);
}

if (failures.length > 0) {
	console.error('Rig package lint failed:');
	for (const failure of failures) {
		console.error(`- ${failure}`);
	}
	process.exit(1);
}

console.log('Rig package lint passed.');
console.log(`- Conflict marker scan: ${countFiles(root)} file(s)`);
console.log(`- JSON validation: ${jsonFiles.length} file(s)`);
console.log(`- PHP syntax: ${hasPhp ? phpFiles.length : 0} file(s)${hasPhp ? '' : ' (skipped; php unavailable)'}`);

function countFiles(directory) {
	let count = 0;
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		if (entry.isDirectory()) {
			if (!ignoredDirectories.has(entry.name)) {
				count += countFiles(join(directory, entry.name));
			}
		} else if (entry.isFile() && statSync(join(directory, entry.name)).isFile()) {
			count++;
		}
	}
	return count;
}
