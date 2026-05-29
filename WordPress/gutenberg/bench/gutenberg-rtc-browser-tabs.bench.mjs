import { runPlaywrightSpecSuite, setting } from './lib/gutenberg-rtc-bench.mjs';

const DEFAULT_SPECS = [
  'collaboration-refresh.spec.ts',
  'collaboration-self-presence.spec.ts',
  'collaboration-awareness-cursor-position.spec.ts',
];

export default async function gutenbergRtcBrowserTabs() {
  const specs = setting('rtc_browser_tabs_specs')
    .split(',')
    .map((spec) => spec.trim())
    .filter(Boolean);

  return runPlaywrightSpecSuite({
    id: 'gutenberg-rtc-browser-tabs',
    specs: specs.length > 0 ? specs : DEFAULT_SPECS,
  });
}
