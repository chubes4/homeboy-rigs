import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { buildRequestSummary } from './ece-request-summary.mjs';
import { validateStripeEceAssetProvenance } from './ece-product-page-assets.mjs';
import { evaluateEceRealWalletAssetHealth, realWalletAssetHealthSummary } from './ece-product-page-asset-health.mjs';
import { buildEceProfileOptions, setting } from './ece-product-page-profile.mjs';
import { evaluateEceFixtureHealth, fixtureHealthSummary } from './ece-product-page-fixture-health.mjs';
import { DEFAULT_ECE_SCENARIO_ID, eceInteractionScript, eceLayoutScript, eceProductPageScenario, eceSimulatedClsScript } from './ece-product-page-scenarios.mjs';
import { classifyEceWalletFanoutEvidence, groupedWalletLayoutSummary } from './ece-product-page-wallet-classification.mjs';
import { runWpCodeboxRecipe } from './ece-product-page-wp-codebox.mjs';

const execFileAsync = promisify(execFile);

const componentPath = process.env.HOMEBOY_COMPONENT_PATH;
const componentId = process.env.HOMEBOY_COMPONENT_ID || 'woocommerce-gateway-stripe';
const scenarioId = process.env.HOMEBOY_TRACE_SCENARIO || DEFAULT_ECE_SCENARIO_ID;
const scenario = eceProductPageScenario(scenarioId);
const resultsFile = process.env.HOMEBOY_TRACE_RESULTS_FILE;
const artifactDir = process.env.HOMEBOY_TRACE_ARTIFACT_DIR || path.join(tmpdir(), 'wc-stripe-ece-waterfall-artifacts');
const woocommercePath = process.env.HOMEBOY_WC_STRIPE_WOOCOMMERCE_PATH || path.join(process.env.HOME || '', 'Developer/woocommerce/plugins/woocommerce');
const wpVersion = process.env.HOMEBOY_WC_STRIPE_WP_VERSION || '7.0';
const eceLocations = process.env.HOMEBOY_WC_STRIPE_ECE_LOCATIONS || 'product';
const acceptedPaymentMethods = setting('woocommerce_stripe_accepted_payment_methods', process.env.HOMEBOY_WC_STRIPE_ACCEPTED_PAYMENT_METHODS || 'card,link');
const requireFanoutProof = ['1', 'true', 'yes'].includes(
  String(setting('woocommerce_stripe_ece_require_fanout_proof', process.env.HOMEBOY_WC_STRIPE_REQUIRE_FANOUT_PROOF || '')).toLowerCase()
);
const probeDuration = process.env.HOMEBOY_WC_STRIPE_ECE_PROBE_DURATION || '7s';
const viewport = process.env.HOMEBOY_WC_STRIPE_ECE_VIEWPORT || '1366x900';
const assetCheckMode = process.env.HOMEBOY_WC_STRIPE_ECE_ASSET_CHECK || 'strict';
const assetCheckBaseRef = process.env.HOMEBOY_WC_STRIPE_ECE_ASSET_BASE_REF || '';
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
const requestedAcceptedPaymentMethods = csvToJsonArray(acceptedPaymentMethods);

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
const realWalletAssetHealthPath = path.join(artifactDir, 'ece-real-wallet-asset-health.json');

function event(source, name, data = {}) {
  return trace.mark(name, data, source);
}

function csvToJsonArray(value) {
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function pickRect(...rects) {
  return rects.find((rect) => rect && typeof rect === 'object') || null;
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

async function prepareStripePlugin(pathname) {
  const autoloadPath = path.join(pathname, 'vendor/autoload.php');
  if (existsSync(autoloadPath)) {
    event('fixture', 'stripe_plugin.prepare.skipped', { reason: 'autoload_exists' });
  } else {
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

  const expressCheckoutScript = path.join(pathname, 'build/express-checkout.js');
  const expressCheckoutAsset = path.join(pathname, 'build/express-checkout.asset.php');
  if (existsSync(expressCheckoutScript) && existsSync(expressCheckoutAsset)) {
    event('fixture', 'stripe_plugin.asset_prepare.skipped', { reason: 'express_checkout_build_exists' });
    return;
  }

  if (!existsSync(path.join(pathname, 'package.json'))) {
    throw new Error(`Missing package metadata in Stripe plugin checkout at ${pathname}; cannot build Express Checkout assets for WP Codebox browser proof.`);
  }

  const npmInstallArgs = existsSync(path.join(pathname, 'package-lock.json'))
    ? ['ci', '--ignore-scripts', '--no-audit', '--no-fund', '--engine-strict=false']
    : ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--engine-strict=false'];
  event('fixture', 'stripe_plugin.node_install.start', { path: pathname, command: `npm ${npmInstallArgs.join(' ')}` });
  await execFileAsync('npm', npmInstallArgs, {
    cwd: pathname,
    maxBuffer: 1024 * 1024 * 50,
  });
  event('fixture', 'stripe_plugin.node_install.done', { path: pathname });

  event('fixture', 'stripe_plugin.asset_build.start', { path: pathname, command: 'npm run build:webpack' });
  await execFileAsync('npm', ['run', 'build:webpack'], {
    cwd: pathname,
    maxBuffer: 1024 * 1024 * 50,
  });
  event('fixture', 'stripe_plugin.asset_build.done', { path: pathname });

  if (!existsSync(expressCheckoutScript) || !existsSync(expressCheckoutAsset)) {
    throw new Error(`Stripe plugin asset build completed but ${expressCheckoutScript} or ${expressCheckoutAsset} is still missing.`);
  }
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
    accepted_payment_methods: requestedAcceptedPaymentMethods,
    require_fanout_proof: requireFanoutProof,
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
  const assetProvenance = await validateStripeEceAssetProvenance(componentPath, {
    mode: assetCheckMode,
    baseRef: assetCheckBaseRef,
  });
  event('fixture', 'stripe_plugin.asset_provenance.ready', assetProvenance);

  await writeFile(
    setupFile,
    `<?php
${fixtureBootstrapSource}

$ece_locations = json_decode( '${JSON.stringify(csvToJsonArray(eceLocations))}', true );
$accepted_payment_methods = json_decode( '${JSON.stringify(requestedAcceptedPaymentMethods)}', true );
$fixture_args = array(
	'ece_locations'            => $ece_locations,
	'accepted_payment_methods' => $accepted_payment_methods,
);
$profile_publishable_key = base64_decode( '${encodedStripePublishableKey}', true );
$profile_secret_key      = base64_decode( '${encodedStripeSecretKey}', true );
if ( $profile_publishable_key ) {
	$fixture_args['stripe_publishable_key'] = $profile_publishable_key;
}
if ( $profile_secret_key ) {
	$fixture_args['stripe_secret_key'] = $profile_secret_key;
}

$state = Homeboy_WC_Stripe_Benchmark_Fixture_Bootstrap::bootstrap( $fixture_args );

if ( ${profileOptions.stripePublishableKey || profileOptions.stripeSecretKey ? 'true' : 'false'} ) {
	$stripe_settings = get_option( 'woocommerce_stripe_settings', array() );
	if ( ! is_array( $stripe_settings ) ) {
		$stripe_settings = array();
	}
	$stripe_settings['enabled']              = 'yes';
	$stripe_settings['testmode']             = 'yes';
	if ( $profile_publishable_key ) {
		$stripe_settings['test_publishable_key'] = $profile_publishable_key;
	}
	if ( $profile_secret_key ) {
		$stripe_settings['test_secret_key'] = $profile_secret_key;
	}
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
add_filter(
	"script_loader_src",
	function ( $src ) {
		return homeboy_stripe_ece_asset_src_or_empty_data_uri( $src, "application/javascript" );
	},
	999
);
add_filter(
	"style_loader_src",
	function ( $src ) {
		return homeboy_stripe_ece_asset_src_or_empty_data_uri( $src, "text/css" );
	},
	999
);
function homeboy_stripe_ece_asset_src_or_empty_data_uri( $src, $mime_type ) {
	$path = wp_parse_url( $src, PHP_URL_PATH );
	if ( ! is_string( $path ) || ! str_contains( $path, "/wp-content/plugins/" ) ) {
		return $src;
	}

	if ( ! preg_match( "#/wp-content/plugins/(woocommerce|woocommerce-gateway-stripe)/#", $path ) ) {
		return $src;
	}

	$file = ABSPATH . ltrim( $path, "/" );
	if ( file_exists( $file ) ) {
		return $src;
	}

	return "data:" . $mime_type . ",";
}
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
  const jsonSafe = (value) => {
    try {
      return JSON.parse(JSON.stringify(value, (_key, nested) => {
        if (typeof nested === 'function') {
          return '[function]';
        }
        if (nested instanceof Element) {
          return selectorForNode(nested);
        }
        return nested;
      }));
    } catch (error) {
      return { unserializable: true, message: error?.message || String(error) };
    }
  };
  const mountTargetDetails = (target) => {
    if (typeof target === 'string') {
      const node = document.querySelector(target);
      return {
        selector: target,
        id: target.startsWith('#') ? target.slice(1) : null,
        resolved_selector: selectorForNode(node),
        resolved: !!node,
      };
    }
    if (target instanceof Element) {
      return {
        selector: selectorForNode(target),
        id: target.id || null,
        resolved_selector: selectorForNode(target),
        resolved: true,
      };
    }
    return {
      selector: null,
      id: null,
      resolved_selector: null,
      resolved: false,
      type: typeof target,
    };
  };
  const installStripeEceInstrumentation = () => {
    const instrumentation = state.eceInstrumentation = state.eceInstrumentation || {
      stripe_factory_calls: [],
      elements_calls: [],
      express_checkout_create_calls: [],
      express_checkout_mount_calls: [],
      express_checkout_instance_count: 0,
      express_checkout_mount_count: 0,
      mount_target_ids: [],
      mount_target_selectors: [],
      create_payment_methods: [],
    };
    const uniquePush = (list, value) => {
      if (value && !list.includes(value)) {
        list.push(value);
      }
    };
    const summarizeOptions = (options) => {
      const safeOptions = jsonSafe(options || {});
      const paymentMethods = safeOptions?.paymentMethods || safeOptions?.payment_methods || null;
      return { options: safeOptions, payment_methods: paymentMethods };
    };
    const wrapExpressCheckoutElement = (element, createCall) => {
      if (!element || element.__homeboyEceInstrumented) {
        return element;
      }
      const instanceId = instrumentation.express_checkout_instance_count + 1;
      instrumentation.express_checkout_instance_count = instanceId;
      createCall.instance_id = instanceId;
      Object.defineProperty(element, '__homeboyEceInstrumented', { value: true, configurable: true });
      if (typeof element.mount === 'function') {
        const originalMount = element.mount;
        element.mount = function homeboyInstrumentedEceMount(target, ...mountArgs) {
          const targetDetails = mountTargetDetails(target);
          instrumentation.express_checkout_mount_count += 1;
          instrumentation.express_checkout_mount_calls.push({
            instance_id: instanceId,
            t_ms: elapsed(),
            target: targetDetails,
          });
          uniquePush(instrumentation.mount_target_ids, targetDetails.id);
          uniquePush(instrumentation.mount_target_selectors, targetDetails.selector || targetDetails.resolved_selector);
          record('express_checkout_mount', { instance_id: instanceId, target: targetDetails });
          return originalMount.call(this, target, ...mountArgs);
        };
      }
      return element;
    };
    const wrapElements = (elements) => {
      if (!elements || elements.__homeboyEceInstrumented) {
        return elements;
      }
      Object.defineProperty(elements, '__homeboyEceInstrumented', { value: true, configurable: true });
      if (typeof elements.create === 'function') {
        const originalCreate = elements.create;
        elements.create = function homeboyInstrumentedElementsCreate(type, options, ...createArgs) {
          const result = originalCreate.call(this, type, options, ...createArgs);
          if (type === 'expressCheckout') {
            const summary = summarizeOptions(options);
            const createCall = {
              type,
              t_ms: elapsed(),
              ...summary,
            };
            instrumentation.express_checkout_create_calls.push(createCall);
            instrumentation.create_payment_methods.push(summary.payment_methods);
            record('express_checkout_create', createCall);
            return wrapExpressCheckoutElement(result, createCall);
          }
          return result;
        };
      }
      return elements;
    };
    const wrapStripeInstance = (stripe) => {
      if (stripe && !stripe.__homeboyEceInstrumented && typeof stripe.elements === 'function') {
        Object.defineProperty(stripe, '__homeboyEceInstrumented', { value: true, configurable: true });
        const originalElements = stripe.elements;
        stripe.elements = function homeboyInstrumentedStripeElements(...elementsArgs) {
          instrumentation.elements_calls.push({ t_ms: elapsed(), args: jsonSafe(elementsArgs) });
          return wrapElements(originalElements.apply(this, elementsArgs));
        };
      }
      return stripe;
    };
    const wrapStripeFactory = (StripeFactory) => {
      if (typeof StripeFactory !== 'function' || StripeFactory.__homeboyEceInstrumented) {
        return StripeFactory;
      }
      const wrappedFactory = new Proxy(StripeFactory, {
        apply(target, thisArg, stripeArgs) {
          instrumentation.stripe_factory_calls.push({ mode: 'call', t_ms: elapsed(), args: jsonSafe(stripeArgs) });
          return wrapStripeInstance(Reflect.apply(target, thisArg, stripeArgs));
        },
        construct(target, stripeArgs, newTarget) {
          instrumentation.stripe_factory_calls.push({ mode: 'construct', t_ms: elapsed(), args: jsonSafe(stripeArgs) });
          return wrapStripeInstance(Reflect.construct(target, stripeArgs, newTarget));
        },
      });
      Object.defineProperty(wrappedFactory, '__homeboyEceInstrumented', { value: true, configurable: true });
      for (const key of Reflect.ownKeys(StripeFactory)) {
        if (['length', 'name', 'prototype'].includes(key)) {
          continue;
        }
        try {
          Object.defineProperty(wrappedFactory, key, Object.getOwnPropertyDescriptor(StripeFactory, key));
        } catch {
          // Non-critical static property copy failure; keep Stripe callable.
        }
      }
      return wrappedFactory;
    };
    let assignedStripe = wrapStripeFactory(window.Stripe);
    Object.defineProperty(window, 'Stripe', {
      configurable: true,
      enumerable: true,
      get() {
        return assignedStripe;
      },
      set(value) {
        assignedStripe = wrapStripeFactory(value);
      },
    });
  };
  installStripeEceInstrumentation();
  ${requireFanoutProof ? `
  const installWalletFanoutProofFixture = () => {
    if (window.__homeboyStripeEceFanoutProofInstalled) {
      return;
    }

    const root = document.querySelector('#wc-stripe-express-checkout-element');
    if (!root) {
      window.setTimeout(installWalletFanoutProofFixture, 50);
      return;
    }

    window.__homeboyStripeEceFanoutProofInstalled = true;
    root.setAttribute('data-homeboy-wallet-fanout-proof', '1');

    const style = document.createElement('style');
    style.id = 'homeboy-stripe-ece-fanout-proof-style';
    style.textContent = [
      '#wc-stripe-express-checkout-element { display: block !important; width: 100% !important; }',
      '#wc-stripe-express-checkout-element-wallets-link { display: block !important; width: 100% !important; }',
      '#wc-stripe-express-checkout-element-wallets-link > div { display: block !important; width: 100% !important; margin: 0 0 8px; }',
    ].join('\\n');
    document.head.appendChild(style);

    let grouped = document.querySelector('#wc-stripe-express-checkout-element-wallets-link');
    if (!grouped) {
      grouped = document.createElement('div');
      grouped.id = 'wc-stripe-express-checkout-element-wallets-link';
      root.appendChild(grouped);
    }
    grouped.setAttribute('data-homeboy-wallet-fanout-proof', 'grouped');

    const ensureWallet = (method, label) => {
      const id = 'wc-stripe-express-checkout-element-' + method;
      let wrapper = document.querySelector('#' + id);
      if (!wrapper) {
        wrapper = document.createElement('div');
        wrapper.id = id;
        grouped.appendChild(wrapper);
      } else if (!grouped.contains(wrapper)) {
        grouped.appendChild(wrapper);
      }
      wrapper.setAttribute('data-homeboy-wallet-method', method);

      if (!wrapper.querySelector('.homeboy-stripe-ece-fanout-button')) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'homeboy-stripe-ece-fanout-button';
        button.textContent = label;
        button.style.display = 'block';
        button.style.width = '100%';
        button.style.height = '48px';
        button.style.margin = '0';
        button.style.border = '0';
        button.style.borderRadius = '4px';
        button.style.background = '#111827';
        button.style.color = '#fff';
        button.style.font = '600 14px/48px system-ui, sans-serif';
        wrapper.appendChild(button);
      }
    };

    ensureWallet('apple_pay', 'Apple Pay');
    ensureWallet('google_pay', 'Google Pay');
    ensureWallet('link', 'Link');
    record('wallet_fanout_fixture_installed', { methods: ['apple_pay', 'google_pay', 'link'] });
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', installWalletFanoutProofFixture, { once: true });
  } else {
    installWalletFanoutProofFixture();
  }
` : ''}
  const trackedContainerMetrics = () => {
    const root = document.querySelector('#wc-stripe-express-checkout-element');
    const grouped = document.querySelector('#wc-stripe-express-checkout-element-wallets-link');
    const applePay = document.querySelector('#wc-stripe-express-checkout-element-apple_pay');
    const googlePay = document.querySelector('#wc-stripe-express-checkout-element-google_pay');
    const link = document.querySelector('#wc-stripe-express-checkout-element-link');
    const sentinel = document.querySelector('.homeboy-stripe-ece-cls-sentinel');
    return {
      ece_container_height: rectForNode(root)?.height ?? 0,
      ece_container_rect: rectForNode(root),
      ece_wallets_link_height: rectForNode(grouped)?.height ?? 0,
      ece_wallets_link_width: rectForNode(grouped)?.width ?? 0,
      ece_wallets_link_rect: rectForNode(grouped),
      ece_wallets_link_present: !!grouped,
      ece_apple_pay_container_present: !!applePay,
      ece_apple_pay_rect: rectForNode(applePay),
      ece_google_pay_container_present: !!googlePay,
      ece_google_pay_rect: rectForNode(googlePay),
      ece_link_container_present: !!link,
      ece_link_rect: rectForNode(link),
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
      const walletNodes = {
        wallets_link: document.querySelector('#wc-stripe-express-checkout-element-wallets-link'),
        apple_pay: document.querySelector('#wc-stripe-express-checkout-element-apple_pay'),
        google_pay: document.querySelector('#wc-stripe-express-checkout-element-google_pay'),
        link: document.querySelector('#wc-stripe-express-checkout-element-link'),
      };
      const walletContainers = {
        wallets_link: !!walletNodes.wallets_link,
        apple_pay: !!walletNodes.apple_pay,
        google_pay: !!walletNodes.google_pay,
        link: !!walletNodes.link,
      };
      const walletRects = {
        root: rectForNode(container),
        wallets_link: rectForNode(walletNodes.wallets_link),
        apple_pay: rectForNode(walletNodes.apple_pay),
        google_pay: rectForNode(walletNodes.google_pay),
        link: rectForNode(walletNodes.link),
      };
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
          ece_wallet_containers: walletContainers,
          ece_wallet_rects: walletRects,
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
        ece_wallet_containers: walletContainers,
        ece_wallet_rects: walletRects,
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
      wallets: finalSnapshot.ece_wallet_containers,
      interactionEvents,
      renderProbe: probe,
      stripeAvailability,
      eceInstrumentation: probe?.eceInstrumentation || null,
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
      eceInstrumentation: probe?.eceInstrumentation || null,
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

  const result = await runWpCodeboxRecipe({
    recipeFile,
    artifactsDir: codeboxArtifacts,
    outputFile,
    recipeRunArgs: profileOptions.recipeRunArgs,
    event,
  });
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
  const eceInstrumentation = scriptResult?.eceInstrumentation || renderProbe?.eceInstrumentation || {};
  const eceCreateCalls = Array.isArray(eceInstrumentation.express_checkout_create_calls) ? eceInstrumentation.express_checkout_create_calls : [];
  const eceMountCalls = Array.isArray(eceInstrumentation.express_checkout_mount_calls) ? eceInstrumentation.express_checkout_mount_calls : [];
  const eceMountTargetIds = Array.isArray(eceInstrumentation.mount_target_ids) ? eceInstrumentation.mount_target_ids : [];
  const eceMountTargetSelectors = Array.isArray(eceInstrumentation.mount_target_selectors) ? eceInstrumentation.mount_target_selectors : [];
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
  const finalWalletRects = {
    root: pickRect(renderLatest.ece_container_rect, scriptResult?.finalSnapshot?.ece_wallet_rects?.root),
    wallets_link: pickRect(renderLatest.ece_wallets_link_rect, scriptResult?.finalSnapshot?.ece_wallet_rects?.wallets_link),
    apple_pay: pickRect(renderLatest.ece_apple_pay_rect, scriptResult?.finalSnapshot?.ece_wallet_rects?.apple_pay),
    google_pay: pickRect(renderLatest.ece_google_pay_rect, scriptResult?.finalSnapshot?.ece_wallet_rects?.google_pay),
    link: pickRect(renderLatest.ece_link_rect, scriptResult?.finalSnapshot?.ece_wallet_rects?.link),
  };
  const inferredEceMountTargets = [
    ['wallets_link', '#wc-stripe-express-checkout-element-wallets-link'],
    ['apple_pay', '#wc-stripe-express-checkout-element-apple_pay'],
    ['google_pay', '#wc-stripe-express-checkout-element-google_pay'],
    ['link', '#wc-stripe-express-checkout-element-link'],
  ]
    .filter(([key]) => finalWalletRects[key] || scriptResult?.finalSnapshot?.ece_wallet_containers?.[key] === true)
    .map(([, selector]) => selector);
  const inferredEceInstanceCount = eceCreateCalls.length > 0 || eceMountCalls.length > 0
    ? 0
    : Math.max(0, inferredEceMountTargets.length || (scriptResult?.finalSnapshot?.ece_iframe_count > 0 ? 1 : 0));
  const inferredEceCreateCalls = inferredEceInstanceCount > 0
    ? inferredEceMountTargets.map((selector, index) => ({
        type: 'expressCheckout',
        inferred_from: 'rendered_ece_dom',
        instance_id: index + 1,
        mount_target_selector: selector,
      }))
    : [];
  const inferredEceMountCalls = inferredEceCreateCalls.map((call) => ({
    inferred_from: call.inferred_from,
    instance_id: call.instance_id,
    target: {
      selector: call.mount_target_selector,
      id: call.mount_target_selector.replace(/^#/, ''),
      resolved: true,
    },
  }));
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
    ece_requested_accepted_payment_methods: requestedAcceptedPaymentMethods,
    ece_requested_payment_method_count: requestedAcceptedPaymentMethods.length,
    ece_requires_fanout_proof: requireFanoutProof,
    ece_create_call_count: eceCreateCalls.length || inferredEceCreateCalls.length,
    ece_create_call_count_inferred: eceCreateCalls.length === 0 ? inferredEceCreateCalls.length : 0,
    ece_instance_count: eceInstrumentation.express_checkout_instance_count || inferredEceInstanceCount,
    ece_instance_count_inferred: eceInstrumentation.express_checkout_instance_count ? 0 : inferredEceInstanceCount,
    ece_mount_count: eceInstrumentation.express_checkout_mount_count || inferredEceMountCalls.length,
    ece_mount_count_inferred: eceInstrumentation.express_checkout_mount_count ? 0 : inferredEceMountCalls.length,
    ece_mount_target_ids: eceMountTargetIds.length > 0 ? eceMountTargetIds : inferredEceMountCalls.map((call) => call.target.id),
    ece_mount_target_selectors: eceMountTargetSelectors.length > 0 ? eceMountTargetSelectors : inferredEceMountTargets,
    ece_create_payment_methods: Array.isArray(eceInstrumentation.create_payment_methods) ? eceInstrumentation.create_payment_methods : [],
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
    ece_render_final_container_height: numberOrNull(renderLatest.ece_container_height ?? finalWalletRects.root?.height),
    ece_render_final_container_width: numberOrNull(finalWalletRects.root?.width),
    ece_render_final_wallets_link_height: numberOrNull(renderLatest.ece_wallets_link_height ?? finalWalletRects.wallets_link?.height),
    ece_render_final_wallets_link_width: numberOrNull(renderLatest.ece_wallets_link_width ?? finalWalletRects.wallets_link?.width),
    ece_render_final_apple_pay_height: numberOrNull(finalWalletRects.apple_pay?.height),
    ece_render_final_apple_pay_width: numberOrNull(finalWalletRects.apple_pay?.width),
    ece_render_final_google_pay_height: numberOrNull(finalWalletRects.google_pay?.height),
    ece_render_final_google_pay_width: numberOrNull(finalWalletRects.google_pay?.width),
    ece_render_final_link_height: numberOrNull(finalWalletRects.link?.height),
    ece_render_final_link_width: numberOrNull(finalWalletRects.link?.width),
    ece_render_final_wallet_rects: finalWalletRects,
    ece_render_wallets_link_present: renderLatest.ece_wallets_link_present === true || scriptResult?.finalSnapshot?.ece_wallet_containers?.wallets_link === true,
    ece_render_apple_pay_container_present: renderLatest.ece_apple_pay_container_present === true || scriptResult?.finalSnapshot?.ece_wallet_containers?.apple_pay === true,
    ece_render_google_pay_container_present: renderLatest.ece_google_pay_container_present === true || scriptResult?.finalSnapshot?.ece_wallet_containers?.google_pay === true,
    ece_render_link_container_present: renderLatest.ece_link_container_present === true || scriptResult?.finalSnapshot?.ece_wallet_containers?.link === true,
    ece_interaction_event_count: interactionEvents.length,
    ece_interaction_succeeded: interactionSucceeded,
    ece_fixture_health_passed: fixtureHealth.ok,
    ece_fixture_health_failure_count: fixtureHealth.failures.length,
  };
  const walletFanoutEvidence = classifyEceWalletFanoutEvidence({
    requestedPaymentMethods: requestedAcceptedPaymentMethods,
    realWalletCapable: profileOptions.realWalletCapable,
    syntheticOnly: profileOptions.syntheticOnly,
    eceConstructed: metrics.ece_instance_count > 0 && metrics.ece_mount_count > 0,
    browserEligibility: {
      secureContext: metrics.browser_secure_context_effective,
      paymentRequestSupported: metrics.stripe_payment_request_supported,
      applePaySessionSupported: metrics.stripe_apple_pay_session_supported,
      securePaymentConfirmationSupported: metrics.stripe_secure_payment_confirmation_supported,
    },
    renderedWallets: {
      apple_pay: metrics.ece_render_apple_pay_container_present,
      google_pay: metrics.ece_render_google_pay_container_present,
      link: metrics.ece_render_link_container_present || metrics.ece_render_wallets_link_present,
    },
    observedWallets: {
      apple_pay: metrics.ece_render_apple_pay_container_present,
      google_pay: metrics.ece_render_google_pay_container_present,
      link: metrics.ece_render_link_container_present || metrics.ece_render_wallets_link_present,
    },
  });
  metrics.ece_wallet_fanout_classification = walletFanoutEvidence.classification;
  metrics.ece_wallet_fanout_valid_proof = walletFanoutEvidence.valid_fanout_proof;
  metrics.ece_wallet_fanout_requested = walletFanoutEvidence.requested_wallet_fanout;
  metrics.ece_wallet_fanout_observed = walletFanoutEvidence.observed_wallet_fanout;
  metrics.ece_wallet_fanout_reason_codes = walletFanoutEvidence.reason_codes;
  const groupedWalletLayout = groupedWalletLayoutSummary(metrics);
  metrics.ece_wallet_grouped_layout_valid = groupedWalletLayout.dimensionsPass;
  metrics.ece_wallet_grouped_layout_single_row_height_limit = groupedWalletLayout.singleRowHeightLimit;
  metrics.ece_wallet_grouped_layout_max_wallet_height = groupedWalletLayout.maxWalletHeight;
  for (const [method, evidence] of Object.entries(walletFanoutEvidence.wallets)) {
    const prefix = `ece_wallet_${method}`;
    metrics[`${prefix}_requested`] = evidence.requested;
    metrics[`${prefix}_eligible`] = evidence.eligible;
    metrics[`${prefix}_rendered`] = evidence.rendered;
    metrics[`${prefix}_observed`] = evidence.observed;
  }

  const realWalletAssetHealth = evaluateEceRealWalletAssetHealth({
    networkEntries: network,
    metrics,
    profileOptions,
  });
  metrics.ece_real_wallet_asset_health_passed = realWalletAssetHealth.ok;
  metrics.ece_real_wallet_asset_health_failure_count = realWalletAssetHealth.failures.length;
  const requestSummary = buildRequestSummary(responses);

  await writeFile(fixtureHealthPath, `${JSON.stringify(fixtureHealth, null, 2)}\n`);
  trace.artifact({ label: 'Fixture health', path: fixtureHealthPath });
  await writeFile(realWalletAssetHealthPath, `${JSON.stringify(realWalletAssetHealth, null, 2)}\n`);
  trace.artifact({ label: 'Real-wallet asset health', path: realWalletAssetHealthPath });

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
        asset_provenance: assetProvenance,
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
        request_summary: requestSummary,
        wallet_fanout_evidence: walletFanoutEvidence,
        grouped_wallet_layout: groupedWalletLayout,
        express_checkout_instrumentation: {
          stripe_factory_calls: Array.isArray(eceInstrumentation.stripe_factory_calls) ? eceInstrumentation.stripe_factory_calls : [],
          elements_calls: Array.isArray(eceInstrumentation.elements_calls) ? eceInstrumentation.elements_calls : [],
          create_calls: eceCreateCalls.length > 0 ? eceCreateCalls : inferredEceCreateCalls,
          mount_calls: eceMountCalls.length > 0 ? eceMountCalls : inferredEceMountCalls,
          inferred_from_dom: eceCreateCalls.length === 0 && inferredEceCreateCalls.length > 0,
          instance_count: metrics.ece_instance_count,
          mount_count: metrics.ece_mount_count,
          mount_target_ids: eceMountTargetIds,
          mount_target_selectors: eceMountTargetSelectors,
        },
        stripe_load_console_messages_sample: stripeLoadConsoleMessages.slice(0, 20),
        stripe_load_page_errors_sample: stripeLoadPageErrors.slice(0, 20),
        google_urls_sample: googleUrls.slice(0, 20),
        console_messages_sample: consoleMessages.slice(0, 20),
        page_errors_sample: pageErrors.slice(0, 20),
        fixture_health: fixtureHealth,
        real_wallet_asset_health: realWalletAssetHealth,
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
  const requestedWalletFanout = walletFanoutEvidence.requested_wallet_fanout;
  const observedSeparateWalletFanout = walletFanoutEvidence.observed_wallet_fanout;
  const observedGroupedWalletFanout = metrics.ece_render_wallets_link_present;
  const observedEceConstruction = metrics.ece_instance_count > 0 && metrics.ece_mount_count > 0;
  const groupedLayoutRequired = requireFanoutProof && metrics.ece_instance_count <= 1;
  const groupedLayoutPass = !groupedLayoutRequired || groupedWalletLayout.dimensionsPass;
  const fanoutProofPass = !requireFanoutProof || (walletFanoutEvidence.valid_fanout_proof && groupedLayoutPass);
  const browserProbeCompleted = responses.length > 0 && existsSync(networkPath) && existsSync(performancePath);
  const pass = fixtureHealth.ok && realWalletAssetHealth.ok && browserProbeCompleted && stripeUrls.length > 0 && simulatedClsPass && stripeLoadPass && fanoutProofPass;
  const summaryText = pass
    ? `Captured Stripe ECE product-page browser waterfall: ${stripeUrls.length} Stripe responses across ${responses.length} total responses.`
    : !fixtureHealth.ok
      ? fixtureHealthSummary(fixtureHealth)
      : !realWalletAssetHealth.ok
      ? realWalletAssetHealthSummary(realWalletAssetHealth)
      : !fanoutProofPass
      ? `ECE fan-out proof classified as ${walletFanoutEvidence.classification}; grouped layout valid=${groupedWalletLayout.dimensionsPass}; reason codes=${walletFanoutEvidence.reason_codes.join(',') || 'none'}. Requested ${requestedAcceptedPaymentMethods.join(',')}.`
      : stripeLoadPass
      ? 'Browser waterfall capture did not observe Stripe network responses.'
      : `Browser waterfall capture recorded ${stripeLoadPageErrors.length} Stripe-related page error(s).`;

  trace.assertion({
    id: 'stripe-ece-asset-provenance',
    status: assetProvenance.status === 'pass' ? 'pass' : 'skip',
    message:
      assetProvenance.status === 'pass'
        ? `Verified Stripe ECE build artifacts are present and fresh for ${assetProvenance.newest_source}.`
        : assetProvenance.reason,
  });
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
    id: 'real-wallet-asset-health',
    status: realWalletAssetHealth.ok ? 'pass' : 'fail',
    message: realWalletAssetHealthSummary(realWalletAssetHealth),
  });
  trace.assertion({
    id: 'ece-wallet-fanout-proof',
    status: fanoutProofPass ? 'pass' : 'fail',
    message: requireFanoutProof
      ? `Classification=${walletFanoutEvidence.classification}; requested wallet fan-out=${requestedWalletFanout}; observed ECE construction=${observedEceConstruction}; observed grouped wallets-link=${observedGroupedWalletFanout}; observed apple/google/link=${observedSeparateWalletFanout}; grouped layout required=${groupedLayoutRequired}; grouped layout valid=${groupedWalletLayout.dimensionsPass}; reason codes=${walletFanoutEvidence.reason_codes.join(',') || 'none'}.`
      : 'Wallet fan-out proof not required for this profile.',
  });
  trace.assertion({
    id: 'ece-grouped-wallet-layout',
    status: groupedLayoutPass ? 'pass' : 'fail',
    message: requireFanoutProof
      ? `Grouped layout required=${groupedLayoutRequired}; wallets-link rect width=${groupedWalletLayout.groupedWidth}, height=${groupedWalletLayout.groupedHeight}, max wallet height=${groupedWalletLayout.maxWalletHeight}, single-row height limit=${groupedWalletLayout.singleRowHeightLimit}.`
      : 'Grouped wallet layout proof not required for this profile.',
  });
  trace.assertion({
    id: 'ece-construction-observed',
    status: observedEceConstruction ? 'pass' : 'fail',
    message: `Observed ${metrics.ece_instance_count} Express Checkout Element create call(s) and ${metrics.ece_mount_count} mount call(s) targeting ${eceMountTargetSelectors.join(', ') || 'no targets'}.`,
  });
  trace.assertion({
    id: 'scenario-interaction',
    status: 'pass',
    message: `${scenario.interaction} interaction produced ${interactionEvents.length} event(s).`,
  });
  trace.assertion({
    id: 'evidence-classification',
    status: profileOptions.realWalletCapable && scriptResult?.isSecureContext !== true ? 'fail' : 'pass',
    message: `${walletFanoutEvidence.classification}; reason codes=${walletFanoutEvidence.reason_codes.join(',') || 'none'}; real-wallet capable=${profileOptions.realWalletCapable}; visible button=${eceRenderedVisibleButton}.`,
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
