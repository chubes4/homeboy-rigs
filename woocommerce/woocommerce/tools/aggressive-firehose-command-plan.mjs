#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.join(__dirname, '..');
const manifestPath = path.join(packageRoot, 'manifests/aggressive-isolated-fuzz-campaign.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));

const options = parseArgs(process.argv.slice(2));
const runIdPrefix = options.runIdPrefix || 'woo-firehose-$YYYYMMDD';
const executionSupported = manifest.readiness?.execution_enabled === true;
const runnableCommandsEnabled = executionSupported && !options.planOnly;

const baseRunCommand = [
  'homeboy', 'fuzz', 'run',
  '--lab-only',
  '--rig', 'woocommerce-performance',
  '--profile', manifest.profile_id,
  '--run-id', `${runIdPrefix}-request`,
  '--tracker-ref', options.trackerRef,
  '--allow-destructive',
  '--isolation', 'isolated',
  '--fuzz-execution-request-artifact',
  '--coverage-reconciliation',
  '--wp-codebox-destructive-fuzz-suite-metadata',
  '--rest-payload-families',
  '--chaos-sequence-packs',
  '--payload-size-depth-families',
  '--relative-hotspot-taxonomy',
  '--snapshot-restore',
  '--hbex-aggressive-isolated-mode',
  '--hbex-admin-generation',
  '--hbex-database-generation',
  '--hbex-browser-generation',
  '--hbex-editor-generation',
];

if (options.runner) {
  baseRunCommand.push('--runner', options.runner);
}
if (options.artifactRoot) {
  baseRunCommand.push('--artifact-root', options.artifactRoot);
}
if (options.detachAfterHandoff) {
  baseRunCommand.push('--detach-after-handoff');
}

const payload = {
  schema: 'homeboy-rigs/woocommerce-aggressive-firehose-command-plan/v1',
  manifest: 'manifests/aggressive-isolated-fuzz-campaign.json',
  rig_id: 'woocommerce-performance',
  profile_id: manifest.profile_id,
  local_execution: false,
  execution_enabled: executionSupported,
  runnable_commands_enabled: runnableCommandsEnabled,
  plan_kind: runnableCommandsEnabled ? 'runnable_offloaded_commands' : 'offloaded_command_plan',
  run_id_prefix: runIdPrefix,
  blockers: executionSupported ? [] : [
    'manifest.readiness.execution_enabled must be true for offloaded execution',
  ],
  plan_items: [
    {
      purpose: 'prepare_disposable_rig',
      command_argv: withOptionalLabArgs(['homeboy', 'rig', 'up', 'woocommerce-performance'], options),
    },
    {
      purpose: 'request_aggressive_isolated_firehose',
      command_argv: baseRunCommand,
    },
    {
      purpose: 'collect_reviewer_facing_artifact_refs',
      command_argv: withOptionalLabArgs([
        'homeboy', 'runs', 'refs',
        '--rig', 'woocommerce-performance',
        '--kind', 'fuzz',
        '--status', 'completed',
        '--tracker-ref', options.trackerRef,
        '--artifact-kind', 'fuzz.execution_request',
        '--artifact-kind', 'fuzz.coverage_reconciliation',
        '--artifact-kind', 'fuzz.payload_family_coverage',
        '--artifact-kind', 'fuzz.chaos_sequence_packs',
        '--artifact-kind', 'fuzz.payload_size_depth_families',
        '--artifact-kind', 'fuzz.relative_hotspot_taxonomy',
        '--artifact-kind', 'fuzz.reset',
        '--artifact-kind', 'fuzz.case_timing',
        '--artifact-kind', 'wordpress.database_observations',
        '--artifact-kind', 'wordpress.admin_observations',
        '--artifact-kind', 'wordpress.browser_observations',
        '--artifact-kind', 'wordpress.editor_observations',
        '--artifact-kind', 'fuzz.relative_hotspots',
      ], options),
    },
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
  process.stdout.write(`# Offloaded Homeboy/HBEX command plan. Local execution is not supported; commands include --lab-only and isolated destructive flags.\n`);
  if (runnableCommandsEnabled) {
    for (const item of payload.commands) {
      process.stdout.write(`# ${item.purpose}\n${shellJoin(item.command)}\n`);
    }
  } else {
    for (const item of payload.plan_items) {
      process.stdout.write(`# ${item.purpose}: offloaded command withheld by --plan-only (${item.command_argv[0]} ${item.command_argv[1]} ...)\n`);
    }
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
