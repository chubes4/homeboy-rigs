// Visual-parity recipe step (#538) for the Static Site Importer fixture matrix.
//
// Extracted verbatim from the former `lib/fixture-matrix.mjs` monolith as part
// of the matrix modularization (Refs #242).

import {
  DEFAULT_VISUAL_PARITY_PIXEL_THRESHOLD,
  DEFAULT_VISUAL_PARITY_CANDIDATE_URL,
  DEFAULT_VISUAL_PARITY_SOURCE_BASE_URL,
  DEFAULT_VISUAL_PARITY_VIEWPORT,
  DEFAULT_VISUAL_PARITY_WAIT_FOR,
} from '../shared/constants.mjs';
import { objectValue, finiteNumber } from '../shared/utils.mjs';

// Compose the existing `wordpress.visual-compare` recipe command into a
// per-fixture visual-parity step. This is the same command the reusable
// `runVisualParityWorkload` helper composes in homeboy-extensions; the matrix
// emits it inline alongside the import/editor steps rather than spinning up a
// separate sandbox. It renders the fixture's static source vs the imported
// WordPress candidate and writes `source.png`/`candidate.png`/`diff.png` plus
// the `mismatch_pixels`/`total_pixels` comparison that
// `collectVisualParityDiagnostics` reads back out. Source/candidate URLs are
// generic and configurable (with per-fixture overrides) — the exact servable
// source URL is the remaining live-run wiring, mirroring how the #537 editor
// step uses a configurable URL rather than resolving each imported post.
export function visualParityCompareStep(input = {}) {
  const fixture = input.fixture || {};
  const options = normalizeVisualParityRecipeOptions(input);
  const sourceUrl = input.sourceUrl
    || input.source_url
    || fixture.source_url
    || fixture.sourceUrl
    || `${options.sourceBaseUrl.replace(/\/+$/, '')}/${fixture.id || 'fixture'}/${String(options.sourceEntry).replace(/^\/+/, '')}`;
  const candidateUrl = input.candidateUrl
    || input.candidate_url
    || fixture.candidate_url
    || fixture.candidateUrl
    || options.candidateUrl;
  return {
    command: 'wordpress.visual-compare',
    args: [
      `source-url=${sourceUrl}`,
      `candidate-url=${candidateUrl}`,
      `source-label=${fixture.id ? `${fixture.id}-source` : 'source'}`,
      `candidate-label=${fixture.id ? `${fixture.id}-candidate` : 'candidate'}`,
      `viewport=${options.viewport.width}x${options.viewport.height}`,
      `full-page=${options.fullPage ? 'true' : 'false'}`,
      `wait-for=${options.waitFor}`,
      `threshold=${options.pixelThreshold}`,
    ],
  };
}

export function normalizeVisualParityRecipeOptions(input = {}) {
  const viewport = objectValue(input.visualParityViewport || input.visual_parity_viewport || input.viewport);
  return {
    pixelThreshold: finiteNumber(input.pixelThreshold ?? input.pixel_threshold ?? input.visualParityPixelThreshold ?? input.visual_parity_pixel_threshold, DEFAULT_VISUAL_PARITY_PIXEL_THRESHOLD),
    candidateUrl: input.visualParityCandidateUrl || input.visual_parity_candidate_url || input.candidateUrl || DEFAULT_VISUAL_PARITY_CANDIDATE_URL,
    sourceBaseUrl: input.visualParitySourceBaseUrl || input.visual_parity_source_base_url || input.sourceBaseUrl || DEFAULT_VISUAL_PARITY_SOURCE_BASE_URL,
    sourceEntry: input.visualParitySourceEntry || input.visual_parity_source_entry || input.sourceEntry || 'index.html',
    viewport: {
      width: finiteNumber(viewport.width, DEFAULT_VISUAL_PARITY_VIEWPORT.width),
      height: finiteNumber(viewport.height, DEFAULT_VISUAL_PARITY_VIEWPORT.height),
    },
    fullPage: input.visualParityFullPage !== false && input.visual_parity_full_page !== false && input.fullPage !== false,
    waitFor: input.visualParityWaitFor || input.visual_parity_wait_for || input.waitFor || DEFAULT_VISUAL_PARITY_WAIT_FOR,
  };
}
