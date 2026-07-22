import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const exec = promisify( execFile );
const componentPath = process.env.HOMEBOY_COMPONENT_PATH;
const resultsFile = process.env.HOMEBOY_TRACE_RESULTS_FILE;
const artifactDir = process.env.HOMEBOY_TRACE_ARTIFACT_DIR || path.join( tmpdir(), 'gutenberg-notes-two-worker-artifacts' );

if ( ! componentPath || ! resultsFile ) {
	throw new Error( 'HOMEBOY_COMPONENT_PATH and HOMEBOY_TRACE_RESULTS_FILE are required' );
}

const suffix = `${ process.pid }-${ Date.now() }`;
const network = `homeboy-notes-${ suffix }`;
const database = `homeboy-notes-db-${ suffix }`;
const wordpress = `homeboy-notes-wp-${ suffix }`;
const workDir = await mkdtemp( path.join( tmpdir(), 'gutenberg-notes-two-worker.' ) );
const fixtureDir = path.join( workDir, 'homeboy-notes-two-worker' );
const fixtureFile = path.join( fixtureDir, 'fixture.php' );
const timeline = [];
const startedAt = performance.now();
const event = ( name, data = {} ) => timeline.push( { t_ms: Math.round( performance.now() - startedAt ), event: name, data } );

async function docker( args, options = {} ) {
	return exec( 'docker', args, { maxBuffer: 16 * 1024 * 1024, ...options } );
}

async function waitFor( predicate, label, timeout = 120000 ) {
	const deadline = Date.now() + timeout;
	let lastError;
	while ( Date.now() < deadline ) {
		try {
			const value = await predicate();
			if ( value ) return value;
		} catch ( error ) {
			lastError = error;
		}
		await new Promise( ( resolve ) => setTimeout( resolve, 500 ) );
	}
	throw new Error( `${ label } timed out${ lastError ? `: ${ lastError.message }` : '' }` );
}

async function request( url, token, options = {} ) {
	const response = await fetch( url, {
		...options,
		headers: {
			'Content-Type': 'application/json',
			'X-Homeboy-CAS-Token': token,
			...( options.headers || {} ),
		},
	} );
	const contentType = response.headers.get( 'content-type' ) || '';
	const text = await response.text();
	let body = text;
	try {
		body = JSON.parse( text );
	} catch {}
	return {
		status: response.status,
		contentType,
		body,
		pid: response.headers.get( 'x-homeboy-php-pid' ),
		dbConnection: response.headers.get( 'x-homeboy-db-connection' ),
	};
}

try {
	await mkdir( fixtureDir, { recursive: true } );
	await mkdir( artifactDir, { recursive: true } );
	await mkdir( path.dirname( resultsFile ), { recursive: true } );
	await writeFile( fixtureFile, `<?php
/** Plugin Name: Homeboy Notes Two Worker Atomicity */
const HOMEBOY_NOTES_INITIAL = '<!-- wp:paragraph --><p>Two worker initial.</p><!-- /wp:paragraph -->';
const HOMEBOY_NOTES_FIRST = '<!-- wp:paragraph {"metadata":{"noteId":[101]}} --><p>Two worker A.</p><!-- /wp:paragraph -->';
const HOMEBOY_NOTES_SECOND = '<!-- wp:paragraph {"metadata":{"noteId":[101,202]}} --><p>Two worker B.</p><!-- /wp:paragraph -->';

function homeboy_notes_two_worker_post_id() {
	$post = get_page_by_path( 'homeboy-notes-two-worker', OBJECT, 'post' );
	if ( $post ) return (int) $post->ID;
	return (int) wp_insert_post( array(
		'post_type' => 'post', 'post_status' => 'draft', 'post_title' => 'Two Worker Atomicity',
		'post_name' => 'homeboy-notes-two-worker', 'post_content' => HOMEBOY_NOTES_INITIAL, 'post_author' => 1,
	) );
}

function homeboy_notes_two_worker_setup() {
	foreach ( array( 'writer-a', 'writer-b' ) as $writer ) {
		$login = 'homeboy-' . $writer;
		if ( ! username_exists( $login ) ) {
			wp_insert_user( array( 'user_login' => $login, 'user_pass' => wp_generate_password( 24 ), 'user_email' => $login . '@example.test', 'role' => 'editor' ) );
		}
	}
	$post_id = homeboy_notes_two_worker_post_id();
	update_post_meta( $post_id, '_crdt_document', 'homeboy-doc-initial' );
	update_option( 'wp_collaboration_enabled', '1' );
}
register_activation_hook( __FILE__, 'homeboy_notes_two_worker_setup' );

add_filter( 'determine_current_user', function ( $user_id ) {
	$token = $_SERVER['HTTP_X_HOMEBOY_CAS_TOKEN'] ?? '';
	if ( ! in_array( $token, array( 'writer-a', 'writer-b' ), true ) ) return $user_id;
	$user = get_user_by( 'login', 'homeboy-' . $token );
	return $user ? $user->ID : $user_id;
}, 20 );

add_filter( 'query', function ( $query ) {
	$actor = $_SERVER['HTTP_X_HOMEBOY_CAS_TOKEN'] ?? '';
	if ( ! in_array( $actor, array( 'writer-a', 'writer-b' ), true ) || ! preg_match( '/^UPDATE .*posts SET post_content =/i', $query ) ) return $query;
	$barrier = sys_get_temp_dir() . '/homeboy-notes-two-worker-${ suffix }';
	if ( ! is_dir( $barrier ) ) mkdir( $barrier, 0777, true );
	file_put_contents( $barrier . '/' . $actor, (string) getmypid() );
	$deadline = microtime( true ) + 20;
	while ( microtime( true ) < $deadline ) {
		if ( file_exists( $barrier . '/writer-a' ) && file_exists( $barrier . '/writer-b' ) ) return $query;
		usleep( 10000 );
	}
	throw new RuntimeException( 'Two-worker database barrier timed out.' );
} );

add_filter( 'rest_post_dispatch', function ( $response, $server, $request ) {
	if ( '/wp-sync/v1/save-entity' !== $request->get_route() ) return $response;
	global $wpdb;
	$response = rest_ensure_response( $response );
	$response->header( 'X-Homeboy-PHP-Pid', (string) getmypid() );
	$response->header( 'X-Homeboy-DB-Connection', (string) $wpdb->get_var( 'SELECT CONNECTION_ID()' ) );
	return $response;
}, 10, 3 );

add_action( 'rest_api_init', function () {
	register_rest_route( 'homeboy-gutenberg-notes/v1', '/two-worker-state', array(
		'methods' => 'GET',
		'permission_callback' => function () { return current_user_can( 'edit_posts' ); },
		'callback' => function () {
			$post_id = homeboy_notes_two_worker_post_id();
			return rest_ensure_response( array(
				'post_id' => $post_id,
				'content' => get_post_field( 'post_content', $post_id, 'raw' ),
				'doc' => get_post_meta( $post_id, '_crdt_document', true ),
				'initial_content' => HOMEBOY_NOTES_INITIAL,
				'first_content' => HOMEBOY_NOTES_FIRST,
				'second_content' => HOMEBOY_NOTES_SECOND,
			) );
		},
	) );
} );
` );
	await chmod( fixtureDir, 0o777 );

	event( 'docker.network.create', { network } );
	await docker( [ 'network', 'create', network ] );
	await docker( [ 'run', '-d', '--name', database, '--network', network,
		'-e', 'MARIADB_DATABASE=wordpress', '-e', 'MARIADB_USER=wordpress', '-e', 'MARIADB_PASSWORD=wordpress', '-e', 'MARIADB_ROOT_PASSWORD=root',
		'mariadb:11.4' ] );
	await docker( [ 'run', '-d', '--name', wordpress, '--network', network, '-p', '127.0.0.1::80',
		'-e', `WORDPRESS_DB_HOST=${ database }:3306`, '-e', 'WORDPRESS_DB_USER=wordpress', '-e', 'WORDPRESS_DB_PASSWORD=wordpress', '-e', 'WORDPRESS_DB_NAME=wordpress',
		'-v', `${ componentPath }:/var/www/html/wp-content/plugins/gutenberg:ro`, '-v', `${ fixtureDir }:/var/www/html/wp-content/plugins/homeboy-notes-two-worker:ro`,
		'wordpress:php8.3-apache' ] );
	await waitFor( async () => {
		await docker( [ 'exec', database, 'mariadb-admin', 'ping', '-uroot', '-proot', '--silent' ] );
		return true;
	}, 'MariaDB readiness' );

	const { stdout: portOutput } = await docker( [ 'port', wordpress, '80/tcp' ] );
	const port = portOutput.trim().match( /:(\d+)$/ )?.[ 1 ];
	if ( ! port ) throw new Error( `Unable to resolve WordPress port from: ${ portOutput }` );
	const baseUrl = `http://127.0.0.1:${ port }`;
	await waitFor( async () => ( await fetch( baseUrl ) ).status < 500, 'WordPress HTTP runtime' );

	const cli = async ( args ) => docker( [ 'run', '--rm', '--network', network, '--volumes-from', wordpress, '--user', '33:33',
		'-e', `WORDPRESS_DB_HOST=${ database }:3306`, '-e', 'WORDPRESS_DB_USER=wordpress', '-e', 'WORDPRESS_DB_PASSWORD=wordpress', '-e', 'WORDPRESS_DB_NAME=wordpress',
		'wordpress:cli', 'wp', ...args ] );
	await waitFor( async () => {
		try {
			await cli( [ 'core', 'is-installed', '--path=/var/www/html' ] );
			return true;
		} catch {}
		await cli( [ 'core', 'install', '--path=/var/www/html', `--url=${ baseUrl }`, '--title=Homeboy', '--admin_user=admin', '--admin_password=admin', '--admin_email=admin@example.test', '--skip-email' ] );
		return true;
	}, 'WordPress installation' );
	await cli( [ 'plugin', 'activate', 'gutenberg', 'homeboy-notes-two-worker', '--path=/var/www/html' ] );

	const stateUrl = `${ baseUrl }/?rest_route=/homeboy-gutenberg-notes/v1/two-worker-state`;
	const initial = await request( stateUrl, 'writer-a' );
	if ( initial.status !== 200 || ! initial.contentType.includes( 'application/json' ) || typeof initial.body !== 'object' ) throw new Error( `Initial state failed: ${ JSON.stringify( initial ) }` );
	const room = `postType/post:${ initial.body.post_id }`;
	const saveUrl = `${ baseUrl }/?rest_route=/wp-sync/v1/save-entity`;
	const saves = await Promise.all( [
		request( saveUrl, 'writer-a', { method: 'POST', body: JSON.stringify( { room, expected_content: initial.body.initial_content, content: initial.body.first_content, doc: 'homeboy-doc-writer-a' } ) } ),
		request( saveUrl, 'writer-b', { method: 'POST', body: JSON.stringify( { room, expected_content: initial.body.initial_content, content: initial.body.second_content, doc: 'homeboy-doc-writer-b' } ) } ),
	] );
	const final = await request( stateUrl, 'writer-a' );
	const statuses = saves.map( ( save ) => save.status ).sort( ( left, right ) => left - right );
	const pids = new Set( saves.map( ( save ) => save.pid ) );
	const dbConnections = new Set( saves.map( ( save ) => save.dbConnection ) );
	const writerAPair = final.body.content === initial.body.first_content && final.body.doc === 'homeboy-doc-writer-a';
	const writerBPair = final.body.content === initial.body.second_content && final.body.doc === 'homeboy-doc-writer-b';
	const pass = JSON.stringify( statuses ) === JSON.stringify( [ 200, 409 ] ) && pids.size === 2 && dbConnections.size === 2 && ( writerAPair || writerBPair );

	event( 'two-worker.complete', { statuses, pids: [ ...pids ], db_connections: [ ...dbConnections ], final_writer: writerAPair ? 'writer-a' : writerBPair ? 'writer-b' : 'torn' } );
	const result = {
		component_id: process.env.HOMEBOY_COMPONENT_ID || 'gutenberg',
		scenario_id: 'notes-two-worker-atomicity',
		status: pass ? 'pass' : 'fail',
		summary: `${ saves.length } concurrent HTTP requests used ${ pids.size } PHP workers and ${ dbConnections.size } MariaDB connections; statuses=${ statuses.join( ',' ) }.` ,
		timeline,
		assertions: [
			{ id: 'independent-php-workers', status: pids.size === 2 ? 'pass' : 'fail', message: `Observed PHP PIDs: ${ [ ...pids ].join( ', ' ) }.` },
			{ id: 'independent-database-connections', status: dbConnections.size === 2 ? 'pass' : 'fail', message: `Observed MariaDB connection IDs: ${ [ ...dbConnections ].join( ', ' ) }.` },
			{ id: 'single-conditional-winner', status: JSON.stringify( statuses ) === JSON.stringify( [ 200, 409 ] ) ? 'pass' : 'fail', message: `Observed HTTP statuses: ${ statuses.join( ', ' ) }.` },
			{ id: 'content-crdt-atomicity', status: writerAPair || writerBPair ? 'pass' : 'fail', message: `Final content and CRDT snapshot came from one writer=${ writerAPair || writerBPair }.` },
		],
		evidence: { requests: saves, final: final.body, database: 'MariaDB 11.4/InnoDB', issue: 'https://github.com/WordPress/gutenberg/pull/79020' },
	};
	await writeFile( path.join( artifactDir, 'two-worker-result.json' ), `${ JSON.stringify( result, null, 2 ) }\n` );
	await writeFile( resultsFile, `${ JSON.stringify( result, null, 2 ) }\n` );
	if ( ! pass ) process.exitCode = 1;
} catch ( error ) {
	const result = { component_id: process.env.HOMEBOY_COMPONENT_ID || 'gutenberg', scenario_id: 'notes-two-worker-atomicity', status: 'fail', summary: error instanceof Error ? error.message : String( error ), timeline, assertions: [] };
	await mkdir( path.dirname( resultsFile ), { recursive: true } );
	await writeFile( resultsFile, `${ JSON.stringify( result, null, 2 ) }\n` );
	throw error;
} finally {
	await docker( [ 'rm', '-f', wordpress, database ] ).catch( () => {} );
	await docker( [ 'network', 'rm', network ] ).catch( () => {} );
	await rm( workDir, { recursive: true, force: true } );
}
