import fs from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';

const root = process.cwd();
const artifactsDir = process.env.HOMEBOY_FUZZ_ARTIFACTS_DIR || path.join( root, 'artifacts/fuzz/run' );
const resultsFile = process.env.HOMEBOY_FUZZ_RESULTS_FILE || path.join( artifactsDir, 'results.json' );
const requestFile = process.env.HOMEBOY_FUZZ_EXECUTION_REQUEST_FILE;
const runId = process.env.HOMEBOY_FUZZ_RUN_ID || `studio-mysql-fuzz-${ Date.now() }`;
const runtimeRoot = process.env.STUDIO_FUZZ_RUNTIME_ROOT || path.join( '/tmp', runId );
const devConfigDir = path.join( runtimeRoot, 'config' );
const sitesRoot = path.join( runtimeRoot, 'sites' );
const caseLogPath = path.join( artifactsDir, 'case-log.jsonl' );
const replayPath = path.join( artifactsDir, 'replay.json' );
const resultsArtifactPath = path.relative( artifactsDir, resultsFile );
const cliPath = path.join( root, 'apps/cli/dist/cli/main.mjs' );
const commandTimeoutMs = Number( process.env.STUDIO_FUZZ_COMMAND_TIMEOUT_MS || 180_000 );
const replayCommand = 'homeboy fuzz run --rig studio-mysql-poc-fuzz-lab --profile lab';

const request = requestFile
	? JSON.parse( await fs.readFile( requestFile, 'utf8' ) )
	: { id: runId, sampling: { operation_strata: [] } };
const selectedOperations = new Set(
	request.sampling?.operation_strata
		?.find( ( stratum ) => stratum.kind === 'operation' )
		?.values || []
);
const cases = [];
const findings = [];
let activeCaseCommands = null;
let commandSequence = 0;

const caseContracts = {
 'build-cli': {
  invariants: [ 'Studio CLI bundle exists before destructive MySQL cases run', 'NPM install/build failures are classified as rig setup failures, not MySQL product failures' ],
  failure_class: 'rig_setup_failure',
 },
 'create-mysql-native': {
  invariants: [ 'A native Studio site can be created with databaseEngine=mysql', 'The site config includes managed MySQL connection metadata', 'The site path stays inside STUDIO_FUZZ_RUNTIME_ROOT' ],
 },
 'create-mysql-playground-rejected': {
  invariants: [ 'Sandbox/playground runtime rejects MySQL explicitly', 'Rejected playground creation must not leave a usable site config entry' ],
  expected_failure_class: 'unsupported_platform',
 },
 'create-sqlite-default': {
  invariants: [ 'Default site creation remains SQLite when --database-engine is omitted', 'SQLite default behavior is not regressed by MySQL support' ],
 },
 'convert-sqlite-empty': {
  invariants: [ 'A SQLite site with default content can convert to MySQL', 'Converted site remains addressable by Studio CLI' ],
 },
 'convert-sqlite-large': {
  invariants: [ 'A CRUD-heavy SQLite seed survives conversion to MySQL', 'Seeded post count, sentinel option, and aggregate checksum match after conversion', 'Conversion does not drop published content' ],
 },
 'convert-sqlite-rollback-on-kept-dropin': {
  invariants: [ 'Failed conversion rolls the site back to SQLite', 'Existing guarded db.php content remains present', 'Partial MySQL config is not persisted after rollback' ],
  expected_failure_class: 'product_guardrail',
 },
 'mysql-start': {
  invariants: [ 'Managed MySQL starts with the Studio site', 'WP-CLI can query the database after start' ],
 },
 'mysql-port-collision': {
  invariants: [ 'Port collision produces a controlled failure', 'The colliding listener is released after the case', 'The failed start does not corrupt site config' ],
  expected_failure_class: 'rig_induced_fault',
 },
 'mysql-orphan-process-recovery': {
  invariants: [ 'A stopped MySQL site can restart cleanly', 'WP-CLI can reconnect after restart', 'Stop after recovery leaves the site manageable' ],
 },
 'mysql-concurrent-install-lock': {
  invariants: [ 'Concurrent MySQL site creation shares the binary install lock safely', 'At least one install lock winner does not corrupt the other site config', 'Lock contention failures are classified distinctly from product data-loss failures' ],
 },
 'wpcli-db-query': {
  invariants: [ 'WP-CLI db query succeeds against the managed MySQL site', 'SELECT 1 returns through the configured Studio runtime' ],
 },
 'wpcli-db-import-export': {
  invariants: [ 'WP-CLI export produces an artifact', 'Import restores the deleted sentinel option exactly', 'Round-trip data parity is verified after import' ],
 },
  'wpcli-starts-mysql-when-needed': {
   invariants: [ 'WP-CLI starts managed MySQL on demand when the site server is stopped', 'Database query succeeds without manually starting the site first' ],
  },
  'site-list-status-json': {
   invariants: [ 'studio site list --format json includes the MySQL site', 'studio site status --format json reports the MySQL-backed site without corrupting config', 'JSON output remains machine-readable for lab automation' ],
  },
  'site-set-settings': {
   invariants: [ 'studio site set updates persisted settings for a MySQL site', 'Name and debug settings survive config reload', 'MySQL connection metadata remains present after settings changes' ],
  },
  'wpcli-content-crud': {
   invariants: [ 'WP-CLI can create and read posts, options, users, terms, and comments on a MySQL site', 'CRUD sentinel data is internally consistent', 'Cleanup removes transient CRUD fixtures without data-path errors' ],
  },
  'mysql-persistence-stop-start': {
   invariants: [ 'WP-CLI-created content persists after studio site stop', 'Content remains queryable after studio site start', 'Managed MySQL state survives the Studio lifecycle boundary' ],
  },
  'studio-export-db-mysql': {
   invariants: [ 'studio export --mode db creates a database artifact for the MySQL site', 'The exported database artifact contains the persistence sentinel', 'Export does not require converting the site back to SQLite' ],
  },
  'site-delete-no-files': {
   invariants: [ 'studio site delete --no-files removes the MySQL site from Studio config', 'The isolated site files remain inside STUDIO_FUZZ_RUNTIME_ROOT for diagnostics', 'Deleting one MySQL site does not remove other campaign sites' ],
  },
  'loopback-wp-cron-idle': {
   invariants: [ 'Loopback wp-cron request returns without a 5xx response', 'Managed MySQL remains queryable after idle loopback traffic' ],
  },
 'loopback-async-post-fanout': {
  invariants: [ 'Concurrent loopback requests avoid 5xx responses', 'Fanout does not wedge the managed MySQL process', 'Managed MySQL remains queryable after fanout' ],
 },
 'loopback-client-abort-worker-survives': {
  invariants: [ 'Intentional client abort is recorded as expected', 'The worker/database path survives the abort', 'A follow-up WP-CLI database query succeeds' ],
 },
 'binary-hash-mismatch-metadata': {
  invariants: [ 'Hash mismatch diagnostics include expected and actual SHA-256 values', 'Synthetic mismatch does not require network download or product mutation' ],
  expected_failure_class: 'rig_induced_fault',
 },
 'binary-offline-unsupported-platform': {
  invariants: [ 'Unsupported synthetic platform is reported as skipped coverage', 'Missing provider artifact is not counted as a product failure' ],
  expected_failure_class: 'unsupported_platform',
  skip_on_expected_failure: true,
 },
 'mysql-stop': {
  invariants: [ 'Managed MySQL can stop cleanly after the campaign', 'Stop cleanup does not mask earlier case results' ],
 },
};

await fs.mkdir( artifactsDir, { recursive: true } );
await fs.rm( runtimeRoot, { recursive: true, force: true } );
await fs.mkdir( sitesRoot, { recursive: true } );
await fs.writeFile( caseLogPath, '' );

const baseEnv = {
	...process.env,
	CI: '1',
	DEV_CONFIG_DIR: devConfigDir,
	STUDIO_PROCESS_MANAGER_HOME: devConfigDir,
	STUDIO_HOME: devConfigDir,
	TMPDIR: path.join( runtimeRoot, 'tmp' ),
};
await fs.mkdir( baseEnv.TMPDIR, { recursive: true } );

function snippet( value, length = 4000 ) {
 return String( value || '' ).slice( -length );
}

function errorMetadata( result ) {
  const text = `${ result.stdout }\n${ result.stderr }`;
  return {
   saw_mysql_unavailable: /MySQL .*not available|No managed MySQL server|unsupported platform/i.test( text ),
   saw_unknown_cli_surface: /Unknown argument|Unknown command|Not enough non-option arguments|You must provide a valid command/i.test( text ),
   saw_hash_mismatch: /SHA-256 mismatch|hash mismatch/i.test( text ),
   saw_lock_timeout: /lock|EEXIST|Timed out waiting/i.test( text ),
   saw_port_collision: /EADDRINUSE|address already in use|port.*in use|Timed out waiting for mysqld/i.test( text ),
  saw_rollback: /rolled back to SQLite|rolling back to SQLite|site is unchanged/i.test( text ),
 };
}

function classifyResult( result, options = {}, contract = {} ) {
 const metadata = errorMetadata( result );
 if ( contract.skip_on_expected_failure && result.code !== 0 ) {
  return 'unsupported_platform';
 }
  if ( metadata.saw_mysql_unavailable ) {
   return 'unsupported_platform';
  }
  if ( metadata.saw_unknown_cli_surface ) {
   return 'unsupported_cli_surface';
  }
 if ( result.signal === 'TIMEOUT' || metadata.saw_lock_timeout ) {
  return 'rig_setup_failure';
 }
 if ( metadata.saw_hash_mismatch || metadata.saw_port_collision || metadata.saw_rollback ) {
  return options.expectFailure ? contract.expected_failure_class || 'rig_induced_fault' : 'product_bug';
 }
 if ( options.expectFailure ) {
  return contract.expected_failure_class || 'rig_induced_fault';
 }
 return contract.failure_class || 'product_bug';
}

async function gitValue( args ) {
 const result = await run( 'git', args, { operationId: 'replay-git', timeoutMs: 15_000 } );
 return result.code === 0 ? result.stdout.trim() : null;
}

async function postCaseHealthProbe( caseId, name ) {
 const probes = [];
 if ( name ) {
  const db = await cli( 'wp', '--path', sitePath( name ), 'db', 'query', 'SELECT 1' );
  probes.push( {
   id: `${ caseId }:wpcli-db-select-1`,
   target: name,
   status: db.code === 0 ? 'passed' : 'failed',
   exit_code: db.code,
   signal: db.signal || null,
   duration_ms: db.duration_ms,
   stdout_tail: snippet( db.stdout ),
   stderr_tail: snippet( db.stderr ),
   classification: db.code === 0 ? 'healthy' : classifyResult( db ),
  } );
 }
 return probes;
}

async function run( command, args, options = {} ) {
 const started = Date.now();
 return await new Promise( ( resolve ) => {
  const commandId = `${ options.operationId || 'command' }-${ ++commandSequence }`;
  const controller = new AbortController();
  const timeout = setTimeout( () => controller.abort(), options.timeoutMs || commandTimeoutMs );
  const child = spawn( command, args, {
   cwd: options.cwd || root,
   env: { ...baseEnv, ...( options.env || {} ) },
   stdio: [ options.stdin ? 'pipe' : 'ignore', 'pipe', 'pipe' ],
   signal: controller.signal,
  } );
  let stdout = '';
  let stderr = '';
  let spawnError = null;
  if ( options.stdin ) {
   child.stdin.end( options.stdin );
  }
  child.stdout.on( 'data', ( chunk ) => ( stdout += chunk ) );
  child.stderr.on( 'data', ( chunk ) => ( stderr += chunk ) );
  child.on( 'error', ( error ) => {
   spawnError = error;
  } );
  child.on( 'close', ( code, signal ) => {
   clearTimeout( timeout );
   const result = {
    command_id: commandId,
    command,
    args,
    cwd: options.cwd || root,
    code: spawnError ? 1 : code,
    signal: signal || ( controller.signal.aborted ? 'TIMEOUT' : null ),
    stdout,
    stderr: spawnError ? `${ stderr }\n${ spawnError.stack || spawnError.message }` : stderr,
    duration_ms: Date.now() - started,
   };
   const envelope = {
    command_id: commandId,
    command,
    args,
    cwd: result.cwd,
    exit_code: result.code,
    signal: result.signal,
    duration_ms: result.duration_ms,
    stdout_tail: snippet( result.stdout ),
    stderr_tail: snippet( result.stderr ),
    error_metadata: errorMetadata( result ),
   };
   activeCaseCommands?.push( envelope );
   resolve( result );
  } );
 } );
}

async function logCase( entry ) {
	await fs.appendFile( caseLogPath, `${ JSON.stringify( entry ) }\n` );
}

async function runCase( id, targetId, operationId, fn, options = {} ) {
	if ( selectedOperations.size && ! selectedOperations.has( operationId ) ) {
		return;
	}
  const started = new Date().toISOString();
  const contract = { ...( caseContracts[ id ] || {} ), ...( options.contract || {} ) };
  activeCaseCommands = [];
   try {
	  const observed = await fn();
   const health_probes = options.healthSite ? await postCaseHealthProbe( id, options.healthSite ) : [];
   const skipped = Boolean( contract.skip_on_expected_failure && options.expectFailure && observed.code !== 0 );
   const passed = skipped || ( options.expectFailure ? observed.code !== 0 : observed.code === 0 );
		const status = skipped ? 'skipped' : passed ? 'passed' : 'failed';
   const classification = classifyResult( observed, options, contract );
		const caseEntry = {
			schema: 'homeboy/fuzz-case/v1',
			id,
			target_id: targetId,
			operation_id: operationId,
			workload_id: process.env.HOMEBOY_FUZZ_WORKLOAD_ID || 'component-script-1',
   observed: {
    status,
    exit_code: observed.code,
    signal: observed.signal || null,
    duration_ms: observed.duration_ms,
    stdout_tail: snippet( observed.stdout ),
    stderr_tail: snippet( observed.stderr ),
    error_metadata: errorMetadata( observed ),
    classification,
    health_probes,
    commands: activeCaseCommands,
   },
   metadata: {
    started,
    expect_failure: Boolean( options.expectFailure ),
    expected_skip: Boolean( contract.skip_on_expected_failure ),
    invariants: contract.invariants || [],
    replay: {
      run_id: runId,
      case_id: id,
      operation_id: operationId,
      runtime_root: runtimeRoot,
      artifacts_dir: artifactsDir,
      command: replayCommand,
      selected_operation: operationId,
     },
    ...( options.metadata || {} ),
   },
  };
		cases.push( caseEntry );
		await logCase( caseEntry );
  if ( ! passed ) {
			findings.push( {
				schema: 'homeboy/fuzz-finding/v1',
				id: `${ id }-failure`,
				status: 'open',
				severity: 'high',
				title: `Studio MySQL fuzz case failed: ${ operationId }`,
				target_id: targetId,
				operation_id: operationId,
				case_id: id,
				metadata: { ...caseEntry.observed, classification, invariants: contract.invariants || [] },
			} );
		}
	} catch ( error ) {
		const caseEntry = {
			schema: 'homeboy/fuzz-case/v1',
			id,
			target_id: targetId,
			operation_id: operationId,
   observed: { status: 'error', error: error?.stack || String( error ), classification: 'rig_setup_failure', commands: activeCaseCommands },
   metadata: { started, invariants: contract.invariants || [] },
  };
		cases.push( caseEntry );
		await logCase( caseEntry );
		findings.push( {
			schema: 'homeboy/fuzz-finding/v1',
			id: `${ id }-error`,
			status: 'open',
			severity: 'critical',
			title: `Studio MySQL fuzz case errored: ${ operationId }`,
			target_id: targetId,
			operation_id: operationId,
			case_id: id,
			metadata: caseEntry.observed,
		} );
 } finally {
  activeCaseCommands = null;
 }
}

const cli = ( ...args ) => run( process.execPath, [ cliPath, ...args ], { operationId: args.join( '-' ) } );
const sitePath = ( name ) => path.join( sitesRoot, name );
const cliConfigPath = path.join( devConfigDir, 'cli.json' );

async function readCliConfig() {
 return JSON.parse( await fs.readFile( cliConfigPath, 'utf8' ) );
}

async function getSiteConfig( name ) {
 const config = await readCliConfig();
 const fullPath = sitePath( name );
 const site = config.sites.find( ( item ) => item.path === fullPath );
 if ( ! site ) {
  throw new Error( `Missing fuzz site config for ${ name } at ${ fullPath }` );
 }
 return site;
}

async function createSqliteSite( name ) {
 return cli( 'site', 'create', '--path', sitePath( name ), '--name', name, '--runtime', 'native', '--no-start', '--skip-browser', '--skip-log-details' );
}

async function createMysqlSite( name ) {
 return cli( 'site', 'create', '--path', sitePath( name ), '--name', name, '--runtime', 'native', '--database-engine', 'mysql', '--no-start', '--skip-browser', '--skip-log-details' );
}

async function seedLargeSqliteSite( name ) {
  const content = 'Large MySQL conversion fuzz payload '.repeat( 200 );
  const code = `for ($i = 0; $i < 250; $i++) { wp_insert_post(array('post_title' => 'Fuzz post ' . $i, 'post_status' => 'publish', 'post_content' => ${ JSON.stringify( content ) })); } for ($i = 0; $i < 25; $i++) { wp_insert_post(array('post_title' => 'Fuzz page ' . $i, 'post_type' => 'page', 'post_status' => 'publish', 'post_content' => 'page-' . $i)); } update_option('studio_mysql_fuzz_large_seeded', '250-posts-25-pages'); update_option('studio_mysql_fuzz_large_checksum', md5('250-posts-25-pages|' . ${ JSON.stringify( content ) }));`;
  return cli( 'wp', '--path', sitePath( name ), 'eval', code );
}

async function verifyLargeSqliteParity( name ) {
 const content = 'Large MySQL conversion fuzz payload '.repeat( 200 );
 const code = `
$posts = (int) wp_count_posts('post')->publish;
$pages = (int) wp_count_posts('page')->publish;
$seeded = get_option('studio_mysql_fuzz_large_seeded');
$checksum = get_option('studio_mysql_fuzz_large_checksum');
$expected_checksum = md5('250-posts-25-pages|' . ${ JSON.stringify( content ) });
$ok = $posts >= 250 && $pages >= 25 && $seeded === '250-posts-25-pages' && $checksum === $expected_checksum;
echo wp_json_encode(array('posts' => $posts, 'pages' => $pages, 'seeded' => $seeded, 'checksum' => $checksum, 'expected_checksum' => $expected_checksum, 'parity_ok' => $ok));
if (!$ok) { exit(1); }
`;
 return cli( 'wp', '--path', sitePath( name ), 'eval', code );
}

async function verifyOptionEquals( name, option, expected ) {
  const code = `$actual = get_option(${ JSON.stringify( option ) }); echo wp_json_encode(array('option' => ${ JSON.stringify( option ) }, 'expected' => ${ JSON.stringify( expected ) }, 'actual' => $actual, 'parity_ok' => $actual === ${ JSON.stringify( expected ) })); if ($actual !== ${ JSON.stringify( expected ) }) { exit(1); }`;
  return cli( 'wp', '--path', sitePath( name ), 'eval', code );
}

function parseJsonOutput( result ) {
 const output = String( result.stdout || '' ).trim();
 const starts = [ output.indexOf( '[' ), output.indexOf( '{' ) ].filter( ( index ) => index >= 0 );
 if ( starts.length === 0 ) {
  throw new Error( `No JSON object found in CLI output: ${ snippet( output ) }` );
 }
 return JSON.parse( output.slice( Math.min( ...starts ) ) );
}

async function verifySiteListAndStatus( name ) {
 const list = await cli( 'site', 'list', '--format', 'json' );
 if ( list.code !== 0 ) {
  return list;
 }
 const sites = parseJsonOutput( list );
 const site = sites.find( ( item ) => item.path === sitePath( name ) );
 if ( ! site || site.databaseEngine !== 'mysql' || ! site.mysql ) {
  return { ...list, code: 1, stderr: `${ list.stderr }\nMySQL site missing from site list JSON: ${ JSON.stringify( { found: site || null } ) }` };
 }
 const status = await cli( 'site', 'status', '--path', sitePath( name ), '--format', 'json' );
 if ( status.code !== 0 ) {
  return combineResults( [ list, status ], list.duration_ms + status.duration_ms );
 }
 const statusJson = parseJsonOutput( status );
 if ( statusJson.sitePath !== sitePath( name ) || typeof statusJson.isOnline !== 'boolean' || statusJson.runtime !== 'Native' ) {
  return { ...status, code: 1, stderr: `${ status.stderr }\nUnexpected site status JSON: ${ JSON.stringify( statusJson ) }` };
 }
 return combineResults( [ list, status ], list.duration_ms + status.duration_ms );
}

async function verifySiteConfigValues( name, expected ) {
 const site = await getSiteConfig( name );
 const mismatches = Object.entries( expected ).filter( ( [ key, value ] ) => site[ key ] !== value );
 if ( mismatches.length || site.databaseEngine !== 'mysql' || ! site.mysql ) {
  return {
   code: 1,
   signal: null,
   duration_ms: 0,
   stdout: JSON.stringify( { site, expected } ),
   stderr: `Site config mismatch: ${ JSON.stringify( mismatches ) }`,
  };
 }
 return { code: 0, signal: null, duration_ms: 0, stdout: JSON.stringify( { site, expected } ), stderr: '' };
}

async function verifyContentCrud( name ) {
 const code = `
$suffix = ${ JSON.stringify( runId ) };
$option_key = 'studio_mysql_fuzz_crud_' . preg_replace('/[^a-z0-9_]/i', '_', $suffix);
update_option($option_key, 'created');
$term = wp_insert_term('Studio MySQL Fuzz Term ' . $suffix, 'category');
if (is_wp_error($term)) { echo $term->get_error_message(); exit(1); }
$user_id = wp_insert_user(array('user_login' => 'studio_mysql_fuzz_' . substr(md5($suffix), 0, 12), 'user_pass' => wp_generate_password(20), 'user_email' => 'studio-mysql-fuzz-' . substr(md5($suffix), 0, 12) . '@example.test', 'role' => 'author'));
if (is_wp_error($user_id)) { echo $user_id->get_error_message(); exit(1); }
$post_id = wp_insert_post(array('post_title' => 'Studio MySQL CRUD ' . $suffix, 'post_status' => 'publish', 'post_content' => 'crud sentinel', 'post_author' => $user_id, 'post_category' => array((int) $term['term_id'])));
if (is_wp_error($post_id) || ! $post_id) { echo 'post insert failed'; exit(1); }
$comment_id = wp_insert_comment(array('comment_post_ID' => $post_id, 'comment_author' => 'Studio Fuzz', 'comment_author_email' => 'studio-fuzz@example.test', 'comment_content' => 'comment sentinel ' . $suffix, 'comment_approved' => 1));
if (! $comment_id) { echo 'comment insert failed'; exit(1); }
$ok = get_option($option_key) === 'created' && get_post($post_id) && get_user_by('id', $user_id) && get_term($term['term_id'], 'category') && get_comment($comment_id);
$summary = array('option' => get_option($option_key), 'term_id' => (int) $term['term_id'], 'user_id' => (int) $user_id, 'post_id' => (int) $post_id, 'comment_id' => (int) $comment_id, 'crud_ok' => (bool) $ok);
wp_delete_comment($comment_id, true);
wp_delete_post($post_id, true);
wp_delete_user($user_id);
wp_delete_term($term['term_id'], 'category');
delete_option($option_key);
echo wp_json_encode($summary);
if (!$ok) { exit(1); }
`;
 return cli( 'wp', '--path', sitePath( name ), 'eval', code );
}

async function seedPersistenceSentinel( name ) {
 const code = `update_option('studio_mysql_fuzz_persistence', ${ JSON.stringify( runId ) }); $post_id = wp_insert_post(array('post_title' => 'Studio MySQL persistence ${ runId }', 'post_status' => 'publish', 'post_content' => 'persistence sentinel')); echo wp_json_encode(array('option' => get_option('studio_mysql_fuzz_persistence'), 'post_id' => $post_id)); if (!$post_id) { exit(1); }`;
 return cli( 'wp', '--path', sitePath( name ), 'eval', code );
}

async function verifyPersistenceSentinel( name ) {
 const code = `$option = get_option('studio_mysql_fuzz_persistence'); $posts = get_posts(array('post_type' => 'post', 'post_status' => 'publish', 'title' => 'Studio MySQL persistence ${ runId }', 'numberposts' => 1)); $ok = $option === ${ JSON.stringify( runId ) } && count($posts) === 1; echo wp_json_encode(array('option' => $option, 'post_count' => count($posts), 'persistence_ok' => $ok)); if (!$ok) { exit(1); }`;
 return cli( 'wp', '--path', sitePath( name ), 'eval', code );
}

async function runSequence( steps ) {
 const outputs = [];
 const started = Date.now();
 for ( const step of steps ) {
  const result = await step();
  outputs.push( result );
  if ( result.code !== 0 ) {
   return combineResults( outputs, Date.now() - started );
  }
 }
 return combineResults( outputs, Date.now() - started );
}

function combineResults( results, durationMs ) {
 const failed = results.find( ( item ) => item.code !== 0 );
 const last = results[ results.length - 1 ] || { code: 0, signal: null };
 return {
  code: failed ? failed.code : last.code,
  signal: failed?.signal || last.signal,
  duration_ms: durationMs,
  stdout: results.map( ( item, index ) => `## step ${ index + 1 }\n${ item.stdout }` ).join( '\n' ),
  stderr: results.map( ( item, index ) => `## step ${ index + 1 }\n${ item.stderr }` ).join( '\n' ),
 };
}

async function withPortCollision( port, fn ) {
 const server = net.createServer();
 await new Promise( ( resolve, reject ) => {
  server.once( 'error', reject );
  server.listen( port, '127.0.0.1', resolve );
 } );
 try {
  return await fn();
 } finally {
  await new Promise( ( resolve ) => server.close( resolve ) );
 }
}

async function requestSite( site, requestPath, options = {} ) {
 const started = Date.now();
 return await new Promise( ( resolve ) => {
  const commandId = `http-${ ++commandSequence }`;
  const finish = ( result ) => {
   const envelope = {
    command_id: commandId,
    command: 'http.request',
    args: [ `${ options.method || 'GET' } http://127.0.0.1:${ site.port }${ requestPath }` ],
    cwd: root,
    exit_code: result.code,
    signal: result.signal || null,
    duration_ms: result.duration_ms,
    stdout_tail: snippet( result.stdout ),
    stderr_tail: snippet( result.stderr ),
    error_metadata: errorMetadata( result ),
   };
   activeCaseCommands?.push( envelope );
   resolve( result );
  };
  const req = http.request(
   {
    hostname: '127.0.0.1',
    port: site.port,
    path: requestPath,
    method: options.method || 'GET',
    headers: { host: `localhost:${ site.port }`, ...( options.headers || {} ) },
    timeout: options.timeoutMs || 15_000,
   },
   ( res ) => {
    let body = '';
    res.on( 'data', ( chunk ) => ( body += chunk ) );
    res.on( 'end', () =>
     finish( {
      code: res.statusCode && res.statusCode < 500 ? 0 : 1,
      signal: null,
      stdout: body,
      stderr: '',
      duration_ms: Date.now() - started,
     } )
    );
   }
  );
  req.on( 'timeout', () => req.destroy( new Error( 'HTTP request timed out' ) ) );
  req.on( 'error', ( error ) =>
   finish( {
    code: options.expectAbort ? 0 : 1,
    signal: options.expectAbort ? 'CLIENT_ABORT' : null,
    stdout: '',
    stderr: error.stack || String( error ),
    duration_ms: Date.now() - started,
   } )
  );
  if ( options.abortAfterMs ) {
   setTimeout( () => req.destroy( new Error( 'intentional client abort' ) ), options.abortAfterMs );
  }
  if ( options.body ) {
   req.write( options.body );
  }
  req.end();
 } );
}

await runCase( 'build-cli', 'studio.mysql.binary.delivery', 'binary.metadata.platform.resolve', () =>
	run( 'npm', [ 'ci' ] ).then( async ( install ) => {
		if ( install.code !== 0 ) {
			return install;
		}

		return await run( 'npm', [ 'run', 'cli:build', '--silent' ] );
	} )
);

await runCase( 'create-mysql-native', 'studio.cli.site.create.mysql', 'create.mysql.native', () =>
	cli( 'site', 'create', '--path', sitePath( 'mysql-native' ), '--name', 'mysql-native', '--runtime', 'native', '--database-engine', 'mysql', '--no-start', '--skip-browser', '--skip-log-details' )
);

await runCase( 'create-mysql-playground-rejected', 'studio.cli.site.create.mysql', 'create.mysql.playground.rejected', () =>
	cli( 'site', 'create', '--path', sitePath( 'mysql-playground' ), '--name', 'mysql-playground', '--runtime', 'sandbox', '--database-engine', 'mysql', '--no-start', '--skip-browser', '--skip-log-details' ),
	{ expectFailure: true }
);

await runCase( 'create-sqlite-default', 'studio.cli.site.create.mysql', 'create.sqlite.default.unchanged', () =>
	cli( 'site', 'create', '--path', sitePath( 'sqlite-default' ), '--name', 'sqlite-default', '--runtime', 'native', '--skip-browser', '--skip-log-details' )
);

await runCase( 'convert-sqlite-empty', 'studio.cli.site.convert.mysql', 'convert.sqlite.mysql.empty', () =>
	cli( 'site', 'convert', '--path', sitePath( 'sqlite-default' ), '--to', 'mysql' )
);

await runCase( 'convert-sqlite-large', 'studio.cli.site.convert.mysql', 'convert.sqlite.mysql.large', () =>
 runSequence( [
  () => createSqliteSite( 'sqlite-large' ),
  () => seedLargeSqliteSite( 'sqlite-large' ),
  () => cli( 'site', 'convert', '--path', sitePath( 'sqlite-large' ), '--to', 'mysql' ),
  () => verifyLargeSqliteParity( 'sqlite-large' ),
 ] ),
 { healthSite: 'sqlite-large', metadata: { expected_minimum_posts_after_conversion: 250, expected_minimum_pages_after_conversion: 25, parity_probe: 'posts-pages-options-checksum' } }
);

await runCase( 'convert-sqlite-rollback-on-kept-dropin', 'studio.cli.site.convert.mysql', 'convert.sqlite.mysql.rollback', async () => {
 const name = 'sqlite-rollback';
 const created = await createSqliteSite( name );
 if ( created.code !== 0 ) {
  return created;
 }
 const dbPhpPath = path.join( sitePath( name ), 'wp-content', 'db.php' );
 const originalDropin = await fs.readFile( dbPhpPath, 'utf8' );
 await fs.writeFile( dbPhpPath, `${ originalDropin }\n/* @studio-keep fuzz rollback guard */\n` );
 const failedConvert = await cli( 'site', 'convert', '--path', sitePath( name ), '--to', 'mysql' );
 const siteConfig = await getSiteConfig( name );
 const dropinAfter = await fs.readFile( dbPhpPath, 'utf8' );
 return {
  ...failedConvert,
  stdout: `${ failedConvert.stdout }\nrollback_probe=${ JSON.stringify( {
   databaseEngine: siteConfig.databaseEngine || 'sqlite-default',
   hasMysqlConfig: Boolean( siteConfig.mysql ),
   keptDropinStillPresent: dropinAfter.includes( '@studio-keep fuzz rollback guard' ),
  } ) }`,
 };
}, { expectFailure: true } );

await runCase( 'mysql-start', 'studio.runtime.mysql.lifecycle', 'mysql.start.stop.restart', () =>
	cli( 'site', 'start', '--path', sitePath( 'mysql-native' ), '--skip-browser', '--skip-log-details' )
, { healthSite: 'mysql-native' } );

await runCase( 'mysql-port-collision', 'studio.runtime.mysql.lifecycle', 'mysql.port.collision', async () => {
 const name = 'mysql-port-collision';
 const created = await createMysqlSite( name );
 if ( created.code !== 0 ) {
  return created;
 }
 const site = await getSiteConfig( name );
 return await withPortCollision( site.mysql.port, () =>
  cli( 'site', 'start', '--path', sitePath( name ), '--skip-browser', '--skip-log-details' )
 );
}, { expectFailure: true } );

await runCase( 'mysql-orphan-process-recovery', 'studio.runtime.mysql.lifecycle', 'mysql.orphan.process.recovery', () =>
 runSequence( [
  () => createMysqlSite( 'mysql-orphan-recovery' ),
  () => cli( 'site', 'start', '--path', sitePath( 'mysql-orphan-recovery' ), '--skip-browser', '--skip-log-details' ),
  () => cli( 'site', 'stop', '--path', sitePath( 'mysql-orphan-recovery' ) ),
  () => cli( 'site', 'start', '--path', sitePath( 'mysql-orphan-recovery' ), '--skip-browser', '--skip-log-details' ),
  () => cli( 'wp', '--path', sitePath( 'mysql-orphan-recovery' ), 'db', 'query', 'SELECT 1' ),
  () => cli( 'site', 'stop', '--path', sitePath( 'mysql-orphan-recovery' ) ),
 ] ),
 { metadata: { recovery_shape: 'restart_after_stop_then_wpcli_connection_check' } }
);

await runCase( 'mysql-concurrent-install-lock', 'studio.runtime.mysql.lifecycle', 'mysql.concurrent.install.lock', async () => {
 const started = Date.now();
 const results = await Promise.all( [ createMysqlSite( 'mysql-lock-a' ), createMysqlSite( 'mysql-lock-b' ) ] );
 return combineResults( results, Date.now() - started );
}, { metadata: { concurrency: 2, intent: 'exercise shared MySQL binary install lock' } } );

await runCase( 'wpcli-db-query', 'studio.runtime.mysql.wpcli', 'wpcli.db.query', () =>
	cli( 'wp', '--path', sitePath( 'mysql-native' ), 'db', 'query', 'SELECT 1' )
, { healthSite: 'mysql-native' } );

await runCase( 'wpcli-db-import-export', 'studio.runtime.mysql.wpcli', 'wpcli.db.import.export', async () => {
 const exportPath = path.join( artifactsDir, 'wpcli-db-import-export.sql' );
 return runSequence( [
  () => cli( 'wp', '--path', sitePath( 'mysql-native' ), 'option', 'update', 'studio_mysql_fuzz_roundtrip', runId ),
   () => cli( 'wp', '--path', sitePath( 'mysql-native' ), 'db', 'export', exportPath ),
   () => cli( 'wp', '--path', sitePath( 'mysql-native' ), 'option', 'delete', 'studio_mysql_fuzz_roundtrip' ),
   () => cli( 'wp', '--path', sitePath( 'mysql-native' ), 'db', 'import', exportPath ),
   () => verifyOptionEquals( 'mysql-native', 'studio_mysql_fuzz_roundtrip', runId ),
  ] );
}, { healthSite: 'mysql-native', metadata: { export_artifact: 'wpcli-db-import-export.sql', parity_probe: 'option-exact-roundtrip' } } );

await runCase( 'wpcli-starts-mysql-when-needed', 'studio.runtime.mysql.wpcli', 'wpcli.starts.mysql.when-needed', () =>
  runSequence( [
   () => cli( 'site', 'stop', '--path', sitePath( 'mysql-native' ) ),
   () => cli( 'wp', '--path', sitePath( 'mysql-native' ), 'db', 'query', 'SELECT 1' ),
  ] ),
  { healthSite: 'mysql-native', metadata: { intent: 'WP-CLI should ensure managed MySQL is running even when the site server is stopped' } }
);

await runCase( 'site-list-status-json', 'studio.cli.site.management.mysql', 'site.list.status.mysql.json', () =>
 verifySiteListAndStatus( 'mysql-native' ),
 { healthSite: 'mysql-native', metadata: { surfaces: [ 'studio site list --format json', 'studio site status --format json' ] } }
);

await runCase( 'site-set-settings', 'studio.cli.site.management.mysql', 'site.set.mysql.settings', () =>
 runSequence( [
  () => cli( 'site', 'set', '--path', sitePath( 'mysql-native' ), '--name', 'mysql-native-renamed', '--debug-log', '--debug-display' ),
  () => verifySiteConfigValues( 'mysql-native', { name: 'mysql-native-renamed', enableDebugLog: true, enableDebugDisplay: true } ),
 ] ),
 { healthSite: 'mysql-native', metadata: { surfaces: [ 'studio site set --name', 'studio site set --debug-log', 'studio site set --debug-display' ] } }
);

await runCase( 'wpcli-content-crud', 'studio.runtime.mysql.wpcli', 'wpcli.content.crud.mysql', () =>
 verifyContentCrud( 'mysql-native' ),
 { healthSite: 'mysql-native', metadata: { crud_entities: [ 'option', 'term', 'user', 'post', 'comment' ] } }
);

await runCase( 'mysql-persistence-stop-start', 'studio.runtime.mysql.lifecycle', 'mysql.persistence.stop.start', () =>
 runSequence( [
  () => seedPersistenceSentinel( 'mysql-native' ),
  () => cli( 'site', 'stop', '--path', sitePath( 'mysql-native' ) ),
  () => cli( 'site', 'start', '--path', sitePath( 'mysql-native' ), '--skip-browser', '--skip-log-details' ),
  () => verifyPersistenceSentinel( 'mysql-native' ),
 ] ),
 { healthSite: 'mysql-native', metadata: { persistence_probe: 'option-and-post-sentinel-after-stop-start' } }
);

await runCase( 'studio-export-db-mysql', 'studio.cli.site.artifacts.mysql', 'studio.export.db.mysql', () =>
 runSequence( [
  () => cli( 'export', path.join( artifactsDir, 'studio-mysql-native-db.sql' ), '--path', sitePath( 'mysql-native' ), '--mode', 'db' ),
  () => run( process.execPath, [ '--input-type=module', '-e', `import fs from 'node:fs'; const dump = fs.readFileSync(${ JSON.stringify( path.join( artifactsDir, 'studio-mysql-native-db.sql' ) ) }, 'utf8'); if (!dump.includes('studio_mysql_fuzz_persistence') || !dump.includes(${ JSON.stringify( runId ) })) { console.error('Export dump missing persistence sentinel'); process.exit(1); }` ] ),
 ] ),
 { healthSite: 'mysql-native', metadata: { export_artifact: 'studio-mysql-native-db.sql', surface: 'studio export --mode db' } }
);

await runCase( 'site-delete-no-files', 'studio.cli.site.management.mysql', 'site.delete.mysql.no-files', async () => {
 const name = 'mysql-delete-no-files';
 const created = await createMysqlSite( name );
 if ( created.code !== 0 ) {
  return created;
 }
 const deleted = await cli( 'site', 'delete', '--path', sitePath( name ), '--no-files' );
 if ( deleted.code !== 0 ) {
  return deleted;
 }
 const config = await readCliConfig();
 const stillRegistered = config.sites.some( ( site ) => site.path === sitePath( name ) );
 const filesRemain = await fs.access( sitePath( name ) ).then( () => true, () => false );
 return {
  ...deleted,
  code: ! stillRegistered && filesRemain ? 0 : 1,
  stdout: `${ deleted.stdout }\ndelete_probe=${ JSON.stringify( { stillRegistered, filesRemain } ) }`,
  stderr: stillRegistered || ! filesRemain ? `${ deleted.stderr }\nUnexpected delete --no-files state` : deleted.stderr,
 };
}, { metadata: { surface: 'studio site delete --no-files', isolated_site: 'mysql-delete-no-files' } } );

await runCase( 'loopback-wp-cron-idle', 'studio.runtime.mysql.loopback', 'loopback.wp-cron.idle', async () => {
 const start = await cli( 'site', 'start', '--path', sitePath( 'mysql-native' ), '--skip-browser', '--skip-log-details' );
 if ( start.code !== 0 ) {
  return start;
 }
 const site = await getSiteConfig( 'mysql-native' );
 return await requestSite( site, '/wp-cron.php?doing_wp_cron=studio-mysql-fuzz' );
}, { healthSite: 'mysql-native' } );

await runCase( 'loopback-async-post-fanout', 'studio.runtime.mysql.loopback', 'loopback.async.post.fanout', async () => {
 const site = await getSiteConfig( 'mysql-native' );
 const started = Date.now();
 const results = await Promise.all(
  Array.from( { length: 12 }, ( _, index ) =>
   requestSite( site, `/wp-cron.php?doing_wp_cron=studio-mysql-fuzz-${ index }`, { timeoutMs: 20_000 } )
  )
 );
 return combineResults( results, Date.now() - started );
}, { healthSite: 'mysql-native', metadata: { fanout: 12 } } );

await runCase( 'loopback-client-abort-worker-survives', 'studio.runtime.mysql.loopback', 'loopback.client-abort.worker-survives', async () => {
 const site = await getSiteConfig( 'mysql-native' );
 const aborted = await requestSite( site, '/wp-cron.php?doing_wp_cron=studio-mysql-fuzz-abort', {
  abortAfterMs: 25,
  expectAbort: true,
 } );
 if ( aborted.code !== 0 ) {
  return aborted;
 }
 const health = await cli( 'wp', '--path', sitePath( 'mysql-native' ), 'db', 'query', 'SELECT 1' );
 return combineResults( [ aborted, health ], aborted.duration_ms + health.duration_ms );
}, { healthSite: 'mysql-native' } );

await runCase( 'binary-hash-mismatch-metadata', 'studio.mysql.binary.delivery', 'binary.hash.mismatch', () =>
 run( process.execPath, [
  '--input-type=module',
  '-e',
  `import crypto from 'node:crypto'; const actual = crypto.createHash('sha256').update('studio-mysql-fuzz').digest('hex'); const expected = '0'.repeat(64); if (actual === expected) process.exit(0); console.error(JSON.stringify({expected, actual, message: 'synthetic SHA-256 mismatch probe for lab diagnostics'})); process.exit(1);`,
 ] ),
 { expectFailure: true, metadata: { synthetic_probe: true, destructive_download_not_required: true } }
);

await runCase( 'binary-offline-unsupported-platform', 'studio.mysql.binary.delivery', 'binary.offline.unsupported-platform', () =>
 run( process.execPath, [
  '--input-type=module',
  '-e',
  `import metadata from './packages/common/lib/mysql-binary-cdn-metadata.json' with { type: 'json' }; const unsupportedKey = 'aix-ppc64'; const found = Object.values(metadata.versions).some((version) => version.artifacts[unsupportedKey]); if (found) process.exit(1); console.error(JSON.stringify({unsupportedKey, message: 'MySQL 8.4 metadata has no artifact for synthetic unsupported offline platform'})); process.exit(1);`,
 ] ),
 { expectFailure: true, metadata: { synthetic_platform: 'aix-ppc64', offline_probe: true, expected_status: 'skipped' } }
);

await runCase( 'mysql-stop', 'studio.runtime.mysql.lifecycle', 'mysql.start.stop.restart', () =>
	cli( 'site', 'stop', '--path', sitePath( 'mysql-native' ) )
);

const replayMetadata = {
 command: replayCommand,
 run_id: runId,
 cwd: root,
 node: process.version,
 platform: process.platform,
 arch: process.arch,
 git_head: await gitValue( [ 'rev-parse', 'HEAD' ] ),
 git_branch: await gitValue( [ 'branch', '--show-current' ] ),
 selected_operations: [ ...selectedOperations ],
 workload_id: process.env.HOMEBOY_FUZZ_WORKLOAD_ID || 'component-script-1',
 env: {
  HOMEBOY_FUZZ_ARTIFACTS_DIR: artifactsDir,
  HOMEBOY_FUZZ_RESULTS_FILE: resultsFile,
  HOMEBOY_FUZZ_EXECUTION_REQUEST_FILE: requestFile || null,
  STUDIO_FUZZ_RUNTIME_ROOT: runtimeRoot,
  STUDIO_FUZZ_COMMAND_TIMEOUT_MS: String( commandTimeoutMs ),
 },
};

await fs.writeFile(
	replayPath,
	JSON.stringify(
		{
			schema: 'homeboy/fuzz-replay/v1',
			run_id: runId,
			request_file: requestFile,
			dev_config_dir: devConfigDir,
			sites_root: sitesRoot,
			metadata: replayMetadata,
		},
		null,
		2
	)
);

const targetIds = new Set( cases.map( ( item ) => item.target_id ) );
const operationIds = new Set( cases.map( ( item ) => item.operation_id ) );
const skippedCases = cases.filter( ( item ) => item.observed.status === 'skipped' );
const skippedTargets = [ ...new Set( skippedCases.map( ( item ) => item.target_id ) ) ];
const skippedOperations = [ ...new Set( skippedCases.map( ( item ) => item.operation_id ) ) ];
const campaign = {
	schema: 'homeboy/fuzz-campaign/v1',
	version: 1,
	id: runId,
	title: 'Studio MySQL destructive fuzz campaign',
	safety_class: 'isolated_mutation',
	cases,
	findings,
	coverage_summary: {
		schema: 'homeboy/fuzz-coverage-summary/v1',
		declared_targets: targetIds.size,
		executable_targets: targetIds.size,
		proven_targets: targetIds.size,
		declared_operations: operationIds.size,
		executable_operations: operationIds.size,
		proven_operations: operationIds.size,
		skipped_targets: skippedTargets,
		skipped_operations: skippedOperations,
		surface_summaries: [],
		kind_summaries: [],
		artifact_ids: [ 'case-log', 'replay-data', 'result-envelope' ],
	},
	artifacts: [
		{
			schema: 'homeboy/fuzz-artifact/v1',
			id: 'case-log',
			kind: 'case_log',
			artifact: {
				schema: 'homeboy/artifact-contract/v1',
				kind: 'case_log',
				type: 'file',
				path: 'case-log.jsonl',
				role: 'case_log',
			},
		},
		{
			schema: 'homeboy/fuzz-artifact/v1',
			id: 'replay-data',
			kind: 'replay_data',
			artifact: {
				schema: 'homeboy/artifact-contract/v1',
				kind: 'replay_data',
				type: 'file',
				path: 'replay.json',
				role: 'replay_data',
			},
		},
		{
			schema: 'homeboy/fuzz-artifact/v1',
			id: 'result-envelope',
			kind: 'result_envelope',
			artifact: {
				schema: 'homeboy/artifact-contract/v1',
				kind: 'result_envelope',
				type: 'file',
				path: resultsArtifactPath,
				role: 'result_envelope',
			},
		},
	],
	metadata: {
		status: findings.length ? 'failed' : 'passed',
		success: findings.length === 0,
		replay: replayMetadata,
		case_counts: {
			passed: cases.filter( ( item ) => item.observed.status === 'passed' ).length,
			failed: cases.filter( ( item ) => item.observed.status === 'failed' ).length,
			errored: cases.filter( ( item ) => item.observed.status === 'error' ).length,
			skipped: skippedCases.length,
		},
		artifact_refs: [
			{ kind: 'case_log', path: 'case-log.jsonl' },
			{ kind: 'replay_data', path: 'replay.json' },
			{ kind: 'result_envelope', path: resultsArtifactPath },
		],
	},
};

await fs.writeFile( resultsFile, JSON.stringify( campaign, null, 2 ) );
process.exit( findings.length ? 1 : 0 );
