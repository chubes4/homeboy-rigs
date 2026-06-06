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
  'ece-product-page-below-fold-load': {
    id: 'ece-product-page-below-fold-load',
    profile: 'below-fold-load',
    interaction: 'load-only',
    layout: 'below-fold',
    description: 'Load a product page with the cart form below the fold and record initial ECE fan-out without scrolling.',
  },
  'ece-product-page-below-fold-scroll-to-ece': {
    id: 'ece-product-page-below-fold-scroll-to-ece',
    profile: 'below-fold-scroll-to-ece',
    interaction: 'scroll-to-ece',
    layout: 'below-fold',
    description: 'Load a product page with the cart form below the fold, then scroll to ECE and record initialization.',
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
  'ece-product-page-simulated-cls': {
    id: 'ece-product-page-simulated-cls',
    profile: 'simulated-cls',
    interaction: 'load-only',
    simulatedCls: 'unreserved',
    waitFor: 'load',
    description: 'Inject a delayed ECE-like button without reserved space and record deterministic CLS.',
  },
  'ece-product-page-simulated-cls-reserved': {
    id: 'ece-product-page-simulated-cls-reserved',
    profile: 'simulated-cls-reserved',
    interaction: 'load-only',
    simulatedCls: 'reserved',
    waitFor: 'load',
    description: 'Reserve ECE button space before injecting the delayed ECE-like button and record CLS.',
  },
};

export function eceProductPageScenario(scenarioId = DEFAULT_ECE_SCENARIO_ID) {
  return SCENARIOS[scenarioId] || SCENARIOS[DEFAULT_ECE_SCENARIO_ID];
}

export function eceProductPageScenarioIds() {
  return Object.keys(SCENARIOS);
}

export function eceInteractionScript(scenario) {
  if (scenario.simulatedCls) {
    return `
      interactionSnapshot('before_simulated_cls_render');
      await sleep(250);
      if (typeof window.__homeboyStripeEceSimulateButton === 'function') {
        window.__homeboyStripeEceSimulateButton();
        interactionEvents.push({ name: 'simulated_cls_render', t_ms: elapsed(), ok: true, reserved: ${scenario.simulatedCls === 'reserved' ? 'true' : 'false'} });
        await sleep(500);
        sample();
        interactionSnapshot('after_simulated_cls_render');
      } else {
        interactionEvents.push({ name: 'simulated_cls_render', t_ms: elapsed(), ok: false, reason: 'missing_simulated_cls_hook' });
      }
    `;
  }

  switch (scenario.interaction) {
    case 'scroll-to-ece':
      return `
        const container = document.querySelector('#wc-stripe-express-checkout-element');
        const scrollTarget = container?.closest('form.cart') || container?.closest('.summary') || container?.parentElement || container;
        interactionSnapshot('before_scroll_to_ece');
        if (scrollTarget) {
          scrollTarget.scrollIntoView({ block: 'center', inline: 'nearest' });
          interactionEvents.push({ name: 'scroll_to_ece', t_ms: elapsed(), ok: true });
          await sleep(1500);
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

export function eceLayoutScript(scenario) {
  if (scenario.layout !== 'below-fold') {
    return '';
  }

  return `
    const installBelowFoldLayout = () => {
      if (document.getElementById('homeboy-ece-below-fold-layout')) {
        return;
      }

      const style = document.createElement('style');
      style.id = 'homeboy-ece-below-fold-layout';
      style.textContent = 'form.cart { margin-top: 1400px !important; }';
      document.head.appendChild(style);
    };

    if (document.head) {
      installBelowFoldLayout();
    } else {
      document.addEventListener('DOMContentLoaded', installBelowFoldLayout, { once: true });
    }
  `;
}

export function eceSimulatedClsScript(scenario) {
  if (!scenario.simulatedCls) {
    return '';
  }

  const reserveSpace = scenario.simulatedCls === 'reserved';

  return `
    const installSimulatedClsProfile = () => {
      if (window.__homeboyStripeEceSimulatedClsInstalled) {
        return;
      }
      window.__homeboyStripeEceSimulatedClsInstalled = true;

      const style = document.createElement('style');
      style.id = 'homeboy-stripe-ece-simulated-cls-style';
      style.textContent = [
        '#wc-stripe-express-checkout-element { display: block !important; width: 100% !important; ${reserveSpace ? 'min-height: 48px !important;' : ''} }',
        '#wc-stripe-express-checkout-element-wallets-link { display: block !important; width: 100% !important; ${reserveSpace ? 'min-height: 48px !important;' : ''} }',
        '.homeboy-stripe-ece-simulated-button { display: block; width: 100%; height: 48px; margin: 0; border: 0; border-radius: 4px; background: #111; color: #fff; font: 600 16px/48px system-ui, sans-serif; text-align: center; }',
        '.homeboy-stripe-ece-cls-sentinel { display: block; height: 120px; margin-top: 12px; padding: 16px; background: #f3f4f6; color: #111827; box-sizing: border-box; }',
      ].join('\\n');
      document.head.appendChild(style);

      const ensureContainers = () => {
        let root = document.querySelector('#wc-stripe-express-checkout-element');
        if (!root) {
          const anchor = document.querySelector('form.cart') || document.querySelector('.summary') || document.body;
          if (!anchor) {
            return null;
          }
          root = document.createElement('div');
          root.id = 'wc-stripe-express-checkout-element';
          root.setAttribute('data-homeboy-simulated-ece-root', '1');
          anchor.insertAdjacentElement(anchor.matches?.('form.cart') ? 'beforebegin' : 'afterbegin', root);
        }
        if (!root) {
          return null;
        }

        let grouped = document.querySelector('#wc-stripe-express-checkout-element-wallets-link');
        if (!grouped) {
          grouped = document.createElement('div');
          grouped.id = 'wc-stripe-express-checkout-element-wallets-link';
          root.appendChild(grouped);
        }

        let sentinel = document.querySelector('.homeboy-stripe-ece-cls-sentinel');
        if (!sentinel) {
          sentinel = document.createElement('div');
          sentinel.className = 'homeboy-stripe-ece-cls-sentinel';
          sentinel.textContent = 'Homeboy deterministic CLS sentinel below simulated ECE.';
          root.insertAdjacentElement('afterend', sentinel);
        }

        return { root, grouped, sentinel };
      };

      const renderButton = () => {
        const containers = ensureContainers();
        if (!containers || containers.grouped.querySelector('.homeboy-stripe-ece-simulated-button')) {
          return;
        }

        const probe = window.__wcStripeEceRenderProbe;
        if (probe) {
          probe.cls = 0;
          probe.layoutShifts = [];
          probe.events?.push({
            name: 'simulated_cls_reset',
            t_ms: Math.round(performance.now() - probe.startedAt),
            data: { reserved: ${reserveSpace ? 'true' : 'false'} },
          });
        }

        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'homeboy-stripe-ece-simulated-button';
        button.textContent = 'Simulated Express Checkout';
        containers.grouped.appendChild(button);
        probe?.events?.push({
          name: 'simulated_ece_button_inserted',
          t_ms: Math.round(performance.now() - probe.startedAt),
          data: { reserved: ${reserveSpace ? 'true' : 'false'} },
        });
      };

      const waitForContainer = () => {
        if (ensureContainers()) {
          window.__homeboyStripeEceSimulateButton = renderButton;
          return;
        }
        window.setTimeout(waitForContainer, 50);
      };

      waitForContainer();
    };

    if (document.head) {
      installSimulatedClsProfile();
    } else {
      document.addEventListener('DOMContentLoaded', installSimulatedClsProfile, { once: true });
    }
  `;
}
