export const DEFERRED_INIT_PHASES = Object.freeze({
  FEATURE_NOT_NEEDED: 'feature-not-needed',
  FEATURE_NEEDED: 'feature-needed',
});

const DEFAULT_MARKER_PREFIX = 'deferred_init';

function markerName(prefix, featureId, name) {
  return `${prefix}.${featureId}.${name}`;
}

export function deferredInitMarkers(featureId, { prefix = DEFAULT_MARKER_PREFIX } = {}) {
  if (!featureId || typeof featureId !== 'string') {
    throw new Error('deferredInitMarkers requires a non-empty string featureId.');
  }

  return Object.freeze({
    featureNotNeededStart: markerName(prefix, featureId, 'feature_not_needed.start'),
    featureNotNeededReady: markerName(prefix, featureId, 'feature_not_needed.ready'),
    featureNeededTrigger: markerName(prefix, featureId, 'feature_needed.trigger'),
    featureNeededReady: markerName(prefix, featureId, 'feature_needed.ready'),
    featureNeededSuccess: markerName(prefix, featureId, 'feature_needed.success'),
  });
}

export function deferredInitBrowserMarkerScript(featureId, options = {}) {
  const markers = deferredInitMarkers(featureId, options);
  return `(() => {
  const startedAt = performance.now();
  const events = [];
  const elapsed = () => Math.round(performance.now() - startedAt);
  const mark = (name, data = {}) => {
    const event = { name, t_ms: elapsed(), data };
    events.push(event);
    try { performance.mark(name); } catch {}
    return event;
  };
  window.__homeboyDeferredInit = window.__homeboyDeferredInit || {};
  window.__homeboyDeferredInit[${JSON.stringify(featureId)}] = {
    featureId: ${JSON.stringify(featureId)},
    markers: ${JSON.stringify(markers)},
    events,
    mark,
  };
  mark(${JSON.stringify(markers.featureNotNeededStart)});
})();`;
}

function toFiniteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function eventTime(event) {
  return toFiniteNumber(event?.t_ms ?? event?.time_ms ?? event?.timestamp_ms ?? event?.startTime ?? event?.start_time_ms);
}

function requestTime(entry) {
  return toFiniteNumber(
    entry?.t_ms ??
      entry?.time_ms ??
      entry?.timestamp_ms ??
      entry?.startTime ??
      entry?.start_time_ms ??
      entry?.request?.startTime ??
      entry?.request?.start_time_ms
  );
}

function requestUrl(entry) {
  return entry?.url || entry?.request?.url || entry?.response?.url || '';
}

function compileMatcher(matcher) {
  if (typeof matcher === 'function') {
    return matcher;
  }
  if (matcher instanceof RegExp) {
    return (entry) => matcher.test(requestUrl(entry));
  }
  if (typeof matcher === 'string') {
    return (entry) => requestUrl(entry).includes(matcher);
  }
  throw new Error(`Unsupported deferred-init request matcher: ${String(matcher)}`);
}

function matchesAny(entry, matchers) {
  return matchers.some((matcher) => matcher(entry));
}

function findMarkerTime(markerEvents, marker) {
  const event = markerEvents.find((candidate) => candidate?.name === marker);
  return eventTime(event);
}

function countRequests(entries, matchers, predicate = () => true) {
  return entries.filter((entry) => predicate(entry) && matchesAny(entry, matchers)).length;
}

function sampleUrls(entries, matchers, predicate = () => true, limit = 20) {
  return entries
    .filter((entry) => predicate(entry) && matchesAny(entry, matchers))
    .map(requestUrl)
    .filter(Boolean)
    .slice(0, limit);
}

function assertion(id, status, message) {
  return { id, status, message };
}

export function summarizeDeferredInitWebperf(options) {
  const {
    featureId,
    markerEvents = [],
    networkEntries = [],
    featureRequestMatchers = [],
    thirdPartyRequestMatchers = [],
    success = false,
    maxEarlyFeatureRequests = 0,
    maxEarlyThirdPartyRequests = null,
    minPostTriggerFeatureRequests = 1,
    metricsPrefix = featureId ? `${featureId}_deferred_init` : 'deferred_init',
    markerPrefix = DEFAULT_MARKER_PREFIX,
  } = options || {};

  if (!featureId || typeof featureId !== 'string') {
    throw new Error('summarizeDeferredInitWebperf requires a non-empty string featureId.');
  }
  if (featureRequestMatchers.length === 0) {
    throw new Error('summarizeDeferredInitWebperf requires at least one featureRequestMatcher.');
  }

  const markers = deferredInitMarkers(featureId, { prefix: markerPrefix });
  const featureMatchers = featureRequestMatchers.map(compileMatcher);
  const thirdPartyMatchers = thirdPartyRequestMatchers.map(compileMatcher);
  const notNeededReadyMs = findMarkerTime(markerEvents, markers.featureNotNeededReady);
  const triggerMs = findMarkerTime(markerEvents, markers.featureNeededTrigger);
  const neededReadyMs = findMarkerTime(markerEvents, markers.featureNeededReady);
  const successMs = findMarkerTime(markerEvents, markers.featureNeededSuccess);
  const hasRequestTiming = networkEntries.some((entry) => requestTime(entry) !== null);
  const beforeTrigger = (entry) => {
    const time = requestTime(entry);
    return triggerMs === null || time === null ? false : time < triggerMs;
  };
  const afterTrigger = (entry) => {
    const time = requestTime(entry);
    return triggerMs === null || time === null ? false : time >= triggerMs;
  };
  const earlyFeatureRequests = countRequests(networkEntries, featureMatchers, beforeTrigger);
  const postTriggerFeatureRequests = countRequests(networkEntries, featureMatchers, afterTrigger);
  const earlyThirdPartyRequests = thirdPartyMatchers.length > 0 ? countRequests(networkEntries, thirdPartyMatchers, beforeTrigger) : null;
  const postTriggerThirdPartyRequests = thirdPartyMatchers.length > 0 ? countRequests(networkEntries, thirdPartyMatchers, afterTrigger) : null;
  const featureRequestCount = countRequests(networkEntries, featureMatchers);
  const thirdPartyRequestCount = thirdPartyMatchers.length > 0 ? countRequests(networkEntries, thirdPartyMatchers) : null;
  const earlyFeaturePass = hasRequestTiming && triggerMs !== null && earlyFeatureRequests <= maxEarlyFeatureRequests;
  const postTriggerFeaturePass = hasRequestTiming && triggerMs !== null && postTriggerFeatureRequests >= minPostTriggerFeatureRequests;
  const thirdPartyEarlyPass =
    maxEarlyThirdPartyRequests === null ||
    (hasRequestTiming && triggerMs !== null && earlyThirdPartyRequests <= maxEarlyThirdPartyRequests);
  const successPass = success === true || successMs !== null;

  const metrics = {
    [`${metricsPrefix}_feature_not_needed_ready_ms`]: notNeededReadyMs,
    [`${metricsPrefix}_feature_needed_trigger_ms`]: triggerMs,
    [`${metricsPrefix}_feature_needed_ready_ms`]: neededReadyMs,
    [`${metricsPrefix}_feature_needed_success_ms`]: successMs,
    [`${metricsPrefix}_request_timing_available`]: hasRequestTiming,
    [`${metricsPrefix}_feature_request_count`]: featureRequestCount,
    [`${metricsPrefix}_feature_request_count_before_trigger`]: earlyFeatureRequests,
    [`${metricsPrefix}_feature_request_count_after_trigger`]: postTriggerFeatureRequests,
    [`${metricsPrefix}_third_party_request_count`]: thirdPartyRequestCount,
    [`${metricsPrefix}_third_party_request_count_before_trigger`]: earlyThirdPartyRequests,
    [`${metricsPrefix}_third_party_request_count_after_trigger`]: postTriggerThirdPartyRequests,
    [`${metricsPrefix}_no_early_feature_init`]: earlyFeaturePass,
    [`${metricsPrefix}_post_trigger_feature_requests`]: postTriggerFeaturePass,
    [`${metricsPrefix}_post_trigger_success`]: successPass,
  };

  return {
    featureId,
    phases: DEFERRED_INIT_PHASES,
    markers,
    metrics,
    assertions: [
      assertion(
        `${featureId}-no-early-feature-init`,
        earlyFeaturePass ? 'pass' : 'fail',
        `Observed ${earlyFeatureRequests} feature request(s) before trigger; expected <= ${maxEarlyFeatureRequests}.`
      ),
      assertion(
        `${featureId}-post-trigger-feature-requests`,
        postTriggerFeaturePass ? 'pass' : 'fail',
        `Observed ${postTriggerFeatureRequests} feature request(s) after trigger; expected >= ${minPostTriggerFeatureRequests}.`
      ),
      assertion(
        `${featureId}-post-trigger-success`,
        successPass ? 'pass' : 'fail',
        successPass ? 'Feature reported post-trigger success.' : 'Feature did not report post-trigger success.'
      ),
      ...(maxEarlyThirdPartyRequests === null
        ? []
        : [
            assertion(
              `${featureId}-no-early-third-party-init`,
              thirdPartyEarlyPass ? 'pass' : 'fail',
              `Observed ${earlyThirdPartyRequests} third-party request(s) before trigger; expected <= ${maxEarlyThirdPartyRequests}.`
            ),
          ]),
    ],
    metadata: {
      marker_events: markerEvents,
      early_feature_urls_sample: sampleUrls(networkEntries, featureMatchers, beforeTrigger),
      post_trigger_feature_urls_sample: sampleUrls(networkEntries, featureMatchers, afterTrigger),
      early_third_party_urls_sample: thirdPartyMatchers.length > 0 ? sampleUrls(networkEntries, thirdPartyMatchers, beforeTrigger) : [],
      post_trigger_third_party_urls_sample: thirdPartyMatchers.length > 0 ? sampleUrls(networkEntries, thirdPartyMatchers, afterTrigger) : [],
    },
  };
}
