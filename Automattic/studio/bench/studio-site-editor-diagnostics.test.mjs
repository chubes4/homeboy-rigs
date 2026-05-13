import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

process.env.HOMEBOY_COMPONENT_PATH ||= '/tmp/homeboy-rigs-test-component';

const DEFAULT_RESOURCE_INCLUDE = Object.freeze([
  '/wp-json/',
  '?rest_route=',
  '/wp-admin/',
  '/wp-content/',
  '/wp-includes/',
]);
const pageProfilerApi = { DEFAULT_RESOURCE_INCLUDE };

const {
  annotatePhase,
  buildTimingDeltaSummary,
  flattenPhasedResourceTimings,
  loadTimingCorrelator,
  requestProfilerPath,
  timingCorrelatorPath,
} = await import('./lib/site-editor-timing-deltas.mjs');
const {
  instrumentIndexPhp,
  instrumentWpSettingsPhp,
  summarizeWordPressBootstrapTimeline,
} = await import('./lib/wordpress-bootstrap-timeline.mjs');
const {
  buildSiteEditorPreloadComparison,
  installSiteEditorPreloadCandidateSource,
} = await import('./lib/site-editor-preload-harness.mjs');
const {
  pageProfilerPath,
  profileWordPressPage,
  wordpressPageProfilerSpec,
} = await import('./lib/wordpress-page-profiler.mjs');
const {
  normalizeWordPressAdminScaleSweepManifest,
} = await import('./lib/wordpress-admin-scale-sweep.mjs');
const {
  sanitizeArtifact,
} = await import('./lib/studio-bench.mjs');

function withEnv(values, callback) {
  const previous = {};
  for (const key of Object.keys(values)) {
    previous[key] = process.env[key];
    if (values[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = values[key];
    }
  }
  try {
    return callback();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

// --- path resolution -------------------------------------------------------

test('sanitizeArtifact redacts sensitive network artifact values', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'homeboy-rigs-sanitize-'));
  const artifactPath = path.join(tempDir, 'network.json');
  await writeFile(
    artifactPath,
    JSON.stringify({ url: 'http://example.test/wp-json/?token=abc123&nonce=secret', autoLoginUrl: 'http://example.test/studio-auto-login?token=login' })
  );

  try {
    await sanitizeArtifact({ path: artifactPath });
    const sanitized = await readFile(artifactPath, 'utf8');
    assert.match(sanitized, /token=\[redacted\]/);
    assert.match(sanitized, /nonce=\[redacted\]/);
    assert.doesNotMatch(sanitized, /abc123|secret|login/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('timingCorrelatorPath sits next to the request profiler by default', () => {
  withEnv({ HOMEBOY_SETTINGS_JSON: undefined }, () => {
    const profilerPath = '/tmp/he/wordpress/lib/request-profiler.js';
    assert.equal(
      timingCorrelatorPath({ profilerPath }),
      '/tmp/he/wordpress/lib/timing-correlator.js'
    );
  });
});

test('timingCorrelatorPath honors an explicit setting override', () => {
  withEnv(
    {
      HOMEBOY_SETTINGS_JSON: JSON.stringify({
        wordpress_timing_correlator_path: '/custom/correlator.js',
      }),
    },
    () => {
      assert.equal(timingCorrelatorPath(), '/custom/correlator.js');
    }
  );
});

test('requestProfilerPath honors the wordpress_request_profiler_path setting', () => {
  withEnv(
    {
      HOMEBOY_SETTINGS_JSON: JSON.stringify({
        wordpress_request_profiler_path: '/another/profiler.js',
      }),
    },
    () => {
      assert.equal(requestProfilerPath(), '/another/profiler.js');
    }
  );
});

test('pageProfilerPath sits next to the request profiler by default', () => {
  const profilerPath = '/tmp/he/wordpress/lib/request-profiler.js';
  assert.equal(
    pageProfilerPath({ profilerPath }),
    '/tmp/he/wordpress/lib/page-profiler.js'
  );
});

test('wordpressPageProfilerSpec defaults to Site Editor', () => {
  withEnv(
    {
      HOMEBOY_WORDPRESS_PAGE_PROFILE_SPEC_JSON: undefined,
      HOMEBOY_WORDPRESS_PAGE_PROFILE_PATH: undefined,
    },
    () => {
      const spec = wordpressPageProfilerSpec({ pageProfiler: pageProfilerApi });
      assert.equal(spec.id, 'site-editor');
      assert.equal(spec.path, '/wp-admin/site-editor.php');
      assert.equal(spec.ready.selector, 'iframe[name="editor-canvas"]');
      assert.equal(spec.ready.frameSelector, '[data-block]');
      assert.equal(typeof spec.ready.frameFunction, 'function');
    }
  );
});

test('wordpressPageProfilerSpec builds a generic WordPress page spec from env', () => {
  withEnv(
    {
      HOMEBOY_WORDPRESS_PAGE_PROFILE_SPEC_JSON: undefined,
      HOMEBOY_WORDPRESS_PAGE_PROFILE_PATH: '/',
      HOMEBOY_WORDPRESS_PAGE_PROFILE_ID: 'front-page',
      HOMEBOY_WORDPRESS_PAGE_PROFILE_LABEL: 'Front page',
      HOMEBOY_WORDPRESS_PAGE_PROFILE_READY_SELECTOR: undefined,
    },
    () => {
      const spec = wordpressPageProfilerSpec({ pageProfiler: pageProfilerApi });
      assert.equal(spec.id, 'front-page');
      assert.equal(spec.label, 'Front page');
      assert.equal(spec.path, '/');
      assert.equal(spec.ready.state, 'domcontentloaded');
      assert.deepEqual(spec.resources.includeResourceSubstrings, [
        ...DEFAULT_RESOURCE_INCLUDE,
      ]);
    }
  );
});

test('wordpressPageProfilerSpec supports selector readiness and resource include overrides', () => {
  withEnv(
    {
      HOMEBOY_WORDPRESS_PAGE_PROFILE_SPEC_JSON: undefined,
      HOMEBOY_WORDPRESS_PAGE_PROFILE_PATH: '/wp-admin/themes.php',
      HOMEBOY_WORDPRESS_PAGE_PROFILE_ID: 'themes',
      HOMEBOY_WORDPRESS_PAGE_PROFILE_READY_SELECTOR: '.theme-browser',
      HOMEBOY_WORDPRESS_PAGE_PROFILE_RESOURCE_INCLUDE: '/wp-json/,/custom-cache/',
    },
    () => {
      const spec = wordpressPageProfilerSpec();
      assert.equal(spec.path, '/wp-admin/themes.php');
      assert.equal(spec.ready.selector, '.theme-browser');
      assert.deepEqual(spec.resources.includeResourceSubstrings, ['/wp-json/', '/custom-cache/']);
    }
  );
});

test('loadTimingCorrelator returns null module when the file is absent', () => {
  const result = loadTimingCorrelator({
    override: '/nonexistent/path/to/timing-correlator.js',
  });
  assert.equal(result.module, null);
  assert.equal(result.path, '/nonexistent/path/to/timing-correlator.js');
});

test('loadTimingCorrelator loads a real correlator module from disk', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'site-editor-correlator-'));
  try {
    const file = path.join(tmp, 'timing-correlator.js');
    await writeFile(
      file,
      "module.exports = { correlateBrowserAndWordPressTimings: () => ({ correlated: [], unmatchedBrowser: [], unmatchedWordPress: [] }) };\n"
    );
    const { module: loaded, path: resolvedPath } = loadTimingCorrelator({ override: file });
    assert.equal(resolvedPath, file);
    assert.equal(typeof loaded.correlateBrowserAndWordPressTimings, 'function');
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

// --- phase annotation ------------------------------------------------------

test('annotatePhase tags every entry with the supplied phase label', () => {
  const tagged = annotatePhase(
    [
      { name: '/wp-json/wp/v2/types', startTime: 0, responseEnd: 10 },
      { name: '/wp-json/wp/v2/posts', startTime: 1, responseEnd: 20 },
    ],
    'measure-site-editor'
  );
  assert.equal(tagged.length, 2);
  assert.equal(tagged[0].phase, 'measure-site-editor');
  assert.equal(tagged[1].phase, 'measure-site-editor');
  // Original entries must not be mutated.
  assert.equal(tagged[0].name, '/wp-json/wp/v2/types');
});

test('flattenPhasedResourceTimings preserves phase order and labels each entry', () => {
  const flat = flattenPhasedResourceTimings({
    'warmup-site-editor': [{ name: '/a', startTime: 0, responseEnd: 1 }],
    'measure-site-editor': [{ name: '/b', startTime: 0, responseEnd: 2 }],
  });
  assert.equal(flat.length, 2);
  assert.equal(flat[0].phase, 'warmup-site-editor');
  assert.equal(flat[1].phase, 'measure-site-editor');
});

// --- summary builder -------------------------------------------------------

// Inline fake correlator so the test does not depend on
// homeboy-extensions being checked out next to the rigs worktree.
function makeFakeCorrelator(rows) {
  return {
    correlateBrowserAndWordPressTimings: () => ({
      correlated: rows,
      unmatchedBrowser: [],
      unmatchedWordPress: [],
    }),
  };
}

test('buildTimingDeltaSummary records why correlation was skipped when correlator is missing', () => {
  const summary = buildTimingDeltaSummary({
    browserResourceTimings: [{ name: '/a', startTime: 0, responseEnd: 5, phase: 'warmup-site-editor' }],
    wordpressRequests: [{ request_id: 'r1', uri: '/a', event: 'request.start', t_ms: 0 }],
    correlator: null,
  });
  assert.equal(summary.available, false);
  assert.match(summary.reason, /correlator/);
  assert.equal(summary.browser_resource_timing_count, 1);
  assert.equal(summary.wordpress_request_event_count, 1);
});

test('buildTimingDeltaSummary surfaces overall + per-phase aggregates and top deltas', () => {
  const correlated = [
    {
      url: 'http://localhost:8881/wp-json/wp/v2/types',
      normalizedUrl: '/wp-json/wp/v2/types',
      method: 'GET',
      phase: 'measure-site-editor',
      browserDurationMs: 430,
      browserTtfbMs: 410,
      wordpressDurationMs: 80,
      transportDeltaMs: 330,
      totalDeltaMs: 350,
    },
    {
      url: 'http://localhost:8881/wp-json/wp/v2/posts',
      normalizedUrl: '/wp-json/wp/v2/posts',
      method: 'GET',
      phase: 'measure-site-editor',
      browserDurationMs: 320,
      browserTtfbMs: 300,
      wordpressDurationMs: 70,
      transportDeltaMs: 230,
      totalDeltaMs: 250,
    },
    {
      url: 'http://localhost:8881/wp-json/wp/v2/posts',
      normalizedUrl: '/wp-json/wp/v2/posts',
      method: 'GET',
      phase: 'warmup-site-editor',
      browserDurationMs: 250,
      browserTtfbMs: 220,
      wordpressDurationMs: 60,
      transportDeltaMs: 160,
      totalDeltaMs: 190,
    },
  ];
  const summary = buildTimingDeltaSummary({
    browserResourceTimings: [],
    wordpressRequests: [],
    correlator: makeFakeCorrelator(correlated),
  });

  assert.equal(summary.available, true);
  assert.equal(summary.counts.correlated, 3);
  assert.equal(summary.counts.unmatched_browser, 0);
  assert.equal(summary.counts.unmatched_wordpress, 0);

  assert.equal(summary.overall.count, 3);
  assert.equal(summary.overall.max_transport_delta_ms, 330);
  assert.equal(summary.overall.max_total_delta_ms, 350);
  // Avg transport delta = (330 + 230 + 160) / 3 = 240.
  assert.equal(summary.overall.avg_transport_delta_ms, 240);
  assert.equal(summary.overall.largest_transport_delta.url, '/wp-json/wp/v2/types');
  assert.equal(summary.overall.largest_transport_delta.transport_delta_ms, 330);

  // Per-phase aggregation.
  const phases = new Map(summary.by_phase.map((row) => [row.phase, row]));
  assert.equal(phases.get('measure-site-editor').count, 2);
  assert.equal(phases.get('measure-site-editor').max_transport_delta_ms, 330);
  // (330 + 230) / 2 = 280.
  assert.equal(phases.get('measure-site-editor').avg_transport_delta_ms, 280);
  assert.equal(phases.get('warmup-site-editor').count, 1);
  assert.equal(phases.get('warmup-site-editor').max_transport_delta_ms, 160);

  // Top-by-transport ordering: largest absolute delta first.
  assert.equal(summary.top_by_transport_delta[0].url, '/wp-json/wp/v2/types');
  assert.equal(summary.top_by_transport_delta[1].url, '/wp-json/wp/v2/posts');
  assert.equal(summary.top_by_transport_delta[2].url, '/wp-json/wp/v2/posts');

  assert.equal(summary.top_by_total_delta[0].url, '/wp-json/wp/v2/types');
});

test('buildTimingDeltaSummary tolerates missing browserDurationMs / wordpressDurationMs', () => {
  const correlated = [
    {
      url: '/wp-json/wp/v2/no-server-timing',
      normalizedUrl: '/wp-json/wp/v2/no-server-timing',
      method: 'GET',
      phase: 'measure-site-editor',
      browserDurationMs: 300,
      browserTtfbMs: 280,
      // wordpressDurationMs / transportDeltaMs / totalDeltaMs deliberately undefined.
    },
  ];
  const summary = buildTimingDeltaSummary({
    browserResourceTimings: [],
    wordpressRequests: [],
    correlator: makeFakeCorrelator(correlated),
  });

  assert.equal(summary.available, true);
  assert.equal(summary.overall.count, 1);
  // No transport/total delta values means the aggregates report `undefined`
  // rather than NaN; metric() in the workload coerces undefined to 0.
  assert.equal(summary.overall.avg_transport_delta_ms, undefined);
  assert.equal(summary.overall.max_transport_delta_ms, undefined);
  assert.equal(summary.overall.avg_total_delta_ms, undefined);
  assert.equal(summary.overall.max_total_delta_ms, undefined);
  assert.equal(summary.overall.largest_transport_delta, null);
  assert.equal(summary.top_by_transport_delta.length, 0);
  assert.equal(summary.top_by_total_delta.length, 0);
});

test('buildTimingDeltaSummary forwards unmatched buckets into preview slices', () => {
  const correlator = {
    correlateBrowserAndWordPressTimings: () => ({
      correlated: [],
      unmatchedBrowser: [
        {
          url: '/missing-from-wp',
          normalizedUrl: '/missing-from-wp',
          method: 'GET',
          phase: 'measure-site-editor',
          initiatorType: 'fetch',
          durationMs: 90,
          ttfbMs: 85,
        },
      ],
      unmatchedWordPress: [
        {
          requestId: 'wp-only',
          uri: '/wp-cron.php',
          method: 'POST',
          durationMs: 12,
          eventCount: 4,
        },
      ],
    }),
  };
  const summary = buildTimingDeltaSummary({
    browserResourceTimings: [],
    wordpressRequests: [],
    correlator,
  });
  assert.equal(summary.counts.unmatched_browser, 1);
  assert.equal(summary.counts.unmatched_wordpress, 1);
  assert.equal(summary.unmatched_browser_preview[0].url, '/missing-from-wp');
  assert.equal(summary.unmatched_wordpress_preview[0].uri, '/wp-cron.php');
  assert.equal(summary.unmatched_wordpress_preview[0].request_id, 'wp-only');
});

// --- WordPress page profiler adapter ---------------------------------------

test('profileWordPressPage delegates page readiness to the Homeboy Extensions page profiler', async () => {
  const calls = [];
  const profile = {
    status: 200,
    readyMs: 345,
    resources: {
      resources: [
        { url: '/wp-json/wp/v2/types', kind: 'rest', startMs: 3, durationMs: 44, ttfbMs: 40 },
      ],
    },
  };
  const pageProfiler = {
    async profileWordPressPage(input) {
      calls.push(input);
      return profile;
    },
  };

  const result = await profileWordPressPage({
    page: { id: 'fake-page' },
    siteUrl: 'http://example.test',
    pageProfiler,
    pageSpec: { id: 'themes', path: '/wp-admin/themes.php', ready: '#wpbody-content' },
    wordpressProfilerRows: [{ request_id: 'r1' }],
    mark: () => {},
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].baseUrl, 'http://example.test');
  assert.equal(calls[0].spec.path, '/wp-admin/themes.php');
  assert.equal(result, profile);
});

// --- WordPress admin scale sweep ------------------------------------------

test('normalizeWordPressAdminScaleSweepManifest accepts page manifests and adds defaults', () => {
  const manifest = normalizeWordPressAdminScaleSweepManifest({
    pages: [
      {
        id: 'pipelines',
        path: '/wp-admin/admin.php?page=datamachine-pipelines',
        ready: { selector: '.datamachine-pipelines-app' },
      },
      {
        path: '/wp-admin/admin.php?page=datamachine-jobs',
        interactions: [{ type: 'click', selector: '.jobs-row:first-child button' }],
      },
    ],
  }, { pageProfiler: pageProfilerApi });

  assert.equal(manifest.pages.length, 2);
  assert.equal(manifest.pages[0].metricId, 'pipelines');
  assert.equal(manifest.pages[0].resources.includeResourceSubstrings.includes('/wp-json/'), true);
  assert.equal(manifest.pages[1].id, 'wp-admin-admin.php-page-datamachine-jobs');
  assert.equal(manifest.pages[1].ready.selector, '#wpbody-content, body.wp-admin');
  assert.equal(manifest.pages[1].interactions.length, 1);
});

// --- WordPress bootstrap timeline -----------------------------------------

test('instrumentIndexPhp adds entry and shutdown timeline hooks once', () => {
  const source = "<?php\ndefine( 'WP_USE_THEMES', true );\nrequire __DIR__ . '/wp-blog-header.php';\n";
  const instrumented = instrumentIndexPhp(source);
  assert.match(instrumented, /HOMEBOY_BOOTSTRAP_TIMELINE/);
  assert.match(instrumented, /entry\.start/);
  assert.match(instrumented, /entry\.shutdown/);
  assert.equal(instrumentIndexPhp(instrumented), instrumented);
});

test('instrumentWpSettingsPhp adds early WordPress bootstrap marks once', () => {
  const source = `<?php
define( 'WPINC', 'wp-includes' );
require_wp_db();
wp_start_object_cache();
require ABSPATH . WPINC . '/default-filters.php';
register_shutdown_function( 'shutdown_action_hook' );
require_once ABSPATH . WPINC . '/class-wp-locale-switcher.php';
wp_not_installed();
// Load most of WordPress.
require ABSPATH . WPINC . '/post.php';
require ABSPATH . WPINC . '/rest-api.php';
require ABSPATH . WPINC . '/rest-api/endpoints/class-wp-rest-navigation-fallback-controller.php';
require ABSPATH . WPINC . '/blocks/index.php';
require ABSPATH . WPINC . '/speculative-loading.php';
wp_plugin_directory_constants();
unset( $mu_plugin, $_wp_plugin_file );
do_action( 'muplugins_loaded' );
`;
  const instrumented = instrumentWpSettingsPhp(source);
  assert.match(instrumented, /wp-settings\.start/);
  assert.match(instrumented, /wp-settings\.after_require_wp_db/);
  assert.match(instrumented, /wp-settings\.before_load_most/);
  assert.match(instrumented, /wp-settings\.after_blocks_index/);
  assert.match(instrumented, /wp-settings\.after_muplugins_loaded/);
  assert.equal(instrumentWpSettingsPhp(instrumented), instrumented);
});

test('summarizeWordPressBootstrapTimeline groups requests and reports per-event deltas', () => {
  const summary = summarizeWordPressBootstrapTimeline([
    { request_id: 'fast', uri: '/wp-json/fast', method: 'GET', event: 'entry.start', t_ms: 0 },
    { request_id: 'fast', uri: '/wp-json/fast', method: 'GET', event: 'entry.shutdown', t_ms: 20 },
    { request_id: 'slow', uri: '/wp-json/slow', method: 'GET', event: 'entry.start', t_ms: 0 },
    { request_id: 'slow', uri: '/wp-json/slow', method: 'GET', event: 'wp-settings.start', t_ms: 2 },
    { request_id: 'slow', uri: '/wp-json/slow', method: 'GET', event: 'entry.shutdown', t_ms: 75 },
  ]);
  assert.equal(summary.length, 2);
  assert.equal(summary[0].uri, '/wp-json/slow');
  assert.equal(summary[0].duration_ms, 75);
  assert.equal(summary[0].events[2].delta_from_previous_ms, 73);
});

// --- Site Editor preload comparison ---------------------------------------

test('installSiteEditorPreloadCandidateSource injects dynamic preload paths once', () => {
  const source = `<?php
$preload_paths = array();
block_editor_rest_api_preload( $preload_paths, $block_editor_context );
`;
  const patched = installSiteEditorPreloadCandidateSource(source);
  assert.match(patched, /HOMEBOY_SITE_EDITOR_PRELOAD_CANDIDATE/);
  assert.match(patched, /get_block_templates\( array\(\), 'wp_template_part' \)/);
  assert.match(patched, /rest_get_route_for_post_type_items\( 'post' \)/);
  assert.match(patched, /'per_page'\s+=> \$homeboy_per_page/);
  assert.match(patched, /\/wp\/v2\/taxonomies\?context=view/);
  assert.equal(installSiteEditorPreloadCandidateSource(patched), patched);
});

test('installSiteEditorPreloadCandidateSource injects extra method and dynamic preload controls', () => {
  withEnv(
    {
      HOMEBOY_SITE_EDITOR_EXTRA_PRELOAD_PATHS_JSON: JSON.stringify([
        '/wp/v2/types/post?context=edit',
        { path: '/wp/v2/settings', method: 'OPTIONS' },
      ]),
      HOMEBOY_SITE_EDITOR_DYNAMIC_PRELOADS_JSON: JSON.stringify(['navigation-fallback']),
    },
    () => {
      const source = `<?php
$preload_paths = array();
block_editor_rest_api_preload( $preload_paths, $block_editor_context );
`;
      const patched = installSiteEditorPreloadCandidateSource(source);
      assert.match(patched, /'\/wp\/v2\/types\/post\?context=edit'/);
      assert.match(patched, /array\( '\/wp\/v2\/settings', 'OPTIONS' \)/);
      assert.match(patched, /WP_Navigation_Fallback::get_fallback\(\)/);
      assert.match(patched, /'\/wp-block-editor\/v1\/navigation-fallback\?_embed=true'/);
      assert.match(patched, /'\/wp\/v2\/navigation\/' \.[\s\S]*\?context=edit/);
    }
  );
});

test('installSiteEditorPreloadCandidateSource fails when preload call is missing', () => {
  assert.throws(
    () => installSiteEditorPreloadCandidateSource('<?php $preload_paths = array();'),
    /preload call not found/
  );
});

test('buildSiteEditorPreloadComparison summarizes the bot-path delta', () => {
  const comparison = buildSiteEditorPreloadComparison({
    baseline: {
      warmup: { readyMs: 1600 },
      measure: {
        readyMs: 1450,
        status: 200,
        resources: {
          count: 2,
          slowest: [
            { url: '/wp-json/wp/v2/template-parts/theme//header', durationMs: 480, ttfbMs: 475 },
            { url: '/wp-json/wp/v2/posts?per_page=3', durationMs: 440, ttfbMs: 438 },
          ],
        },
      },
    },
    candidate: {
      warmup: { readyMs: 1550 },
      measure: {
        readyMs: 950,
        status: 200,
        resources: { count: 0, slowest: [] },
      },
    },
  });

  assert.equal(comparison.baseline_measure_ms, 1450);
  assert.equal(comparison.candidate_measure_ms, 950);
  assert.equal(comparison.delta_ms, -500);
  assert.equal(comparison.delta_pct, -34.5);
  assert.equal(comparison.baseline_measure_resource_count, 2);
  assert.equal(comparison.candidate_measure_resource_count, 0);
  assert.equal(comparison.baseline_slowest_measure_resources[0].duration_ms, 480);
});
