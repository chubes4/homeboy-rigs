import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { buildEceProfileOptions } from './ece-product-page-profile.mjs';

const execFileAsync = promisify(execFile);

const componentPath = process.env.HOMEBOY_COMPONENT_PATH;
const componentId = process.env.HOMEBOY_COMPONENT_ID || 'woocommerce-gateway-stripe';
const scenarioId = process.env.HOMEBOY_TRACE_SCENARIO || 'ece-product-page-waterfall';
const resultsFile = process.env.HOMEBOY_TRACE_RESULTS_FILE;
const artifactDir = process.env.HOMEBOY_TRACE_ARTIFACT_DIR || path.join(tmpdir(), 'wc-stripe-ece-waterfall-artifacts');
const wpCodeboxBin = process.env.HOMEBOY_WP_CODEBOX_BIN || 'wp-codebox';
const woocommercePath = process.env.HOMEBOY_WC_STRIPE_WOOCOMMERCE_PATH || path.join(process.env.HOME || '', 'Developer/woocommerce/plugins/woocommerce');
const wpVersion = process.env.HOMEBOY_WC_STRIPE_WP_VERSION || '7.0';
const eceLocations = process.env.HOMEBOY_WC_STRIPE_ECE_LOCATIONS || 'product';
const acceptedPaymentMethods = process.env.HOMEBOY_WC_STRIPE_ACCEPTED_PAYMENT_METHODS || 'card,link';
const probeDuration = process.env.HOMEBOY_WC_STRIPE_ECE_PROBE_DURATION || '7s';
const viewport = process.env.HOMEBOY_WC_STRIPE_ECE_VIEWPORT || '1366x900';
const profileOptions = buildEceProfileOptions();

if (!componentPath) {
  throw new Error('HOMEBOY_COMPONENT_PATH is required');
}
if (!resultsFile) {
  throw new Error('HOMEBOY_TRACE_RESULTS_FILE is required');
}
if (!existsSync(path.join(componentPath, 'tests/benchmarks/fixture-bootstrap.php'))) {
  throw new Error('Missing tests/benchmarks/fixture-bootstrap.php in the Stripe checkout. Run against woocommerce-gateway-stripe#5522 or later.');
}
if (!existsSync(path.join(woocommercePath, 'woocommerce.php'))) {
  throw new Error(`Missing WooCommerce dependency plugin at ${woocommercePath}. Set HOMEBOY_WC_STRIPE_WOOCOMMERCE_PATH to a packaged WooCommerce plugin directory.`);
}

await mkdir(artifactDir, { recursive: true });
await mkdir(path.dirname(resultsFile), { recursive: true });

const workDir = await mkdtemp(path.join(tmpdir(), 'wc-stripe-ece-waterfall.'));
const setupFile = path.join(workDir, 'setup.php');
const recipeFile = path.join(workDir, 'recipe.json');
const outputFile = path.join(artifactDir, 'wp-codebox-output.json');
const codeboxArtifacts = path.join(artifactDir, 'wp-codebox-artifacts');
const metricsPath = path.join(artifactDir, 'ece-waterfall-metrics.json');
const metadataPath = path.join(artifactDir, 'ece-waterfall-metadata.json');

const startedAt = performance.now();
const timeline = [];

function timestampMs() {
  return Math.round(performance.now() - startedAt);
}

function event(source, name, data = {}) {
	timeline.push({ t_ms: timestampMs(), source, event: name, data });
}

function csvToJsonArray(value) {
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

async function readJsonAsync(pathname) {
  return existsSync(pathname) ? JSON.parse(await readFile(pathname, 'utf8')) : null;
}

async function readJsonl(pathname) {
  if (!existsSync(pathname)) {
    return [];
  }

  const contents = await readFile(pathname, 'utf8');
  return contents
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function relativeTimingMs(cdpMetrics, metricName) {
  const navigationStart = cdpMetrics.NavigationStart;
  const value = cdpMetrics[metricName];
  if (typeof value !== 'number' || typeof navigationStart !== 'number') {
    return null;
  }

  return Math.round((value - navigationStart) * 1000);
}

function relativeArtifactPath(pathname) {
  return path.relative(artifactDir, pathname);
}

function wpCodeboxCommand() {
  if (wpCodeboxBin.endsWith('.js') || wpCodeboxBin.endsWith('.cjs') || wpCodeboxBin.endsWith('.mjs')) {
    return { command: 'node', args: [wpCodeboxBin] };
  }

  return { command: wpCodeboxBin, args: [] };
}

function numberOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : null;
}

function peakSampleValue(samples, key) {
  if (!Array.isArray(samples)) {
    return null;
  }

  const values = samples.map((sample) => sample?.[key]).filter((value) => typeof value === 'number' && Number.isFinite(value));
  return values.length > 0 ? Math.max(...values) : null;
}

try {
  event('scenario', 'start', {
    component_path: componentPath,
    woocommerce_path: woocommercePath,
    ece_locations: csvToJsonArray(eceLocations),
    accepted_payment_methods: csvToJsonArray(acceptedPaymentMethods),
    browser_profile: profileOptions.profile,
  });

  await writeFile(
    setupFile,
    `<?php
require_once WP_PLUGIN_DIR . '/woocommerce-gateway-stripe/tests/benchmarks/fixture-bootstrap.php';

$ece_locations = json_decode( '${JSON.stringify(csvToJsonArray(eceLocations))}', true );
$accepted_payment_methods = json_decode( '${JSON.stringify(csvToJsonArray(acceptedPaymentMethods))}', true );

$state = WC_Stripe_Benchmark_Fixture_Bootstrap::bootstrap(
	array(
		'ece_locations'            => $ece_locations,
		'accepted_payment_methods' => $accepted_payment_methods,
	)
);

update_option( 'permalink_structure', '/%postname%/' );
flush_rewrite_rules();

if ( ! get_permalink( (int) $state['product_id'] ) ) {
	throw new RuntimeException( 'Could not resolve benchmark product URL.' );
}
`
  );

  const prePageScript = `(() => {
  const state = window.__wcStripeEceRenderProbe = {
    startedAt: performance.now(),
    events: [],
    marks: {},
    samples: [],
  };
  const elapsed = () => Math.round(performance.now() - state.startedAt);
  const record = (name, data = {}) => {
    state.events.push({ name, t_ms: elapsed(), data });
  };
  const mark = (name, data = {}) => {
    if (state.marks[name] === undefined) {
      state.marks[name] = elapsed();
      record(name, data);
    }
  };
  const isVisible = (node) => {
    if (!node || !(node instanceof Element)) {
      return false;
    }
    const style = window.getComputedStyle(node);
    const rect = node.getBoundingClientRect();
    return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
  };
  const sample = () => {
    const container = document.querySelector('#wc-stripe-express-checkout-element');
    if (!container) {
      return;
    }
    mark('container_seen');
    if (isVisible(container)) {
      mark('container_visible');
    }
    const children = Array.from(container.children || []);
    const iframes = Array.from(container.querySelectorAll('iframe'));
    const buttons = Array.from(container.querySelectorAll('button'));
    const visibleIframes = iframes.filter(isVisible);
    const visibleButtons = buttons.filter(isVisible);
    if (children.length > 0) {
      mark('first_child', { child_count: children.length });
    }
    if (iframes.length > 0) {
      mark('first_iframe', { iframe_count: iframes.length });
    }
    if (visibleIframes.length > 0) {
      mark('first_visible_iframe', { visible_iframe_count: visibleIframes.length });
    }
    if (visibleButtons.length > 0) {
      mark('first_visible_button', { visible_button_count: visibleButtons.length });
    }
    state.latest = {
      t_ms: elapsed(),
      child_count: children.length,
      iframe_count: iframes.length,
      visible_iframe_count: visibleIframes.length,
      button_count: buttons.length,
      visible_button_count: visibleButtons.length,
      container_visible: isVisible(container),
    };
    state.samples.push(state.latest);
  };
  const observer = new MutationObserver(sample);
  const observe = () => {
    if (!document.documentElement) {
      window.setTimeout(observe, 0);
      return;
    }
    observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'class', 'height', 'width'] });
    sample();
  };
  window.addEventListener('DOMContentLoaded', () => { record('domcontentloaded'); sample(); }, { once: true });
  window.addEventListener('load', () => { record('load'); sample(); }, { once: true });
  document.addEventListener('transitionend', (event) => {
    const container = document.querySelector('#wc-stripe-express-checkout-element');
    if (container && event.target instanceof Node && container.contains(event.target)) {
      mark('first_transitionend', { property_name: event.propertyName || null });
      sample();
    }
  }, true);
  state.interval = window.setInterval(sample, 50);
  window.setTimeout(() => window.clearInterval(state.interval), 15000);
  observe();
})();`;
  const browserProbeScript = "const probe = window.__wcStripeEceRenderProbe || null; if (probe && probe.interval) { window.clearInterval(probe.interval); } window.__wpCodeboxProbeCheckpoint && window.__wpCodeboxProbeCheckpoint('ece-waterfall-after-wait', { buttons: document.querySelectorAll('#wc-stripe-express-checkout-element iframe, #wc-stripe-express-checkout-element button').length, renderProbe: probe }); return { title: document.title, eceContainer: !!document.querySelector('#wc-stripe-express-checkout-element'), eceChildren: document.querySelectorAll('#wc-stripe-express-checkout-element > div').length, iframes: document.querySelectorAll('iframe').length, renderProbe: probe };";
  const recipe = {
    schema: 'wp-codebox/workspace-recipe/v1',
    runtime: {
      wp: wpVersion,
      ...(profileOptions.runtimePreview ? { preview: profileOptions.runtimePreview } : {}),
      blueprint: {
        steps: [
          { step: 'activatePlugin', pluginPath: '/wordpress/wp-content/plugins/woocommerce/woocommerce.php' },
          { step: 'activatePlugin', pluginPath: '/wordpress/wp-content/plugins/woocommerce-gateway-stripe/woocommerce-gateway-stripe.php' },
        ],
      },
    },
    inputs: {
      extraPlugins: [
        { source: woocommercePath, slug: 'woocommerce', activate: true },
        { source: componentPath, slug: 'woocommerce-gateway-stripe', pluginFile: 'woocommerce-gateway-stripe/woocommerce-gateway-stripe.php', activate: true },
      ],
    },
    workflow: {
      steps: [
        { command: 'wordpress.run-php', args: [`code-file=${setupFile}`] },
        {
          command: 'wordpress.browser-probe',
          args: [
            'url=/?product=stripe-benchmark-product',
            'wait-for=networkidle',
            `duration=${probeDuration}`,
            `viewport=${viewport}`,
            ...profileOptions.browserProbeArgs,
            'capture=console,errors,html,network,performance,memory,screenshot',
            `pre-page-script=${prePageScript}`,
            `script=${browserProbeScript}`,
          ],
        },
      ],
    },
    artifacts: { directory: codeboxArtifacts },
  };

  await writeFile(recipeFile, `${JSON.stringify(recipe, null, 2)}\n`);

  event('wp_codebox', 'recipe.start', { recipe_file: recipeFile });
  const { command, args } = wpCodeboxCommand();
  const result = await execFileAsync(command, [...args, 'recipe-run', '--recipe', recipeFile, '--artifacts', codeboxArtifacts, ...profileOptions.recipeRunArgs, '--json'], {
    maxBuffer: 1024 * 1024 * 50,
  });
  await writeFile(outputFile, result.stdout);
  event('wordpress', 'fixture.ready');

  const output = JSON.parse(result.stdout);
  const bundleDir = output.artifacts?.directory;
  const browserDir = bundleDir ? path.join(bundleDir, 'files', 'browser') : '';
  const networkPath = browserDir ? path.join(browserDir, 'network.jsonl') : '';
  const summaryPath = browserDir ? path.join(browserDir, 'summary.json') : '';
  const performancePath = browserDir ? path.join(browserDir, 'performance.json') : '';
  const network = await readJsonl(networkPath);
  const responses = network.filter((entry) => entry.type === 'response');
  const urls = responses.map((entry) => entry.url || entry.request?.url || '').filter(Boolean);
  const stripeUrls = urls.filter((url) => /(^|\.)stripe\.com|stripe\.network/.test(url));
  const googleUrls = urls.filter((url) => /(^|\.)google\.com|(^|\.)gstatic\.com|googleapis\.com/.test(url));
  const iframeResponses = responses.filter((entry) => (entry.resourceType || entry.request?.resourceType) === 'iframe');
  const summary = await readJsonAsync(summaryPath);
  const performanceSummary = await readJsonAsync(performancePath);
  const browserMetrics = summary?.summary?.metrics ?? {};
  const cdpMetrics = performanceSummary?.final?.cdpMetrics ?? {};
  const scriptResult = summary?.summary?.scriptResult || summary?.scriptResult || {};
  const renderProbe = scriptResult?.renderProbe || {};
  const renderMarks = renderProbe?.marks || {};
  const renderLatest = renderProbe?.latest || {};
  const renderSamples = renderProbe?.samples || [];

  event('browser', 'probe.ready', {
    total_responses: responses.length,
    stripe_responses: stripeUrls.length,
  });

  const metrics = {
    network_response_count: responses.length,
    stripe_response_count: stripeUrls.length,
    google_response_count: googleUrls.length,
    iframe_response_count: iframeResponses.length,
    browser_probe_duration_ms: summary?.durationMs ?? null,
    browser_dom_content_loaded_ms: relativeTimingMs(cdpMetrics, 'DomContentLoaded'),
    browser_first_meaningful_paint_ms: relativeTimingMs(cdpMetrics, 'FirstMeaningfulPaint'),
    browser_iframe_count: browserMetrics.browser_iframe_count ?? null,
    browser_resource_count: browserMetrics.browser_resource_count ?? performanceSummary?.summary?.resources ?? null,
    browser_transfer_size_bytes: browserMetrics.browser_transfer_size_bytes ?? performanceSummary?.summary?.transferSizeBytes ?? null,
    browser_long_task_count: browserMetrics.browser_long_task_count ?? performanceSummary?.final?.longTasks?.count ?? null,
    browser_long_task_total_ms: browserMetrics.browser_long_task_total_ms ?? performanceSummary?.final?.longTasks?.totalDurationMs ?? null,
    browser_long_task_max_ms: performanceSummary?.final?.longTasks?.maxDurationMs ?? null,
    browser_final_used_js_heap_bytes: browserMetrics.browser_final_used_js_heap_bytes ?? cdpMetrics.JSHeapUsedSize ?? null,
    browser_peak_used_js_heap_bytes: browserMetrics.browser_peak_used_js_heap_bytes ?? performanceSummary?.peak?.cdpMetrics?.JSHeapUsedSize?.peak ?? null,
    browser_dom_node_count: browserMetrics.browser_dom_node_count ?? performanceSummary?.final?.dom?.nodes ?? null,
    browser_document_count: performanceSummary?.final?.dom?.documents ?? null,
    browser_js_event_listener_count: cdpMetrics.JSEventListeners ?? null,
    ece_render_container_seen_ms: numberOrNull(renderMarks.container_seen),
    ece_render_container_visible_ms: numberOrNull(renderMarks.container_visible),
    ece_render_first_child_ms: numberOrNull(renderMarks.first_child),
    ece_render_first_iframe_ms: numberOrNull(renderMarks.first_iframe),
    ece_render_first_visible_iframe_ms: numberOrNull(renderMarks.first_visible_iframe),
    ece_render_first_visible_button_ms: numberOrNull(renderMarks.first_visible_button),
    ece_render_first_transitionend_ms: numberOrNull(renderMarks.first_transitionend),
    ece_render_peak_child_count: peakSampleValue(renderSamples, 'child_count'),
    ece_render_peak_iframe_count: peakSampleValue(renderSamples, 'iframe_count'),
    ece_render_peak_visible_iframe_count: peakSampleValue(renderSamples, 'visible_iframe_count'),
    ece_render_peak_button_count: peakSampleValue(renderSamples, 'button_count'),
    ece_render_peak_visible_button_count: peakSampleValue(renderSamples, 'visible_button_count'),
    ece_render_final_child_count: renderLatest.child_count ?? null,
    ece_render_final_iframe_count: renderLatest.iframe_count ?? null,
    ece_render_final_visible_iframe_count: renderLatest.visible_iframe_count ?? null,
    ece_render_final_button_count: renderLatest.button_count ?? null,
    ece_render_final_visible_button_count: renderLatest.visible_button_count ?? null,
  };

  await writeFile(metricsPath, `${JSON.stringify(metrics, null, 2)}\n`);
  await writeFile(
    metadataPath,
    `${JSON.stringify(
      {
        final_url: summary?.summary?.finalUrl || summary?.finalUrl || null,
        browser_profile: profileOptions.profile,
        runtime_preview: profileOptions.runtimePreview,
        browser_probe_args: profileOptions.browserProbeArgs,
        stripe_urls_sample: stripeUrls.slice(0, 20),
        google_urls_sample: googleUrls.slice(0, 20),
        browser_script_result: scriptResult,
        render_probe_events: Array.isArray(renderProbe.events) ? renderProbe.events.slice(0, 100) : [],
      },
      null,
      2
    )}\n`
  );
  event('waterfall', 'metrics.ready', metrics);

  const pass = output.success === true && stripeUrls.length > 0;
  const traceResult = {
    component_id: componentId,
    scenario_id: scenarioId,
    status: pass ? 'pass' : 'fail',
    summary: pass
      ? `Captured Stripe ECE product-page browser waterfall: ${stripeUrls.length} Stripe responses across ${responses.length} total responses.`
      : 'Browser waterfall capture did not observe Stripe network responses.',
    timeline,
    assertions: [
      {
        id: 'stripe-network-observed',
        status: stripeUrls.length > 0 ? 'pass' : 'fail',
        message: `Observed ${stripeUrls.length} Stripe/stripe.network responses.`,
      },
      {
        id: 'network-response-count',
        status: responses.length > 0 ? 'pass' : 'fail',
        message: `Observed ${responses.length} total network responses.`,
      },
    ],
    artifacts: [
      { label: 'WP Codebox output', path: relativeArtifactPath(outputFile) },
      { label: 'Waterfall metrics', path: relativeArtifactPath(metricsPath) },
      { label: 'Waterfall metadata', path: relativeArtifactPath(metadataPath) },
      ...(summaryPath && existsSync(summaryPath) ? [{ label: 'Browser summary', path: relativeArtifactPath(summaryPath) }] : []),
      ...(networkPath && existsSync(networkPath) ? [{ label: 'Browser network log', path: relativeArtifactPath(networkPath) }] : []),
      ...(performancePath && existsSync(performancePath) ? [{ label: 'Browser performance', path: relativeArtifactPath(performancePath) }] : []),
    ],
  };

  await writeFile(resultsFile, `${JSON.stringify(traceResult, null, 2)}\n`);
  process.exitCode = pass ? 0 : 1;
} catch (error) {
  const traceResult = {
    component_id: componentId,
    scenario_id: scenarioId,
    status: 'fail',
    summary: error instanceof Error ? error.message : String(error),
    timeline,
    assertions: [
      {
        id: 'trace-workload-completed',
        status: 'fail',
        message: error instanceof Error ? error.message : String(error),
      },
    ],
    artifacts: existsSync(outputFile) ? [{ label: 'WP Codebox output', path: relativeArtifactPath(outputFile) }] : [],
  };

  await writeFile(resultsFile, `${JSON.stringify(traceResult, null, 2)}\n`);
  throw error;
} finally {
  await rm(workDir, { recursive: true, force: true });
}
