import { runPlaywrightSpecSuite, setting } from './lib/gutenberg-rtc-bench.mjs';

const DEFAULT_SPECS = [
  'collaboration-sync.spec.ts',
  'collaboration-presence.spec.ts',
  'collaboration-selection.spec.ts',
];

export default async function gutenbergRtcBrowserBasic() {
  const specs = setting('rtc_browser_basic_specs')
    .split(',')
    .map((spec) => spec.trim())
    .filter(Boolean);

  return runPlaywrightSpecSuite({
    id: 'gutenberg-rtc-browser-basic',
    specs: specs.length > 0 ? specs : DEFAULT_SPECS,
  });
}
