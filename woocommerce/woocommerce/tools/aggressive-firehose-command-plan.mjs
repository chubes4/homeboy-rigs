#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.join(__dirname, '..');
const manifestPath = path.join(packageRoot, 'manifests/aggressive-isolated-fuzz-campaign.json');
const rigPath = path.join(packageRoot, 'rigs/woocommerce-performance/rig.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const rig = JSON.parse(readFileSync(rigPath, 'utf8'));

const options = parseArgs(process.argv.slice(2));
const runIdPrefix = options.runIdPrefix || 'woo-firehose-$YYYYMMDD';
const executionSupported = manifest.readiness?.execution_enabled === true;
const runnableCommandsEnabled = executionSupported && !options.planOnly;
const profileWorkloads = rig.fuzz_profiles?.[manifest.profile_id] || [];
const plannedArtifactSemanticKeys = (manifest.planned_artifact_expectations || []).map((artifact) => artifact.semantic_key);
const campaignInputs = buildCampaignInputs(manifest);

if (!Array.isArray(profileWorkloads) || profileWorkloads.length === 0) {
  throw new Error(`Rig fuzz profile ${manifest.profile_id} must declare at least one workload`);
}

const payload = {
  schema: 'homeboy-rigs/woocommerce-aggressive-firehose-command-plan/v1',
  manifest: 'manifests/aggressive-isolated-fuzz-campaign.json',
  rig_id: 'woocommerce-performance',
  profile_id: manifest.profile_id,
  local_execution: false,
  execution_enabled: executionSupported,
  runnable_commands_enabled: runnableCommandsEnabled,
  plan_kind: executionSupported ? (runnableCommandsEnabled ? 'runnable_offloaded_commands' : 'offloaded_command_plan') : 'declared_offloaded_command_plan',
  run_id_prefix: runIdPrefix,
  workload_ids: profileWorkloads,
  blockers: executionSupported ? [] : [
    'manifest.readiness.execution_enabled is false because REST CRUD fixture-plan mutations are disabled',
  ],
  plan_items: [
    {
      purpose: 'validate_disposable_rig',
      command_argv: withOptionalLabArgs(['homeboy', 'rig', 'check', 'woocommerce-performance'], options),
    },
    ...(executionSupported ? [
      ...profileWorkloads.map((workloadId, index) => ({
        purpose: `request_aggressive_isolated_firehose:${workloadId}`,
        command_argv: fuzzRunCommandForWorkload(workloadId, index, options),
        campaign_inputs: campaignInputs,
        artifact_expectations: manifest.planned_artifact_expectations,
      })),
      {
        purpose: 'collect_reviewer_facing_artifact_refs',
        command_argv: withOptionalLabArgs([
          'homeboy', 'runs', 'refs',
          '--rig', 'woocommerce-performance',
          '--kind', 'fuzz',
          '--status', 'completed',
          '--tracker-ref', options.trackerRef,
          ...plannedArtifactSemanticKeys.flatMap((semanticKey) => ['--artifact-kind', semanticKey]),
        ], options),
      },
    ] : []),
  ],
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
    trackerRef: '$WC_TRACKER_REF',
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
      case '--tracker-ref':
        parsed.trackerRef = readValue(arg);
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

function fuzzRunCommandForWorkload(workloadId, index, options) {
  const command = [
    'homeboy', 'fuzz', 'run',
    '--lab-only',
    '--rig', 'woocommerce-performance',
    '--workload', workloadId,
    '--run-id', `${runIdPrefix}-${String(index + 1).padStart(2, '0')}-${workloadId}`,
    '--tracker-ref', options.trackerRef,
    '--allow-destructive',
    '--isolation', 'isolated',
    '--isolation-proof', '${artifact.root}/isolation-proof.json',
  ];

  if (options.runner) {
    command.push('--runner', options.runner);
  }
  if (options.artifactRoot) {
    command.push('--artifact-root', options.artifactRoot);
  }
  if (options.detachAfterHandoff) {
    command.push('--detach-after-handoff');
  }

  command.push(
    '--',
    '--profile', manifest.profile_id,
    '--fuzz-execution-request-artifact',
    '--coverage-reconciliation',
    '--wp-codebox-destructive-fuzz-suite-metadata',
    '--rest-payload-families',
    '--chaos-sequence-packs',
    '--payload-size-depth-families',
    '--relative-hotspot-taxonomy',
    '--disposable-sandbox-boundary',
    '--hbex-aggressive-isolated-mode',
    '--hbex-admin-generation',
    '--hbex-database-generation',
    '--hbex-browser-generation',
    '--hbex-editor-generation',
  );

  return command;
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

function withOptionalLabArgs(command, options) {
  const withOptions = [...command, '--lab-only'];
  if (options.runner) {
    withOptions.push('--runner', options.runner);
  }
  if (options.artifactRoot) {
    withOptions.push('--artifact-root', options.artifactRoot);
  }
  return withOptions;
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
  process.stdout.write(`  --run-id-prefix <id>      Firehose run id prefix. Defaults to the stable placeholder woo-firehose-$YYYYMMDD.\n`);
  process.stdout.write(`  --tracker-ref <kind:id>   Tracker ref for reviewer-facing evidence. Default: $WC_TRACKER_REF.\n`);
  process.stdout.write(`  --detach-after-handoff    Return after the Lab daemon accepts the run.\n`);
  process.stdout.write(`  --plan-only               Emit structured plan_items but withhold runnable command arrays.\n`);
  process.stdout.write(`  --runnable                Emit runnable offloaded command arrays. This is the default when execution is enabled.\n`);
  process.stdout.write(`  --json                    Emit structured JSON instead of shell commands.\n`);
}
