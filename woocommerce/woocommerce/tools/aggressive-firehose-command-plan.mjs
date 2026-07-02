#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.join(__dirname, '..');
const manifestPath = path.join(packageRoot, 'manifests/aggressive-isolated-fuzz-campaign.json');
const rigPath = path.join(packageRoot, 'rigs/woocommerce-performance/rig.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const rig = JSON.parse(readFileSync(rigPath, 'utf8'));

const options = parseArgs(process.argv.slice(2));
const commandPlan = manifest.command_plan;
validateCommandPlan(commandPlan);

const runIdPrefix = options.runIdPrefix || commandPlan.defaults.run_id_prefix;
const executionSupported = manifest.readiness?.execution_enabled === true;
const runnableCommandsEnabled = executionSupported && !options.planOnly;
const profileWorkloads = rig.fuzz_profiles?.[manifest.profile_id] || [];
const plannedArtifactSemanticKeys = (manifest.planned_artifact_expectations || []).map((artifact) => artifact.semantic_key);
const campaignInputs = buildCampaignInputs(manifest);
const isolationProofPath = options.isolationProofPath || defaultIsolationProofPath(options, commandPlan);

if (!Array.isArray(profileWorkloads) || profileWorkloads.length === 0) {
  throw new Error(`Rig fuzz profile ${manifest.profile_id} must declare at least one workload`);
}

if (options.writeIsolationProof) {
  writeIsolationProof(options.writeIsolationProof, buildIsolationProof());
  process.exit(0);
}

const payload = {
  schema: commandPlan.schema,
  manifest: commandPlan.manifest,
  rig_id: commandPlan.rig_id,
  profile_id: manifest.profile_id,
  local_execution: commandPlan.local_execution,
  execution_enabled: executionSupported,
  runnable_commands_enabled: runnableCommandsEnabled,
  plan_kind: planKind(commandPlan, executionSupported, runnableCommandsEnabled),
  run_id_prefix: runIdPrefix,
  workload_ids: profileWorkloads,
  upstream_contract_artifact_sources: renderArtifactSources(commandPlan.upstream_contract_artifact_sources, { isolationProofPath }),
  blockers: executionSupported ? [] : commandPlan.blockers_when_execution_disabled,
  generated_isolation_proof: buildIsolationProof(),
  plan_items: buildPlanItems(commandPlan, { executionSupported, profileWorkloads, plannedArtifactSemanticKeys, campaignInputs, options, isolationProofPath }),
};

if (runnableCommandsEnabled) {
  payload.commands = payload.plan_items.map((item) => ({
    purpose: item.purpose,
    command: item.command_argv,
  }));
} else {
  payload.commands = [];
}

if (options.json) {
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
} else {
  process.stdout.write(`# ${payload.schema}\n`);
  process.stdout.write(`# Offloaded Homeboy/HBEX command plan. Local execution is not supported.\n`);
  if (runnableCommandsEnabled) {
    for (const item of payload.commands) {
      process.stdout.write(`# ${item.purpose}\n${shellJoin(item.command)}\n`);
    }
  } else if (executionSupported) {
    for (const item of payload.plan_items) {
      process.stdout.write(`# ${item.purpose}: offloaded command withheld by --plan-only (${item.command_argv[0]} ${item.command_argv[1]} ...)\n`);
    }
  } else {
    process.stdout.write(`# Commands withheld: ${payload.blockers.join('; ')}\n`);
  }
}

function parseArgs(argv) {
  const parsed = {
    artifactRoot: '',
    detachAfterHandoff: false,
    json: false,
    planOnly: false,
    runner: '',
    runIdPrefix: '',
    isolationProofPath: '',
    trackerRef: '$WC_TRACKER_REF',
    writeIsolationProof: '',
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const readValue = (name) => {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) {
        throw new Error(`${name} requires a value`);
      }
      index += 1;
      return value;
    };

    switch (arg) {
      case '--artifact-root':
        parsed.artifactRoot = readValue(arg);
        break;
      case '--detach-after-handoff':
        parsed.detachAfterHandoff = true;
        break;
      case '--json':
        parsed.json = true;
        break;
      case '--runner':
        parsed.runner = readValue(arg);
        break;
      case '--plan-only':
        parsed.planOnly = true;
        break;
      case '--runnable':
        parsed.planOnly = false;
        break;
      case '--run-id-prefix':
        parsed.runIdPrefix = readValue(arg);
        break;
      case '--isolation-proof':
        parsed.isolationProofPath = readValue(arg);
        break;
      case '--tracker-ref':
        parsed.trackerRef = readValue(arg);
        break;
      case '--write-isolation-proof':
        parsed.writeIsolationProof = readValue(arg);
        break;
      case '--help':
      case '-h':
        printHelp();
        process.exit(0);
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return parsed;
}

function buildPlanItems(plan, context) {
  const items = [renderPlanItem(plan.plan_items.validate_disposable_rig, context)];

  if (!context.executionSupported) {
    return items;
  }

  items.push(renderPlanItem(plan.plan_items.write_homeboy_isolation_proof, context));
  context.profileWorkloads.forEach((workloadId, index) => {
    items.push(renderPlanItem(plan.plan_items.request_aggressive_isolated_firehose, {
      ...context,
      workloadId,
      runId: `${runIdPrefix}-${String(index + 1).padStart(2, '0')}-${workloadId}`,
    }));
  });
  items.push(renderPlanItem(plan.plan_items.collect_reviewer_facing_artifact_refs, context));

  return items;
}

function renderPlanItem(item, context) {
  const rendered = {
    purpose: renderTemplate(item.purpose, context),
    command_argv: renderCommand(item.command_argv, context),
  };

  if (item.artifact) {
    rendered.artifact = renderObject(item.artifact, context);
  }
  if (item.include_campaign_inputs) {
    rendered.campaign_inputs = context.campaignInputs;
  }
  if (item.include_artifact_expectations) {
    rendered.artifact_expectations = manifest.planned_artifact_expectations;
  }

  return rendered;
}

function renderCommand(command, context) {
  const rendered = command.flatMap((entry) => {
    if (entry === '$planned_artifact_semantic_keys') {
      return context.plannedArtifactSemanticKeys.flatMap((semanticKey) => ['--artifact-kind', semanticKey]);
    }
    return [renderTemplate(entry, context)];
  });

  if (context.options.runner && command.includes('$optional_runner')) {
    rendered.splice(rendered.indexOf('$optional_runner'), 1, '--runner', context.options.runner);
  }
  if (context.options.artifactRoot && command.includes('$optional_artifact_root')) {
    rendered.splice(rendered.indexOf('$optional_artifact_root'), 1, '--artifact-root', context.options.artifactRoot);
  }
  if (context.options.detachAfterHandoff && command.includes('$optional_detach_after_handoff')) {
    rendered.splice(rendered.indexOf('$optional_detach_after_handoff'), 1, '--detach-after-handoff');
  }

  return rendered.filter((entry) => !entry.startsWith('$optional_'));
}

function buildCampaignInputs(campaign) {
  return {
    campaign_manifest: 'manifests/aggressive-isolated-fuzz-campaign.json',
    target_inventory_manifest: campaign.target_inventory_manifest,
    full_surface_manifest: campaign.full_surface_manifest,
    product_surface_taxonomy_ref: campaign.product_surface_taxonomy_ref,
    fixture_sources: campaign.fixture_sources || {},
    groups: campaign.campaign_input_groups || {},
  };
}

function buildIsolationProof() {
  return renderObject(commandPlan.generated_isolation_proof, { profileWorkloads });
}

function defaultIsolationProofPath(options, plan) {
  if (options.artifactRoot) {
    return path.join(options.artifactRoot, plan.defaults.isolation_proof_artifact_root_relative_path);
  }
  return plan.defaults.isolation_proof_path;
}

function writeIsolationProof(targetPath, proof) {
  mkdirSync(path.dirname(targetPath), { recursive: true });
  writeFileSync(targetPath, `${JSON.stringify(proof, null, 2)}\n`);
}

function planKind(plan, executionEnabled, runnableEnabled) {
  if (!executionEnabled) {
    return plan.plan_kinds.declared;
  }
  return runnableEnabled ? plan.plan_kinds.runnable : plan.plan_kinds.plan_only;
}

function renderArtifactSources(sources, context) {
  return sources.map((source) => renderObject(source, context));
}

function renderObject(value, context) {
  if (typeof value === 'string') {
    return renderTemplate(value, context);
  }
  if (Array.isArray(value)) {
    if (value.length === 1 && value[0] === '$profile_workloads') {
      return context.profileWorkloads;
    }
    return value.map((entry) => renderObject(entry, context));
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, renderObject(entry, context)]));
  }
  return value;
}

function renderTemplate(value, context) {
  return value
    .replaceAll('$rig_id', commandPlan.rig_id)
    .replaceAll('$profile_id', manifest.profile_id)
    .replaceAll('$workload_id', context.workloadId || '')
    .replaceAll('$run_id', context.runId || '')
    .replaceAll('$tracker_ref', context.options?.trackerRef || '')
    .replaceAll('$isolation_proof_path', context.isolationProofPath || '')
    .replaceAll('$command_plan_generator', manifest.command_plan_generator);
}

function validateCommandPlan(plan) {
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) {
    throw new Error('Manifest must declare command_plan');
  }

  const requiredSections = ['defaults', 'plan_kinds', 'upstream_contract_artifact_sources', 'generated_isolation_proof', 'plan_items'];
  for (const section of requiredSections) {
    if (!plan[section]) {
      throw new Error(`Manifest command_plan must declare ${section}`);
    }
  }

  if (plan.schema !== 'homeboy-rigs/woocommerce-aggressive-firehose-command-plan/v1') {
    throw new Error('Manifest command_plan schema drifted');
  }
  if (plan.rig_id !== 'woocommerce-performance') {
    throw new Error('Manifest command_plan rig_id drifted');
  }
  if (plan.local_execution !== false) {
    throw new Error('Aggressive command plan must not enable local execution');
  }

  for (const key of ['validate_disposable_rig', 'write_homeboy_isolation_proof', 'request_aggressive_isolated_firehose', 'collect_reviewer_facing_artifact_refs']) {
    if (!Array.isArray(plan.plan_items[key]?.command_argv)) {
      throw new Error(`Manifest command_plan plan_items.${key}.command_argv must be an array`);
    }
  }
}

function shellJoin(command) {
  return command.map(shellQuote).join(' ');
}

function shellQuote(value) {
  if (/^[A-Za-z0-9_./:=,@+$-]+$/.test(value)) {
    return value;
  }
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function printHelp() {
  process.stdout.write(`Usage: node tools/aggressive-firehose-command-plan.mjs [options]\n\n`);
  process.stdout.write(`Emits the intended offloaded Homeboy/HBEX command sequence for the Woo aggressive isolated firehose. It never executes workloads.\n\n`);
  process.stdout.write(`Options:\n`);
  process.stdout.write(`  --runner <id>             Add a Homeboy Lab runner id to commands.\n`);
  process.stdout.write(`  --artifact-root <dir>     Add a persisted artifact root to commands.\n`);
  process.stdout.write(`  --isolation-proof <path>  Isolation proof artifact path passed to each fuzz run. Defaults under --artifact-root or artifacts/woocommerce-aggressive-firehose/.\n`);
  process.stdout.write(`  --run-id-prefix <id>      Firehose run id prefix. Defaults to the stable placeholder woo-firehose-$YYYYMMDD.\n`);
  process.stdout.write(`  --tracker-ref <kind:id>   Tracker ref for reviewer-facing evidence. Default: $WC_TRACKER_REF.\n`);
  process.stdout.write(`  --detach-after-handoff    Return after the Lab daemon accepts the run.\n`);
  process.stdout.write(`  --plan-only               Emit structured plan_items but withhold runnable command arrays.\n`);
  process.stdout.write(`  --runnable                Emit runnable offloaded command arrays. This is the default when execution is enabled.\n`);
  process.stdout.write(`  --json                    Emit structured JSON instead of shell commands.\n`);
  process.stdout.write(`  --write-isolation-proof <path>  Write the homeboy/isolation-proof/v1 preflight artifact and exit.\n`);
}
