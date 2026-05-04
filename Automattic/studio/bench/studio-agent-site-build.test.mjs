import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

process.env.HOMEBOY_COMPONENT_PATH ||= '/tmp/homeboy-rigs-test-component';

const {
  hiddenEditorContentDiagnostics,
  scoreDesignFingerprintAgainstPrior,
  summarizeDesignNoveltyAgainstPriors,
  loadDesignNoveltyPriors,
} = await import('./studio-agent-site-build.bench.mjs');

function makeFingerprint(overrides = {}) {
  return {
    motifs: ['cards_grid', 'pricing'],
    palette_labels: ['dark_base', 'purple_lime'],
    font_families: ['Playfair Display', 'Libre Baskerville'],
    dark_theme: true,
    patterns: {
      hero_grid_background_present: true,
      type_pairing_signature: 'Playfair Display / Libre Baskerville',
      repetition_signature:
        'hero-grid-background|eyebrow-title-labels|type:playfair display / libre baskerville',
    },
    ...overrides,
  };
}

function makeMetrics(overrides = {}) {
  return {
    design_uses_dark_base: 1,
    design_uses_purple_lime: 1,
    design_uses_cards_grid: 1,
    design_hero_grid_background_present: 1,
    ...overrides,
  };
}

test('generated-theme UX gate accepts broad .reveal editor override for .reveal.hidden', () => {
  const diagnostics = hiddenEditorContentDiagnostics([
    {
      source: 'style.css',
      content: `
        .reveal.hidden { opacity: 0; transform: translateY(2rem); }
        .editor-styles-wrapper .reveal { opacity: 1 !important; transform: none !important; }
      `,
    },
  ]);

  assert.equal(diagnostics.hidden_rule_count, 1);
  assert.equal(diagnostics.editor_override_rule_count, 1);
  assert.equal(diagnostics.missing_editor_override_count, 0);
});

test('generated-theme UX gate accepts broad .hidden editor override for .reveal.hidden', () => {
  const diagnostics = hiddenEditorContentDiagnostics([
    {
      source: 'style.css',
      content: `
        .reveal.hidden { opacity: 0; transform: translateY(2rem); }
        .editor-styles-wrapper .hidden { opacity: 1 !important; transform: none !important; }
      `,
    },
  ]);

  assert.equal(diagnostics.hidden_rule_count, 1);
  assert.equal(diagnostics.editor_override_rule_count, 1);
  assert.equal(diagnostics.missing_editor_override_count, 0);
});

test('generated-theme UX gate still fails hidden reveal selectors without editor override', () => {
  const diagnostics = hiddenEditorContentDiagnostics([
    {
      source: 'style.css',
      content: '.reveal.hidden { opacity: 0; transform: translateY(2rem); }',
    },
  ]);

  assert.equal(diagnostics.hidden_rule_count, 1);
  assert.equal(diagnostics.editor_override_rule_count, 0);
  assert.equal(diagnostics.missing_editor_override_count, 1);
  assert.equal(diagnostics.missing_editor_override_rules[0].selector, '.reveal.hidden');
});

test('generated-theme UX gate does not accept narrower editor overrides for compound hidden selectors', () => {
  const diagnostics = hiddenEditorContentDiagnostics([
    {
      source: 'style.css',
      content: `
        .reveal.hidden { opacity: 0; transform: translateY(2rem); }
        .editor-styles-wrapper .card.reveal { opacity: 1 !important; transform: none !important; }
      `,
    },
  ]);

  assert.equal(diagnostics.editor_override_rule_count, 1);
  assert.equal(diagnostics.missing_editor_override_count, 1);
});

test('design novelty summary returns zeroed metrics when there are no priors', () => {
  const summary = summarizeDesignNoveltyAgainstPriors({
    currentFingerprint: makeFingerprint(),
    currentMetrics: makeMetrics(),
    priors: [],
    threshold: 0.7,
  });

  assert.equal(summary.metrics.design_repetition_prior_run_count, 0);
  assert.equal(summary.metrics.design_repetition_match_count, 0);
  assert.equal(summary.metrics.design_repetition_max_score, 0);
  assert.equal(summary.metrics.design_repetition_signal, 0);
  assert.equal(summary.metrics.design_repetition_threshold, 0.7);
  assert.deepEqual(summary.diagnostics.matches, []);
  assert.deepEqual(summary.diagnostics.recurring.repetition_tokens, []);
});

test('design novelty signal triggers when a near-identical prior exists', () => {
  const current = makeFingerprint();
  const priorFingerprint = makeFingerprint();
  const summary = summarizeDesignNoveltyAgainstPriors({
    currentFingerprint: current,
    currentMetrics: makeMetrics(),
    priors: [
      {
        artifact: '/tmp/result-prior.json',
        mtimeMs: 1,
        prompt_variant: 'event-conference',
        designFingerprint: priorFingerprint,
        metrics: makeMetrics(),
      },
    ],
    threshold: 0.7,
  });

  assert.equal(summary.metrics.design_repetition_prior_run_count, 1);
  assert.equal(summary.metrics.design_repetition_match_count, 1);
  assert.equal(summary.metrics.design_repetition_signal, 1);
  assert.ok(summary.metrics.design_repetition_max_score >= 0.95);
  assert.equal(summary.diagnostics.matches[0].artifact, '/tmp/result-prior.json');
  assert.deepEqual(summary.diagnostics.matches[0].shared.motifs, ['cards_grid', 'pricing']);
});

test('design novelty signal stays silent when fingerprints diverge', () => {
  const current = makeFingerprint();
  const priorFingerprint = {
    motifs: ['marquee'],
    palette_labels: ['cyan_teal'],
    font_families: ['Inter'],
    dark_theme: false,
    patterns: {
      hero_grid_background_present: false,
      type_pairing_signature: 'Inter / Inter',
      repetition_signature: 'type:inter / inter',
    },
  };
  const summary = summarizeDesignNoveltyAgainstPriors({
    currentFingerprint: current,
    currentMetrics: makeMetrics(),
    priors: [
      {
        artifact: '/tmp/result-divergent.json',
        mtimeMs: 1,
        prompt_variant: 'event-conference',
        designFingerprint: priorFingerprint,
        metrics: { design_uses_inter: 1 },
      },
    ],
    threshold: 0.7,
  });

  assert.equal(summary.metrics.design_repetition_match_count, 0);
  assert.equal(summary.metrics.design_repetition_signal, 0);
  assert.ok(summary.metrics.design_repetition_max_score < 0.5);
});

test('design novelty surfaces recurring tokens, motifs, and palette labels across priors', () => {
  const current = makeFingerprint();
  const priorA = makeFingerprint();
  const priorB = makeFingerprint({
    motifs: ['cards_grid'],
    palette_labels: ['dark_base'],
    patterns: {
      hero_grid_background_present: true,
      type_pairing_signature: 'Inter / Inter',
      repetition_signature: 'hero-grid-background|eyebrow-title-labels|type:inter / inter',
    },
  });
  const summary = summarizeDesignNoveltyAgainstPriors({
    currentFingerprint: current,
    currentMetrics: makeMetrics(),
    priors: [
      {
        artifact: '/tmp/result-a.json',
        mtimeMs: 2,
        prompt_variant: 'event-conference',
        designFingerprint: priorA,
        metrics: makeMetrics(),
      },
      {
        artifact: '/tmp/result-b.json',
        mtimeMs: 1,
        prompt_variant: 'event-conference',
        designFingerprint: priorB,
        metrics: makeMetrics({ design_uses_purple_lime: 0 }),
      },
    ],
    threshold: 0.7,
  });

  const recurringTokens = summary.diagnostics.recurring.repetition_tokens.map((entry) => entry.value);
  assert.ok(recurringTokens.includes('hero-grid-background'));
  assert.ok(recurringTokens.includes('eyebrow-title-labels'));
  const recurringMotifs = summary.diagnostics.recurring.motifs.map((entry) => entry.value);
  assert.ok(recurringMotifs.includes('cards_grid'));
  const recurringPalette = summary.diagnostics.recurring.palette_labels.map((entry) => entry.value);
  assert.ok(recurringPalette.includes('dark_base'));
  assert.equal(summary.diagnostics.matches.length, 2);
  // Ordering: highest score first.
  assert.ok(summary.diagnostics.matches[0].score >= summary.diagnostics.matches[1].score);
});

test('design novelty score component breakdown exposes per-axis Jaccard', () => {
  const current = makeFingerprint();
  const detail = scoreDesignFingerprintAgainstPrior({
    currentSignatureTokens: new Set([
      'hero-grid-background',
      'eyebrow-title-labels',
      'type:playfair display / libre baskerville',
    ]),
    currentMotifs: new Set(['cards_grid', 'pricing']),
    currentPalette: new Set(['dark_base', 'purple_lime']),
    currentRecipeFlags: new Set([
      'design_uses_dark_base',
      'design_uses_purple_lime',
      'design_uses_cards_grid',
      'design_hero_grid_background_present',
    ]),
    currentTypePairing: 'playfair display / libre baskerville',
    prior: {
      designFingerprint: current,
      metrics: makeMetrics(),
    },
  });

  assert.equal(detail.component_scores.repetition_tokens, 1);
  assert.equal(detail.component_scores.motifs, 1);
  assert.equal(detail.component_scores.palette_labels, 1);
  assert.equal(detail.component_scores.recipe_flags, 1);
  assert.equal(detail.component_scores.type_pairing, 1);
  assert.equal(detail.score, 1);
});

test('loadDesignNoveltyPriors reads matching prompt-variant artifacts and skips the current run', async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'design-novelty-priors-'));
  try {
    const currentPath = path.join(tmpDir, 'result-current.json');
    const matchingPath = path.join(tmpDir, 'result-matching.json');
    const otherVariantPath = path.join(tmpDir, 'result-other.json');
    const malformedPath = path.join(tmpDir, 'result-malformed.json');
    const unrelatedPath = path.join(tmpDir, 'unrelated.txt');

    await writeFile(
      currentPath,
      JSON.stringify({ prompt_variant: 'event-conference', designFingerprint: makeFingerprint() })
    );
    await writeFile(
      matchingPath,
      JSON.stringify({
        prompt_variant: 'event-conference',
        designFingerprint: makeFingerprint(),
        siteUrl: 'http://localhost:9254/',
      })
    );
    await writeFile(
      otherVariantPath,
      JSON.stringify({ prompt_variant: 'restaurant', designFingerprint: makeFingerprint() })
    );
    await writeFile(malformedPath, '{not-json');
    await writeFile(unrelatedPath, 'noise');

    const priors = await loadDesignNoveltyPriors({
      artifactDir: tmpDir,
      currentArtifactPath: currentPath,
      promptVariant: 'event-conference',
      maxPriors: 5,
    });

    assert.equal(priors.length, 1);
    assert.equal(priors[0].artifact, matchingPath);
    assert.equal(priors[0].prompt_variant, 'event-conference');
    assert.equal(priors[0].siteUrl, 'http://localhost:9254/');
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test('loadDesignNoveltyPriors returns empty array when artifact dir is missing', async () => {
  const priors = await loadDesignNoveltyPriors({
    artifactDir: '/tmp/__definitely_missing_homeboy_rigs__',
    currentArtifactPath: '',
    promptVariant: 'event-conference',
    maxPriors: 5,
  });
  assert.deepEqual(priors, []);
});
