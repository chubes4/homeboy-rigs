import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { assertFullSurfaceCoverageManifest } from '../../../scripts/fuzz-manifest-helpers.mjs';

const __dirname = path.dirname( fileURLToPath( import.meta.url ) );
const packageRoot = path.join( __dirname, '..' );
const wordpressPackageRoot = path.join( packageRoot, '..', 'wordpress' );

function readJson( ...parts ) {
	return JSON.parse( readFileSync( path.join( packageRoot, ...parts ), 'utf8' ) );
}

test( 'Core admin coverage declares safe enumeration, role boundaries, skipped reasons, and required artifact contract', () => {
	const workload = readJson( 'fuzz', 'admin-page-coverage.json' );
	const workloadCase = workload.cases[0];

	assert.equal( workload.safety_class, 'read_only' );
	assert.ok( workload.operations.includes( 'safe-admin-page-enumeration' ) );
	assert.ok( workload.operations.includes( 'skipped-destructive-classification' ) );
	assert.deepEqual( workloadCase.metadata.role_boundaries, [ 'administrator', 'editor', 'author', 'contributor', 'subscriber' ] );
	assert.ok( workloadCase.metadata.skipped_reason_codes.includes( 'unsafe_query_arg_action' ) );
	assert.ok( workloadCase.metadata.skipped_reason_codes.includes( 'permission_boundary' ) );
	assert.ok( workloadCase.artifacts.every( ( artifact ) => artifact.required === true ) );
	assert.equal( workload.artifacts.expected[0].schema, 'homeboy-rigs/wordpress-core-admin-page-coverage/v1' );
	assert.ok( workloadCase.metadata.artifact_contract.required_fields.includes( 'role_boundary_summary' ) );
} );

test( 'Core frontend/content/media fuzz workloads declare posts, pages, users, media, rendering, and artifact contracts', () => {
	const frontend = readJson( 'fuzz', 'frontend-rendering-request-coverage.json' );
	const content = readJson( 'fuzz', 'content-types-taxonomies.json' );
	const mediaUsers = readJson( 'fuzz', 'media-users.json' );

	assert.ok( frontend.operations.includes( 'frontend-request-capture' ) );
	assert.ok( frontend.operations.includes( 'page-rendering' ) );
	assert.ok( frontend.cases[0].metadata.scenarios.includes( 'single-post' ) );
	assert.ok( frontend.cases[0].metadata.scenarios.includes( 'single-page' ) );
	assert.ok( frontend.artifacts.expected.every( ( artifact ) => artifact.required === true ) );

	assert.ok( content.surface_ids.includes( 'wordpress-core-posts' ) );
	assert.ok( content.surface_ids.includes( 'wordpress-core-pages' ) );
	assert.ok( content.operations.includes( 'post-editor-readiness' ) );
	assert.ok( content.operations.includes( 'page-editor-readiness' ) );
	assert.ok( content.artifacts.expected.every( ( artifact ) => artifact.required === true ) );

	assert.ok( mediaUsers.operations.includes( 'media-library-rendering' ) );
	assert.ok( mediaUsers.operations.includes( 'user-list-rendering' ) );
	assert.ok( mediaUsers.cases[0].metadata.scenarios.includes( 'users-list' ) );
	assert.ok( mediaUsers.artifacts.expected.every( ( artifact ) => artifact.required === true ) );
} );

test( 'Core fuzz rig and full-surface profile include admin and frontend coverage with no bench fallback', () => {
	const rig = readJson( 'rigs', 'wordpress-core-fuzz-coverage', 'rig.json' );
	const manifest = readJson( 'manifests', 'full-surface-coverage.json' );
	const workloadPaths = rig.fuzz_workloads.wordpress.map( ( entry ) => entry.path );
	const allProfiles = Object.values( rig.fuzz_profiles ).flat();

	assert.ok( workloadPaths.some( ( entry ) => entry.includes( 'fuzz/admin-page-coverage.json' ) ) );
	assert.ok( workloadPaths.some( ( entry ) => entry.includes( 'fuzz/frontend-rendering-request-coverage.json' ) ) );
	assert.ok( allProfiles.includes( 'admin-page-coverage' ) );
	assert.ok( allProfiles.includes( 'frontend-rendering-request-coverage' ) );
	assert.ok( ! rig.bench_workloads );
	assert.ok( ! rig.bench_profiles );
	assertFullSurfaceCoverageManifest( manifest, { file: 'WordPress Core full-surface coverage' } );
	assert.ok( manifest.coverage_profiles[ 'full-surface' ].includes( 'frontend-rendering-request-coverage' ) );
} );

test( 'Core browser request coverage includes frontend, posts, pages, media, and users without form submissions', () => {
	const trace = readFileSync( path.join( wordpressPackageRoot, 'bench', 'wordpress-core-browser-coverage.trace.mjs' ), 'utf8' );
	for ( const scenario of [ 'front_page', 'posts_list', 'post_editor', 'pages_list', 'page_editor', 'media_library', 'media_new', 'users_list', 'profile' ] ) {
		assert.match( trace, new RegExp( `id: '${ scenario }'` ) );
	}
	const scenarioRoot = path.join( wordpressPackageRoot, 'browser-scenarios' );
	const scenarioSteps = readdirSync( scenarioRoot )
		.filter( ( file ) => file.endsWith( '.json' ) )
		.map( ( file ) => readFileSync( path.join( scenarioRoot, file ), 'utf8' ) )
		.join( '\n' );
	assert.doesNotMatch( scenarioSteps, /"kind"\s*:\s*"(?:click|fill|select|submit)"|bulk-action|delete/i );
	assert.match( trace, /Coverage stays read-only in the browser/ );
} );
