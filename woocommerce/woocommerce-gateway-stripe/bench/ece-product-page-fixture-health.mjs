const FATAL_HTML_PATTERN = /(?:fatal error|parse error|syntax error|critical error|there has been a critical error)/i;
const FETCH_FAILED_PATTERN = /fetch failed/i;
const ADD_TO_CART_WARNING_PATTERN = /(?:warning|notice|deprecated|recoverable fatal error).*?(?:add-to-cart|add to cart|single-product|product-template|template|form\.cart|woocommerce_template_single_add_to_cart)/i;

function artifactPointer(label, pathname) {
  return pathname ? `${label}: ${pathname}` : null;
}

function messageText(entries) {
  return entries.map((entry) => JSON.stringify(entry)).join('\n');
}

export function evaluateEceFixtureHealth({
  html = '',
  htmlPath = '',
  summaryPath = '',
  consolePath = '',
  errorsPath = '',
  summary = null,
  consoleMessages = [],
  pageErrors = [],
  scriptResult = {},
  scenario = {},
  profileOptions = {},
} = {}) {
  const failures = [];
  const pointers = [
    artifactPointer('Browser summary', summaryPath),
    artifactPointer('Captured HTML', htmlPath),
    artifactPointer('Browser console', consolePath),
    artifactPointer('Browser page errors', errorsPath),
  ].filter(Boolean);
  const fixture = scriptResult?.fixtureHealth || {};
  const finalUrl = summary?.summary?.finalUrl || summary?.finalUrl || scriptResult?.locationHref || '';
  const title = scriptResult?.title || '';
  const combinedMessages = messageText([...consoleMessages, ...pageErrors]);

  if (!fixture.productTitleMatches && !/stripe benchmark product/i.test(`${title}\n${html}`)) {
    failures.push('Product page did not resolve to the benchmark product "Stripe Benchmark Product".');
  }

  if (finalUrl && !/stripe-benchmark-product|post_type=product/.test(finalUrl)) {
    failures.push(`Product page resolved to unexpected URL: ${finalUrl}.`);
  }

  if (html && html.length < 1024 && FETCH_FAILED_PATTERN.test(html)) {
    failures.push(`Captured HTML is a tiny fetch-failed page (${html.length} bytes).`);
  }

  if (FATAL_HTML_PATTERN.test(html)) {
    failures.push('Captured HTML contains a fatal/parse/critical-error marker.');
  }

  if (ADD_TO_CART_WARNING_PATTERN.test(`${html}\n${combinedMessages}`)) {
    failures.push('Product render emitted Woo add-to-cart/template warnings that can break ECE placement.');
  }

  if (fixture.hasCartForm === false) {
    failures.push('Selected product-page insertion point is missing: expected form.cart to render.');
  }

  if (profileOptions.requiresEceMount !== false && scriptResult?.eceContainer !== true) {
    failures.push('Required ECE mount #wc-stripe-express-checkout-element is missing.');
  }

  if (profileOptions.requiresStripeParams !== false && fixture.hasStripeParams !== true) {
    failures.push('Stripe Express Checkout params are missing: expected window.wc_stripe_express_checkout_params.');
  }

  if (scenario.layout === 'below-fold' && fixture.hasBelowFoldLayout !== true) {
    failures.push('Selected below-fold layout insertion point did not render: expected #homeboy-ece-below-fold-layout.');
  }

  return {
    ok: failures.length === 0,
    failures,
    artifact_pointers: pointers,
    details: {
      final_url: finalUrl || null,
      title: title || null,
      html_bytes: html ? html.length : null,
      has_cart_form: fixture.hasCartForm === true,
      has_summary: fixture.hasSummary === true,
      has_ece_container: scriptResult?.eceContainer === true,
      has_stripe_params: fixture.hasStripeParams === true,
      product_title_matches: fixture.productTitleMatches === true,
      has_below_fold_layout: fixture.hasBelowFoldLayout === true,
    },
  };
}

export function fixtureHealthSummary(health) {
  if (health.ok) {
    return 'Woo Stripe ECE fixture health passed.';
  }

  const artifactText = health.artifact_pointers.length > 0 ? ` Artifacts: ${health.artifact_pointers.join('; ')}.` : '';
  return `Woo Stripe ECE fixture health failed: ${health.failures.join(' ')}${artifactText}`;
}
