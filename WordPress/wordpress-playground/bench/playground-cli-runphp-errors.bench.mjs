import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const CONTROL_BLUEPRINT = {
  steps: [
    {
      step: 'runPHP',
      code: "<?php echo 'PLAYGROUND_RUNPHP_CONTROL_OK';",
    },
  ],
};

const FATAL_BLUEPRINT = {
  steps: [
    {
      step: 'runPHP',
      code: "<?php require_once '/wordpress/wp-load.php'; playground_cli_missing_probe_function();",
    },
  ],
};

function artifactRoot() {
  return (
    process.env.HOMEBOY_INVOCATION_ARTIFACT_DIR ||
    process.env.HOMEBOY_BENCH_SHARED_STATE ||
    path.join(os.tmpdir(), 'playground-cli-diagnostics')
  );
}

function componentPath() {
  if (!process.env.HOMEBOY_COMPONENT_PATH) {
    throw new Error('HOMEBOY_COMPONENT_PATH is required and must point to the wordpress-playground component checkout.');
  }
  return process.env.HOMEBOY_COMPONENT_PATH;
}

function cliArgs(blueprintPath) {
  return [
    '--experimental-strip-types',
    '--experimental-transform-types',
    '--disable-warning=ExperimentalWarning',
    '--import',
    './packages/meta/src/node-es-module-loader/register.mts',
    './packages/playground/cli/src/cli.ts',
    'run-blueprint',
    '--blueprint',
    blueprintPath,
    '--wp',
    process.env.PLAYGROUND_CLI_DIAGNOSTIC_WP_VERSION || 'latest',
    '--php',
    process.env.PLAYGROUND_CLI_DIAGNOSTIC_PHP_VERSION || '8.3',
    '--verbosity=debug',
  ];
}

async function runCliProbe(playgroundPath, blueprintPath) {
  const started = Date.now();
  try {
    const result = await execFileAsync(process.execPath, cliArgs(blueprintPath), {
      cwd: playgroundPath,
      env: {
        ...process.env,
        PLAYGROUND_NO_JSPI_RESPAWN: '1',
        NO_COLOR: '1',
      },
      maxBuffer: 20 * 1024 * 1024,
    });
    return {
      exitCode: 0,
      stdout: result.stdout,
      stderr: result.stderr,
      elapsedMs: Date.now() - started,
    };
  } catch (error) {
    return {
      exitCode: typeof error.code === 'number' ? error.code : 1,
      stdout: error.stdout || '',
      stderr: error.stderr || '',
      message: error.message || '',
      elapsedMs: Date.now() - started,
    };
  }
}

function combinedOutput(result) {
  return `${result.stdout || ''}\n${result.stderr || ''}\n${result.message || ''}`;
}

function analyzeFatalOutput(result) {
  const output = combinedOutput(result);
  const normalized = output.replace(/\x1b\[[0-9;]*m/g, '').trim();
  return {
    hasBlankError: /(^|\n)Error:\s*($|\n)/.test(normalized),
    hasPhpFatal: /Fatal error|Uncaught Error|Call to undefined function|playground_cli_missing_probe_function/i.test(
      normalized
    ),
    errorLine: normalized
      .split('\n')
      .find((line) => line.startsWith('Error:')) || '',
  };
}

export default async function playgroundCliRunphpErrorsBench() {
  const runId = `playground-cli-runphp-errors-${process.pid}-${Date.now()}`;
  const artifactsDir = path.join(artifactRoot(), runId);
  const blueprintsDir = path.join(artifactsDir, 'blueprints');
  await mkdir(blueprintsDir, { recursive: true });

  const controlBlueprint = path.join(blueprintsDir, 'control.json');
  const fatalBlueprint = path.join(blueprintsDir, 'fatal-runphp.json');
  await writeFile(controlBlueprint, JSON.stringify(CONTROL_BLUEPRINT, null, 2));
  await writeFile(fatalBlueprint, JSON.stringify(FATAL_BLUEPRINT, null, 2));

  const playgroundPath = componentPath();
  const control = await runCliProbe(playgroundPath, controlBlueprint);
  const fatal = await runCliProbe(playgroundPath, fatalBlueprint);
  const fatalAnalysis = analyzeFatalOutput(fatal);

  const report = {
    playgroundPath,
    node: process.version,
    control: {
      exitCode: control.exitCode,
      elapsedMs: control.elapsedMs,
      stdout: control.stdout,
      stderr: control.stderr,
    },
    fatal: {
      exitCode: fatal.exitCode,
      elapsedMs: fatal.elapsedMs,
      stdout: fatal.stdout,
      stderr: fatal.stderr,
      message: fatal.message,
      analysis: fatalAnalysis,
    },
  };

  const reportPath = path.join(artifactsDir, 'runphp-error-report.json');
  const controlOutputPath = path.join(artifactsDir, 'control-output.txt');
  const fatalOutputPath = path.join(artifactsDir, 'fatal-output.txt');
  await writeFile(reportPath, JSON.stringify(report, null, 2));
  await writeFile(controlOutputPath, combinedOutput(control));
  await writeFile(fatalOutputPath, combinedOutput(fatal));

  if (control.exitCode !== 0) {
    throw new Error(`control Blueprint failed; see ${controlOutputPath}`);
  }
  if (fatal.exitCode === 0) {
    throw new Error(`fatal Blueprint unexpectedly passed; see ${fatalOutputPath}`);
  }

  return {
    metrics: {
      success_rate: 1,
      control_exit_code: control.exitCode,
      fatal_exit_code: fatal.exitCode,
      fatal_blank_error: fatalAnalysis.hasBlankError ? 1 : 0,
      fatal_has_php_diagnostic: fatalAnalysis.hasPhpFatal ? 1 : 0,
      control_elapsed_ms: control.elapsedMs,
      fatal_elapsed_ms: fatal.elapsedMs,
    },
    artifacts: {
      report: reportPath,
      control_output: controlOutputPath,
      fatal_output: fatalOutputPath,
      control_blueprint: controlBlueprint,
      fatal_blueprint: fatalBlueprint,
    },
    metadata: {
      fatal_error_line: fatalAnalysis.errorLine,
      wp_version: process.env.PLAYGROUND_CLI_DIAGNOSTIC_WP_VERSION || 'latest',
      php_version: process.env.PLAYGROUND_CLI_DIAGNOSTIC_PHP_VERSION || '8.3',
    },
  };
}
