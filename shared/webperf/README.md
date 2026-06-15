# Deferred-Initialization Webperf Pattern

This package is a reusable Homeboy Rigs pattern for proving that browser work is
deferred until a feature is needed. It is intentionally generic: rig authors
provide feature selectors, URL matchers, and interaction scripts; the helper only
normalizes phase markers, request counts, metrics, assertions, and metadata.

## Goal

Use this pattern when load-only parity is not enough. The proof shape is:

1. Start a **feature-not-needed** phase before page scripts initialize.
2. Load the page and mark the page state where the feature should still be idle.
3. Trigger the user action or viewport condition that makes the feature needed.
4. Mark post-trigger readiness and success.
5. Count feature and third-party requests before and after the trigger.
6. Assert no early feature initialization while proving post-trigger success.

## Helper

Import from `shared/webperf/deferred-init-webperf.mjs`:

```js
import {
  deferredInitBrowserMarkerScript,
  deferredInitMarkers,
  summarizeDeferredInitWebperf,
} from '../../shared/webperf/deferred-init-webperf.mjs';
```

`deferredInitBrowserMarkerScript(featureId)` returns a small pre-page script that
installs `window.__homeboyDeferredInit[featureId]`. The installed channel exposes
stable marker names and a `mark(name, data)` function. Rig-specific browser probe
scripts can use it like this:

```js
const deferred = window.__homeboyDeferredInit['checkout-widget'];
deferred.mark(deferred.markers.featureNotNeededReady, {
  visible: document.querySelector('#checkout-widget') !== null,
});

document.querySelector('#show-checkout-widget').click();
deferred.mark(deferred.markers.featureNeededTrigger, { trigger: 'button-click' });

await pageWaitForWidgetReady();
deferred.mark(deferred.markers.featureNeededReady);
deferred.mark(deferred.markers.featureNeededSuccess, { buttonVisible: true });
```

After the browser probe finishes, pass the marker events and captured network log
to `summarizeDeferredInitWebperf()`:

```js
const summary = summarizeDeferredInitWebperf({
  featureId: 'checkout-widget',
  markerEvents: scriptResult.deferredInitEvents,
  networkEntries: browserNetworkResponses,
  featureRequestMatchers: [/checkout-widget/, /api\.example\.com\/widget/],
  thirdPartyRequestMatchers: [/third-party\.example/],
  maxEarlyFeatureRequests: 0,
  maxEarlyThirdPartyRequests: 0,
  minPostTriggerFeatureRequests: 1,
});

for (const assertion of summary.assertions) {
  trace.assertion(assertion);
}
```

## Example Metrics

For `featureId: 'checkout-widget'`, the helper emits metrics like:

```json
{
  "checkout-widget_deferred_init_feature_not_needed_ready_ms": 500,
  "checkout-widget_deferred_init_feature_needed_trigger_ms": 1500,
  "checkout-widget_deferred_init_feature_needed_ready_ms": 2200,
  "checkout-widget_deferred_init_feature_request_count": 3,
  "checkout-widget_deferred_init_feature_request_count_before_trigger": 0,
  "checkout-widget_deferred_init_feature_request_count_after_trigger": 3,
  "checkout-widget_deferred_init_third_party_request_count_before_trigger": 0,
  "checkout-widget_deferred_init_no_early_feature_init": true,
  "checkout-widget_deferred_init_post_trigger_feature_requests": true,
  "checkout-widget_deferred_init_post_trigger_success": true
}
```

The metadata includes sampled early and post-trigger feature/third-party URLs so
PR evidence can show what initialized too early without dumping full network logs
into the summary.

## Phase Markers

The default marker namespace is `deferred_init.<featureId>.*`:

- `feature_not_needed.start`
- `feature_not_needed.ready`
- `feature_needed.trigger`
- `feature_needed.ready`
- `feature_needed.success`

## Current Dependencies

This helper can land before Homeboy or WP Codebox adds a higher-level declarative
deferred-init phase primitive. Current rigs still need to provide:

- A browser probe or trace workload that can inject the pre-page marker script.
- A post-load interaction script that returns the marker events.
- A browser network artifact with request timing fields such as `t_ms`,
  `startTime`, or `request.startTime`.
- Rig-specific selectors and URL matchers that define what counts as feature or
  third-party initialization.

Future upstream Homeboy/WP Codebox work can wrap those pieces in declarative
phase syntax. The metric and assertion contract here should remain reusable.
