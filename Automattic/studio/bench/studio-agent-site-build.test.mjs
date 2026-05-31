import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

process.env.HOMEBOY_COMPONENT_PATH ||= '/tmp/homeboy-rigs-test-component';

const {
  agentSuccessGate,
  availablePromptVariants,
  createStudioBenchRuntime,
  hiddenEditorContentDiagnostics,
  importerBlockQualityFailureDetails,
  importerBlockQualityMetrics,
  importerTimingMetrics,
  normalizeImportReport,
  promptVariantCatalog,
  restoreMissingSourceStaticFiles,
  semanticTargetMetric,
  siteBuildPrompt,
  structuralSelectorDriftDiagnostics,
  validatePromptVariantCatalog,
  VISUAL_PIXEL_DIFF_THRESHOLD,
  visualEditorParityFailureDetails,
  visualEditorParityMetrics,
} = await import('./studio-agent-site-build.bench.mjs');

const { collectLatestGeneratedTheme } = await import('./lib/design-gates.mjs');

const invocationRuntimeHelper = `data:text/javascript,${encodeURIComponent(`
export function resolveHomeboyInvocationRuntime({ namespace }) {
  const state = process.env.HOMEBOY_INVOCATION_STATE_DIR ? process.env.HOMEBOY_INVOCATION_STATE_DIR + '/' + namespace : null;
  const artifact = process.env.HOMEBOY_INVOCATION_ARTIFACT_DIR ? process.env.HOMEBOY_INVOCATION_ARTIFACT_DIR + '/' + namespace : null;
  const tmp = process.env.HOMEBOY_INVOCATION_TMP_DIR ? process.env.HOMEBOY_INVOCATION_TMP_DIR + '/' + namespace : null;
  return {
    isolated: true,
    namespace,
    invocationId: process.env.HOMEBOY_INVOCATION_ID || null,
    baseDirs: {
      state: process.env.HOMEBOY_INVOCATION_STATE_DIR || null,
      artifact: process.env.HOMEBOY_INVOCATION_ARTIFACT_DIR || null,
      tmp: process.env.HOMEBOY_INVOCATION_TMP_DIR || null,
    },
    dirs: { state, artifact, tmp },
    portRange: {
      base: Number(process.env.HOMEBOY_INVOCATION_PORT_BASE),
      max: Number(process.env.HOMEBOY_INVOCATION_PORT_MAX),
    },
    childEnv(extra = {}) {
      return {
        HOMEBOY_INVOCATION_NAMESPACE: namespace,
        HOMEBOY_INVOCATION_STATE_DIR: state,
        HOMEBOY_INVOCATION_ARTIFACT_DIR: artifact,
        HOMEBOY_INVOCATION_TMP_DIR: tmp,
        TMPDIR: tmp,
        ...extra,
      };
    },
    async prepareDirs() {},
    assertPort(port) { return Number(port); },
  };
}
`)}`;

async function withEnv(values, callback) {
  const previous = {};
  for (const key of Object.keys(values)) {
    previous[key] = process.env[key];
    if (values[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = values[key];
    }
  }

  try {
    return await callback();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

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

test('bench runtime falls back to shared-state artifacts without invocation helper', async () => {
  await withEnv(
    {
      HOMEBOY_NODEJS_INVOCATION_RUNTIME_HELPER: undefined,
    },
    async () => {
      const runtime = await createStudioBenchRuntime('/tmp/shared-state');

      assert.equal(runtime.invocationId, '');
      assert.equal(runtime.artifactDir, '/tmp/shared-state/studio-agent-site-build-artifacts');
      assert.equal(runtime.siteRoot, '/tmp/shared-state/studio-agent-site-build-artifacts/sites');
      assert.deepEqual(runtime.env, {});
      assert.equal(runtime.portBase, null);
      assert.equal(runtime.portMax, null);
    }
  );
});

test('bench runtime composes the Homeboy invocation helper output for Studio', async () => {
  await withEnv(
    {
      HOMEBOY_NODEJS_INVOCATION_RUNTIME_HELPER: invocationRuntimeHelper,
      HOMEBOY_INVOCATION_ID: 'inv-test',
      HOMEBOY_INVOCATION_STATE_DIR: '/tmp/inv/state',
      HOMEBOY_INVOCATION_ARTIFACT_DIR: '/tmp/inv/artifacts',
      HOMEBOY_INVOCATION_TMP_DIR: '/tmp/inv/tmp',
      HOMEBOY_INVOCATION_PORT_BASE: '20000',
      HOMEBOY_INVOCATION_PORT_MAX: '20009',
    },
    async () => {
      const runtime = await createStudioBenchRuntime('/tmp/shared-state');

      assert.equal(runtime.invocationId, 'inv-test');
      assert.equal(runtime.artifactDir, '/tmp/inv/artifacts');
      assert.equal(runtime.siteRoot, '/tmp/inv/state/studio-agent-site-build/sites');
      assert.equal(runtime.cliConfigDir, '/tmp/inv/state/studio-agent-site-build/cli-config');
      assert.equal(runtime.appDataDir, '/tmp/inv/state/studio-agent-site-build/appdata');
      assert.equal(runtime.processManagerHome, '/tmp/inv/state/studio-agent-site-build/daemon');
      assert.equal(runtime.tmpDir, '/tmp/inv/tmp/studio-agent-site-build');
      assert.equal(runtime.portBase, 20000);
      assert.equal(runtime.portMax, 20009);
      assert.deepEqual(runtime.env, {
        HOMEBOY_INVOCATION_NAMESPACE: 'studio-agent-site-build',
        HOMEBOY_INVOCATION_STATE_DIR: '/tmp/inv/state/studio-agent-site-build',
        HOMEBOY_INVOCATION_ARTIFACT_DIR: '/tmp/inv/artifacts/studio-agent-site-build',
        HOMEBOY_INVOCATION_TMP_DIR: '/tmp/inv/tmp/studio-agent-site-build',
        TMPDIR: '/tmp/inv/tmp/studio-agent-site-build',
        E2E: '1',
        E2E_CLI_CONFIG_PATH: '/tmp/inv/state/studio-agent-site-build/cli-config',
        E2E_APP_DATA_PATH: '/tmp/inv/state/studio-agent-site-build/appdata',
        STUDIO_PROCESS_MANAGER_HOME: '/tmp/inv/state/studio-agent-site-build/daemon',
      });
    }
  );
});

test('bench restores missing SSI source files from Studio Write tool path input', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'studio-source-restore-'));
  const sitePath = path.join(tempDir, 'site');
  const sourcePath = path.join(sitePath, 'tmp/static-site/index.html');
  const content = '<!doctype html><html><body><main>Source evidence</main></body></html>';

  try {
    await restoreMissingSourceStaticFiles(
      {
        reportPath: path.join(sitePath, 'wp-content/themes/demo/import-report.json'),
        report: {
          visual_fidelity: {
            comparison_targets: [
              {
                source_file: '/wordpress/tmp/static-site/index.html',
                comparison_hooks: {
                  render_surfaces: {
                    source_static: { url: '/wordpress/tmp/static-site/index.html' },
                  },
                },
              },
            ],
          },
        },
      },
      sitePath,
      {
        toolCalls: [
          {
            name: 'Write',
            input: {
              path: sourcePath,
              content,
            },
          },
        ],
      }
    );

    assert.equal(await readFile(sourcePath, 'utf8'), content);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('bench normalizes import reports without a reportPath', async () => {
  const importReport = normalizeImportReport({ report: { quality: {} } });

  assert.deepEqual(importReport, {
    report: { quality: {} },
    reportPath: '',
    error: '',
  });
});

test('bench source restore tolerates import reports without a reportPath', async () => {
  await restoreMissingSourceStaticFiles(
    {
      report: {
        visual_fidelity: {
          comparison_targets: [
            {
              source_file: '/wordpress/tmp/static-site/index.html',
            },
          ],
        },
      },
    },
    '/tmp/studio-site',
    { toolCalls: [] }
  );
});

test('generated-theme discovery reports missing SSI import instead of throwing', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'studio-no-import-report-'));

  try {
    await mkdir(path.join(tempDir, 'wp-content/themes'), { recursive: true });

    assert.deepEqual(await collectLatestGeneratedTheme(tempDir), {
      themeRoot: '',
      themeSlug: '',
      reportPath: '',
      error: 'No Static Site Importer report found.',
    });
  } finally {
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

test('importer timing metrics flatten SSI report performance fields', () => {
  const importReport = {
    report: {
      performance: {
        total_ms: 1234.5,
        timings: {
          convert_page_artifacts_ms: 900,
          quality_and_fidelity_analysis_ms: 40,
        },
      },
      conversion_fragments: {
        main: {
          html_bytes: 524288,
          block_bytes: 120000,
          fallback_count: 0,
          content_loss_count: 1,
          timings: {
            bfb_convert_ms: 800,
            finish_fragment_report_ms: 12,
          },
        },
      },
    },
  };

  assert.deepEqual(importerTimingMetrics(importReport), {
    importer_performance_total_ms: 1234.5,
    importer_phase_convert_page_artifacts_ms: 900,
    importer_phase_quality_and_fidelity_analysis_ms: 40,
    importer_fragment_main_html_bytes: 524288,
    importer_fragment_main_block_bytes: 120000,
    importer_fragment_main_fallback_count: 0,
    importer_fragment_main_content_loss_count: 1,
    importer_fragment_main_bfb_convert_ms: 800,
    importer_fragment_main_finish_fragment_report_ms: 12,
  });
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

test('visual pixel diff ratio hard-fails the agent success gate', () => {
  const gate = agentSuccessGate(
    { success: true, error: null, timedOut: false },
    { mismatch_count: 0 },
    { report: { quality: { core_html_block_count: 0, freeform_block_count: 0, fallback_count: 0 } } },
    { pixel_diff_ratio: VISUAL_PIXEL_DIFF_THRESHOLD + 0.034 }
  );

  assert.equal(gate.agentSucceeded, false);
  assert.equal(gate.metrics.success_rate, 0);
  assert.equal(gate.metrics.agent_error_rate, 1);
  assert.equal(gate.visualPixelDiffRatio, 0.084);
  assert.deepEqual(gate.visualPixelDiffFailureDetails, ['visual pixel diff: 0.084 (threshold: 0.050)']);
});

test('visual pixel diff ratio accepts values at the threshold', () => {
  const gate = agentSuccessGate(
    { success: true, error: null, timedOut: false },
    { mismatch_count: 0 },
    { report: { quality: { core_html_block_count: 0, freeform_block_count: 0, fallback_count: 0 } } },
    { pixel_diff_ratio: VISUAL_PIXEL_DIFF_THRESHOLD }
  );

  assert.equal(gate.agentSucceeded, true);
  assert.deepEqual(gate.visualPixelDiffFailureDetails, []);
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
