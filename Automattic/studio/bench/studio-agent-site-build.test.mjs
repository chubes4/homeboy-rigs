import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

process.env.HOMEBOY_COMPONENT_PATH ||= '/tmp/homeboy-rigs-test-component';

const {
  agentSuccessGate,
  availablePromptVariants,
  hiddenEditorContentDiagnostics,
  promptVariantCatalog,
  semanticTargetMetric,
  siteBuildPrompt,
  structuralSelectorDriftDiagnostics,
  validatePromptVariantCatalog,
} = await import('./studio-agent-site-build.bench.mjs');

test('site-build prompt variants are discovered from prompt files', async () => {
  const variants = await availablePromptVariants();

  assert.ok(variants.includes('restaurant'));
  assert.ok(variants.includes('studio-code'));
  assert.ok(variants.includes('static-content-library'));
  assert.deepEqual(await validatePromptVariantCatalog(), variants);
});

test('site-build prompt catalog derives variant IDs from markdown basenames', () => {
  assert.deepEqual(promptVariantCatalog(['plain-site/restaurant.md', 'static-markdown/static-content-library.md']), {
    restaurant: 'plain-site/restaurant.md',
    'static-content-library': 'static-markdown/static-content-library.md',
  });
});

test('site-build prompt catalog fails clearly for duplicate basename-derived IDs', () => {
  assert.throws(
    () => promptVariantCatalog(['plain-site/restaurant.md', 'store/restaurant.md']),
    /duplicate basename-derived variant IDs.*restaurant.*plain-site\/restaurant\.md.*store\/restaurant\.md/
  );
});

test('site-build prompt file override bypasses discovered variants', async () => {
  const previousSettings = process.env.HOMEBOY_SETTINGS_JSON;
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'studio-site-build-prompt-'));
  const promptFile = path.join(tempDir, 'custom.md');

  try {
    await writeFile(promptFile, 'Build {{sitePath}} from ${sitePath}\n');
    process.env.HOMEBOY_SETTINGS_JSON = JSON.stringify({ studio_site_build_prompt_file: promptFile });

    assert.equal(await siteBuildPrompt('/tmp/example-site'), 'Build /tmp/example-site from /tmp/example-site');
  } finally {
    if (previousSettings === undefined) {
      delete process.env.HOMEBOY_SETTINGS_JSON;
    } else {
      process.env.HOMEBOY_SETTINGS_JSON = previousSettings;
    }
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('semantic-fidelity mismatches hard-fail the agent success gate', () => {
  const gate = agentSuccessGate(
    { success: true, error: null, timedOut: false },
    {
      mismatch_count: 1,
      mismatches: [
        {
          type: 'repeated_structure',
          reason: 'repeated_structure_count_changed_materially',
          concept: 'list_item',
          source: { count: 12 },
          generated: { count: 6 },
        },
      ],
    }
  );

  assert.equal(gate.agentSucceeded, false);
  assert.equal(gate.metrics.success_rate, 0);
  assert.equal(gate.metrics.agent_error_rate, 1);
  assert.equal(gate.semanticMismatchCount, 1);
  assert.deepEqual(gate.semanticFailureDetails, [
    'semantic mismatch: list_item source=12 generated=6 reason=repeated_structure_count_changed_materially',
  ]);
});

test('zero semantic-fidelity mismatches keep successful agent runs green', () => {
  const gate = agentSuccessGate({ success: true, error: null, timedOut: false }, { mismatch_count: 0 });

  assert.equal(gate.agentSucceeded, true);
  assert.equal(gate.metrics.success_rate, 1);
  assert.equal(gate.metrics.agent_error_rate, 0);
  assert.equal(gate.semanticMismatchCount, 0);
  assert.deepEqual(gate.semanticFailureDetails, []);
});

test('semantic target metrics sum artifact target details for top-level output', () => {
  assert.equal(
    semanticTargetMetric(
      {
        diagnostics: {
          targets: [
            { optional_selector_absent_count: 2 },
            { optional_selector_absent_count: 3 },
          ],
        },
      },
      'optional_selector_absent_count'
    ),
    5
  );
});

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

test('generated-theme UX gate fails source hero structural selector drift', () => {
  const diagnostics = structuralSelectorDriftDiagnostics(
    [
      {
        source: 'styles.css',
        content: `
          header#hero {
            min-height: 90vh;
            display: grid;
            align-items: center;
          }
        `,
      },
    ],
    [
      {
        source: 'templates/index.html',
        content: '<!-- wp:group {"tagName":"div","className":"hero"} --><div class="wp-block-group hero"></div><!-- /wp:group -->',
      },
    ]
  );

  assert.equal(diagnostics.source_structural_selector_count, 1);
  assert.equal(diagnostics.missing_structural_selector_count, 1);
  assert.equal(diagnostics.missing_structural_selectors[0].selector, 'header#hero');
  assert.equal(diagnostics.missing_structural_selectors[0].reason, 'missing_generated_dom_id');
});

test('generated-theme UX gate keeps matching source hero structural selectors clean', () => {
  const diagnostics = structuralSelectorDriftDiagnostics(
    [
      {
        source: 'styles.css',
        content: 'header#hero { min-height: 90vh; display: grid; }',
      },
    ],
    [
      {
        source: 'templates/index.html',
        content: '<header id="hero" class="site-hero"><h1>Field Notes Live</h1></header>',
      },
    ]
  );

  assert.equal(diagnostics.source_structural_selector_count, 1);
  assert.equal(diagnostics.missing_structural_selector_count, 0);
});
