import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function emitStableWorkloadLabCommands(config, argv = process.argv.slice(2), stdout = process.stdout) {
  const scriptDir = path.dirname(fileURLToPath(config.moduleUrl));
  const packageRoot = path.join(scriptDir, '..');
  const manifestPath = path.join(packageRoot, 'manifests/stable-workloads.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));

  const options = parseArgs(argv, config, stdout);
  const contracts = selectedContracts(manifest.contracts || [], options.stableIds);
  const runIdPrefix = options.runIdPrefix || `${config.defaultRunIdPrefix}-${new Date().toISOString().slice(0, 10).replaceAll('-', '')}`;

  const runCommands = [];
  for (const contract of contracts) {
    contract.entry_workloads.forEach((workloadId, index) => {
      const runId = `${runIdPrefix}-${contract.id}-${String(index + 1).padStart(2, '0')}-${workloadId}`;
      const command = [
        'homeboy',
        'fuzz',
        'run',
        '--lab-only',
        '--rig',
        config.rigId,
        '--workload',
        workloadId,
        '--gate-profile',
        'measurement',
        '--run-id',
        runId,
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
        run_id: runId,
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
        '--component', config.component,
        '--rig', config.rigId,
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
        '--component', config.component,
        '--rig', config.rigId,
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
    schema: config.schema,
    manifest: 'manifests/stable-workloads.json',
    profile_id: manifest.profile_id,
    rig_id: config.rigId,
    local_execution: false,
    run_id_prefix: runIdPrefix,
    run_commands: runCommands,
    compare_commands: compareCommands,
  };

  if (options.json) {
    stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return;
  }

  for (const item of runCommands) {
    stdout.write(`# ${item.stable_workload_id} -> ${item.workload_id}\n${shellJoin(item.command)}\n`);
  }
  stdout.write('\n# Compare persisted evidence after Lab runs complete.\n');
  for (const item of compareCommands) {
    stdout.write(`# ${item.purpose}\n${shellJoin(item.command)}\n`);
  }
}

function parseArgs(argv, config, stdout) {
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
        printHelp(config, stdout);
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

function printHelp(config, stdout) {
  stdout.write(`Usage: node tools/stable-workload-lab-commands.mjs [options]\n\n`);
  stdout.write(`Emits Lab-only Homeboy commands for ${config.productLabel} stable workload contracts. It never executes workloads.\n\n`);
  stdout.write(`Options:\n`);
  stdout.write(`  --stable-id <id[,id]>        Limit to one or more stable workload ids. Repeatable.\n`);
  stdout.write(`  --runner <id>                Add a Homeboy Lab runner id to every command.\n`);
  stdout.write(`  --artifact-root <dir>        Add a persisted artifact root to every command.\n`);
  stdout.write(`  --run-id-prefix <id>         Stable proof prefix. Defaults to ${config.defaultRunIdPrefix}-YYYYMMDD.\n`);
  stdout.write(`  --tracker-ref <kind:id>      Extra tracker ref added to every run command. Repeatable.\n`);
  stdout.write(`  --detach-after-handoff       Return after the Lab daemon accepts each run.\n`);
  stdout.write(`  --since <duration>           Lookback for refs compare command. Default: 30d.\n`);
  stdout.write(`  --limit <n>                  Run-history limit for refs/compare. Default: 50.\n`);
  stdout.write(`  --hotspot-limit <n>          Hotspot compare row limit. Default: 20.\n`);
  stdout.write(`  --json                       Emit structured JSON instead of shell commands.\n`);
}
