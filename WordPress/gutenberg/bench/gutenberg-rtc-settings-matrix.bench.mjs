import { runPlaywrightSpecSuite, setting } from './lib/gutenberg-rtc-bench.mjs';

const DEFAULT_SPECS = [
  'collaboration-metabox-lock.spec.ts',
  'collaboration-document-size-lock.spec.ts',
  'collaboration-sync-error-filter.spec.ts',
  'collaboration-autodraft-autosave-loss.spec.ts',
  'collaboration-autodraft-collaborator-autosave-loss.spec.ts',
];

export default async function gutenbergRtcSettingsMatrix() {
  const specs = setting('rtc_settings_specs')
    .split(',')
    .map((spec) => spec.trim())
    .filter(Boolean);

  return runPlaywrightSpecSuite({
    id: 'gutenberg-rtc-settings-matrix',
    specs: specs.length > 0 ? specs : DEFAULT_SPECS,
    timeoutMs: 1500000,
  });
}
