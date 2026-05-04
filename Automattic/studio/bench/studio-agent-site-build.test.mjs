import assert from 'node:assert/strict';
import test from 'node:test';

process.env.HOMEBOY_COMPONENT_PATH ||= '/tmp/homeboy-rigs-test-component';

const {
  agentSuccessGate,
  hiddenEditorContentDiagnostics,
  semanticTargetMetric,
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
