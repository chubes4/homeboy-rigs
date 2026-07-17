import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const supportedTestFile = /\.test\.(?:mjs|js|cjs)$/;

function committedTestFiles() {
  return execFileSync('git', ['ls-files', '-z'], {
    cwd: repoRoot,
    encoding: 'utf8',
  })
    .split('\0')
    .filter((file) => supportedTestFile.test(file))
    .sort();
}

const testFiles = committedTestFiles();

if (testFiles.length === 0) {
  throw new Error('No committed Node contract test files found.');
}

process.stdout.write(`Running ${testFiles.length} committed contract test files:\n`);
for (const file of testFiles) {
  process.stdout.write(`- ${file}\n`);
}

// Contract tests commonly set process-wide fixture environment variables. Keep
// files serial so they cannot affect one another through the shared process env.
const result = spawnSync(process.execPath, ['--test', '--test-concurrency=1', ...testFiles], {
  cwd: repoRoot,
  stdio: 'inherit',
});

if (result.error) {
  throw result.error;
}

process.exitCode = result.status ?? 1;
