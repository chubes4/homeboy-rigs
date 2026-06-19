import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { runWpCodeboxRecipe } from './recipe.mjs';

export async function runBrowserCoverageTrace( config ) {
	const componentId = process.env.HOMEBOY_COMPONENT_ID || config.componentId;
	const scenarioId = process.env.HOMEBOY_TRACE_SCENARIO || config.scenarioId;
	const resultsFile = process.env.HOMEBOY_TRACE_RESULTS_FILE;
	const artifactDir = process.env.HOMEBOY_TRACE_ARTIFACT_DIR || path.join( tmpdir(), `${ config.scenarioId }-artifacts` );
	const componentPath = config.componentPath || process.env.HOMEBOY_COMPONENT_PATH;
	const wpVersion = config.wpVersion || '7.0';
	const viewport = config.viewport || '1366x900';
	const stepTimeout = config.stepTimeout || '45s';
	const timeout = config.timeout || '180s';
	const startedAt = performance.now();
	const timeline = [];

	if ( ! resultsFile ) {
		throw new Error( 'HOMEBOY_TRACE_RESULTS_FILE is required' );
	}
	if ( config.requiredFile && ! existsSync( path.join( componentPath || '', config.requiredFile ) ) ) {
		throw new Error( `Missing required component file at ${ path.join( componentPath || '', config.requiredFile ) }` );
	}

	await mkdir( artifactDir, { recursive: true } );
	await mkdir( path.dirname( resultsFile ), { recursive: true } );

	const workDir = await mkdtemp( path.join( tmpdir(), `${ config.scenarioId }.` ) );
	const setupFile = path.join( workDir, 'setup.php' );
	const combinedStepsFile = path.join( workDir, 'browser-actions.json' );
	const recipeFile = path.join( workDir, 'recipe.json' );
	const outputFile = path.join( artifactDir, 'wp-codebox-output.json' );
	const codeboxArtifacts = path.join( artifactDir, 'wp-codebox-artifacts' );

	function timestampMs() {
		return Math.round( performance.now() - startedAt );
	}

	function event( source, name, data = {} ) {
		timeline.push( { t_ms: timestampMs(), source, event: name, data } );
	}

	function relativeArtifactPath( pathname ) {
		return path.relative( artifactDir, pathname );
	}

	async function readJsonAsync( pathname ) {
		return existsSync( pathname ) ? JSON.parse( await readFile( pathname, 'utf8' ) ) : null;
	}

	async function readJsonl( pathname ) {
		if ( ! existsSync( pathname ) ) {
			return [];
		}
		const contents = await readFile( pathname, 'utf8' );
		return contents.trim().split( '\n' ).filter( Boolean ).map( ( line ) => JSON.parse( line ) );
	}

	try {
		event( 'scenario', 'start', {
			component_path: componentPath,
			wp_version: wpVersion,
			scenarios: config.scenarios.map( ( scenario ) => scenario.id ),
		} );

		const workflowSteps = [];
		if ( config.setupCode ) {
			await writeFile( setupFile, config.setupCode );
			workflowSteps.push( { command: 'wordpress.run-php', args: [ `code-file=${ setupFile }` ] } );
		}

		const combinedSteps = [];
		for ( const scenario of config.scenarios ) {
			const steps = JSON.parse( await readFile( scenario.stepsFile, 'utf8' ) );
			if ( ! Array.isArray( steps ) ) {
				throw new Error( `Browser scenario steps must be an array: ${ scenario.stepsFile }` );
			}
			combinedSteps.push( ...steps );
		}
		await writeFile( combinedStepsFile, `${ JSON.stringify( combinedSteps, null, 2 ) }\n` );
		workflowSteps.push( {
			command: 'wordpress.browser-actions',
			args: [
				`step-timeout=${ stepTimeout }`,
				`timeout=${ timeout }`,
				`viewport=${ viewport }`,
				'capture=steps,console,errors,network,html,screenshot,dom-snapshot',
				`steps-json=@${ combinedStepsFile }`,
			],
		} );

		const recipe = {
			schema: 'wp-codebox/workspace-recipe/v1',
			runtime: {
				wp: wpVersion,
				blueprint: {
					steps: config.blueprintSteps || [ { step: 'login', username: 'admin', password: 'password' } ],
				},
			},
			...( config.inputs ? { inputs: config.inputs } : {} ),
			workflow: { steps: workflowSteps },
			artifacts: { directory: codeboxArtifacts },
		};

		await writeFile( recipeFile, `${ JSON.stringify( recipe, null, 2 ) }\n` );

		const result = await runWpCodeboxRecipe( {
			recipeFile,
			artifactsDir: codeboxArtifacts,
			outputFile,
			event,
			maxBuffer: 1024 * 1024 * 50,
		} );

		const output = result.json || JSON.parse( result.stdout );
		const bundleDir = output.artifacts?.directory;
		const browserDir = bundleDir ? path.join( bundleDir, 'files', 'browser' ) : '';
		const summaryPath = browserDir ? path.join( browserDir, 'action-summary.json' ) : '';
		const networkPath = browserDir ? path.join( browserDir, 'network.jsonl' ) : '';
		const requestCoveragePath = browserDir ? path.join( browserDir, 'request-coverage.json' ) : '';
		const errorsPath = browserDir ? path.join( browserDir, 'errors.jsonl' ) : '';
		const stepsPath = browserDir ? path.join( browserDir, 'steps.jsonl' ) : '';
		const summary = await readJsonAsync( summaryPath );
		const requestCoverage = await readJsonAsync( requestCoveragePath );
		const network = await readJsonl( networkPath );
		const errors = await readJsonl( errorsPath );
		const steps = await readJsonl( stepsPath );
		const failedSteps = steps.filter( ( step ) => step.status === 'failed' );
		const responseCount = network.filter( ( entry ) => entry.type === 'response' ).length;
		const requestCoverageReady = Boolean( requestCoverage && existsSync( requestCoveragePath ) );
		const pass = requestCoverageReady && failedSteps.length === 0;

		event( 'browser', 'actions.ready', {
			request_coverage_ready: requestCoverageReady,
			network_events: network.length,
			responses: responseCount,
			failed_steps: failedSteps.length,
		} );

		const traceResult = {
			component_id: componentId,
			scenario_id: scenarioId,
			status: pass ? 'pass' : 'fail',
			summary: requestCoverageReady
				? `Captured WP Codebox browser request coverage for ${ config.scenarios.length } scenario(s), ${ network.length } network event(s), ${ responseCount } response(s).`
				: 'WP Codebox browser request coverage artifact was not produced.',
			timeline,
			assertions: [
				{
					id: 'browser-request-coverage-produced',
					status: requestCoverageReady ? 'pass' : 'fail',
					message: requestCoverageReady ? 'request-coverage.json was produced by wordpress.browser-actions.' : 'request-coverage.json was missing.',
				},
				{
					id: 'browser-actions-completed',
					status: failedSteps.length === 0 ? 'pass' : 'fail',
					message: `Recorded ${ failedSteps.length } failed browser action step(s).`,
				},
				{
					id: 'browser-errors-recorded',
					status: 'pass',
					message: `Recorded ${ errors.length } browser/runtime error artifact entr${ errors.length === 1 ? 'y' : 'ies' }.`,
				},
			],
			artifacts: [
				{ label: 'WP Codebox output', path: relativeArtifactPath( outputFile ) },
				...( summaryPath && existsSync( summaryPath ) ? [ { label: 'Browser actions summary', path: relativeArtifactPath( summaryPath ) } ] : [] ),
				...( requestCoveragePath && existsSync( requestCoveragePath ) ? [ { label: 'Browser request coverage', path: relativeArtifactPath( requestCoveragePath ) } ] : [] ),
				...( networkPath && existsSync( networkPath ) ? [ { label: 'Browser network log', path: relativeArtifactPath( networkPath ) } ] : [] ),
			],
			metadata: {
				assumptions: config.assumptions || [],
				final_url: summary?.finalUrl || summary?.summary?.finalUrl || null,
				request_coverage_schema: requestCoverage?.schema || null,
			},
		};

		await writeFile( resultsFile, `${ JSON.stringify( traceResult, null, 2 ) }\n` );
		process.exitCode = pass ? 0 : 1;
	} catch ( error ) {
		const traceResult = {
			component_id: componentId,
			scenario_id: scenarioId,
			status: 'fail',
			summary: error instanceof Error ? error.message : String( error ),
			timeline,
			assertions: [
				{
					id: 'trace-workload-completed',
					status: 'fail',
					message: error instanceof Error ? error.message : String( error ),
				},
			],
			artifacts: existsSync( outputFile ) ? [ { label: 'WP Codebox output', path: relativeArtifactPath( outputFile ) } ] : [],
		};
		await writeFile( resultsFile, `${ JSON.stringify( traceResult, null, 2 ) }\n` );
		throw error;
	} finally {
		await rm( workDir, { recursive: true, force: true } );
	}
}
