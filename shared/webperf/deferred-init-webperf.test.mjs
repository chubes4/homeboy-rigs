import assert from 'node:assert/strict';
import test from 'node:test';

import {
  deferredInitBrowserMarkerScript,
  deferredInitMarkers,
  summarizeDeferredInitWebperf,
} from './deferred-init-webperf.mjs';

test('deferred init markers are stable and namespaced by feature id', () => {
  assert.deepEqual(deferredInitMarkers('checkout-widget'), {
    featureNotNeededStart: 'deferred_init.checkout-widget.feature_not_needed.start',
    featureNotNeededReady: 'deferred_init.checkout-widget.feature_not_needed.ready',
    featureNeededTrigger: 'deferred_init.checkout-widget.feature_needed.trigger',
    featureNeededReady: 'deferred_init.checkout-widget.feature_needed.ready',
    featureNeededSuccess: 'deferred_init.checkout-widget.feature_needed.success',
  });
});

test('deferred init browser script installs a feature marker channel', () => {
  const script = deferredInitBrowserMarkerScript('checkout-widget');

  assert.match(script, /__homeboyDeferredInit/);
  assert.match(script, /checkout-widget/);
  assert.match(script, /feature_not_needed\.start/);
});

test('summarizeDeferredInitWebperf passes when feature requests wait until trigger', () => {
  const markers = deferredInitMarkers('checkout-widget');
  const summary = summarizeDeferredInitWebperf({
    featureId: 'checkout-widget',
    markerEvents: [
      { name: markers.featureNotNeededReady, t_ms: 500 },
      { name: markers.featureNeededTrigger, t_ms: 1500 },
      { name: markers.featureNeededReady, t_ms: 2200 },
      { name: markers.featureNeededSuccess, t_ms: 2300 },
    ],
    networkEntries: [
      { url: 'https://example.test/style.css', t_ms: 200 },
      { url: 'https://cdn.example.test/feature.js', t_ms: 1600 },
      { url: 'https://api.example.test/feature/session', t_ms: 1700 },
      { url: 'https://third-party.example/feature-frame', t_ms: 1800 },
    ],
    featureRequestMatchers: [/feature/],
    thirdPartyRequestMatchers: ['third-party.example'],
    maxEarlyThirdPartyRequests: 0,
  });

  assert.equal(summary.metrics['checkout-widget_deferred_init_feature_request_count_before_trigger'], 0);
  assert.equal(summary.metrics['checkout-widget_deferred_init_feature_request_count_after_trigger'], 3);
  assert.equal(summary.metrics['checkout-widget_deferred_init_third_party_request_count_before_trigger'], 0);
  assert.equal(summary.metrics['checkout-widget_deferred_init_post_trigger_success'], true);
  assert.deepEqual(summary.assertions.map((entry) => entry.status), ['pass', 'pass', 'pass', 'pass']);
  assert.deepEqual(summary.metadata.post_trigger_feature_urls_sample, [
    'https://cdn.example.test/feature.js',
    'https://api.example.test/feature/session',
    'https://third-party.example/feature-frame',
  ]);
});

test('summarizeDeferredInitWebperf fails for early feature initialization', () => {
  const markers = deferredInitMarkers('checkout-widget');
  const summary = summarizeDeferredInitWebperf({
    featureId: 'checkout-widget',
    markerEvents: [
      { name: markers.featureNotNeededReady, t_ms: 500 },
      { name: markers.featureNeededTrigger, t_ms: 1500 },
    ],
    networkEntries: [
      { url: 'https://cdn.example.test/feature.js', t_ms: 200 },
      { url: 'https://api.example.test/feature/session', t_ms: 1700 },
    ],
    featureRequestMatchers: [/feature/],
    success: true,
  });

  assert.equal(summary.metrics['checkout-widget_deferred_init_feature_request_count_before_trigger'], 1);
  assert.equal(summary.assertions.find((entry) => entry.id === 'checkout-widget-no-early-feature-init').status, 'fail');
});

test('summarizeDeferredInitWebperf fails when timing data cannot prove phase boundaries', () => {
  const markers = deferredInitMarkers('checkout-widget');
  const summary = summarizeDeferredInitWebperf({
    featureId: 'checkout-widget',
    markerEvents: [{ name: markers.featureNeededTrigger, t_ms: 1500 }],
    networkEntries: [{ url: 'https://api.example.test/feature/session' }],
    featureRequestMatchers: [/feature/],
    success: true,
  });

  assert.equal(summary.metrics['checkout-widget_deferred_init_request_timing_available'], false);
  assert.equal(summary.assertions.find((entry) => entry.id === 'checkout-widget-post-trigger-feature-requests').status, 'fail');
});
