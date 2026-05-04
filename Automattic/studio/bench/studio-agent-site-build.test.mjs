import assert from 'node:assert/strict';
import test from 'node:test';

process.env.HOMEBOY_COMPONENT_PATH ||= '/tmp/homeboy-rigs-test-component';

const {
  agentSuccessGate,
  hiddenEditorContentDiagnostics,
  importerBlockQualityFailureDetails,
  importerBlockQualityMetrics,
  semanticTargetMetric,
  structuralSelectorDriftDiagnostics,
  visualEditorParityFailureDetails,
  visualEditorParityMetrics,
} = await import('./studio-agent-site-build.bench.mjs');

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

test('importer block-quality counters hard-fail the agent success gate', () => {
  const importReport = {
    report: {
      quality: {
        core_html_block_count: 4,
        freeform_block_count: 1,
        fallback_count: 4,
      },
    },
  };
  const gate = agentSuccessGate({ success: true, error: null, timedOut: false }, { mismatch_count: 0 }, importReport);

  assert.equal(gate.agentSucceeded, false);
  assert.equal(gate.metrics.success_rate, 0);
  assert.equal(gate.metrics.agent_error_rate, 1);
  assert.deepEqual(gate.importerBlockQuality, {
    importerCoreHtmlBlockCount: 4,
    importerFreeformBlockCount: 1,
    importerFallbackCount: 4,
  });
  assert.deepEqual(gate.importerBlockQualityFailureDetails, [
    'importer block quality: core/html=4, freeform=1, fallback=4',
  ]);
});

test('importer block-quality metrics use zero as the clean threshold', () => {
  const importReport = {
    report: {
      quality: {
        core_html_block_count: 0,
        freeform_block_count: 0,
        fallback_count: 0,
      },
    },
  };

  assert.deepEqual(importerBlockQualityMetrics(importReport), {
    importerCoreHtmlBlockCount: 0,
    importerFreeformBlockCount: 0,
    importerFallbackCount: 0,
  });
  assert.deepEqual(importerBlockQualityFailureDetails(importerBlockQualityMetrics(importReport)), []);
  assert.equal(
    agentSuccessGate({ success: true, error: null, timedOut: false }, { mismatch_count: 0 }, importReport).agentSucceeded,
    true
  );
});

test('editor visual parity metrics hard-fail the agent success gate', () => {
  const visualComparison = {
    visual_editor_vs_source_pixel_diff_ratio: 0.15,
    visual_editor_vs_frontend_pixel_diff_ratio: 0.14,
    visual_source_vs_frontend_pixel_diff_ratio_diagnostic: 0.03,
  };
  const gate = agentSuccessGate(
    { success: true, error: null, timedOut: false },
    { mismatch_count: 0 },
    { report: { quality: {} } },
    visualComparison
  );

  assert.equal(gate.agentSucceeded, false);
  assert.equal(gate.metrics.success_rate, 0);
  assert.equal(gate.metrics.agent_error_rate, 1);
  assert.deepEqual(gate.visualEditorParity, {
    visualEditorVsSourcePixelDiffRatio: 0.15,
    visualEditorVsFrontendPixelDiffRatio: 0.14,
    visualSourceVsFrontendPixelDiffRatio: 0.03,
    visualEditorParityErrorCount: 0,
  });
  assert.deepEqual(gate.visualEditorFailureDetails, [
    'editor render diverges from frontend (editor diff: 0.15, frontend diff: 0.03) - likely block-validation or unscoped CSS',
  ]);
});

test('editor visual parity failure details distinguish upstream conversion failures', () => {
  const visualEditorParity = visualEditorParityMetrics({
    visual_editor_vs_source_pixel_diff_ratio: 0.15,
    visual_editor_vs_frontend_pixel_diff_ratio: 0.04,
    visual_source_vs_frontend_pixel_diff_ratio_diagnostic: 0.12,
  });

  assert.deepEqual(visualEditorParityFailureDetails(visualEditorParity), [
    'editor and frontend both diverge from source (editor: 0.15, frontend: 0.12) - conversion failed before editor concern',
  ]);
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
