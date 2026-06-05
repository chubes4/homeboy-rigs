import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

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

try {
  event('scenario', 'start', {
    component_path: componentPath,
    woocommerce_path: woocommercePath,
    ece_locations: csvToJsonArray(eceLocations),
    accepted_payment_methods: csvToJsonArray(acceptedPaymentMethods),
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

  const browserProbeScript = "window.__wpCodeboxProbeCheckpoint && window.__wpCodeboxProbeCheckpoint('ece-waterfall-after-wait', { buttons: document.querySelectorAll('#wc-stripe-express-checkout-element iframe, #wc-stripe-express-checkout-element button').length }); return { title: document.title, eceContainer: !!document.querySelector('#wc-stripe-express-checkout-element'), eceChildren: document.querySelectorAll('#wc-stripe-express-checkout-element > div').length, iframes: document.querySelectorAll('iframe').length };";
  const recipe = {
    schema: 'wp-codebox/workspace-recipe/v1',
    runtime: {
      wp: wpVersion,
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
            'capture=console,errors,html,network,performance,memory,screenshot',
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
  const result = await execFileAsync(command, [...args, 'recipe-run', '--recipe', recipeFile, '--artifacts', codeboxArtifacts, '--json'], {
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
  };

  await writeFile(metricsPath, `${JSON.stringify(metrics, null, 2)}\n`);
  await writeFile(
    metadataPath,
    `${JSON.stringify(
      {
        final_url: summary?.summary?.finalUrl || summary?.finalUrl || null,
        stripe_urls_sample: stripeUrls.slice(0, 20),
        google_urls_sample: googleUrls.slice(0, 20),
        browser_script_result: summary?.summary?.scriptResult || summary?.scriptResult || null,
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
