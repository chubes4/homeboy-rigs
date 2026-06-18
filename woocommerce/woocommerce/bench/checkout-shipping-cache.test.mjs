import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const workload = readFileSync(path.join(__dirname, 'checkout-shipping-cache.php'), 'utf8');

function caseBody(name) {
  const match = workload.match(new RegExp(`case '${name}':[\\s\\S]*?\\n\\s*break;`));
  assert.ok(match, `Expected ${name} case to exist`);
  return match[0];
}

test('package_index churn does not mutate the rig-only helper key', () => {
  assert.match(workload, /\$package\['homeboy_package_index'\]\s+=\s+\$index;/);

  const packageIndexCase = caseBody('package_index');
  assert.match(packageIndexCase, /\$package\['package_index'\]\s+=\s+\$index \+ \$step;/);
  assert.doesNotMatch(packageIndexCase, /homeboy_package_index/);
});

test('unknown package key guardrails still use the synthetic key', () => {
  assert.match(caseBody('unknown_package_key'), /\$package\[ \$synthetic_unknown_key \]/);
  assert.match(caseBody('ignored_unknown_package_key'), /\$package\[ \$synthetic_unknown_key \]/);
  assert.match(workload, /add_filter\( \$ignored_hash_fields_filter, \$ignore_synthetic_key \)/);
});
