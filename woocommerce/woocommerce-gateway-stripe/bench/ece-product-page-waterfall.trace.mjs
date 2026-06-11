import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { buildEceProfileOptions } from './ece-product-page-profile.mjs';
import { evaluateEceFixtureHealth, fixtureHealthSummary } from './ece-product-page-fixture-health.mjs';
import { DEFAULT_ECE_SCENARIO_ID, eceInteractionScript, eceLayoutScript, eceProductPageScenario, eceSimulatedClsScript } from './ece-product-page-scenarios.mjs';

const execFileAsync = promisify(execFile);

const componentPath = process.env.HOMEBOY_COMPONENT_PATH;
const componentId = process.env.HOMEBOY_COMPONENT_ID || 'woocommerce-gateway-stripe';
const scenarioId = process.env.HOMEBOY_TRACE_SCENARIO || DEFAULT_ECE_SCENARIO_ID;
const scenario = eceProductPageScenario(scenarioId);
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
const encodedStripePublishableKey = profileOptions.stripePublishableKey ? Buffer.from(profileOptions.stripePublishableKey).toString('base64') : '';
const encodedStripeSecretKey = profileOptions.stripeSecretKey ? Buffer.from(profileOptions.stripeSecretKey).toString('base64') : '';
const traceHelperDir = process.env.HOMEBOY_TRACE_HELPER_DIR;
const fixtureBootstrapPath = fileURLToPath(new URL('./fixture-bootstrap.php', import.meta.url));

if (!componentPath) {
  throw new Error('HOMEBOY_COMPONENT_PATH is required');
}
if (!resultsFile) {
  throw new Error('HOMEBOY_TRACE_RESULTS_FILE is required');
}
if (!traceHelperDir) {
  throw new Error('HOMEBOY_TRACE_HELPER_DIR is required');
}
if (!existsSync(fixtureBootstrapPath)) {
  throw new Error(`Missing rig-owned Stripe fixture bootstrap at ${fixtureBootstrapPath}`);
}
if (!existsSync(path.join(woocommercePath, 'woocommerce.php'))) {
  throw new Error(`Missing WooCommerce dependency plugin at ${woocommercePath}. Set HOMEBOY_WC_STRIPE_WOOCOMMERCE_PATH to a packaged WooCommerce plugin directory.`);
}

const fixtureBootstrapSource = (await readFile(fixtureBootstrapPath, 'utf8'))
  .replace(/^<\?php\s*/, '')
  .replace(/^\s*declare\(strict_types=1\);\s*/m, '');

process.env.HOMEBOY_TRACE_ARTIFACT_DIR ||= artifactDir;
const { createTraceReporter } = await import(pathToFileURL(path.join(traceHelperDir, 'timeline.mjs')).href);
const trace = createTraceReporter({
  componentId,
  scenarioId,
  resultsFile,
});
trace.recorder.timestampMs = () => Math.round(performance.now() - trace.recorder.start);

await mkdir(artifactDir, { recursive: true });
await mkdir(path.dirname(resultsFile), { recursive: true });

const workDir = await mkdtemp(path.join(tmpdir(), 'wc-stripe-ece-waterfall.'));
const setupFile = path.join(workDir, 'setup.php');
const recipeFile = path.join(workDir, 'recipe.json');
const outputFile = path.join(artifactDir, 'wp-codebox-output.json');
const codeboxArtifacts = path.join(artifactDir, 'wp-codebox-artifacts');
const metricsPath = path.join(artifactDir, 'ece-waterfall-metrics.json');
const metadataPath = path.join(artifactDir, 'ece-waterfall-metadata.json');
const fixtureHealthPath = path.join(artifactDir, 'ece-fixture-health.json');

function event(source, name, data = {}) {
  return trace.mark(name, data, source);
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

async function findBrowserHtmlPath(directory) {
  if (!directory || !existsSync(directory)) {
    return '';
  }

  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const pathname = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      const nested = await findBrowserHtmlPath(pathname);
      if (nested) {
        return nested;
      }
      continue;
    }

    if (/\.html?$/i.test(entry.name)) {
      return pathname;
    }
  }

  return '';
}

async function readTextIfSmall(pathname, maxBytes = 1024 * 1024 * 5) {
  if (!pathname || !existsSync(pathname)) {
    return '';
  }

  const fileStat = await stat(pathname);
  if (fileStat.size > maxBytes) {
    return '';
  }

  return readFile(pathname, 'utf8');
}

function relativeTimingMs(cdpMetrics, metricName) {
  const navigationStart = cdpMetrics.NavigationStart;
  const value = cdpMetrics[metricName];
  if (typeof value !== 'number' || typeof navigationStart !== 'number') {
    return null;
  }

  return Math.round((value - navigationStart) * 1000);
}

function wpCodeboxCommand() {
  if (wpCodeboxBin.endsWith('.js') || wpCodeboxBin.endsWith('.cjs') || wpCodeboxBin.endsWith('.mjs')) {
    return { command: 'node', args: [wpCodeboxBin] };
  }

  return { command: wpCodeboxBin, args: [] };
}

async function prepareStripePlugin(pathname) {
  const autoloadPath = path.join(pathname, 'vendor/autoload.php');
  if (existsSync(autoloadPath)) {
    event('fixture', 'stripe_plugin.prepare.skipped', { reason: 'autoload_exists' });
    return;
  }

  if (!existsSync(path.join(pathname, 'composer.json'))) {
    throw new Error(`Missing Composer metadata in Stripe plugin checkout at ${pathname}; cannot prepare autoloader for WP Codebox activation.`);
  }

  event('fixture', 'stripe_plugin.prepare.start', { path: pathname });
  await execFileAsync('composer', ['install', '--no-interaction', '--no-progress', '--no-dev', '--classmap-authoritative'], {
    cwd: pathname,
    maxBuffer: 1024 * 1024 * 20,
  });
  event('fixture', 'stripe_plugin.prepare.done', { path: pathname });
}

function numberOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : null;
}

function parseViewport(value) {
  const match = /^(\d+)x(\d+)$/.exec(value || '');
  if (!match) {
    return null;
  }

  return {
    width: Number.parseInt(match[1], 10),
    height: Number.parseInt(match[2], 10),
  };
}

function peakSampleValue(samples, key) {
  if (!Array.isArray(samples)) {
    return null;
  }

  const values = samples.map((sample) => sample?.[key]).filter((value) => typeof value === 'number' && Number.isFinite(value));
  return values.length > 0 ? Math.max(...values) : null;
}

function stripeElementsSessionResponses(networkEntries) {
  return networkEntries.filter((entry) => {
    const url = entry.url || entry.request?.url || '';
    return /api\.stripe\.com\/v1\/elements\/sessions/.test(url);
  });
}

function responseStatus(entry) {
  return entry.status ?? entry.response?.status ?? entry.responseStatus ?? null;
}

function stripeLoadMessages(messages) {
  return messages.filter((entry) => /stripe|express checkout|paymentrequest|apple pay|google pay/i.test(JSON.stringify(entry)));
}

function roundedNumberOrNull(value, places = 4) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return null;
  }

  const multiplier = 10 ** places;
  return Math.round(value * multiplier) / multiplier;
}

try {
  event('scenario', 'start', {
    component_path: componentPath,
    woocommerce_path: woocommercePath,
    ece_locations: csvToJsonArray(eceLocations),
    accepted_payment_methods: csvToJsonArray(acceptedPaymentMethods),
    ece_scenario_profile: scenario.profile,
    ece_interaction: scenario.interaction,
    browser_profile: profileOptions.profile,
    browser_profile_label: profileOptions.profileLabel,
    browser_profile_caveat: profileOptions.profileCaveat,
    browser_wait_for: profileOptions.waitFor || scenario.waitFor || 'networkidle',
    browser_throttle_profile: profileOptions.throttleProfile,
    real_wallet_capable: profileOptions.realWalletCapable,
    synthetic_only: profileOptions.syntheticOnly,
  });

  await prepareStripePlugin(componentPath);

  await writeFile(
    setupFile,
    `<?php
${fixtureBootstrapSource}

$ece_locations = json_decode( '${JSON.stringify(csvToJsonArray(eceLocations))}', true );
$accepted_payment_methods = json_decode( '${JSON.stringify(csvToJsonArray(acceptedPaymentMethods))}', true );

$state = Homeboy_WC_Stripe_Benchmark_Fixture_Bootstrap::bootstrap(
	array(
		'ece_locations'            => $ece_locations,
		'accepted_payment_methods' => $accepted_payment_methods,
	)
);

if ( ${profileOptions.realWalletCapable ? 'true' : 'false'} ) {
	$stripe_settings = get_option( 'woocommerce_stripe_settings', array() );
	if ( ! is_array( $stripe_settings ) ) {
		$stripe_settings = array();
	}
	$stripe_settings['enabled']              = 'yes';
	$stripe_settings['testmode']             = 'yes';
	$stripe_settings['test_publishable_key'] = base64_decode( '${encodedStripePublishableKey}', true );
	$stripe_settings['test_secret_key']      = base64_decode( '${encodedStripeSecretKey}', true );
	update_option( 'woocommerce_stripe_settings', $stripe_settings );
}

$mu_plugin_dir = WP_CONTENT_DIR . '/mu-plugins';
if ( ! is_dir( $mu_plugin_dir ) && ! wp_mkdir_p( $mu_plugin_dir ) ) {
	throw new RuntimeException( 'Could not create mu-plugins directory for Stripe benchmark fixture.' );
}

file_put_contents(
	$mu_plugin_dir . '/homeboy-stripe-ece-fixture-dependencies.php',
	'<?php
add_action(
	"wp_enqueue_scripts",
	function () {
		if ( function_exists( "is_product" ) && is_product() ) {
			wp_enqueue_script( "wc-settings" );
		}
	},
	20
);
add_action(
	"wp_head",
	function () {
		if ( ! function_exists( "is_product" ) || ! is_product() ) {
			return;
		}
		?>
<script id="homeboy-stripe-ece-wc-settings-shim">
window.wc = window.wc || {};
window.wcSettings = window.wcSettings || {};
window.wc.wcSettings = window.wc.wcSettings || {
	getSetting: function( name, defaultValue ) {
		return Object.prototype.hasOwnProperty.call( window.wcSettings, name ) ? window.wcSettings[ name ] : defaultValue;
	}
};
</script>
		<?php
	},
	0
);
'
);

update_option( 'permalink_structure', '/%postname%/' );
flush_rewrite_rules();

if ( ! get_permalink( (int) $state['product_id'] ) ) {
	throw new RuntimeException( 'Could not resolve benchmark product URL.' );
}
`
  );

  const prePageScript = `(() => {
  ${eceLayoutScript(scenario)}
  ${eceSimulatedClsScript(scenario)}
  const state = window.__wcStripeEceRenderProbe = {
    startedAt: performance.now(),
    events: [],
    marks: {},
    samples: [],
    cls: 0,
    layoutShifts: [],
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
  const selectorForNode = (node) => {
    if (!node || !(node instanceof Element)) {
      return null;
    }
    if (node.id) {
      return '#' + node.id;
    }
    const className = Array.from(node.classList || []).slice(0, 3).join('.');
    return node.tagName.toLowerCase() + (className ? '.' + className : '');
  };
  const rectForNode = (node) => {
    if (!node || !(node instanceof Element)) {
      return null;
    }
    const rect = node.getBoundingClientRect();
    return {
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    };
  };
  const trackedContainerMetrics = () => {
    const root = document.querySelector('#wc-stripe-express-checkout-element');
    const grouped = document.querySelector('#wc-stripe-express-checkout-element-wallets-link');
    const sentinel = document.querySelector('.homeboy-stripe-ece-cls-sentinel');
    return {
      ece_container_height: rectForNode(root)?.height ?? 0,
      ece_container_rect: rectForNode(root),
      ece_wallets_link_height: rectForNode(grouped)?.height ?? 0,
      ece_wallets_link_rect: rectForNode(grouped),
      ece_cls_sentinel_rect: rectForNode(sentinel),
    };
  };
  try {
    const layoutShiftObserver = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (entry.hadRecentInput) {
          continue;
        }
        const sources = Array.from(entry.sources || []).map((source) => ({
          selector: selectorForNode(source.node),
          current_rect: source.currentRect
            ? { x: Math.round(source.currentRect.x), y: Math.round(source.currentRect.y), width: Math.round(source.currentRect.width), height: Math.round(source.currentRect.height) }
            : null,
          previous_rect: source.previousRect
            ? { x: Math.round(source.previousRect.x), y: Math.round(source.previousRect.y), width: Math.round(source.previousRect.width), height: Math.round(source.previousRect.height) }
            : null,
        }));
        state.cls += entry.value;
        state.layoutShifts.push({
          t_ms: elapsed(),
          value: entry.value,
          sources,
          tracked_containers: trackedContainerMetrics(),
        });
        record('layout_shift', { value: entry.value, sources, tracked_containers: trackedContainerMetrics() });
      }
    });
    layoutShiftObserver.observe({ type: 'layout-shift', buffered: true });
    state.layoutShiftObserver = layoutShiftObserver;
  } catch (error) {
    record('layout_shift_observer_unavailable', { message: error?.message || String(error) });
  }
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
      ...trackedContainerMetrics(),
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
  const browserProbeScript = `
    const probe = window.__wcStripeEceRenderProbe || null;
    const interactionEvents = [];
    const sleep = (ms) => new Promise((resolve) => window.setTimeout(resolve, ms));
    const elapsed = () => probe?.startedAt ? Math.round(performance.now() - probe.startedAt) : null;
    const sample = () => {
      const container = document.querySelector('#wc-stripe-express-checkout-element');
      const isVisible = (node) => {
        if (!node || !(node instanceof Element)) {
          return false;
        }
        const style = window.getComputedStyle(node);
        const rect = node.getBoundingClientRect();
        return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
      };
      if (!container) {
        return {
          ece_container: false,
          ece_child_count: 0,
          ece_iframe_count: 0,
          ece_visible_iframe_count: 0,
          ece_button_count: 0,
          ece_visible_button_count: 0,
        };
      }
      const iframes = Array.from(container.querySelectorAll('iframe'));
      const buttons = Array.from(container.querySelectorAll('button'));
      return {
        ece_container: true,
        ece_child_count: container.children?.length || 0,
        ece_iframe_count: iframes.length,
        ece_visible_iframe_count: iframes.filter(isVisible).length,
        ece_button_count: buttons.length,
        ece_visible_button_count: buttons.filter(isVisible).length,
      };
    };
    const interactionSnapshot = (name) => {
      interactionEvents.push({ name, t_ms: elapsed(), ...sample() });
    };
    ${eceInteractionScript(scenario)}
    if (probe && probe.interval) {
      window.clearInterval(probe.interval);
    }
    if (probe && probe.layoutShiftObserver) {
      probe.layoutShiftObserver.disconnect();
      delete probe.layoutShiftObserver;
    }
    const finalSnapshot = sample();
    const stripeAvailability = {
      paymentRequestSupported: typeof window.PaymentRequest === 'function',
      applePaySessionSupported: typeof window.ApplePaySession === 'function',
      securePaymentConfirmationSupported: typeof window.SecurePaymentConfirmationRequest === 'function',
    };
    window.__wpCodeboxProbeCheckpoint && window.__wpCodeboxProbeCheckpoint('ece-waterfall-after-wait', {
      scenario: ${JSON.stringify(scenario.id)},
      interaction: ${JSON.stringify(scenario.interaction)},
      buttons: document.querySelectorAll('#wc-stripe-express-checkout-element iframe, #wc-stripe-express-checkout-element button').length,
      interactionEvents,
      renderProbe: probe,
      stripeAvailability,
    });
    return {
      title: document.title,
      locationHref: window.location.href,
      scenario: ${JSON.stringify(scenario.id)},
      interaction: ${JSON.stringify(scenario.interaction)},
      interactionEvents,
      isSecureContext: window.isSecureContext === true,
      locationOrigin: window.location.origin,
      userAgent: navigator.userAgent,
      eceContainer: !!document.querySelector('#wc-stripe-express-checkout-element'),
      eceChildren: document.querySelectorAll('#wc-stripe-express-checkout-element > div').length,
      iframes: document.querySelectorAll('iframe').length,
      finalSnapshot,
      stripeAvailability,
      fixtureHealth: {
        hasCartForm: !!document.querySelector('form.cart'),
        hasSummary: !!document.querySelector('.summary'),
        hasAddToCartButton: !!document.querySelector('form.cart button[type="submit"], form.cart .single_add_to_cart_button'),
        hasStripeParams: typeof window.wc_stripe_express_checkout_params === 'object' && window.wc_stripe_express_checkout_params !== null,
        productTitle: document.querySelector('h1.product_title, .product_title, h1')?.textContent?.trim() || '',
        productTitleMatches: /stripe benchmark product/i.test(document.querySelector('h1.product_title, .product_title, h1')?.textContent || ''),
        hasBelowFoldLayout: !!document.querySelector('#homeboy-ece-below-fold-layout'),
      },
      renderProbe: probe,
    };
  `;
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
      extra_plugins: [
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
            'url=/?post_type=product&name=stripe-benchmark-product',
            `wait-for=${profileOptions.waitFor || scenario.waitFor || 'networkidle'}`,
            `duration=${probeDuration}`,
            `viewport=${viewport}`,
            ...profileOptions.browserProbeArgs,
            ...profileOptions.browserProbeAssertions,
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
  const consolePath = browserDir ? path.join(browserDir, 'console.jsonl') : '';
  const errorsPath = browserDir ? path.join(browserDir, 'errors.jsonl') : '';
  const htmlPath = await findBrowserHtmlPath(browserDir);
  const network = await readJsonl(networkPath);
  const consoleMessages = await readJsonl(consolePath);
  const pageErrors = await readJsonl(errorsPath);
  const responses = network.filter((entry) => entry.type === 'response');
  const urls = responses.map((entry) => entry.url || entry.request?.url || '').filter(Boolean);
  const stripeUrls = urls.filter((url) => /(^|\.)stripe\.com|stripe\.network/.test(url));
  const elementsSessionResponses = stripeElementsSessionResponses(responses);
  const elementsSessionStatuses = elementsSessionResponses.map(responseStatus).filter((status) => status !== null);
  const googleUrls = urls.filter((url) => /(^|\.)google\.com|(^|\.)gstatic\.com|googleapis\.com/.test(url));
  const iframeResponses = responses.filter((entry) => (entry.resourceType || entry.request?.resourceType) === 'iframe');
  const summary = await readJsonAsync(summaryPath);
  const html = await readTextIfSmall(htmlPath);
  const performanceSummary = await readJsonAsync(performancePath);
  const browserMetrics = summary?.summary?.metrics ?? {};
  const cdpMetrics = performanceSummary?.final?.cdpMetrics ?? {};
  const scriptResult = summary?.summary?.scriptResult || summary?.scriptResult || {};
  const renderProbe = scriptResult?.renderProbe || {};
  const renderMarks = renderProbe?.marks || {};
  const renderLatest = renderProbe?.latest || {};
  const renderSamples = renderProbe?.samples || [];
  const layoutShifts = Array.isArray(renderProbe?.layoutShifts) ? renderProbe.layoutShifts : [];
  const layoutShiftSourceDetails = layoutShifts.flatMap((entry) =>
    Array.isArray(entry.sources)
      ? entry.sources.map((source) => ({
          t_ms: entry.t_ms ?? null,
          value: roundedNumberOrNull(entry.value),
          selector: source.selector ?? null,
          previous_rect: source.previous_rect ?? null,
          current_rect: source.current_rect ?? null,
        }))
      : []
  );
  const requestedViewport = parseViewport(viewport);
  const effectiveViewport = summary?.viewport || summary?.summary?.viewport || null;
  const interactionEvents = Array.isArray(scriptResult?.interactionEvents) ? scriptResult.interactionEvents : [];
  const interactionSucceeded = scenario.interaction === 'load-only' || interactionEvents.some((entry) => entry?.ok === true);
  const stripeLoadConsoleMessages = stripeLoadMessages(consoleMessages);
  const stripeLoadPageErrors = stripeLoadMessages(pageErrors);
  const finalVisibleButtonCount = scriptResult?.finalSnapshot?.ece_visible_button_count ?? renderLatest.visible_button_count ?? 0;
  const eceRenderedVisibleButton = finalVisibleButtonCount > 0 || peakSampleValue(renderSamples, 'visible_button_count') > 0;
  const fixtureHealth = evaluateEceFixtureHealth({
    html,
    htmlPath,
    summaryPath,
    consolePath,
    errorsPath,
    summary,
    consoleMessages,
    pageErrors,
    scriptResult,
    scenario,
    profileOptions,
  });

  event('browser', 'probe.ready', {
    total_responses: responses.length,
    stripe_responses: stripeUrls.length,
  });

  const metrics = {
    browser_profile: profileOptions.profile,
    browser_profile_label: profileOptions.profileLabel,
    browser_profile_caveat: profileOptions.profileCaveat,
    browser_profile_conclusion: profileOptions.profileConclusion,
    browser_wait_for: profileOptions.waitFor || scenario.waitFor || 'networkidle',
    browser_throttle_profile: profileOptions.throttleProfile,
    network_response_count: responses.length,
    stripe_response_count: stripeUrls.length,
    google_response_count: googleUrls.length,
    iframe_response_count: iframeResponses.length,
    console_message_count: consoleMessages.length,
    page_error_count: pageErrors.length,
    browser_probe_duration_ms: summary?.durationMs ?? null,
    browser_requested_viewport_width: requestedViewport?.width ?? null,
    browser_requested_viewport_height: requestedViewport?.height ?? null,
    browser_effective_viewport_width: effectiveViewport?.width ?? null,
    browser_effective_viewport_height: effectiveViewport?.height ?? null,
    browser_secure_context_effective: scriptResult?.isSecureContext === true,
    browser_cls: roundedNumberOrNull(renderProbe.cls),
    browser_layout_shift_count: layoutShifts.length,
    ece_real_wallet_capable: profileOptions.realWalletCapable,
    ece_synthetic_only: profileOptions.syntheticOnly,
    ece_rendered_visible_button: eceRenderedVisibleButton,
    stripe_elements_session_response_count: elementsSessionResponses.length,
    stripe_elements_session_status: elementsSessionStatuses[0] ?? null,
    stripe_elements_session_error_count: elementsSessionStatuses.filter((status) => status >= 400).length,
    stripe_load_console_message_count: stripeLoadConsoleMessages.length,
    stripe_load_page_error_count: stripeLoadPageErrors.length,
    stripe_payment_request_supported: scriptResult?.stripeAvailability?.paymentRequestSupported === true,
    stripe_apple_pay_session_supported: scriptResult?.stripeAvailability?.applePaySessionSupported === true,
    stripe_secure_payment_confirmation_supported: scriptResult?.stripeAvailability?.securePaymentConfirmationSupported === true,
    browser_nav_duration_ms: browserMetrics.browser_nav_duration_ms ?? performanceSummary?.final?.navigation?.durationMs ?? null,
    browser_dom_content_loaded_ms: browserMetrics.browser_dom_content_loaded_ms ?? relativeTimingMs(cdpMetrics, 'DomContentLoaded'),
    browser_load_event_ms: browserMetrics.browser_load_event_ms ?? performanceSummary?.final?.navigation?.loadEventMs ?? null,
    browser_ttfb_ms: browserMetrics.browser_ttfb_ms ?? performanceSummary?.final?.navigation?.ttfbMs ?? null,
    browser_fcp_ms: browserMetrics.browser_fcp_ms ?? performanceSummary?.final?.paint?.firstContentfulPaintMs ?? null,
    browser_lcp_ms: browserMetrics.browser_lcp_ms ?? performanceSummary?.final?.paint?.largestContentfulPaintMs ?? null,
    browser_lcp_size: browserMetrics.browser_lcp_size ?? performanceSummary?.final?.paint?.largestContentfulPaintSize ?? null,
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
    ece_render_final_container_height: numberOrNull(renderLatest.ece_container_height),
    ece_render_final_wallets_link_height: numberOrNull(renderLatest.ece_wallets_link_height),
    ece_interaction_event_count: interactionEvents.length,
    ece_interaction_succeeded: interactionSucceeded,
    ece_fixture_health_passed: fixtureHealth.ok,
    ece_fixture_health_failure_count: fixtureHealth.failures.length,
  };

  await writeFile(fixtureHealthPath, `${JSON.stringify(fixtureHealth, null, 2)}\n`);
  trace.artifact({ label: 'Fixture health', path: fixtureHealthPath });

  await writeFile(metricsPath, `${JSON.stringify(metrics, null, 2)}\n`);
  trace.artifact({ label: 'Waterfall metrics', path: metricsPath });
  await writeFile(
    metadataPath,
    `${JSON.stringify(
      {
        final_url: summary?.summary?.finalUrl || summary?.finalUrl || null,
        scenario: {
          id: scenario.id,
          profile: scenario.profile,
          interaction: scenario.interaction,
          description: scenario.description,
        },
        browser_profile: profileOptions.profile,
        browser_profile_label: profileOptions.profileLabel,
        browser_profile_caveat: profileOptions.profileCaveat,
        browser_profile_conclusion: profileOptions.profileConclusion,
        requested_browser_context: {
          viewport,
          browser_profile: profileOptions.profile,
          wait_for: profileOptions.waitFor || scenario.waitFor || 'networkidle',
          throttle_profile: profileOptions.throttleProfile,
          runtime_preview: profileOptions.runtimePreview,
          browser_probe_args: profileOptions.browserProbeArgs,
          secure_context_profile: ['secure-browser', 'real-wallet'].includes(profileOptions.profile),
          real_wallet_capable: profileOptions.realWalletCapable,
          synthetic_only: profileOptions.syntheticOnly,
          required_env: profileOptions.realWalletCapable ? ['STRIPE_PUBLISHABLE_KEY', 'STRIPE_SECRET_KEY', 'HOMEBOY_WC_STRIPE_ECE_PREVIEW_PUBLIC_URL'] : [],
        },
        effective_browser_context: {
          viewport: effectiveViewport,
          is_secure_context: scriptResult?.isSecureContext === true,
          location_origin: scriptResult?.locationOrigin || null,
          user_agent: scriptResult?.userAgent || null,
        },
        stripe_urls_sample: stripeUrls.slice(0, 20),
        stripe_elements_session: {
          response_count: elementsSessionResponses.length,
          statuses: elementsSessionStatuses,
        },
        stripe_load_console_messages_sample: stripeLoadConsoleMessages.slice(0, 20),
        stripe_load_page_errors_sample: stripeLoadPageErrors.slice(0, 20),
        google_urls_sample: googleUrls.slice(0, 20),
        console_messages_sample: consoleMessages.slice(0, 20),
        page_errors_sample: pageErrors.slice(0, 20),
        fixture_health: fixtureHealth,
        browser_script_result: scriptResult,
        pass_conditions: {
          network_path_exists: existsSync(networkPath),
          performance_path_exists: existsSync(performancePath),
          response_count: responses.length,
          stripe_response_count: stripeUrls.length,
        },
        interaction_events: interactionEvents,
        render_probe_events: Array.isArray(renderProbe.events) ? renderProbe.events.slice(0, 100) : [],
        layout_shift_sources: layoutShiftSourceDetails.slice(0, 50),
        layout_shifts: layoutShifts.slice(0, 50),
      },
      null,
      2
    )}\n`
  );
  trace.artifact({ label: 'Waterfall metadata', path: metadataPath });
  event('waterfall', 'metrics.ready', metrics);

  const simulatedClsPass =
    scenario.simulatedCls === 'unreserved'
      ? typeof metrics.browser_cls === 'number' && metrics.browser_cls > 0 && eceRenderedVisibleButton
      : scenario.simulatedCls === 'reserved'
        ? typeof metrics.browser_cls === 'number' && metrics.browser_cls <= 0.01 && eceRenderedVisibleButton
        : true;
  const stripeLoadPass = stripeLoadPageErrors.length === 0;
  const browserProbeCompleted = responses.length > 0 && existsSync(networkPath) && existsSync(performancePath);
  const pass = fixtureHealth.ok && browserProbeCompleted && stripeUrls.length > 0 && simulatedClsPass && stripeLoadPass;
  const summaryText = pass
    ? `Captured Stripe ECE product-page browser waterfall: ${stripeUrls.length} Stripe responses across ${responses.length} total responses.`
    : !fixtureHealth.ok
      ? fixtureHealthSummary(fixtureHealth)
      : stripeLoadPass
      ? 'Browser waterfall capture did not observe Stripe network responses.'
      : `Browser waterfall capture recorded ${stripeLoadPageErrors.length} Stripe-related page error(s).`;

  trace.assertion({
    id: 'fixture-health',
    status: fixtureHealth.ok ? 'pass' : 'fail',
    message: fixtureHealthSummary(fixtureHealth),
  });
  trace.assertion({
    id: 'stripe-network-observed',
    status: stripeUrls.length > 0 ? 'pass' : 'fail',
    message: `Observed ${stripeUrls.length} Stripe/stripe.network responses.`,
  });
  trace.assertion({
    id: 'network-response-count',
    status: responses.length > 0 ? 'pass' : 'fail',
    message: `Observed ${responses.length} total network responses.`,
  });
  trace.assertion({
    id: 'page-errors-recorded',
    status: 'pass',
    message: `Recorded ${pageErrors.length} page errors.`,
  });
  trace.assertion({
    id: 'stripe-load-errors',
    status: stripeLoadPass ? 'pass' : 'fail',
    message: `Recorded ${stripeLoadPageErrors.length} Stripe-related page error(s).`,
  });
  trace.assertion({
    id: 'scenario-interaction',
    status: 'pass',
    message: `${scenario.interaction} interaction produced ${interactionEvents.length} event(s).`,
  });
  trace.assertion({
    id: 'evidence-classification',
    status: profileOptions.realWalletCapable ? (scriptResult?.isSecureContext === true ? 'pass' : 'fail') : 'pass',
    message: profileOptions.realWalletCapable
      ? `Real-wallet-capable profile ran with secure context=${scriptResult?.isSecureContext === true} and visible button=${eceRenderedVisibleButton}.`
      : 'Synthetic-only profile ran without requiring real Stripe keys or wallet eligibility.',
  });
  if (scenario.simulatedCls) {
    trace.assertion({
      id: 'simulated-cls-profile',
      status: simulatedClsPass ? 'pass' : 'fail',
      message:
        scenario.simulatedCls === 'reserved'
          ? `Reserved simulated ECE CLS was ${metrics.browser_cls} with visible button=${eceRenderedVisibleButton}; expected near zero (<= 0.01).`
          : `Unreserved simulated ECE CLS was ${metrics.browser_cls} with visible button=${eceRenderedVisibleButton}; expected non-zero deterministic CLS.`,
    });
  }

  trace.artifact({ label: 'WP Codebox output', path: outputFile });
  if (summaryPath && existsSync(summaryPath)) {
    trace.artifact({ label: 'Browser summary', path: summaryPath });
  }
  if (htmlPath && existsSync(htmlPath)) {
    trace.artifact({ label: 'Captured HTML', path: htmlPath });
  }
  if (networkPath && existsSync(networkPath)) {
    trace.artifact({ label: 'Browser network log', path: networkPath });
  }
  if (performancePath && existsSync(performancePath)) {
    trace.artifact({ label: 'Browser performance', path: performancePath });
  }

  if (pass) {
    await trace.pass(metrics, { summary: summaryText });
  } else {
    await trace.fail(null, metrics, { summary: summaryText });
  }
  process.exitCode = pass ? 0 : 1;
} catch (error) {
  const summaryText = error instanceof Error ? error.message : String(error);

  trace.assertion({
    id: 'trace-workload-completed',
    status: 'fail',
    message: summaryText,
  });
  if (existsSync(outputFile)) {
    trace.artifact({ label: 'WP Codebox output', path: outputFile });
  }

  await trace.fail(error, {}, { summary: summaryText });
  throw error;
} finally {
  await rm(workDir, { recursive: true, force: true });
}
