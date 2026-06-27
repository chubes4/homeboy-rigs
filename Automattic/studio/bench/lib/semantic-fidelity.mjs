import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';

import { safeSlug, semanticComparisonTargets, stringArray, surfaceUrl } from './fidelity-targets.mjs';
import { loadNodeWorkloadUtils } from '../../../../shared/nodejs-workload-utils-loader.mjs';

const requireFromSemanticFidelity = createRequire(import.meta.url);

const { metric } = await loadNodeWorkloadUtils();


async function loadSemanticSurface(page, url) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  await page.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => {});
  await page.waitForTimeout(300);
}
function emptySemanticComparison(error = '', artifactPath = '', diagnostics = null) {
  return {
    target_count: 0,
    checked_target_count: 0,
    error_count: error ? 1 : 0,
    mismatch_count: 0,
    role_mismatch_count: 0,
    class_owner_changed_count: 0,
    interaction_group_split_count: 0,
    interaction_group_merged_count: 0,
    link_text_delta_count: 0,
    region_link_count_delta: 0,
    clickable_area_delta_ratio: 0,
    landmark_mismatch_count: 0,
    repeated_count_delta_count: 0,
    brand_logo_missing_count: 0,
    error,
    results: [],
    ...(artifactPath ? { artifact_dir: path.dirname(artifactPath), artifact: artifactPath } : {}),
    ...(diagnostics ? { diagnostics } : {}),
  };
}

function semanticTargetSelectorGroups(target) {
  const hooks = target?.comparison_hooks || {};
  const layoutProbes = hooks.layout_probes && typeof hooks.layout_probes === 'object' ? hooks.layout_probes : {};
  const groups = [];
  const seen = new Set();

  function add(name, selectors) {
    const normalizedSelectors = stringArray(selectors);
    if (!normalizedSelectors.length || seen.has(name)) {
      return;
    }
    seen.add(name);
    groups.push({ name, selectors: normalizedSelectors });
  }

  for (const [name, probe] of Object.entries(layoutProbes)) {
    add(name, probe?.selectors);
  }

  add('hero', hooks.hero);
  add('visible_chrome', hooks.visible_chrome);
  add('footer_chrome', ['footer', '.site-footer', '[class*=footer]']);
  add('brand_hooks', ['[class*=brand]', '[class*=logo]', '[class*=wordmark]']);
  add('interaction_hooks', ['a', 'button', '[role=button]', '[role=link]']);

  return groups;
}

function semanticSurfaceTotals(fingerprint) {
  const regions = fingerprint?.regions || {};
  return Object.values(regions).reduce(
    (totals, region) => {
      totals.region_link_count += Number(region?.link_count || 0);
      totals.clickable_area += Number(region?.clickable_area || 0);
      return totals;
    },
    { region_link_count: 0, clickable_area: 0 }
  );
}

function semanticFingerprintExtractor(groups) {
  const meaningfulHookPattern = /(brand|logo|wordmark|nav|menu|footer|header|hero|card|panel|cta|button|price|plan|feature|testimonial|avatar|badge|label|eyebrow|status|icon)/i;
  const landmarkSelectors = {
    header: 'header,[role=banner]',
    nav: 'nav,[role=navigation]',
    main: 'main,[role=main]',
    footer: 'footer,[role=contentinfo]',
    section: 'section',
    aside: 'aside,[role=complementary]',
  };

  function normalizeText(value, limit = 180) {
    return String(value || '').trim().replace(/\s+/g, ' ').slice(0, limit);
  }

  function visible(element) {
    const rect = element.getBoundingClientRect();
    const style = window.getComputedStyle(element);
    return (
      rect.width > 0 &&
      rect.height > 0 &&
      style.display !== 'none' &&
      style.visibility !== 'hidden' &&
      Number(style.opacity || '1') > 0
    );
  }

  function roleOf(element) {
    const explicit = element.getAttribute('role');
    if (explicit) {
      return explicit.toLowerCase();
    }
    const tag = element.tagName.toLowerCase();
    if (tag === 'a' && element.getAttribute('href')) {
      return 'link';
    }
    if (tag === 'button') {
      return 'button';
    }
    if (['input', 'select', 'textarea'].includes(tag)) {
      return 'form-control';
    }
    if (tag === 'summary') {
      return 'button';
    }
    if (['header', 'nav', 'main', 'footer', 'section', 'aside'].includes(tag)) {
      return tag;
    }
    return 'group';
  }

  function isInteractive(element) {
    const role = roleOf(element);
    const tag = element.tagName.toLowerCase();
    return role === 'link' || role === 'button' || role === 'form-control' || ['a', 'button', 'input', 'select', 'textarea', 'summary'].includes(tag);
  }

  function classTokens(element) {
    return [...element.classList].filter((token) => meaningfulHookPattern.test(token)).sort();
  }

  function childClassTokens(element) {
    return [...element.querySelectorAll('[class]')]
      .flatMap((child) => classTokens(child))
      .filter((token, index, values) => values.indexOf(token) === index)
      .sort();
  }

  function regionOf(element) {
    const region = element.closest('footer,header,nav,main,section,aside,[role=banner],[role=navigation],[role=main],[role=contentinfo]');
    if (!region) {
      return 'body';
    }
    const role = roleOf(region);
    if (role === 'banner') {
      return 'header';
    }
    if (role === 'navigation') {
      return 'nav';
    }
    if (role === 'contentinfo') {
      return 'footer';
    }
    return region.tagName.toLowerCase();
  }

  function boxOf(element) {
    const rect = element.getBoundingClientRect();
    return {
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
      area: Math.round(rect.width * rect.height),
    };
  }

  function containsLogo(element) {
    return Boolean(
      element.querySelector('img,svg,picture') ||
        /\b(?:brand|logo|wordmark)\b/i.test(element.className || '') ||
        /\b(?:logo|brand|wordmark)\b/i.test(element.getAttribute('aria-label') || '')
    );
  }

  function containsWordmark(element) {
    return Boolean(
      /\bwordmark\b/i.test(element.className || '') ||
        element.querySelector('[class*=wordmark]') ||
        normalizeText(element.textContent).length > 0
    );
  }

  function clickableDescendants(element) {
    return [...element.querySelectorAll('a[href],button,[role=button],[role=link],input,select,textarea,summary')].filter(visible);
  }

  function visualPartCount(element) {
    return [...element.children].filter((child) => visible(child)).length;
  }

  function elementSummary(element, extra = {}) {
    const clickable = clickableDescendants(element);
    const box = boxOf(element);
    return {
      tag: element.tagName.toLowerCase(),
      role: roleOf(element),
      text: normalizeText(element.textContent),
      href: element.getAttribute('href') || '',
      descendant_href: clickable.find((item) => item.getAttribute('href'))?.getAttribute('href') || '',
      own_classes: classTokens(element),
      child_classes: childClassTokens(element),
      contains_logo: containsLogo(element),
      contains_wordmark: containsWordmark(element),
      contains_image: Boolean(element.querySelector('img,picture,video')),
      contains_svg: Boolean(element.querySelector('svg')),
      clickable_descendant_count: clickable.length + (isInteractive(element) ? 1 : 0),
      child_visual_part_count: visualPartCount(element),
      wraps_multiple_visual_parts: visualPartCount(element) >= 2,
      ancestor_region: regionOf(element),
      bounding_box: box,
      ...extra,
    };
  }

  function conceptForElement(element) {
    const haystack = [element.className || '', normalizeText(element.textContent), element.getAttribute('aria-label') || ''].join(' ');
    const match = haystack.match(meaningfulHookPattern);
    return match ? match[1].toLowerCase() : '';
  }

  const landmarks = {};
  for (const [name, selector] of Object.entries(landmarkSelectors)) {
    const matches = [...document.querySelectorAll(selector)].filter(visible);
    landmarks[name] = {
      count: matches.length,
      visible_count: matches.length,
      first_text: normalizeText(matches[0]?.textContent || ''),
    };
  }

  const classOwners = [];
  for (const element of [...document.querySelectorAll('[class]')].filter(visible)) {
    const classes = classTokens(element);
    if (!classes.length) {
      continue;
    }
    classOwners.push(elementSummary(element, { selector_signature: `.${classes[0]}`, concept: conceptForElement(element) }));
  }

  const interactions = [...document.querySelectorAll('a[href],button,[role=button],[role=link],input,select,textarea,summary')]
    .filter(visible)
    .map((element) => elementSummary(element, { concept: conceptForElement(element) }));

  const regions = {};
  for (const name of ['header', 'nav', 'main', 'footer', 'section', 'aside', 'body']) {
    regions[name] = {
      link_count: 0,
      button_count: 0,
      clickable_area: 0,
      media_count: 0,
      brand_present: false,
      logo_present: false,
      text: '',
    };
  }

  for (const interaction of interactions) {
    const region = regions[interaction.ancestor_region] || regions.body;
    if (interaction.role === 'link') {
      region.link_count++;
    }
    if (interaction.role === 'button') {
      region.button_count++;
    }
    region.clickable_area += interaction.bounding_box.area;
  }

  for (const [name, region] of Object.entries(regions)) {
    const root = name === 'body' ? document.body : document.querySelector(name);
    if (!root) {
      continue;
    }
    region.media_count = root.querySelectorAll('img,svg,picture,video').length;
    region.brand_present = Boolean(root.querySelector('[class*=brand],[class*=wordmark]'));
    region.logo_present = Boolean(root.querySelector('img,svg,picture,[class*=logo]'));
    region.text = normalizeText(root.textContent, 260);
  }

  const repeated = {
    card: document.querySelectorAll('[class*=card],article').length,
    list_item: document.querySelectorAll('li').length,
    feature: document.querySelectorAll('[class*=feature]').length,
    plan: document.querySelectorAll('[class*=plan],[class*=price]').length,
    testimonial: document.querySelectorAll('[class*=testimonial]').length,
  };

  const selector_groups = [];
  for (const group of groups || []) {
    const selectors = [];
    for (const selector of group.selectors || []) {
      try {
        const matches = [...document.querySelectorAll(selector)].filter(visible);
        selectors.push({
          selector,
          count: matches.length,
          first: matches[0] ? elementSummary(matches[0], { concept: conceptForElement(matches[0]) }) : null,
        });
      } catch (error) {
        selectors.push({ selector, count: 0, first: null, error: error instanceof Error ? error.message : String(error) });
      }
    }
    selector_groups.push({ name: group.name, selectors });
  }

  return {
    url: window.location.href,
    title: document.title,
    landmarks,
    class_owners: classOwners,
    interactions,
    regions,
    repeated,
    selector_groups,
  };
}

async function evaluateSemanticSurface(page, groups) {
  return page.evaluate(semanticFingerprintExtractor, groups);
}

function semanticPrimaryClassKey(owner) {
  return owner?.own_classes?.[0] || '';
}

function semanticRole(owner) {
  return owner?.role || owner?.tag || '';
}

function semanticTextTokens(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/g, ' ')
    .split(/\s+/)
    .filter((token) => token.length >= 3);
}

function semanticHasMaterialRepeatedDelta(sourceCount, frontendCount) {
  if (sourceCount < 3 && frontendCount < 3) {
    return false;
  }
  return Math.abs(sourceCount - frontendCount) >= Math.max(3, Math.ceil(sourceCount * 0.35));
}

function semanticAllowsNavigationClassRoleChange(sourceOwner, frontendOwner) {
  const sourceRole = semanticRole(sourceOwner);
  const frontendRole = semanticRole(frontendOwner);
  const key = semanticPrimaryClassKey(sourceOwner);
  if (!/nav|menu/i.test(key) || !['group', 'list'].includes(sourceRole) || frontendRole !== 'nav') {
    return false;
  }

  return (
    Number(sourceOwner.clickable_descendant_count || 0) === Number(frontendOwner.clickable_descendant_count || 0) &&
    semanticTextTokens(sourceOwner.text).every((token) => new Set(semanticTextTokens(frontendOwner.text)).has(token))
  );
}

function semanticAllowsLinkPreservingWrapper(sourceOwner, frontendOwner) {
  if (semanticRole(sourceOwner) !== 'link' || semanticRole(frontendOwner) === 'link') {
    return false;
  }

  if (Number(frontendOwner.clickable_descendant_count || 0) < 1) {
    return false;
  }

  const sourceHref = String(sourceOwner.href || '');
  const frontendHref = String(frontendOwner.href || frontendOwner.descendant_href || '');
  if (sourceHref && sourceHref !== frontendHref) {
    return false;
  }

  const frontendTokens = new Set(semanticTextTokens(frontendOwner.text));
  return semanticTextTokens(sourceOwner.text).every((token) => frontendTokens.has(token));
}

function semanticMismatch(type, reason, source, frontend, extra = {}) {
  return {
    type,
    reason,
    region: source?.ancestor_region || frontend?.ancestor_region || extra.region || '',
    concept: source?.concept || frontend?.concept || extra.concept || '',
    selector_signature: source?.selector_signature || frontend?.selector_signature || extra.selector_signature || '',
    source,
    generated: frontend,
    ...extra,
  };
}

export function compareSemanticFingerprints(source, frontend) {
  const mismatches = [];
  const optionalSelectorAbsences = [];
  const counts = {
    role_mismatch_count: 0,
    class_owner_changed_count: 0,
    interaction_group_split_count: 0,
    interaction_group_merged_count: 0,
    link_text_delta_count: 0,
    landmark_mismatch_count: 0,
    repeated_count_delta_count: 0,
    brand_logo_missing_count: 0,
  };

  for (const landmark of ['header', 'nav', 'main', 'footer']) {
    const sourceCount = Number(source?.landmarks?.[landmark]?.visible_count || 0);
    const frontendCount = Number(frontend?.landmarks?.[landmark]?.visible_count || 0);
    if (sourceCount > 0 && frontendCount === 0) {
      counts.landmark_mismatch_count++;
      mismatches.push(
        semanticMismatch('landmark', 'landmark_disappeared', source?.landmarks?.[landmark], frontend?.landmarks?.[landmark], {
          region: landmark,
          concept: landmark,
        })
      );
    }
  }

  const frontendOwnersByClass = new Map();
  for (const owner of frontend?.class_owners || []) {
    const key = semanticPrimaryClassKey(owner);
    if (key && !frontendOwnersByClass.has(key)) {
      frontendOwnersByClass.set(key, owner);
    }
  }

  for (const sourceOwner of source?.class_owners || []) {
    const key = semanticPrimaryClassKey(sourceOwner);
    const frontendOwner = key ? frontendOwnersByClass.get(key) : null;
    if (!frontendOwner) {
      continue;
    }

    const sourceRole = semanticRole(sourceOwner);
    const frontendRole = semanticRole(frontendOwner);
    const sourceInteractive = ['link', 'button', 'form-control'].includes(sourceRole);
    const frontendInteractive = ['link', 'button', 'form-control'].includes(frontendRole);
    const roleChanged = sourceRole !== frontendRole;
    const sourceClickable = Number(sourceOwner.clickable_descendant_count || 0);
    const frontendClickable = Number(frontendOwner.clickable_descendant_count || 0);

    if (sourceRole === 'link' && frontendRole !== 'link' && !semanticAllowsLinkPreservingWrapper(sourceOwner, frontendOwner)) {
      counts.role_mismatch_count++;
      counts.class_owner_changed_count++;
      if (frontendClickable > sourceClickable) {
        counts.interaction_group_split_count++;
      }
      mismatches.push(
        semanticMismatch('class_owner', 'classed_link_became_non_link', sourceOwner, frontendOwner, {
          selector_signature: `.${key}`,
        })
      );
      continue;
    }

    if (
      roleChanged &&
      !semanticAllowsNavigationClassRoleChange(sourceOwner, frontendOwner) &&
      !semanticAllowsLinkPreservingWrapper(sourceOwner, frontendOwner) &&
      (sourceInteractive || frontendInteractive || sourceOwner.concept || frontendOwner.concept)
    ) {
      counts.role_mismatch_count++;
      counts.class_owner_changed_count++;
      mismatches.push(
        semanticMismatch('class_owner', 'meaningful_class_moved_role', sourceOwner, frontendOwner, {
          selector_signature: `.${key}`,
        })
      );
    }

    if (sourceInteractive && frontendClickable > sourceClickable + 1) {
      counts.interaction_group_split_count++;
      mismatches.push(
        semanticMismatch('interaction_group', 'source_interaction_group_split', sourceOwner, frontendOwner, {
          selector_signature: `.${key}`,
        })
      );
    } else if (!sourceInteractive && frontendInteractive && sourceClickable > frontendClickable + 1) {
      counts.interaction_group_merged_count++;
      mismatches.push(
        semanticMismatch('interaction_group', 'source_interaction_group_merged', sourceOwner, frontendOwner, {
          selector_signature: `.${key}`,
        })
      );
    }

    const sourceTokens = semanticTextTokens(sourceOwner.text);
    const frontendTokens = new Set(semanticTextTokens(frontendOwner.text));
    const missingTokens = sourceTokens.filter((token) => !frontendTokens.has(token));
    if ((sourceRole === 'link' || sourceRole === 'button') && sourceTokens.length && missingTokens.length === sourceTokens.length) {
      counts.link_text_delta_count++;
      mismatches.push(
        semanticMismatch('interaction_text', 'link_or_button_text_disappeared', sourceOwner, frontendOwner, {
          selector_signature: `.${key}`,
          missing_text_tokens: missingTokens,
        })
      );
    }
  }

  for (const [regionName, sourceRegion] of Object.entries(source?.regions || {})) {
    const frontendRegion = frontend?.regions?.[regionName];
    if (!frontendRegion) {
      continue;
    }
    const sourceHasBrandLogo = sourceRegion.brand_present && sourceRegion.logo_present;
    const frontendHasBrandLogo = frontendRegion.brand_present && frontendRegion.logo_present;
    if (['header', 'footer'].includes(regionName) && sourceHasBrandLogo && !frontendHasBrandLogo) {
      counts.brand_logo_missing_count++;
      mismatches.push(
        semanticMismatch('brand_media', 'brand_or_logo_image_disappeared', sourceRegion, frontendRegion, {
          region: regionName,
          concept: 'brand',
        })
      );
    }
  }

  for (const [name, sourceCount] of Object.entries(source?.repeated || {})) {
    const frontendCount = Number(frontend?.repeated?.[name] || 0);
    if (semanticHasMaterialRepeatedDelta(Number(sourceCount || 0), frontendCount)) {
      counts.repeated_count_delta_count++;
      mismatches.push(
        semanticMismatch('repeated_structure', 'repeated_structure_count_changed_materially', { count: sourceCount }, { count: frontendCount }, {
          concept: name,
        })
      );
    }
  }

  const frontendSelectorGroups = new Map((frontend?.selector_groups || []).map((group) => [group.name, group]));
  for (const sourceGroup of source?.selector_groups || []) {
    const frontendGroup = frontendSelectorGroups.get(sourceGroup.name);
    if (!frontendGroup) {
      continue;
    }
    const frontendSelectors = new Map((frontendGroup.selectors || []).map((selector) => [selector.selector, selector]));
    for (const sourceSelector of sourceGroup.selectors || []) {
      const frontendSelector = frontendSelectors.get(sourceSelector.selector);
      if (!frontendSelector) {
        continue;
      }
      if (sourceSelector.count === 0 && frontendSelector.count === 0) {
        optionalSelectorAbsences.push({ group: sourceGroup.name, selector: sourceSelector.selector });
      }
    }
  }

  const sourceTotals = semanticSurfaceTotals(source);
  const frontendTotals = semanticSurfaceTotals(frontend);
  const sourceArea = sourceTotals.clickable_area;
  const areaDeltaRatio = sourceArea > 0 ? Math.abs(sourceArea - frontendTotals.clickable_area) / sourceArea : 0;

  return {
    mismatch_count: mismatches.length,
    ...counts,
    region_link_count_delta: frontendTotals.region_link_count - sourceTotals.region_link_count,
    clickable_area_delta_ratio: Number(areaDeltaRatio.toFixed(4)),
    mismatches,
    optional_selector_absences: optionalSelectorAbsences,
  };
}

function buildSemanticArtifact(results, artifactPath) {
  const mismatches = [];
  const targets = [];
  for (const result of results) {
    const comparison = result.comparison || {};
    for (const mismatch of comparison.mismatches || []) {
      mismatches.push({
        target: result.source_filename || String(result.wordpress_page_id || ''),
        ...mismatch,
      });
    }
    targets.push({
      source_filename: result.source_filename || '',
      wordpress_page_id: result.wordpress_page_id || null,
      mismatch_count: Number(comparison.mismatch_count || 0),
      role_mismatch_count: Number(comparison.role_mismatch_count || 0),
      class_owner_changed_count: Number(comparison.class_owner_changed_count || 0),
      interaction_group_split_count: Number(comparison.interaction_group_split_count || 0),
      interaction_group_merged_count: Number(comparison.interaction_group_merged_count || 0),
      link_text_delta_count: Number(comparison.link_text_delta_count || 0),
      landmark_mismatch_count: Number(comparison.landmark_mismatch_count || 0),
      repeated_count_delta_count: Number(comparison.repeated_count_delta_count || 0),
      brand_logo_missing_count: Number(comparison.brand_logo_missing_count || 0),
      region_link_count_delta: Number(comparison.region_link_count_delta || 0),
      clickable_area_delta_ratio: Number(comparison.clickable_area_delta_ratio || 0),
      optional_selector_absent_count: Number(comparison.optional_selector_absences?.length || 0),
    });
  }

  return {
    artifact: artifactPath,
    target_count: results.length,
    mismatch_count: mismatches.length,
    targets,
    mismatches,
    results,
  };
}

export async function compareSemanticFidelity(importReport, artifactDir, sitePath, options = {}) {
  const targets = semanticComparisonTargets(importReport);
  if (!targets.length) {
    const semanticDir = path.join(artifactDir, 'semantic-comparisons');
    const artifactPath = path.join(semanticDir, 'semantic-fidelity-skipped.json');
    const reason = importReport?.error || 'No semantic or visual fidelity comparison targets found.';
    const artifact = {
      ...buildSemanticArtifact([], artifactPath),
      skipped: true,
      reason,
    };
    await mkdir(semanticDir, { recursive: true });
    await writeFile(artifactPath, JSON.stringify(artifact, null, 2));
    return emptySemanticComparison(reason, artifactPath, artifact);
  }

  const studioPath = options.studioPath || process.env.HOMEBOY_COMPONENT_PATH;
  if (!studioPath) {
    throw new Error('HOMEBOY_COMPONENT_PATH is required');
  }
  const playwrightPackage = path.join(studioPath, 'node_modules/@playwright/test');
  const { chromium } = requireFromSemanticFidelity(playwrightPackage);
  const semanticDir = path.join(artifactDir, 'semantic-comparisons');
  await mkdir(semanticDir, { recursive: true });

  let browser;
  const results = [];

  try {
    browser = await chromium.launch({ args: ['--ignore-certificate-errors'] });
    for (const [index, target] of targets.entries()) {
      const targetSlug = safeSlug(target.source_filename || target.wordpress_page_id, `target-${index + 1}`);
      const selectorGroups = semanticTargetSelectorGroups(target);
      const result = {
        source_filename: target.source_filename || '',
        wordpress_page_id: target.wordpress_page_id || null,
        generated_template: target.generated_template || '',
        generated_pattern: target.generated_pattern || '',
        comparison_hooks: target.comparison_hooks || {},
        surfaces: {},
        comparison: null,
        errors: [],
      };

      for (const surface of ['source_static', 'wordpress_frontend']) {
        const url = surfaceUrl(target, surface, importReport.reportPath, sitePath);
        const page = await browser.newPage({ ignoreHTTPSErrors: true, viewport: (options.viewport || { width: 1440, height: 1100 }) });
        try {
          if (!url) {
            throw new Error(`Missing ${surface} render URL.`);
          }
          await loadSemanticSurface(page, url);
          result.surfaces[surface] = {
            url,
            fingerprint: await evaluateSemanticSurface(page, selectorGroups),
          };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          result.errors.push(`${surface}: ${message}`);
          result.surfaces[surface] = { url, fingerprint: null, error: message };
        } finally {
          await page.close();
        }
      }

      if (result.surfaces.source_static?.fingerprint && result.surfaces.wordpress_frontend?.fingerprint) {
        result.comparison = compareSemanticFingerprints(
          result.surfaces.source_static.fingerprint,
          result.surfaces.wordpress_frontend.fingerprint
        );
      } else {
        result.comparison = compareSemanticFingerprints({}, {});
      }

      await writeFile(path.join(semanticDir, `${targetSlug}-semantic-fingerprint.json`), JSON.stringify(result, null, 2));
      results.push(result);
    }
  } catch (error) {
    return emptySemanticComparison(`Semantic comparison failed: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    if (browser) {
      await browser.close();
    }
  }

  const totals = results.reduce(
    (summary, result) => {
      const comparison = result.comparison || {};
      summary.error_count += result.errors.length;
      summary.checked_target_count += result.errors.length === 0 ? 1 : 0;
      summary.mismatch_count += Number(comparison.mismatch_count || 0);
      summary.role_mismatch_count += Number(comparison.role_mismatch_count || 0);
      summary.class_owner_changed_count += Number(comparison.class_owner_changed_count || 0);
      summary.interaction_group_split_count += Number(comparison.interaction_group_split_count || 0);
      summary.interaction_group_merged_count += Number(comparison.interaction_group_merged_count || 0);
      summary.link_text_delta_count += Number(comparison.link_text_delta_count || 0);
      summary.region_link_count_delta += Math.abs(Number(comparison.region_link_count_delta || 0));
      summary.clickable_area_delta_ratio += Number(comparison.clickable_area_delta_ratio || 0);
      summary.landmark_mismatch_count += Number(comparison.landmark_mismatch_count || 0);
      summary.repeated_count_delta_count += Number(comparison.repeated_count_delta_count || 0);
      summary.brand_logo_missing_count += Number(comparison.brand_logo_missing_count || 0);
      return summary;
    },
    {
      target_count: targets.length,
      checked_target_count: 0,
      error_count: 0,
      mismatch_count: 0,
      role_mismatch_count: 0,
      class_owner_changed_count: 0,
      interaction_group_split_count: 0,
      interaction_group_merged_count: 0,
      link_text_delta_count: 0,
      region_link_count_delta: 0,
      clickable_area_delta_ratio: 0,
      landmark_mismatch_count: 0,
      repeated_count_delta_count: 0,
      brand_logo_missing_count: 0,
    }
  );

  if (results.length) {
    totals.clickable_area_delta_ratio = Number((totals.clickable_area_delta_ratio / results.length).toFixed(4));
  }

  const artifactPath = path.join(semanticDir, 'semantic-fidelity.json');
  const artifact = buildSemanticArtifact(results, artifactPath);
  await writeFile(artifactPath, JSON.stringify(artifact, null, 2));

  return {
    ...totals,
    artifact_dir: semanticDir,
    artifact: artifactPath,
    diagnostics: artifact,
    results,
  };
}

export function semanticTargetMetric(semanticComparison, key) {
  return (semanticComparison?.diagnostics?.targets || semanticComparison?.targets || []).reduce(
    (sum, target) => sum + metric(target?.[key]),
    0
  );
}

export function semanticMismatchFailureDetails(semanticComparison) {
  const mismatches = semanticComparison?.diagnostics?.mismatches || semanticComparison?.mismatches || [];
  return mismatches.map((mismatch) => {
    const concept = mismatch.concept || mismatch.type || 'unknown';
    const sourceCount =
      mismatch.source && Object.hasOwn(mismatch.source, 'count') ? ` source=${mismatch.source.count}` : '';
    const generatedCount =
      mismatch.generated && Object.hasOwn(mismatch.generated, 'count') ? ` generated=${mismatch.generated.count}` : '';
    const reason = mismatch.reason ? ` reason=${mismatch.reason}` : '';
    return `semantic mismatch: ${concept}${sourceCount}${generatedCount}${reason}`;
  });
}
