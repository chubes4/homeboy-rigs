#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.join(__dirname, '..');
const manifestPath = path.join(packageRoot, 'manifests/stable-workloads.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));

const options = parseArgs(process.argv.slice(2));
const contracts = selectedContracts(manifest.contracts || [], options.stableIds);
const runIdPrefix = options.runIdPrefix || `jetpack-stable-${new Date().toISOString().slice(0, 10).replaceAll('-', '')}`;

const runCommands = [];
for (const contract of contracts) {
  contract.entry_workloads.forEach((workloadId, index) => {
    const command = [
      'homeboy',
      'fuzz',
      'run',
      '--lab-only',
      '--rig',
      'jetpack-api-route-inventory',
      '--workload',
      workloadId,
      '--gate-profile',
      'measurement',
      '--run-id',
      `${runIdPrefix}-${contract.id}-${String(index + 1).padStart(2, '0')}-${workloadId}`,
      '--tracker-ref',
      `stable-workload:${contract.id}`,
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
    if (contract.budgets?.max_duration_seconds) {
      command.push('--max-duration', `${contract.budgets.max_duration_seconds}s`);
    }
    for (const trackerRef of options.trackerRefs) {
      command.push('--tracker-ref', trackerRef);
    }

    runCommands.push({
      stable_workload_id: contract.id,
      workload_id: workloadId,
      run_id: `${runIdPrefix}-${contract.id}-${String(index + 1).padStart(2, '0')}-${workloadId}`,
      command,
    });
  });
}

const compareCommands = [
  {
    purpose: 'list_recent_refs',
    command: withLabOptions([
      'homeboy', 'runs', 'refs',
      '--kind', 'fuzz',
      '--component', 'jetpack',
      '--rig', 'jetpack-api-route-inventory',
      '--status', 'completed',
      '--since', options.since,
      '--limit', String(options.limit),
      '--aggregate-artifact-kind', 'fuzz.report',
    ], options),
  },
  {
    purpose: 'trend_elapsed_time',
    command: withLabOptions([
      'homeboy', 'runs', 'compare',
      '--kind', 'fuzz',
      '--component', 'jetpack',
      '--rig', 'jetpack-api-route-inventory',
      '--metric', 'total_elapsed_ms',
      '--limit', String(options.limit),
    ], options),
  },
  {
    purpose: 'compare_hotspots_after_two_runs_complete',
    command: withLabOptions([
      'homeboy', 'runs', 'hotspots',
      '--baseline-run', 'BASELINE_RUN_ID',
      '--candidate-run', 'CANDIDATE_RUN_ID',
      '--limit', String(options.hotspotLimit),
    ], options),
  },
];

const payload = {
  schema: 'homeboy-rigs/jetpack-stable-lab-command-plan/v1',
  manifest: 'manifests/stable-workloads.json',
  profile_id: manifest.profile_id,
  rig_id: 'jetpack-api-route-inventory',
  local_execution: false,
  run_id_prefix: runIdPrefix,
  run_commands: runCommands,
  compare_commands: compareCommands,
};

if (options.json) {
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
} else {
  for (const item of runCommands) {
    process.stdout.write(`# ${item.stable_workload_id} -> ${item.workload_id}\n${shellJoin(item.command)}\n`);
  }
  process.stdout.write('\n# Compare persisted evidence after Lab runs complete.\n');
  for (const item of compareCommands) {
    process.stdout.write(`# ${item.purpose}\n${shellJoin(item.command)}\n`);
  }
}

function parseArgs(argv) {
  const parsed = {
    artifactRoot: '',
    detachAfterHandoff: false,
    hotspotLimit: 20,
    json: false,
    limit: 50,
    runner: '',
    runIdPrefix: '',
    since: '30d',
    stableIds: [],
    trackerRefs: [],
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
      case '--hotspot-limit':
        parsed.hotspotLimit = Number.parseInt(readValue(arg), 10);
        break;
      case '--json':
        parsed.json = true;
        break;
      case '--limit':
        parsed.limit = Number.parseInt(readValue(arg), 10);
        break;
      case '--runner':
        parsed.runner = readValue(arg);
        break;
      case '--run-id-prefix':
        parsed.runIdPrefix = readValue(arg);
        break;
      case '--since':
        parsed.since = readValue(arg);
        break;
      case '--stable-id':
        parsed.stableIds.push(...readValue(arg).split(',').filter(Boolean));
        break;
      case '--tracker-ref':
        parsed.trackerRefs.push(readValue(arg));
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

  for (const [name, value] of [['--limit', parsed.limit], ['--hotspot-limit', parsed.hotspotLimit]]) {
    if (!Number.isInteger(value) || value < 1) {
      throw new Error(`${name} must be a positive integer`);
    }
  }

  return parsed;
}

function selectedContracts(contracts, stableIds) {
  if (stableIds.length === 0) {
    return contracts;
  }

  const selected = new Set(stableIds);
  const filtered = contracts.filter((contract) => selected.has(contract.id));
  const found = new Set(filtered.map((contract) => contract.id));
  const missing = [...selected].filter((id) => !found.has(id));
  if (missing.length > 0) {
    throw new Error(`Unknown stable workload id(s): ${missing.join(', ')}`);
  }
  return filtered;
}

function withLabOptions(command, options) {
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
  if (/^[A-Za-z0-9_./:=,@+-]+$/.test(value)) {
    return value;
  }
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function printHelp() {
  process.stdout.write(`Usage: node tools/stable-workload-lab-commands.mjs [options]\n\n`);
  process.stdout.write(`Emits Lab-only Homeboy commands for Jetpack stable workload contracts. It never executes workloads.\n\n`);
  process.stdout.write(`Options:\n`);
  process.stdout.write(`  --stable-id <id[,id]>        Limit to one or more stable workload ids. Repeatable.\n`);
  process.stdout.write(`  --runner <id>                Add a Homeboy Lab runner id to every command.\n`);
  process.stdout.write(`  --artifact-root <dir>        Add a persisted artifact root to every command.\n`);
  process.stdout.write(`  --run-id-prefix <id>         Stable proof prefix. Defaults to jetpack-stable-YYYYMMDD.\n`);
  process.stdout.write(`  --tracker-ref <kind:id>      Extra tracker ref added to every run command. Repeatable.\n`);
  process.stdout.write(`  --detach-after-handoff       Return after the Lab daemon accepts each run.\n`);
  process.stdout.write(`  --since <duration>           Lookback for refs compare command. Default: 30d.\n`);
  process.stdout.write(`  --limit <n>                  Run-history limit for refs/compare. Default: 50.\n`);
  process.stdout.write(`  --hotspot-limit <n>          Hotspot compare row limit. Default: 20.\n`);
  process.stdout.write(`  --json                       Emit structured JSON instead of shell commands.\n`);
}
