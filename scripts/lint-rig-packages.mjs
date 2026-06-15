#!/usr/bin/env node

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

const root = process.argv[2] ? join(process.cwd(), process.argv[2]) : process.cwd();
const ignoredDirectories = new Set(['.git', '.claude', '.datamachine', '.opencode', 'node_modules', 'vendor']);
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

    if (entry.isFile() && entry.name.endsWith('.php')) {
      phpFiles.push(join(directory, entry.name));
    }
  }
}

function lintPhp(file) {
  const result = spawnSync('php', ['-l', file], { encoding: 'utf8' });
  if (result.status !== 0) {
    const output = `${result.stdout || ''}${result.stderr || ''}`.trim();
    failures.push(`${relative(root, file)}: PHP syntax check failed${output ? `: ${output}` : ''}`);
  }
}

function hasPhp() {
  try {
    execFileSync('php', ['-v'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

walk(root);

if (!hasPhp()) {
  console.warn(`PHP not found; skipped syntax checks for ${phpFiles.length} PHP file(s).`);
  process.exit(0);
}

phpFiles.forEach(lintPhp);

if (failures.length > 0) {
  console.error('Rig package PHP syntax lint failed:');
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}

console.log('Rig package PHP syntax lint passed.');
console.log(`- PHP syntax: ${phpFiles.length} file(s)`);
