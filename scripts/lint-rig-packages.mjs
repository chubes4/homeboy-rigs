#!/usr/bin/env node

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

const root = process.argv[2] ? join(process.cwd(), process.argv[2]) : process.cwd();
const ignoredDirectories = new Set(['.git', '.claude', '.datamachine', '.opencode', 'node_modules', 'vendor']);
const phpFiles = [];
const rigFiles = [];
const portableSourceFiles = [];
const failures = [];
const studioModelRigGenerator = join(root, 'scripts/generate-studio-agent-model-rigs.mjs');
const personalPathPrefix = '/Users/' + 'chubes/';
const tsrmlsPatchMarker = 'PHP-WASM-COMBINED-FIXES ' + 'TSRMLS fallback';

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

    if (entry.isFile() && entry.name === 'rig.json') {
      rigFiles.push(join(directory, entry.name));
    }

    if (entry.isFile() && /\.(json|mjs|js)$/.test(entry.name)) {
      portableSourceFiles.push(join(directory, entry.name));
    }
  }
}

function lintRigPortability(file) {
  const rel = relative(root, file);
  const contents = readFileSync(file, 'utf8');
  let rig;

  try {
    rig = JSON.parse(contents);
  } catch (error) {
    failures.push(`${rel}: invalid JSON: ${error.message}`);
    return;
  }

  const pipelineCommands = Object.values(rig.pipeline || {})
    .flatMap((steps) => Array.isArray(steps) ? steps : [])
    .map((step) => step.command || '')
    .join('\n');

  if (rel.startsWith('WordPress/gutenberg/rigs/') && /\$HOME\/Developer\/gutenberg|~\/Developer\/gutenberg/.test(pipelineCommands)) {
    failures.push(`${rel}: Gutenberg rig checks must reference ${'${components.gutenberg.path}'} instead of a hard-coded personal checkout path`);
  }

  if (rel === 'chubes4/isolated-block-editor/rigs/isolated-block-editor/rig.json' && contents.includes('/var/lib/datamachine')) {
    failures.push(`${rel}: isolated-block-editor must use the component path or shared node_modules setting instead of /var/lib/datamachine`);
  }
}

function lintPortableSource(file) {
  const rel = relative(root, file);
  const contents = readFileSync(file, 'utf8');

  if (contents.includes(personalPathPrefix)) {
    failures.push(`${rel}: use $HOME, homedir(), component paths, or settings instead of hard-coded /Users/chubes paths`);
  }

  if (contents.includes(tsrmlsPatchMarker)) {
    failures.push(`${rel}: TSRMLS fallback defines are owned by WordPress/wordpress-playground#3512; do not patch Playground source in rigs`);
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

function reportFailures() {
  if (failures.length === 0) {
    return;
  }

  console.error('Rig package lint failed:');
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}

function lintGeneratedStudioModelRigs() {
  if (!existsSync(studioModelRigGenerator)) {
    return;
  }

  const result = spawnSync('node', [studioModelRigGenerator, '--check'], { encoding: 'utf8' });
  if (result.status !== 0) {
    const output = `${result.stdout || ''}${result.stderr || ''}`.trim();
    failures.push(`Studio agent model rig generation check failed${output ? `: ${output}` : ''}`);
  }
}

walk(root);

rigFiles.forEach(lintRigPortability);
portableSourceFiles.forEach(lintPortableSource);
lintGeneratedStudioModelRigs();

reportFailures();

if (!hasPhp()) {
  console.warn(`PHP not found; skipped syntax checks for ${phpFiles.length} PHP file(s).`);
  process.exit(0);
}

phpFiles.forEach(lintPhp);

reportFailures();

console.log('Rig package lint passed.');
console.log(`- PHP syntax: ${phpFiles.length} file(s)`);
console.log(`- rig portability: ${rigFiles.length} rig(s)`);
console.log(`- portable source paths: ${portableSourceFiles.length} file(s)`);
