import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile, appendFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = path.resolve( path.dirname( fileURLToPath( import.meta.url ) ), '..' );
const tracePath = path.join( packageRoot, 'bench/notes-unsaved-attachment.trace.mjs' );
const artifactsDir = process.env.HOMEBOY_FUZZ_ARTIFACTS_DIR || path.join( packageRoot, 'artifacts/fuzz/notes-unsaved-attachment' );
const resultsFile = process.env.HOMEBOY_FUZZ_RESULTS_FILE || path.join( artifactsDir, 'results.json' );
const runId = process.env.HOMEBOY_FUZZ_RUN_ID || `gutenberg-notes-${ Date.now() }`;
const workloadId = process.env.HOMEBOY_FUZZ_WORKLOAD_ID || 'gutenberg-notes-attachment-corpus';
const requestFile = process.env.HOMEBOY_FUZZ_EXECUTION_REQUEST_FILE || null;
const caseLogPath = path.join( artifactsDir, 'case-log.jsonl' );
const replayPath = path.join( artifactsDir, 'replay.json' );

const corpus = [
	[ 'orphan', 'missing-anchor-load' ],
	[ 'saved-anchor', 'saved-anchor-load' ],
	[ 'autosave-anchor', 'autosave-anchor-load' ],
	[ 'live-create', 'live-note-create' ],
	[ 'dirty-live-create', 'dirty-block-live-note-create' ],
	[ 'dirty-sibling-live-create', 'dirty-sibling-live-note-create' ],
	[ 'dirty-structural-live-create', 'dirty-structural-live-note-create' ],
	[ 'nested-live-create', 'nested-live-note-create' ],
	[ 'double-live-create', 'repeated-live-note-create' ],
];

await mkdir( artifactsDir, { recursive: true } );
await writeFile( caseLogPath, '' );

function runTrace( caseId, resultFile, caseArtifactsDir ) {
	return new Promise( ( resolve ) => {
		const started = performance.now();
		const child = spawn( process.execPath, [ tracePath ], {
			cwd: packageRoot,
			env: {
				...process.env,
				HOMEBOY_GUTENBERG_NOTES_CASE: caseId,
				HOMEBOY_TRACE_PROFILE: caseId,
				HOMEBOY_TRACE_SCENARIO: 'notes-unsaved-attachment',
				HOMEBOY_TRACE_RESULTS_FILE: resultFile,
				HOMEBOY_TRACE_ARTIFACT_DIR: caseArtifactsDir,
			},
			stdio: [ 'ignore', 'pipe', 'pipe' ],
		} );
		let stdout = '';
		let stderr = '';
		child.stdout.on( 'data', ( chunk ) => { stdout += chunk; } );
		child.stderr.on( 'data', ( chunk ) => { stderr += chunk; } );
		child.on( 'error', ( error ) => resolve( {
			exitCode: null,
			durationMs: Math.round( performance.now() - started ),
			stdout,
			stderr: `${ stderr }\n${ error.stack || error }`.trim(),
		} ) );
		child.on( 'close', ( exitCode ) => resolve( {
			exitCode,
			durationMs: Math.round( performance.now() - started ),
			stdout,
			stderr,
		} ) );
	} );
}

async function readJson( file ) {
	try {
		return JSON.parse( await readFile( file, 'utf8' ) );
	} catch {
		return null;
	}
}

const cases = [];
const findings = [];

for ( const [ caseId, operationId ] of corpus ) {
	const caseDir = path.join( artifactsDir, 'cases', caseId );
	const traceResultFile = path.join( caseDir, 'trace-result.json' );
	const traceArtifactsDir = path.join( caseDir, 'artifacts' );
	await mkdir( traceArtifactsDir, { recursive: true } );

	const execution = await runTrace( caseId, traceResultFile, traceArtifactsDir );
	const traceResult = await readJson( traceResultFile );
	const status = execution.exitCode === 0 && traceResult?.status === 'pass' ? 'passed' : traceResult ? 'failed' : 'error';
	const entry = {
		schema: 'homeboy/fuzz-case/v1',
		id: caseId,
		target_id: 'gutenberg-block-notes',
		operation_id: operationId,
		workload_id: workloadId,
		observed: {
			status,
			exit_code: execution.exitCode,
			duration_ms: execution.durationMs,
			trace_status: traceResult?.status || null,
			trace_summary: traceResult?.summary || null,
			assertions: traceResult?.assertions || [],
			stdout_tail: execution.stdout.slice( -4000 ),
			stderr_tail: execution.stderr.slice( -4000 ),
		},
		metadata: {
			trace_result: path.relative( artifactsDir, traceResultFile ),
			trace_artifacts: path.relative( artifactsDir, traceArtifactsDir ),
			replay: {
				run_id: runId,
				case_id: caseId,
				command: `homeboy fuzz run gutenberg --rig gutenberg-api-route-inventory --workload ${ workloadId } --run-id ${ runId }`,
			},
		},
	};
	cases.push( entry );
	await appendFile( caseLogPath, `${ JSON.stringify( entry ) }\n` );

	if ( status !== 'passed' ) {
		findings.push( {
			schema: 'homeboy/fuzz-finding/v1',
			id: `${ caseId }-failure`,
			status: 'open',
			severity: status === 'error' ? 'critical' : 'high',
			title: `Gutenberg Block Notes fuzz case failed: ${ caseId }`,
			target_id: 'gutenberg-block-notes',
			operation_id: operationId,
			case_id: caseId,
			metadata: entry.observed,
		} );
	}
}

const replay = {
	schema: 'homeboy/fuzz-replay/v1',
	run_id: runId,
	request_file: requestFile,
	metadata: {
		workload_id: workloadId,
		component_path: process.env.HOMEBOY_COMPONENT_PATH || null,
		cases: corpus.map( ( [ caseId ] ) => caseId ),
		command: `homeboy fuzz run gutenberg --rig gutenberg-api-route-inventory --workload ${ workloadId } --run-id ${ runId }`,
	},
};
await writeFile( replayPath, `${ JSON.stringify( replay, null, 2 ) }\n` );

const campaign = {
	schema: 'homeboy/fuzz-campaign/v1',
	version: 1,
	id: runId,
	title: 'Gutenberg Block Notes attachment persistence corpus',
	safety_class: 'isolated_mutation',
	cases,
	findings,
	coverage_summary: {
		schema: 'homeboy/fuzz-coverage-summary/v1',
		declared_targets: 1,
		executable_targets: 1,
		proven_targets: cases.length > 0 ? 1 : 0,
		declared_operations: corpus.length,
		executable_operations: corpus.length,
		proven_operations: cases.filter( ( entry ) => entry.observed.status === 'passed' ).length,
		skipped_targets: [],
		skipped_operations: [],
		surface_summaries: [],
		kind_summaries: [],
		artifact_ids: [ 'case-log', 'replay-data', 'result-envelope' ],
	},
	artifacts: [
		{ schema: 'homeboy/fuzz-artifact/v1', id: 'case-log', kind: 'case_log', artifact: { schema: 'homeboy/artifact-contract/v1', kind: 'case_log', type: 'file', path: 'case-log.jsonl', role: 'case_log' } },
		{ schema: 'homeboy/fuzz-artifact/v1', id: 'replay-data', kind: 'replay_data', artifact: { schema: 'homeboy/artifact-contract/v1', kind: 'replay_data', type: 'file', path: 'replay.json', role: 'replay_data' } },
		{ schema: 'homeboy/fuzz-artifact/v1', id: 'result-envelope', kind: 'result_envelope', artifact: { schema: 'homeboy/artifact-contract/v1', kind: 'result_envelope', type: 'file', path: path.relative( artifactsDir, resultsFile ), role: 'result_envelope' } },
	],
	metadata: {
		status: findings.length ? 'failed' : 'passed',
		success: findings.length === 0,
		case_counts: {
			passed: cases.filter( ( entry ) => entry.observed.status === 'passed' ).length,
			failed: cases.filter( ( entry ) => entry.observed.status === 'failed' ).length,
			errored: cases.filter( ( entry ) => entry.observed.status === 'error' ).length,
			skipped: 0,
		},
		artifact_refs: [
			{ kind: 'case_log', path: 'case-log.jsonl' },
			{ kind: 'replay_data', path: 'replay.json' },
			{ kind: 'result_envelope', path: path.relative( artifactsDir, resultsFile ) },
		],
	},
};

await mkdir( path.dirname( resultsFile ), { recursive: true } );
await writeFile( resultsFile, `${ JSON.stringify( campaign, null, 2 ) }\n` );
process.exitCode = findings.length ? 1 : 0;
