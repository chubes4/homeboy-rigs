export const DEFAULT_ECE_SCENARIO_ID = 'ece-product-page-waterfall';

const SCENARIOS = {
  [DEFAULT_ECE_SCENARIO_ID]: {
    id: DEFAULT_ECE_SCENARIO_ID,
    profile: 'load-only',
    interaction: 'load-only',
    description: 'Load the product page and record the initial ECE render lifecycle.',
  },
  'ece-product-page-scroll-to-ece': {
    id: 'ece-product-page-scroll-to-ece',
    profile: 'scroll-to-ece',
    interaction: 'scroll-to-ece',
    description: 'Scroll the product-page ECE container into view after load.',
  },
  'ece-product-page-quantity-change': {
    id: 'ece-product-page-quantity-change',
    profile: 'quantity-change',
    interaction: 'quantity-change',
    description: 'Change the product quantity after load and record ECE lifecycle stability.',
  },
  'ece-product-page-variation-change': {
    id: 'ece-product-page-variation-change',
    profile: 'variation-change',
    interaction: 'variation-change',
    description: 'Attempt a product variation selection change when variation controls exist.',
  },
};

export function eceProductPageScenario(scenarioId = DEFAULT_ECE_SCENARIO_ID) {
  return SCENARIOS[scenarioId] || SCENARIOS[DEFAULT_ECE_SCENARIO_ID];
}

export function eceProductPageScenarioIds() {
  return Object.keys(SCENARIOS);
}

export function eceInteractionScript(scenario) {
  switch (scenario.interaction) {
    case 'scroll-to-ece':
      return `
        const container = document.querySelector('#wc-stripe-express-checkout-element');
        interactionSnapshot('before_scroll_to_ece');
        if (container) {
          container.scrollIntoView({ block: 'center', inline: 'nearest' });
          interactionEvents.push({ name: 'scroll_to_ece', t_ms: elapsed(), ok: true });
          await sleep(750);
          sample();
          interactionSnapshot('after_scroll_to_ece');
        } else {
          interactionEvents.push({ name: 'scroll_to_ece', t_ms: elapsed(), ok: false, reason: 'missing_ece_container' });
        }
      `;
    case 'quantity-change':
      return `
        const quantity = document.querySelector('form.cart input.qty, input.qty[name="quantity"], input[name="quantity"]');
        interactionSnapshot('before_quantity_change');
        if (quantity) {
          const before = Number.parseInt(quantity.value || quantity.getAttribute('value') || '1', 10) || 1;
          quantity.value = String(before + 1);
          quantity.dispatchEvent(new Event('input', { bubbles: true }));
          quantity.dispatchEvent(new Event('change', { bubbles: true }));
          interactionEvents.push({ name: 'quantity_change', t_ms: elapsed(), ok: true, before, after: before + 1 });
          await sleep(750);
          sample();
          interactionSnapshot('after_quantity_change');
        } else {
          interactionEvents.push({ name: 'quantity_change', t_ms: elapsed(), ok: false, reason: 'missing_quantity_input' });
        }
      `;
    case 'variation-change':
      return `
        const selects = Array.from(document.querySelectorAll('form.variations_form select'));
        interactionSnapshot('before_variation_change');
        const select = selects.find((candidate) => Array.from(candidate.options || []).some((option) => option.value && option.value !== candidate.value));
        if (select) {
          const option = Array.from(select.options || []).find((candidate) => candidate.value && candidate.value !== select.value);
          const before = select.value;
          select.value = option.value;
          select.dispatchEvent(new Event('input', { bubbles: true }));
          select.dispatchEvent(new Event('change', { bubbles: true }));
          interactionEvents.push({ name: 'variation_change', t_ms: elapsed(), ok: true, before, after: select.value });
          await sleep(1000);
          sample();
          interactionSnapshot('after_variation_change');
        } else {
          interactionEvents.push({ name: 'variation_change', t_ms: elapsed(), ok: false, reason: 'missing_variation_select' });
        }
      `;
    default:
      return `interactionSnapshot('load_only_final');`;
  }
}
