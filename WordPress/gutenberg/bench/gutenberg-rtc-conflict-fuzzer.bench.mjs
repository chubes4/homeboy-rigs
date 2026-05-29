import { runPlaywrightSpecSuite, setting } from './lib/gutenberg-rtc-bench.mjs';

const DEFAULT_SPECS = [
  'collaboration-stress.spec.ts',
  'collaboration-undo-redo.spec.ts',
  'collaboration-block-gauntlet.spec.ts',
];

export default async function gutenbergRtcConflictFuzzer() {
  const specs = setting('rtc_conflict_specs')
    .split(',')
    .map((spec) => spec.trim())
    .filter(Boolean);

  return runPlaywrightSpecSuite({
    id: 'gutenberg-rtc-conflict-fuzzer',
    specs: specs.length > 0 ? specs : DEFAULT_SPECS,
    timeoutMs: 1500000,
  });
}
