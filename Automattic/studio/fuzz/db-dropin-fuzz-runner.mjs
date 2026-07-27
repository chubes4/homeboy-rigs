import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const studioRoot = process.cwd();
const seed = process.env.HOMEBOY_FUZZ_SEED || '3692';
const runId = process.env.HOMEBOY_FUZZ_RUN_ID || `studio-db-dropin-${ seed }`;
const artifactsDir = process.env.HOMEBOY_FUZZ_ARTIFACTS_DIR || path.join( studioRoot, 'artifacts/fuzz/run' );
const resultsFile = process.env.HOMEBOY_FUZZ_RESULTS_FILE || path.join( artifactsDir, 'results.json' );
const sourceFile = path.join( studioRoot, 'packages/common/lib/sqlite-integration.ts' );
const scratchRoot = fs.mkdtempSync( path.join( tmpdir(), 'studio-db-dropin-fuzz-' ) );
const integrationSource = path.join( scratchRoot, 'integration-source' );
const stockMarker = 'This file is auto-generated and copied from the sqlite plugin.';
const stockDropin = `<?php\n// ${ stockMarker }\ndefine( 'SQLITE_DB_DROPIN_VERSION', 'test' );\n'{SQLITE_IMPLEMENTATION_FOLDER_PATH}';\n`;
const operations = [
  'sqlite.destination.classify',
  'sqlite.dropin.classify',
  'sqlite.integration.install',
  'sqlite.integration.keep-updated',
];
const dimensions = [
  'destination-artifact-combinations',
  'dropin-content-spoofing',
  'custom-dropin-preservation',
  'filesystem-blocker-recovery',
  'symlink-containment',
  'intentional-mysql-non-mutation',
];

if ( ! fs.existsSync( sourceFile ) ) {
  throw new Error( `Studio SQLite integration source not found: ${ sourceFile }` );
}

const { SqliteIntegrationProvider } = await import( pathToFileURL( sourceFile ).href );
fs.mkdirSync( integrationSource, { recursive: true } );
fs.writeFileSync( path.join( integrationSource, 'db.copy' ), stockDropin );
fs.writeFileSync( path.join( integrationSource, 'load.php' ), '<?php\n/** Version: test */\n' );

class FuzzSqliteProvider extends SqliteIntegrationProvider {
  getSqliteDirname() {
    return 'sqlite-database-integration';
  }

  getSqlitePluginSourcePath() {
    return integrationSource;
  }
}

const provider = new FuzzSqliteProvider();
const results = [];

function hash( value ) {
  return `sha256:${ createHash( 'sha256' ).update( value ).digest( 'hex' ) }`;
}

function writeJson( file, value ) {
  fs.mkdirSync( path.dirname( file ), { recursive: true } );
  fs.writeFileSync( file, `${ JSON.stringify( value, null, 2 ) }\n` );
}

function sitePathFor( id ) {
  const sitePath = path.join( scratchRoot, 'cases', id );
  fs.mkdirSync( path.join( sitePath, 'wp-content' ), { recursive: true } );
  return sitePath;
}

function seededNoise( index ) {
  return createHash( 'sha256' ).update( `${ seed }:${ index }` ).digest( 'hex' ).slice( 0, 16 );
}

async function runCase( id, operation, expected, callback ) {
  const sitePath = sitePathFor( id );
  const started = performance.now();
  try {
    const observed = await callback( sitePath );
    results.push( {
      id,
      operation,
      passed: JSON.stringify( observed ) === JSON.stringify( expected ),
      expected,
      observed,
      duration_ms: Math.max( 1, Math.ceil( performance.now() - started ) ),
    } );
  } catch ( error ) {
    results.push( {
      id,
      operation,
      passed: false,
      expected,
      observed: { completed: false },
      error: error instanceof Error ? `${ error.name }: ${ error.message }` : String( error ),
      duration_ms: Math.max( 1, Math.ceil( performance.now() - started ) ),
    } );
  }
}

function materializeArtifacts( sitePath, state ) {
  if ( state.config ) {
    fs.writeFileSync( path.join( sitePath, 'wp-config.php' ), '<?php // external database\n' );
  }
  if ( state.dropin ) {
    fs.writeFileSync( path.join( sitePath, 'wp-content', 'db.php' ), '<?php // foreign drop-in\n' );
  }
  if ( state.database ) {
    fs.mkdirSync( path.join( sitePath, 'wp-content', 'database' ), { recursive: true } );
    fs.writeFileSync( path.join( sitePath, 'wp-content', 'database', '.ht.sqlite' ), '' );
  }
  if ( state.plugin ) {
    fs.mkdirSync( path.join( sitePath, 'wp-content', 'mu-plugins', 'sqlite-database-integration' ), {
      recursive: true,
    } );
  }
}

async function classificationCases() {
  for ( const config of [ false, true ] ) {
    for ( let mask = 0; mask < 8; mask++ ) {
      const id = `classify-config-${ Number( config ) }-artifacts-${ mask }`;
      await runCase(
        id,
        operations[ 0 ],
        { needsSqliteSetup: ! config || mask > 0 },
        async ( sitePath ) => {
          materializeArtifacts( sitePath, {
            config,
            dropin: Boolean( mask & 1 ),
            database: Boolean( mask & 2 ),
            plugin: Boolean( mask & 4 ),
          } );
          return { needsSqliteSetup: await provider.needsSqliteSetup( sitePath ) };
        }
      );
    }
  }
}

async function contentCases() {
  const corpus = [
    [ 'absent', null, true ],
    [ 'empty', '', true ],
    [ 'foreign', '<?php class QM_DB {}\n', true ],
    [ 'custom-define', "<?php define( 'SQLITE_DB_DROPIN_VERSION', 'custom' );\n", false ],
    [ 'stock-with-define', `<?php // ${ stockMarker }\ndefine( 'SQLITE_DB_DROPIN_VERSION', 'old' );\n`, true ],
    [ 'comment-only-token', '<?php // SQLITE_DB_DROPIN_VERSION is intentionally not defined\n', true ],
    [ 'string-only-token', "<?php $name = 'SQLITE_DB_DROPIN_VERSION';\n", true ],
    [ 'prefixed-identifier-token', '<?php $MY_SQLITE_DB_DROPIN_VERSION = true;\n', true ],
    [ 'lowercase-token', '<?php // sqlite_db_dropin_version\n', true ],
    [ 'nul-bytes', '<?php\u0000foreign\u0000dropin\n', true ],
  ];

  for ( let index = 0; index < 48; index++ ) {
    const noise = seededNoise( index );
    const mode = index % 3;
    corpus.push( [
      `generated-token-spoof-${ index }`,
      mode === 0
        ? `<?php /* ${ noise } SQLITE_DB_DROPIN_VERSION ${ noise } */\n`
        : mode === 1
          ? `<?php $value = "${ noise } SQLITE_DB_DROPIN_VERSION ${ noise }";\n`
          : `<?php $${ noise }_SQLITE_DB_DROPIN_VERSION = false;\n`,
      true,
    ] );
  }

  for ( const [ name, content, replace ] of corpus ) {
    await runCase( `content-${ name }`, operations[ 1 ], { replace }, async ( sitePath ) => {
      if ( content !== null ) {
        fs.writeFileSync( path.join( sitePath, 'wp-content', 'db.php' ), content );
      }
      return { replace: await provider.shouldReplaceDbDropin( sitePath ) };
    } );
  }
}

async function installCases() {
  const corpus = [
    [ 'absent', null, false ],
    [ 'foreign', '<?php class QM_DB {}\n', false ],
    [ 'stock', `<?php // ${ stockMarker }\n`, false ],
    [ 'custom-define', "<?php define( 'SQLITE_DB_DROPIN_VERSION', 'custom' );\n", true ],
    [ 'comment-token', '<?php // SQLITE_DB_DROPIN_VERSION is not defined\n', false ],
    [ 'string-token', "<?php $value = 'SQLITE_DB_DROPIN_VERSION';\n", false ],
  ];

  for ( const [ name, content, preserved ] of corpus ) {
    await runCase(
      `install-${ name }`,
      operations[ 2 ],
      { completed: true, preserved, pluginInstalled: true },
      async ( sitePath ) => {
        const dbPath = path.join( sitePath, 'wp-content', 'db.php' );
        if ( content !== null ) {
          fs.writeFileSync( dbPath, content );
        }
        await provider.installSqliteIntegration( sitePath );
        return {
          completed: true,
          preserved: fs.readFileSync( dbPath, 'utf8' ) === content,
          pluginInstalled: fs.existsSync(
            path.join( sitePath, 'wp-content', 'mu-plugins', 'sqlite-database-integration', 'load.php' )
          ),
        };
      }
    );
  }

  await runCase(
    'install-database-file-blocker',
    operations[ 2 ],
    { completed: true, databaseDirectory: true },
    async ( sitePath ) => {
      const databasePath = path.join( sitePath, 'wp-content', 'database' );
      fs.writeFileSync( databasePath, 'blocker' );
      await provider.installSqliteIntegration( sitePath );
      return { completed: true, databaseDirectory: fs.lstatSync( databasePath ).isDirectory() };
    }
  );

  await runCase(
    'install-db-php-directory-blocker',
    operations[ 2 ],
    { completed: true, dbPhpFile: true },
    async ( sitePath ) => {
      const dbPath = path.join( sitePath, 'wp-content', 'db.php' );
      fs.mkdirSync( dbPath );
      await provider.installSqliteIntegration( sitePath );
      return { completed: true, dbPhpFile: fs.lstatSync( dbPath ).isFile() };
    }
  );

  await runCase(
    'install-db-php-external-symlink',
    operations[ 2 ],
    { completed: true, externalUnchanged: true, dbPhpSymlink: false },
    async ( sitePath ) => {
      const externalPath = path.join( scratchRoot, 'external-db.php' );
      const dbPath = path.join( sitePath, 'wp-content', 'db.php' );
      fs.writeFileSync( externalPath, '<?php // external sentinel\n' );
      fs.symlinkSync( externalPath, dbPath );
      await provider.installSqliteIntegration( sitePath );
      return {
        completed: true,
        externalUnchanged: fs.readFileSync( externalPath, 'utf8' ) === '<?php // external sentinel\n',
        dbPhpSymlink: fs.lstatSync( dbPath ).isSymbolicLink(),
      };
    }
  );

  await runCase(
    'keep-updated-intentional-mysql',
    operations[ 3 ],
    { sqliteArtifacts: false },
    async ( sitePath ) => {
      fs.writeFileSync( path.join( sitePath, 'wp-config.php' ), '<?php // external database\n' );
      await provider.keepSqliteIntegrationUpdated( sitePath );
      return {
        sqliteArtifacts:
          fs.existsSync( path.join( sitePath, 'wp-content', 'db.php' ) ) ||
          fs.existsSync( path.join( sitePath, 'wp-content', 'database', '.ht.sqlite' ) ) ||
          fs.existsSync(
            path.join( sitePath, 'wp-content', 'mu-plugins', 'sqlite-database-integration' )
          ),
      };
    }
  );
}

function findingCode( result ) {
  if ( result.id.includes( 'external-symlink' ) ) return 'external-symlink-write';
  if ( result.id.includes( 'database-file-blocker' ) ) return 'database-path-blocker';
  if ( result.id.includes( 'db-php-directory-blocker' ) ) return 'dropin-path-blocker';
  return 'non-defining-token-preserved';
}

const findingDetails = {
  'external-symlink-write': [ 'SQLite installation writes through an external db.php symlink', 'high' ],
  'database-path-blocker': [ 'SQLite installation cannot recover from a file blocking the database directory', 'medium' ],
  'dropin-path-blocker': [ 'SQLite installation cannot recover from a directory blocking db.php', 'medium' ],
  'non-defining-token-preserved': [ 'Non-defining SQLITE_DB_DROPIN_VERSION text preserves a foreign drop-in', 'medium' ],
};

function artifact( id, kind, file ) {
  return {
    schema: 'homeboy/fuzz-artifact/v1',
    id,
    kind,
    artifact: {
      schema: 'homeboy/artifact-contract/v1',
      kind,
      type: 'file',
      path: file,
      role: kind,
    },
  };
}

try {
  await classificationCases();
  await contentCases();
  await installCases();

  const failed = results.filter( ( result ) => ! result.passed );
  const groupedFailures = Map.groupBy( failed, findingCode );
  const findings = Array.from( groupedFailures, ( [ code, cases ] ) => {
    const representative = cases[ 0 ];
    return {
      schema: 'homeboy/fuzz-finding/v1',
      id: `db-dropin-${ code }`,
      title: findingDetails[ code ][ 0 ],
      severity: findingDetails[ code ][ 1 ],
      status: 'open',
      target_id: 'sqlite-integration-provider',
      operation_id: representative.operation,
      case_id: representative.id,
      workload_id: 'db-dropin-state-machine-fuzz',
      seed_id: `seed-${ seed }`,
      fingerprint: hash( code ),
      artifact_ids: [ 'case-log', 'replay-data' ],
      source_refs: [ 'packages/common/lib/sqlite-integration.ts' ],
      metadata: {
        case_ids: cases.map( ( result ) => result.id ),
        operations: Array.from( new Set( cases.map( ( result ) => result.operation ) ) ),
        expected: representative.expected,
        observed: representative.observed,
        error: representative.error,
      },
    };
  } );
  const caseLog = results.map( ( result ) => ( {
    schema: 'homeboy/fuzz-case-log/v1',
    version: 1,
    case_id: result.id,
    target_id: 'sqlite-integration-provider',
    operation_id: result.operation,
    operation_family: result.operation.includes( 'classify' ) ? 'read' : 'update',
    seed,
    input_hash: hash( `${ seed }:${ result.id }` ),
    status: result.passed ? 'passed' : 'failed',
    duration_ms: result.duration_ms,
    ...( result.passed
      ? {}
      : { failure_reason: result.error || 'Observed filesystem state differed from the contract.' } ),
  } ) );
  const coverageSummary = {
    schema: 'homeboy/fuzz-coverage-summary/v1',
    declared_targets: 1,
    executable_targets: 1,
    proven_targets: 1,
    declared_operations: operations.length,
    executable_operations: operations.length,
    proven_operations: new Set( results.map( ( result ) => result.operation ) ).size,
    artifact_ids: [ 'coverage-summary', 'case-log' ],
    metadata: { case_count: results.length, dimensions },
  };
  const artifacts = [
    artifact( 'case-log', 'case_log', 'case-log.jsonl' ),
    artifact( 'replay-data', 'replay_data', 'replay.json' ),
    artifact( 'coverage-summary', 'coverage_summary', 'coverage-summary.json' ),
    artifact( 'result-envelope', 'result_envelope', 'results.json' ),
  ];
  const operationContracts = operations.map( ( operation ) => ( {
    id: operation,
    kind: operation,
    family: operation.includes( 'classify' ) ? 'read' : 'update',
    target_id: 'sqlite-integration-provider',
  } ) );
  const campaign = {
    schema: 'homeboy/fuzz-campaign/v1',
    version: 1,
    id: runId,
    title: 'Studio SQLite db.php state-machine fuzz campaign',
    safety_class: 'isolated_mutation',
    surfaces: [ {
      schema: 'homeboy/fuzz-surface/v1',
      id: 'studio-sqlite-dropin-filesystem',
      kind: 'filesystem-state-machine',
      safety_class: 'isolated_mutation',
      operations: operationContracts,
    } ],
    targets: [ {
      schema: 'homeboy/fuzz-target/v1',
      id: 'sqlite-integration-provider',
      kind: 'typescript-class',
      operations: operationContracts,
      source_refs: [ 'packages/common/lib/sqlite-integration.ts' ],
    } ],
    workloads: [ {
      schema: 'homeboy/fuzz-workload/v1',
      id: 'db-dropin-state-machine-fuzz',
      safety_class: 'isolated_mutation',
      operations,
      seed_ids: [ `seed-${ seed }` ],
      case_budget: results.length,
    } ],
    cases: results.map( ( result ) => ( {
      schema: 'homeboy/fuzz-case/v1',
      id: result.id,
      target_id: 'sqlite-integration-provider',
      operation_id: result.operation,
      workload_id: 'db-dropin-state-machine-fuzz',
      seed_id: `seed-${ seed }`,
      replay_id: result.id,
      expected: result.expected,
      observed: { ...result.observed, error: result.error },
    } ) ),
    seeds: [ {
      schema: 'homeboy/fuzz-seed/v1',
      id: `seed-${ seed }`,
      kind: 'deterministic',
      value: seed,
    } ],
    coverage_summary: coverageSummary,
    findings,
    artifacts,
    provenance: {
      schema: 'homeboy/fuzz-provenance/v1',
      producer: 'homeboy-rigs/Automattic/studio',
      producer_version: 'db-dropin-state-machine/v1',
      invocation: 'Automattic/studio/fuzz/db-dropin-fuzz-runner.mjs',
      run_id: runId,
      source_ref: 'packages/common/lib/sqlite-integration.ts',
    },
    replay: {
      schema: 'homeboy/fuzz-replay/v1',
      id: 'studio-db-dropin-replay',
      command: 'homeboy',
      args: [ 'fuzz', 'run', '--rig', 'studio-db-dropin-fuzz', '--profile', 'isolated' ],
      seed,
      artifact_id: 'replay-data',
    },
  };

  fs.mkdirSync( artifactsDir, { recursive: true } );
  fs.writeFileSync(
    path.join( artifactsDir, 'case-log.jsonl' ),
    `${ caseLog.map( ( entry ) => JSON.stringify( entry ) ).join( '\n' ) }\n`
  );
  writeJson( path.join( artifactsDir, 'replay.json' ), {
    seed,
    tracker: 'github-issue:Automattic/studio#4355',
    command: 'homeboy fuzz run --rig studio-db-dropin-fuzz --profile isolated',
    case_ids: results.map( ( result ) => result.id ),
  } );
  writeJson( path.join( artifactsDir, 'coverage-summary.json' ), coverageSummary );
  writeJson( resultsFile, campaign );
  console.log( `Wrote Studio db.php fuzz artifacts (${ results.length } cases, ${ findings.length } findings).` );
} finally {
  fs.rmSync( scratchRoot, { recursive: true, force: true } );
}
