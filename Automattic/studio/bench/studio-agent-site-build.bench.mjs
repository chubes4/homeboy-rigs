import { mkdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';

import {
  agentAuthoredBlockMetrics,
  collectGeneratedThemeUxGates,
  collectLatestImportReport,
  collectThemeBlockDocuments,
  importerTimingMetrics,
  nativeBlockQualityMetrics,
  probeQuality,
} from './lib/wordpress-quality.mjs';

import { collectDesignFingerprint } from './lib/design-gates.mjs';

export {
  agentAuthoredBlockMetrics,
  importerTimingMetrics,
  nativeBlockQualityMetrics,
} from './lib/wordpress-quality.mjs';

export { extractDesignPatternFingerprint } from './lib/design-gates.mjs';

export {
  hiddenEditorContentDiagnostics,
  reportedFreeformBlockCount,
  structuralSelectorDriftDiagnostics,
} from './lib/design-gates.mjs';

import { compareVisualFidelity, VISUAL_VIEWPORT } from './lib/visual-fidelity.mjs';
export { compareVisualFidelity } from './lib/visual-fidelity.mjs';

import {
  compareSemanticFidelity as compareSemanticFidelityImpl,
  semanticTargetMetric,
} from './lib/semantic-fidelity.mjs';
export { compareSemanticFingerprints, semanticMismatchFailureDetails, semanticTargetMetric } from './lib/semantic-fidelity.mjs';

import { comparisonTargets, resolveSourceStaticFile } from './lib/fidelity-targets.mjs';
export { resolveSourceStaticFile } from './lib/fidelity-targets.mjs';

import {
  PROMPT_CATEGORY,
  createFreshSite,
  createStudioBenchRuntime,
  evalModel,
  prepareStudioRuntime,
  runCli,
  runEval,
  siteBuildPrompt,
  siteStatus,
  statusPort,
  systemPromptFingerprint,
  variant,
  workflowBenchScenario,
  workflowBenchScenarioId,
  workflowBenchScenarios,
} from './lib/site-build-runtime.mjs';

export {
  createStudioBenchRuntime,
  siteBuildPrompt,
  workflowBenchScenario,
  workflowBenchScenarioId,
  workflowBenchScenarios,
} from './lib/site-build-runtime.mjs';

import {
  agentSuccessGate,
  importerBlockQualityMetrics,
  importerBlockQualityFailureDetails,
  VISUAL_PIXEL_DIFF_THRESHOLD,
  visualEditorParityMetrics,
  visualEditorParityFailureDetails,
  visualPixelDiffFailureDetails,
} from './lib/site-build-gates.mjs';

export {
  agentSuccessGate,
  importerBlockQualityMetrics,
  importerBlockQualityFailureDetails,
  VISUAL_PIXEL_DIFF_THRESHOLD,
  visualEditorParityMetrics,
  visualEditorParityFailureDetails,
  visualPixelDiffFailureDetails,
} from './lib/site-build-gates.mjs';

const requireFromBench = createRequire(import.meta.url);

export function normalizeImportReport(importReport) {
  return {
    report: null,
    error: '',
    ...(importReport && typeof importReport === 'object' ? importReport : {}),
    reportPath: typeof importReport?.reportPath === 'string' ? importReport.reportPath : '',
  };
}

export async function restoreMissingSourceStaticFiles(importReport, sitePath, result) {
  const normalizedImportReport = normalizeImportReport(importReport);
  const writes = new Map();
  for (const call of Array.isArray(result?.toolCalls) ? result.toolCalls : []) {
    const filePath = call?.input?.file_path || call?.input?.path || '';
    if (call?.name !== 'Write' || typeof filePath !== 'string' || typeof call?.input?.content !== 'string') {
      continue;
    }
    writes.set(path.resolve(filePath), call.input.content);
  }

  if (!writes.size) {
    return;
  }

  for (const target of comparisonTargets(normalizedImportReport)) {
    const surfaces = target?.comparison_hooks?.render_surfaces || {};
    const sourceFile = surfaces.source_static?.url || target?.source_file || '';
    const hostPath = resolveSourceStaticFile(sourceFile, normalizedImportReport.reportPath, sitePath);
    if (!hostPath) {
      continue;
    }

    try {
      await stat(hostPath);
      continue;
    } catch {
      // Restore only files the agent authored during this benchmark run.
    }

    const content = writes.get(path.resolve(hostPath));
    if (typeof content !== 'string') {
      continue;
    }

    await mkdir(path.dirname(hostPath), { recursive: true });
    await writeFile(hostPath, content);
  }
}

export async function compareSemanticFidelity(importReport, artifactDir, sitePath) {
  return compareSemanticFidelityImpl(normalizeImportReport(importReport), artifactDir, sitePath, {
    studioPath: STUDIO_PATH,
    viewport: VISUAL_VIEWPORT,
  });
}

function designFingerprintMetrics(fingerprint) {
  const motifs = new Set(fingerprint?.motifs || []);
  const paletteLabels = new Set(fingerprint?.palette_labels || []);
  const fonts = (fingerprint?.font_families || []).map((font) => font.toLowerCase());
  const patterns = fingerprint?.patterns || {};

  return {
    design_source_html_present: fingerprint?.source_html_present ? 1 : 0,
    design_css_file_count: Number(fingerprint?.css_file_count || 0),
    design_font_unique_count: Number(fingerprint?.font_families?.length || 0),
    design_color_unique_count: Number(fingerprint?.color_values?.length || 0),
    design_css_variable_count: Number(fingerprint?.css_variables?.length || 0),
    design_motif_count: Number(fingerprint?.motifs?.length || 0),
    design_palette_label_count: Number(fingerprint?.palette_labels?.length || 0),
    design_gradient_count: Number(fingerprint?.gradient_count || 0),
    design_animation_count: Number(fingerprint?.animation_count || 0),
    design_transition_count: Number(fingerprint?.transition_count || 0),
    design_hero_grid_background_count: Number(patterns.hero_grid_background_count || 0),
    design_hero_grid_background_present: patterns.hero_grid_background_present ? 1 : 0,
    design_stacked_full_width_section_count: Number(patterns.stacked_full_width_section_count || 0),
    design_panel_section_count: Number(patterns.panel_section_count || 0),
    design_eyebrow_label_count: Number(patterns.eyebrow_label_count || 0),
    design_sections_with_eyebrow_title_count: Number(patterns.sections_with_eyebrow_title_count || 0),
    design_font_family_count: Number(patterns.font_family_count || fingerprint?.font_families?.length || 0),
    design_uses_inter: fonts.includes('inter') ? 1 : 0,
    design_uses_syne: fonts.includes('syne') ? 1 : 0,
    design_uses_space_grotesk: fonts.includes('space grotesk') ? 1 : 0,
    design_uses_purple_lime: paletteLabels.has('purple_lime') ? 1 : 0,
    design_uses_dark_base: paletteLabels.has('dark_base') || fingerprint?.dark_theme ? 1 : 0,
    design_uses_bento_grid: motifs.has('bento_grid') ? 1 : 0,
    design_uses_cards_grid: motifs.has('cards_grid') ? 1 : 0,
    design_uses_code_preview: motifs.has('code_preview') ? 1 : 0,
    design_uses_dashboard_mockup: motifs.has('dashboard_mockup') ? 1 : 0,
    design_uses_glow_overlay: motifs.has('glow_overlay') ? 1 : 0,
    design_uses_marquee: motifs.has('marquee') ? 1 : 0,
    design_uses_terminal_window: motifs.has('terminal_window') ? 1 : 0,
  };
}

async function validateThemeBlocks(sitePath, siteUrl) {
  const documents = await collectThemeBlockDocuments(sitePath);
  if (documents.length === 0) {
    return {
      document_count: 0,
      total_blocks: 0,
      valid_blocks: 0,
      invalid_blocks: 0,
      error: 'No generated theme block documents found.',
      results: [],
    };
  }

  const playwrightPackage = path.join(STUDIO_PATH, 'node_modules/@playwright/test');
  const { chromium } = requireFromBench(playwrightPackage);
  let browser;
  let page;

  try {
    browser = await chromium.launch({ args: ['--ignore-certificate-errors'] });
    page = await browser.newPage({ ignoreHTTPSErrors: true });
    const normalizedSiteUrl = siteUrl.replace(/\/+$/, '');
    await page.goto(`${normalizedSiteUrl}/studio-auto-login?redirect_to=%2Fwp-admin%2Fpost-new.php`, {
      waitUntil: 'domcontentloaded',
      timeout: 30_000,
    });
    await page.waitForFunction(
      () => {
        try {
          const wp = window.wp;
          return (
            wp &&
            wp.blocks &&
            typeof wp.blocks.getBlockTypes === 'function' &&
            wp.blocks.getBlockTypes().length > 0
          );
        } catch {
          return false;
        }
      },
      { timeout: 30_000 }
    );

    const report = await page.evaluate((docs) => {
      const wpBlocks = window.wp?.blocks;
      const results = [];

      function issueStrings(validationIssues) {
        const issues = [];
        for (const issue of validationIssues || []) {
          if (!issue?.args) {
            continue;
          }
          const message = String(issue.args[0] || '');
          if (message.startsWith('Block validation failed')) {
            continue;
          }
          issues.push(
            issue.args
              .map((arg) => (typeof arg === 'object' ? JSON.stringify(arg).slice(0, 200) : String(arg).slice(0, 500)))
              .join(' ')
          );
        }
        return issues;
      }

      function validateRecursive(block, source) {
        if (!block?.name || block.name === 'core/freeform' || block.name === 'core/missing') {
          return;
        }

        const blockType = wpBlocks.getBlockType(block.name);
        let isValid = true;
        let issues = [];
        let expectedContent;

        if (!blockType) {
          isValid = false;
          issues = [`Block type "${block.name}" is not registered.`];
        } else {
          const validation = wpBlocks.validateBlock(block, blockType);
          if (Array.isArray(validation)) {
            isValid = validation[0];
            if (!isValid) {
              issues = issueStrings(validation[1]);
            }
          } else {
            isValid = validation.isValid;
            if (!isValid) {
              issues = issueStrings(validation.validationIssues);
            }
          }

          if (!isValid) {
            try {
              expectedContent = wpBlocks.getSaveContent(blockType, block.attributes, block.innerBlocks);
            } catch {
              expectedContent = undefined;
            }
          }
        }

        results.push({
          source,
          blockName: block.name,
          isValid,
          issues,
          originalContent: block.originalContent || '',
          expectedContent,
        });

        for (const inner of block.innerBlocks || []) {
          validateRecursive(inner, source);
        }
      }

      for (const doc of docs) {
        for (const block of wpBlocks.parse(doc.content)) {
          validateRecursive(block, doc.source);
        }
      }

      const validBlocks = results.filter((result) => result.isValid).length;
      return {
        document_count: docs.length,
        total_blocks: results.length,
        valid_blocks: validBlocks,
        invalid_blocks: results.length - validBlocks,
        results,
      };
    }, documents);

    await page.close();
    return report;
  } catch (error) {
    let diagnostics = '';
    if (page && !page.isClosed()) {
      try {
        diagnostics = await page.evaluate(() => {
          const wp = window.wp;
          return JSON.stringify({
            url: window.location.href,
            title: document.title,
            bodyClass: document.body?.className || '',
            hasWp: typeof wp !== 'undefined',
            hasBlocks: !!wp?.blocks,
            blockTypeCount: wp?.blocks?.getBlockTypes?.()?.length || 0,
          });
        });
      } catch (diagnosticError) {
        diagnostics = `diagnostics failed: ${diagnosticError instanceof Error ? diagnosticError.message : String(diagnosticError)}`;
      }
    }

    return {
      document_count: documents.length,
      total_blocks: 0,
      valid_blocks: 0,
      invalid_blocks: 0,
      error: `Editor block validation failed: ${error instanceof Error ? error.message : String(error)}${diagnostics ? `; ${diagnostics}` : ''}`,
      results: [],
    };
  } finally {
    if (browser) {
      await browser.close();
    }
  }
}

function validationMetrics(result) {
  const toolCalls = Array.isArray(result.toolCalls) ? result.toolCalls : [];
  const toolResults = Array.isArray(result.toolResults) ? result.toolResults : [];
  const validateCallCount = toolCalls.filter((item) => item && item.name === 'validate_blocks').length;
  const validateResults = toolResults.filter((item) => item && item.toolName === 'validate_blocks');
  const validateErrorCount = validateResults.filter((item) => item.isError === true).length;
  const validatedAllCount = validateResults.filter((item) => {
    const text = typeof item.text === 'string' ? item.text : '';
    const match = text.match(/Validation:\s+(\d+)\/(\d+)\s+blocks valid/i);
    return match && match[1] === match[2];
  }).length;

  return { validateCallCount, validateErrorCount, validatedAllCount };
}

function metric(value) {
  const number = Number(value ?? 0);
  return Number.isFinite(number) ? number : 0;
}

function toolMetrics(result) {
  const toolEvents = Array.isArray(result.toolEvents) ? result.toolEvents : [];
  const names = ['site_info', 'wp_cli', 'validate_blocks', 'take_screenshot', 'Write', 'Edit'];
  const metrics = {
    tool_event_count: toolEvents.length,
    max_tool_duration_ms: 0,
  };

  for (const event of toolEvents) {
    const duration = metric(event?.durationMs);
    if (duration > metrics.max_tool_duration_ms) {
      metrics.max_tool_duration_ms = duration;
    }
  }

  for (const name of names) {
    const events = toolEvents.filter((event) => event && event.toolName === name);
    const durations = events.map((event) => metric(event?.durationMs)).filter((value) => value > 0);
    const key = name.toLowerCase().replace(/[^a-z0-9]+/g, '_');
    metrics[`${key}_tool_count`] = events.length;
    metrics[`${key}_error_count`] = events.filter((event) => event.isError === true).length;
    metrics[`${key}_duration_ms`] = durations.reduce((sum, value) => sum + value, 0);
    metrics[`${key}_max_duration_ms`] = durations.length ? Math.max(...durations) : 0;
  }

  return metrics;
}

function optionalArtifactPath(name, value) {
  return typeof value === 'string' && value.length > 0 ? { [name]: value } : {};
}


export default async function studioAgentSiteBuildBench() {
  const runtime = await createStudioBenchRuntime();
  const currentVariant = variant();
  const runId = `${currentVariant}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const artifactDir = runtime.artifactDir;
  const sitePath = path.join(runtime.siteRoot, runId);
  await prepareStudioRuntime(runtime);
  await mkdir(runtime.siteRoot, { recursive: true });

  const totalStarted = Date.now();
  const siteCreateStarted = Date.now();
  await createFreshSite(sitePath);
  const siteCreateMs = Date.now() - siteCreateStarted;

  const selectedWorkflowBenchScenario = await workflowBenchScenario();
  const selectedWorkflowBenchScenarioId = workflowBenchScenarioId();
  const systemPrompt = await systemPromptFingerprint();
  const prompt = await siteBuildPrompt(sitePath);
  const model = evalModel();
  const agentStarted = Date.now();
  const { result, resultFile, exitCode, stderr } = await runEval(prompt, {
    maxTurns: 40,
    timeoutMs: 420000,
    ...(model ? { model } : {}),
  });
  const agentElapsedMs = Date.now() - agentStarted;
  const qualityProbeStarted = Date.now();
  const quality = await probeQuality(sitePath, { runCli });
  const qualityProbeMs = Date.now() - qualityProbeStarted;
  const status = await siteStatus(sitePath);
  runtime.assertPort(statusPort(status));
  const importReport = normalizeImportReport(await collectLatestImportReport(sitePath));
  const importerTimings = importerTimingMetrics(importReport);
  await mkdir(artifactDir, { recursive: true });
  await restoreMissingSourceStaticFiles(importReport, sitePath, result);
  const visualComparisonStarted = Date.now();
  const visualComparison = await compareVisualFidelity(importReport, artifactDir, sitePath);
  const visualComparisonMs = Date.now() - visualComparisonStarted;
  const semanticComparisonStarted = Date.now();
  const semanticComparison = await compareSemanticFidelity(importReport, artifactDir, sitePath);
  const semanticComparisonMs = Date.now() - semanticComparisonStarted;
  const editorValidationStarted = Date.now();
  const editorValidation = await validateThemeBlocks(sitePath, status.siteUrl);
  const editorValidationMs = Date.now() - editorValidationStarted;
  const generatedThemeUxStarted = Date.now();
  const generatedThemeUxGates = await collectGeneratedThemeUxGates(sitePath, importReport, artifactDir);
  const generatedThemeUxMs = Date.now() - generatedThemeUxStarted;
  const totalElapsedMs = Date.now() - totalStarted;
  const validation = validationMetrics(result);
  const authoredBlocks = agentAuthoredBlockMetrics(result);
  const nativeBlockQuality = nativeBlockQualityMetrics(quality, authoredBlocks, editorValidation, importReport);
  const designFingerprint = await collectDesignFingerprint(sitePath);
  const designMetrics = designFingerprintMetrics(designFingerprint);
  const gate = agentSuccessGate(result, semanticComparison, importReport, visualComparison);
  const semanticMismatchCount = gate.semanticMismatchCount;
  const semanticOptionalSelectorAbsentCount = semanticTargetMetric(semanticComparison, 'optional_selector_absent_count');
  const failureDetails = [
    ...gate.semanticFailureDetails,
    ...gate.importerBlockQualityFailureDetails,
    ...gate.visualEditorFailureDetails,
    ...gate.visualPixelDiffFailureDetails,
  ];
  const { importerCoreHtmlBlockCount, importerFreeformBlockCount, importerFallbackCount } = gate.importerBlockQuality;

  const artifactFile = path.join(artifactDir, `result-${runId}.json`);
  await writeFile(
    artifactFile,
    JSON.stringify(
      {
        variant: currentVariant,
        homeboy_invocation_id: runtime.invocationId,
        homeboy_invocation_port_range: runtime.portBase !== null ? `${runtime.portBase}-${runtime.portMax}` : '',
        workflow_bench_scenario_id: selectedWorkflowBenchScenarioId,
        workflow_bench_scenario_title: selectedWorkflowBenchScenario.title,
        prompt_category: PROMPT_CATEGORY,
        model,
        ...systemPrompt,
        prompt,
        sitePath,
        siteUrl: status.siteUrl,
        autoLoginUrl: status.autoLoginUrl,
        exitCode,
        stderr,
        resultFile,
        result,
        timings: {
          site_create_ms: siteCreateMs,
          agent_elapsed_ms: agentElapsedMs,
          quality_probe_ms: qualityProbeMs,
          visual_comparison_ms: visualComparisonMs,
          semantic_comparison_ms: semanticComparisonMs,
          editor_validation_ms: editorValidationMs,
          generated_theme_ux_ms: generatedThemeUxMs,
          total_elapsed_ms: totalElapsedMs,
        },
        quality,
        importReport,
        visualComparison,
        semanticComparison,
        editorValidation,
        generatedThemeUxGates,
        designFingerprint,
        authoredBlocks,
        nativeBlockQuality,
        validation,
      },
      null,
      2
    )
  );

  const toolCalls = Array.isArray(result.toolCalls) ? result.toolCalls : [];
  const toolResults = Array.isArray(result.toolResults) ? result.toolResults : [];
  const turnDurations = Array.isArray(result.turnDurationsMs) ? result.turnDurationsMs : [];
  const phaseTimings = result.phaseTimingsMs && typeof result.phaseTimingsMs === 'object' ? result.phaseTimingsMs : {};
  const toolBreakdown = toolMetrics(result);
  // result.error and result.timedOut land in the eval-runner JSON via
  // Automattic/studio#3330. Both are nullish on Studio versions older than
  // that PR, which collapses the AND to result.success === true (the same
  // gate the bench had before). On versions with #3330, the bench correctly
  // distinguishes successful runs from runs that finished with a runner-side
  // exception, and from runs that timed out. timed_out is surfaced as its
  // own metric so timeout regressions are visible separately from agent
  // failures.
  // Issue #60: Static Site Importer can produce a syntactically valid theme
  // while dropping meaningful source content. Any semantic-fidelity mismatch
  // means the generated site no longer preserves the source fixture, so the
  // correct threshold for this bench is zero mismatches rather than warnings.

  return {
    metrics: {
      ...gate.metrics,
      elapsed_ms: totalElapsedMs,
      site_create_ms: siteCreateMs,
      agent_elapsed_ms: agentElapsedMs,
      quality_probe_ms: qualityProbeMs,
      visual_comparison_ms: visualComparisonMs,
      semantic_comparison_ms: semanticComparisonMs,
      editor_validation_ms: editorValidationMs,
      generated_theme_ux_ms: generatedThemeUxMs,
      total_elapsed_ms: totalElapsedMs,
      phase_resolve_initial_provider_ms: metric(phaseTimings.resolve_initial_provider_ms),
      phase_resolve_unavailable_provider_ms: metric(phaseTimings.resolve_unavailable_provider_ms),
      phase_resolve_ai_environment_ms: metric(phaseTimings.resolve_ai_environment_ms),
      phase_start_ai_agent_ms: metric(phaseTimings.start_ai_agent_ms),
      phase_first_assistant_message_ms: metric(phaseTimings.first_assistant_message_ms),
      phase_total_eval_ms: metric(phaseTimings.total_eval_ms),
      turn_count: Number(result.numTurns ?? turnDurations.length ?? 0),
      assistant_message_count: turnDurations.length,
      max_turn_ms: turnDurations.length ? Math.max(...turnDurations) : 0,
      tool_call_count: toolCalls.length,
      tool_error_count: toolResults.filter((item) => item && item.isError === true).length,
      ...toolBreakdown,
      validate_call_count: validation.validateCallCount,
      validate_error_count: validation.validateErrorCount,
      validated_all_count: validation.validatedAllCount,
      ...authoredBlocks,
      native_block_quality_pass: nativeBlockQuality.native_block_quality_pass ? 1 : 0,
      native_block_quality_failure_count: nativeBlockQuality.native_block_quality_failure_count,
      generated_theme_ux_quality_pass: generatedThemeUxGates.generated_theme_ux_quality_pass ? 1 : 0,
      generated_theme_ux_quality_failure_count: Number(generatedThemeUxGates.generated_theme_ux_quality_failure_count || 0),
      generated_theme_actual_freeform_block_count: Number(generatedThemeUxGates.actual_freeform_block_count || 0),
      generated_theme_importer_freeform_block_count: Number(generatedThemeUxGates.importer_freeform_block_count || 0),
      generated_theme_freeform_report_mismatch_count: Number(generatedThemeUxGates.freeform_report_mismatch_count || 0),
      generated_theme_css_hidden_editor_content_count: Number(generatedThemeUxGates.css_hidden_editor_content_count || 0),
      generated_theme_css_editor_reveal_override_count: Number(generatedThemeUxGates.css_editor_reveal_override_count || 0),
      generated_theme_css_hidden_editor_content_without_override_count: Number(
        generatedThemeUxGates.css_hidden_editor_content_without_override_count || 0
      ),
      editor_validation_document_count: Number(editorValidation.document_count || 0),
      editor_validation_total_blocks: Number(editorValidation.total_blocks || 0),
      editor_validation_valid_blocks: Number(editorValidation.valid_blocks || 0),
      editor_validation_invalid_blocks: Number(editorValidation.invalid_blocks || 0),
      editor_validation_error_count: editorValidation.error ? 1 : 0,
      importer_report_error_count: importReport.error ? 1 : 0,
      importer_fallback_count: importerFallbackCount,
      importer_core_html_block_count: importerCoreHtmlBlockCount,
      importer_freeform_block_count: importerFreeformBlockCount,
      importer_invalid_block_count: Number(importReport.report?.quality?.invalid_block_count || 0),
      importer_invalid_block_document_count: Number(importReport.report?.quality?.invalid_block_document_count || 0),
      importer_generated_block_document_count: Number(importReport.report?.generated_theme?.block_documents?.length || 0),
      ...importerTimings,
      system_prompt_size_bytes: systemPrompt.system_prompt_size_bytes,
      visual_comparison_target_count: Number(visualComparison.target_count || 0),
      visual_comparison_checked_target_count: Number(visualComparison.checked_target_count || 0),
      visual_comparison_error_count: Number(visualComparison.error_count || 0),
      visual_editor_vs_source_pixel_diff_ratio: metric(visualComparison.visual_editor_vs_source_pixel_diff_ratio),
      visual_editor_vs_frontend_pixel_diff_ratio: metric(visualComparison.visual_editor_vs_frontend_pixel_diff_ratio),
      visual_editor_parity_error_count: Number(visualComparison.visual_editor_parity_error_count || 0),
      visual_missing_selector_count: Number(visualComparison.missing_selector_count || 0),
      visual_visibility_mismatch_count: Number(visualComparison.visibility_mismatch_count || 0),
      visual_nonzero_bounding_box_count: Number(visualComparison.nonzero_bounding_box_count || 0),
      visual_nonzero_bounding_box_mismatch_count: Number(visualComparison.nonzero_bounding_box_mismatch_count || 0),
      visual_mismatch_detail_count: Number(visualComparison.diagnostics?.mismatch_count || 0),
      visual_optional_probe_absent_count: Number(visualComparison.diagnostics?.optional_probe_absent_count || 0),
      visual_simple_probe_parity_mismatch_count: Number(visualComparison.simple_probe_parity_mismatch_count || 0),
      visual_nav_probe_parity_mismatch_count: Number(visualComparison.nav_probe_parity_mismatch_count || 0),
      visual_footer_probe_parity_mismatch_count: Number(visualComparison.footer_probe_parity_mismatch_count || 0),
      visual_hero_probe_parity_mismatch_count: Number(visualComparison.hero_probe_parity_mismatch_count || 0),
      visual_pixel_diff_ratio: gate.visualPixelDiffRatio,
      visual_pixel_diff_pixel_count: Number(visualComparison.pixel_diff_pixel_count || 0),
      semantic_comparison_target_count: Number(semanticComparison.target_count || 0),
      semantic_comparison_checked_target_count: Number(semanticComparison.checked_target_count || 0),
      semantic_comparison_error_count: Number(semanticComparison.error_count || 0),
      semantic_mismatch_count: semanticMismatchCount,
      semantic_dom_mismatch_count: semanticMismatchCount,
      semantic_role_mismatch_count: Number(semanticComparison.role_mismatch_count || 0),
      semantic_class_owner_changed_count: Number(semanticComparison.class_owner_changed_count || 0),
      semantic_interaction_group_split_count: Number(semanticComparison.interaction_group_split_count || 0),
      semantic_interaction_group_merged_count: Number(semanticComparison.interaction_group_merged_count || 0),
      semantic_link_text_delta_count: Number(semanticComparison.link_text_delta_count || 0),
      semantic_region_link_count_delta: metric(semanticComparison.region_link_count_delta),
      semantic_clickable_area_delta_ratio: metric(semanticComparison.clickable_area_delta_ratio),
      semantic_optional_selector_absent_count: semanticOptionalSelectorAbsentCount,
      region_link_count_delta: metric(semanticComparison.region_link_count_delta),
      clickable_area_delta_ratio: metric(semanticComparison.clickable_area_delta_ratio),
      optional_selector_absent_count: semanticOptionalSelectorAbsentCount,
      semantic_landmark_mismatch_count: Number(semanticComparison.landmark_mismatch_count || 0),
      semantic_repeated_count_delta_count: Number(semanticComparison.repeated_count_delta_count || 0),
      semantic_brand_logo_missing_count: Number(semanticComparison.brand_logo_missing_count || 0),
      ...designMetrics,
      posts_seen: Number(quality.posts_seen || 0),
      posts_with_blocks: Number(quality.posts_with_blocks || 0),
      pages_seen: Number(quality.pages_seen || 0),
      templates_seen: Number(quality.templates_seen || 0),
      template_parts_seen: Number(quality.template_parts_seen || 0),
      target_pages_seen: Number(quality.target_pages_seen || 0),
      target_posts_with_blocks: Number(quality.target_posts_with_blocks || 0),
      target_raw_html_unconverted: Number(quality.target_raw_html_unconverted || 0),
      target_total_blocks: Number(quality.target_total_blocks || 0),
      target_core_html_blocks: Number(quality.target_core_html_blocks || 0),
      target_serialized_block_comments: Number(quality.target_serialized_block_comments || 0),
      total_blocks: Number(quality.total_blocks || 0),
      core_html_blocks: Number(quality.core_html_blocks || 0),
      core_html_without_bfb_fallback: Number(quality.core_html_without_bfb_fallback || 0),
      target_core_html_without_bfb_fallback: Number(quality.target_core_html_without_bfb_fallback || 0),
      serialized_block_comments: Number(quality.serialized_block_comments || 0),
      bfb_fallback_count: Number(quality.bfb_fallback_count || 0),
    },
    artifacts: {
      raw_result: artifactFile,
      site_path: sitePath,
      frontend_url: status.siteUrl,
      admin_auto_login_url: status.autoLoginUrl,
      ...optionalArtifactPath('visual_comparison_dir', visualComparison.artifact_dir),
      ...optionalArtifactPath('visual_comparison_mismatches', visualComparison.diagnostics_artifact),
      ...optionalArtifactPath('visual_pixel_diff', visualComparison.pixel_diff_artifact),
      ...optionalArtifactPath('semantic_fidelity', semanticComparison.artifact),
      ...optionalArtifactPath('semantic_comparison_dir', semanticComparison.artifact_dir),
      ...optionalArtifactPath('generated_theme_ux_gates', generatedThemeUxGates.artifact),
    },
    errors: failureDetails,
    metadata: {
      benchmark_variant: currentVariant,
      homeboy_invocation_id: runtime.invocationId,
      homeboy_invocation_port_range: runtime.portBase !== null ? `${runtime.portBase}-${runtime.portMax}` : '',
      workflow_bench_scenario_id: selectedWorkflowBenchScenarioId,
      workflow_bench_scenario_title: selectedWorkflowBenchScenario.title,
      prompt_category: PROMPT_CATEGORY,
      model: model || 'default',
      design_primary_font_family: designFingerprint.patterns?.primary_font_family || '',
      design_display_font_family: designFingerprint.patterns?.display_font_family || '',
      design_type_pairing_signature: designFingerprint.patterns?.type_pairing_signature || '',
      design_repetition_signature: designFingerprint.patterns?.repetition_signature || '',
      design: designFingerprint,
      ...systemPrompt,
    },
  };
}
