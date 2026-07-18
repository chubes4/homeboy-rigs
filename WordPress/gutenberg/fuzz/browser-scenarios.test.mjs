import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const packageRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

for (const workloadName of ['block-editor-browser-coverage', 'site-editor-browser-coverage']) {
  test(`${workloadName} uses the canonical Codebox browser scenario contract`, () => {
    const workload = JSON.parse(readFileSync(path.join(packageRoot, 'fuzz', `${workloadName}.json`), 'utf8'));
    const runnerCase = workload.cases[0];
    const setup = runnerCase.phases.setup.find((step) => step.command === 'wordpress.run-php');
    const action = runnerCase.phases.action[0];

    assert.equal(workload.workload.command, 'wordpress.browser-scenario');
    assert.ok(setup.args.includes('code-file=${package.root}/fixtures/browser-coverage.php'));
    assert.ok(existsSync(path.join(packageRoot, 'fixtures/browser-coverage.php')));
    assert.equal(action.command, 'wordpress.browser-scenario');
    assert.ok(action.args[0].startsWith('scenario-json='));
  });
}
