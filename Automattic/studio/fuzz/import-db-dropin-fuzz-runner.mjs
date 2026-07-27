import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const studioRoot = process.cwd();
const requireFromStudio = createRequire( path.join( studioRoot, 'package.json' ) );
const tar = requireFromStudio( 'tar' );
const seed = process.env.HOMEBOY_FUZZ_SEED || '4356';
const runId = process.env.HOMEBOY_FUZZ_RUN_ID || `studio-import-db-dropin-${ seed }`;
const artifactsDir = process.env.HOMEBOY_FUZZ_ARTIFACTS_DIR || path.join( studioRoot, 'artifacts/fuzz/run' );
const resultsFile = process.env.HOMEBOY_FUZZ_RESULTS_FILE || path.join( artifactsDir, 'results.json' );
const cliPath = path.join( studioRoot, 'apps/cli/dist/cli/main.mjs' );
const fixturePath = path.join( studioRoot, 'test-fixtures/backups/jetpack-backup.tar.gz' );
const serverFiles = path.join( os.homedir(), '.studio/server-files' );
const root = path.join( os.tmpdir(), `studio-import-fuzz-${ randomUUID() }` );
const configDir = path.join( root, 'config' );
const sitesDir = path.join( root, 'sites' );
const daemonHome = path.join( os.tmpdir(), `sif-${ randomUUID().slice( 0, 8 ) }` );
const results = [];
const caseFilter = process.env.STUDIO_IMPORT_FUZZ_CASE;
const operations = [ 'import.sqlite.foreign-dropin', 'import.mysql.reject-before-mutation' ];
const dimensions = [
  'seven-nonempty-sqlite-artifact-topologies',
  'foreign-dropin-payload-shapes',
  'jetpack-backup-import',
  'raw-sql-import',
  'repeated-import-idempotency',
  'running-site-restoration',
  'intentional-mysql-byte-parity',
];

for ( const prerequisite of [ cliPath, fixturePath, path.join( serverFiles, 'wordpress-versions/latest' ) ] ) {
  if ( ! fs.existsSync( prerequisite ) ) throw new Error( `Missing Studio fuzz prerequisite: ${ prerequisite }` );
}

fs.mkdirSync( configDir, { recursive: true } );
fs.mkdirSync( sitesDir, { recursive: true } );
fs.mkdirSync( daemonHome, { recursive: true } );
fs.symlinkSync( serverFiles, path.join( configDir, 'server-files' ), 'junction' );
fs.writeFileSync(
  path.join( configDir, 'cli.json' ),
  JSON.stringify( { version: 1, sites: [], snapshots: [], lastDependencyCheckTime: Date.now() } )
);

const cliEnv = {
  ...process.env,
  DEV_CONFIG_DIR: configDir,
  STUDIO_PROCESS_MANAGER_HOME: daemonHome,
  E2E: '1',
  E2E_APP_DATA_PATH: root,
};

function hash( value ) {
  return `sha256:${ createHash( 'sha256' ).update( value ).digest( 'hex' ) }`;
}

function writeJson( file, value ) {
  fs.mkdirSync( path.dirname( file ), { recursive: true } );
  fs.writeFileSync( file, `${ JSON.stringify( value, null, 2 ) }\n` );
}

function runCli( args, timeoutMs = 300_000 ) {
  return new Promise( ( resolve ) => {
    const controller = new AbortController();
    const timeout = setTimeout( () => controller.abort(), timeoutMs );
    const child = spawn( process.execPath, [ cliPath, ...args ], {
      cwd: studioRoot,
      env: cliEnv,
      stdio: [ 'ignore', 'pipe', 'pipe' ],
      signal: controller.signal,
    } );
    let stdout = '';
    let stderr = '';
    let spawnError;
    child.stdout.on( 'data', ( chunk ) => ( stdout += chunk ) );
    child.stderr.on( 'data', ( chunk ) => ( stderr += chunk ) );
    child.on( 'error', ( error ) => ( spawnError = error ) );
    child.on( 'close', ( code, signal ) => {
      clearTimeout( timeout );
      resolve( {
        code: spawnError ? 1 : code,
        signal: signal || ( controller.signal.aborted ? 'TIMEOUT' : null ),
        stdout,
        stderr: spawnError ? `${ stderr }\n${ spawnError.message }` : stderr,
      } );
    } );
  } );
}

async function createStoppedSite( id ) {
  const sitePath = path.join( sitesDir, id );
  const result = await runCli( [
    'site', 'create', '--name', id, '--path', sitePath, '--wp', 'latest', '--runtime', 'sandbox',
    '--no-start', '--skip-browser', '--skip-log-details',
  ] );
  if ( result.code !== 0 ) throw new Error( `Site creation failed for ${ id }: ${ result.stderr }` );
  return sitePath;
}

function sqlitePaths( sitePath ) {
  return [
    path.join( sitePath, 'wp-content/db.php' ),
    path.join( sitePath, 'wp-content/database/.ht.sqlite' ),
    path.join( sitePath, 'wp-content/mu-plugins/sqlite-database-integration' ),
  ];
}

function setArtifactMask( sitePath, mask ) {
  fs.copyFileSync( path.join( sitePath, 'wp-config-sample.php' ), path.join( sitePath, 'wp-config.php' ) );
  const artifacts = sqlitePaths( sitePath );
  for ( const [ index, artifactPath ] of artifacts.entries() ) {
    if ( ! ( mask & ( 1 << index ) ) ) {
      fs.rmSync( artifactPath, { recursive: true, force: true } );
    }
  }
  if ( mask & 1 && ! fs.existsSync( artifacts[ 0 ] ) ) {
    throw new Error( 'Fresh Studio site did not include the SQLite db.php drop-in.' );
  }
  if ( mask & 2 && ! fs.existsSync( artifacts[ 1 ] ) ) {
    fs.mkdirSync( path.dirname( artifacts[ 1 ] ), { recursive: true } );
    fs.writeFileSync( artifacts[ 1 ], '' );
  }
  if ( mask & 4 && ! fs.existsSync( artifacts[ 2 ] ) ) {
    throw new Error( 'Fresh Studio site did not include the SQLite integration plugin.' );
  }
}

function snapshotTree( directory ) {
  const entries = [];
  function walk( current ) {
    for ( const entry of fs.readdirSync( current, { withFileTypes: true } ).sort( ( a, b ) => a.name.localeCompare( b.name ) ) ) {
      const absolute = path.join( current, entry.name );
      const relative = path.relative( directory, absolute );
      if ( entry.isDirectory() ) {
        entries.push( [ relative, 'directory' ] );
        walk( absolute );
      } else if ( entry.isSymbolicLink() ) {
        entries.push( [ relative, 'symlink', fs.readlinkSync( absolute ) ] );
      } else {
        entries.push( [ relative, 'file', hash( fs.readFileSync( absolute ) ) ] );
      }
    }
  }
  walk( directory );
  return entries;
}

async function backupVariant( id, content ) {
  const workDir = path.join( root, 'backups', id );
  const contents = path.join( workDir, 'contents' );
  fs.mkdirSync( contents, { recursive: true } );
  await tar.x( { file: fixturePath, cwd: contents } );
  if ( content === null ) fs.rmSync( path.join( contents, 'wp-content/db.php' ), { force: true } );
  else fs.writeFileSync( path.join( contents, 'wp-content/db.php' ), content );
  const archive = path.join( workDir, `${ id }.tar.gz` );
  await tar.c( { file: archive, cwd: contents, gzip: true }, fs.readdirSync( contents ) );
  return { archive, contents };
}

async function runCase( id, operation, callback ) {
  if ( caseFilter && caseFilter !== id ) return;
  const started = performance.now();
  try {
    const observed = await callback();
    results.push( { id, operation, passed: observed.passed, observed, duration_ms: Math.ceil( performance.now() - started ) } );
  } catch ( error ) {
    results.push( {
      id, operation, passed: false, observed: {},
      error: error instanceof Error ? `${ error.name }: ${ error.message }` : String( error ),
      duration_ms: Math.ceil( performance.now() - started ),
    } );
  }
}

function sqliteImportObservation( result, sitePath ) {
  const dbPhp = fs.existsSync( path.join( sitePath, 'wp-content/db.php' ) )
    ? fs.readFileSync( path.join( sitePath, 'wp-content/db.php' ), 'utf8')
    : '';
  const databasePath = path.join( sitePath, 'wp-content/database/.ht.sqlite' );
  const passed =
    result.code === 0 &&
    dbPhp.includes( 'SQLITE_DB_DROPIN_VERSION' ) &&
    ! dbPhp.includes( 'QM_DB' ) &&
    fs.existsSync( databasePath ) &&
    fs.statSync( databasePath ).size > 0;
  return { passed, exit_code: result.code, signal: result.signal, stderr_tail: result.stderr.slice( -2000 ) };
}

function firstSqlFile( contents ) {
  return fs.readdirSync( contents, { recursive: true } )
    .map( ( file ) => path.join( contents, file ) )
    .find( ( file ) => file.endsWith( '.sql' ) && fs.statSync( file ).isFile() );
}

function artifact( id, kind, file ) {
  return {
    schema: 'homeboy/fuzz-artifact/v1', id, kind,
    artifact: { schema: 'homeboy/artifact-contract/v1', kind, type: 'file', path: file, role: kind },
  };
}

try {
  const queryMonitor = "<?php\nclass QM_DB extends wpdb {}\n";
  const topologyBackup = await backupVariant( 'query-monitor-topologies', queryMonitor );
  for ( let mask = 1; mask < 8; mask++ ) {
    await runCase( `sqlite-artifact-mask-${ mask }`, operations[ 0 ], async () => {
      const sitePath = await createStoppedSite( `sqlite-mask-${ mask }` );
      setArtifactMask( sitePath, mask );
      return sqliteImportObservation( await runCli( [ 'import', topologyBackup.archive, '--path', sitePath ] ), sitePath );
    } );
  }

  const payloads = [
    [ 'query-monitor', queryMonitor ],
    [ 'bom-query-monitor', `\ufeff${ queryMonitor }` ],
    [ 'large-query-monitor', `<?php\n/* ${ 'q'.repeat( 524_288 ) } */\nclass QM_DB extends wpdb {}\n` ],
    [ 'foreign-function', '<?php\nfunction foreign_db_dropin() { return true; }\n' ],
    [ 'crlf-query-monitor', queryMonitor.replaceAll( '\n', '\r\n' ) ],
    [ 'binary-ish-query-monitor', `<?php\u0000\u0001\nclass QM_DB extends wpdb {}\n` ],
  ];
  for ( const [ name, content ] of payloads ) {
    await runCase( `sqlite-payload-${ name }`, operations[ 0 ], async () => {
      const backup = await backupVariant( `payload-${ name }`, content );
      const sitePath = await createStoppedSite( `sqlite-payload-${ name }` );
      return sqliteImportObservation( await runCli( [ 'import', backup.archive, '--path', sitePath ] ), sitePath );
    } );
  }

  await runCase( 'sqlite-repeated-foreign-import', operations[ 0 ], async () => {
    const sitePath = await createStoppedSite( 'sqlite-repeated-foreign-import' );
    const first = await runCli( [ 'import', topologyBackup.archive, '--path', sitePath ] );
    const second = await runCli( [ 'import', topologyBackup.archive, '--path', sitePath ] );
    const observation = sqliteImportObservation( second, sitePath );
    return { ...observation, passed: first.code === 0 && observation.passed, first_exit_code: first.code };
  } );

  await runCase( 'sqlite-raw-sql-with-foreign-destination-dropin', operations[ 0 ], async () => {
    const sqlFile = firstSqlFile( topologyBackup.contents );
    if ( ! sqlFile ) throw new Error( 'Jetpack fixture contained no SQL file.' );
    const rawSql = path.join( root, 'backups/sqlite-raw-import.sql' );
    fs.copyFileSync( sqlFile, rawSql );
    const sitePath = await createStoppedSite( 'sqlite-raw-sql' );
    const start = await runCli( [ 'site', 'start', '--path', sitePath, '--skip-browser', '--skip-log-details' ] );
    if ( start.code !== 0 ) return { passed: false, start_exit_code: start.code, stderr_tail: start.stderr.slice( -2000 ) };
    const stop = await runCli( [ 'site', 'stop', '--path', sitePath ] );
    if ( stop.code !== 0 ) return { passed: false, stop_exit_code: stop.code, stderr_tail: stop.stderr.slice( -2000 ) };
    fs.writeFileSync( path.join( sitePath, 'wp-content/db.php' ), queryMonitor );
    return sqliteImportObservation( await runCli( [ 'import', rawSql, '--path', sitePath ] ), sitePath );
  } );

  await runCase( 'sqlite-running-site-foreign-import', operations[ 0 ], async () => {
    const sitePath = await createStoppedSite( 'sqlite-running-site' );
    const start = await runCli( [ 'site', 'start', '--path', sitePath, '--skip-browser', '--skip-log-details' ] );
    if ( start.code !== 0 ) return { passed: false, start_exit_code: start.code, stderr_tail: start.stderr.slice( -2000 ) };
    const imported = await runCli( [ 'import', topologyBackup.archive, '--path', sitePath ] );
    const listed = await runCli( [ 'site', 'list', '--format', 'json' ] );
    const sites = listed.code === 0 ? JSON.parse( listed.stdout.trim() ) : [];
    const running = sites.find( ( site ) => site.path === sitePath )?.running === true;
    const observation = sqliteImportObservation( imported, sitePath );
    return { ...observation, passed: observation.passed && running, running };
  } );

  for ( const [ name, content ] of [ [ 'foreign-backup', queryMonitor ], [ 'backup-without-dropin', null ] ] ) {
    await runCase( `mysql-${ name }`, operations[ 1 ], async () => {
      const backup = await backupVariant( `mysql-${ name }`, content );
      const sitePath = await createStoppedSite( `mysql-${ name }` );
      setArtifactMask( sitePath, 0 );
      const before = snapshotTree( sitePath );
      const result = await runCli( [ 'import', backup.archive, '--path', sitePath ] );
      const after = snapshotTree( sitePath );
      const passed =
        result.code !== 0 &&
        result.stderr.includes( 'Database import requires SQLite' ) &&
        JSON.stringify( before ) === JSON.stringify( after );
      return { passed, exit_code: result.code, tree_equal: JSON.stringify( before ) === JSON.stringify( after ), stderr_tail: result.stderr.slice( -2000 ) };
    } );
  }

  await runCase( 'mysql-raw-sql', operations[ 1 ], async () => {
    const extracted = await backupVariant( 'raw-sql-source', queryMonitor );
    const sqlFile = firstSqlFile( extracted.contents );
    if ( ! sqlFile ) throw new Error( 'Jetpack fixture contained no SQL file.' );
    const rawSql = path.join( root, 'backups/raw-import.sql' );
    fs.copyFileSync( sqlFile, rawSql );
    const sitePath = await createStoppedSite( 'mysql-raw-sql' );
    setArtifactMask( sitePath, 0 );
    const before = snapshotTree( sitePath );
    const result = await runCli( [ 'import', rawSql, '--path', sitePath ] );
    const after = snapshotTree( sitePath );
    const passed = result.code !== 0 && result.stderr.includes( 'Database import requires SQLite' ) && JSON.stringify( before ) === JSON.stringify( after );
    return { passed, exit_code: result.code, tree_equal: JSON.stringify( before ) === JSON.stringify( after ), stderr_tail: result.stderr.slice( -2000 ) };
  } );

  const findings = results.filter( ( result ) => ! result.passed ).map( ( result ) => ( {
    schema: 'homeboy/fuzz-finding/v1',
    id: `pr-4356-${ result.id }`,
    title: `PR 4356 import contract failed: ${ result.id }`,
    severity: 'high', status: 'open', target_id: 'studio-import', operation_id: result.operation,
    case_id: result.id, workload_id: 'import-db-dropin-pr-4356-fuzz', seed_id: `seed-${ seed }`,
    fingerprint: hash( `${ result.operation }:${ result.id }` ),
    artifact_ids: [ 'case-log', 'replay-data' ], source_refs: [ 'Automattic/studio#4356' ],
    metadata: { observed: result.observed, error: result.error },
  } ) );
  const coverageSummary = {
    schema: 'homeboy/fuzz-coverage-summary/v1',
    declared_targets: 1, executable_targets: 1, proven_targets: 1,
    declared_operations: 2, executable_operations: 2,
    proven_operations: new Set( results.map( ( result ) => result.operation ) ).size,
    artifact_ids: [ 'coverage-summary', 'case-log' ], metadata: { case_count: results.length, dimensions },
  };
  const artifacts = [
    artifact( 'case-log', 'case_log', 'case-log.jsonl' ),
    artifact( 'replay-data', 'replay_data', 'replay.json' ),
    artifact( 'coverage-summary', 'coverage_summary', 'coverage-summary.json' ),
    artifact( 'result-envelope', 'result_envelope', 'results.json' ),
  ];
  const operationContracts = operations.map( ( operation ) => ( {
    id: operation, kind: operation, family: 'submit', target_id: 'studio-import',
  } ) );
  const campaign = {
    schema: 'homeboy/fuzz-campaign/v1', version: 1, id: runId,
    title: 'Studio PR 4356 database import boundary fuzz campaign', safety_class: 'isolated_mutation',
    surfaces: [ {
      schema: 'homeboy/fuzz-surface/v1', id: 'studio-cli-database-import', kind: 'cli-import',
      safety_class: 'isolated_mutation', operations: operationContracts,
    } ],
    targets: [ {
      schema: 'homeboy/fuzz-target/v1', id: 'studio-import', kind: 'cli-command',
      operations: operationContracts, source_refs: [ 'apps/cli/lib/import-export/import/importers/importer.ts' ],
    } ],
    workloads: [ {
      schema: 'homeboy/fuzz-workload/v1', id: 'import-db-dropin-pr-4356-fuzz', safety_class: 'isolated_mutation',
      operations, seed_ids: [ `seed-${ seed }` ], case_budget: results.length,
    } ],
    cases: results.map( ( result ) => ( {
      schema: 'homeboy/fuzz-case/v1', id: result.id, target_id: 'studio-import', operation_id: result.operation,
      workload_id: 'import-db-dropin-pr-4356-fuzz', seed_id: `seed-${ seed }`, replay_id: result.id,
      expected: { passed: true }, observed: { ...result.observed, error: result.error },
    } ) ),
    seeds: [ { schema: 'homeboy/fuzz-seed/v1', id: `seed-${ seed }`, kind: 'deterministic', value: seed } ],
    coverage_summary: coverageSummary, findings, artifacts,
    provenance: {
      schema: 'homeboy/fuzz-provenance/v1', producer: 'homeboy-rigs/Automattic/studio',
      producer_version: 'import-db-dropin-pr-4356/v1', invocation: 'Automattic/studio/fuzz/import-db-dropin-fuzz-runner.mjs',
      run_id: runId, source_ref: 'github-pr:Automattic/studio#4356',
    },
    replay: {
      schema: 'homeboy/fuzz-replay/v1', id: 'studio-pr-4356-import-replay', command: 'homeboy',
      args: [ 'fuzz', 'run', '--rig', 'studio-db-dropin-fuzz', '--profile', 'pr-4356' ], seed,
      artifact_id: 'replay-data',
    },
  };

  fs.mkdirSync( artifactsDir, { recursive: true } );
  const caseLog = results.map( ( result ) => ( {
    schema: 'homeboy/fuzz-case-log/v1', version: 1, case_id: result.id, target_id: 'studio-import',
    operation_id: result.operation, operation_family: 'submit', seed,
    input_hash: hash( `${ seed }:${ result.id }` ), status: result.passed ? 'passed' : 'failed',
    duration_ms: result.duration_ms,
    ...( result.passed ? {} : { failure_reason: result.error || 'Import contract failed.' } ),
  } ) );
  fs.writeFileSync( path.join( artifactsDir, 'case-log.jsonl' ), `${ caseLog.map( JSON.stringify ).join( '\n' ) }\n` );
  writeJson( path.join( artifactsDir, 'replay.json' ), {
    seed, tracker: 'github-pr:Automattic/studio#4356',
    command: 'homeboy fuzz run --rig studio-db-dropin-fuzz --profile pr-4356',
    case_ids: results.map( ( result ) => result.id ),
  } );
  writeJson( path.join( artifactsDir, 'coverage-summary.json' ), coverageSummary );
  writeJson( resultsFile, campaign );
  console.log( `Wrote PR 4356 import fuzz artifacts (${ results.length } cases, ${ findings.length } findings).` );
} finally {
  await runCli( [ 'site', 'stop', '--all' ], 60_000 );
  fs.rmSync( root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 } );
  fs.rmSync( daemonHome, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 } );
}
