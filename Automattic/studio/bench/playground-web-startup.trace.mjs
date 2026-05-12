import { createWriteStream } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';

const require = createRequire(import.meta.url);
const HELPER_DIR = process.env.HOMEBOY_TRACE_HELPER_DIR || '/Users/chubes/Developer/homeboy-extensions/nodejs/scripts/trace/lib';
const PLAYGROUND_PATH = process.env.PLAYGROUND_WEB_TRACE_PLAYGROUND_PATH || '/Users/chubes/Developer/wordpress-playground@investigate-preinstalled-sqlite-template';
const BASE_URL = process.env.PLAYGROUND_WEB_TRACE_BASE_URL || 'http://127.0.0.1:5400/website-server/';
const WP_VERSION = process.env.PLAYGROUND_WEB_TRACE_WP_VERSION || '6.8';
const PHP_VERSION = process.env.PLAYGROUND_WEB_TRACE_PHP_VERSION || '8.3';
const TEMPLATE_PATH = process.env.PLAYGROUND_WEB_TRACE_TEMPLATE_PATH || `/website-server/test-fixtures/preinstalled-sqlite/wp-${WP_VERSION}.ht.sqlite`;
const TIMEOUT_MS = Number(process.env.PLAYGROUND_WEB_TRACE_TIMEOUT_MS || 120_000);
const ARTIFACT_DIR = process.env.HOMEBOY_TRACE_ARTIFACT_DIR || path.join(tmpdir(), 'playground-web-trace-artifacts');

const { createTraceRecorder } = await import(pathToFileURL(`${HELPER_DIR}/timeline.mjs`).href);
const { pollHttp } = await import(pathToFileURL(`${HELPER_DIR}/probes.mjs`).href);

const playwright = require(require.resolve('playwright', { paths: [PLAYGROUND_PATH] }));
const recorder = createTraceRecorder({ scenarioId: 'playground-web-startup' });
recorder.timestampMs = () => Math.round((performance.now() - recorder.start));
const onEvent = recorder.recordEvent.bind(recorder);
const startedProcesses = [];

await mkdir(ARTIFACT_DIR, { recursive: true });

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function writeTraceResults(options) {
	for (const artifact of recorder.artifacts) {
		delete artifact.kind;
	}
	for (const assertion of recorder.assertions) {
		if (assertion.data !== undefined) {
			assertion.details = assertion.data;
			delete assertion.data;
		}
	}
	return recorder.writeTraceResults(options);
}

async function waitFor(predicate, timeoutMs, message) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() <= deadline) {
		const value = await predicate();
		if (value) {
			return value;
		}
		await sleep(100);
	}
	throw new Error(message);
}

function launchDevServer() {
	const logPath = path.join(ARTIFACT_DIR, 'playground-web-dev-server.log');
	const logStream = createWriteStream(logPath, { flags: 'a' });
	let output = '';
	const child = spawn('npx', ['nx', 'run', 'playground-website:dev'], {
		cwd: PLAYGROUND_PATH,
		env: process.env,
		detached: true,
		stdio: ['ignore', 'pipe', 'pipe'],
	});
	startedProcesses.push(child);
	recorder.addArtifact('dev server log', logPath, 'text');
	void recorder.recordEvent('dev_server', 'launch', { pid: child.pid || null, cwd: PLAYGROUND_PATH });

	const capture = (chunk) => {
		const text = chunk.toString();
		output += text;
		logStream.write(text);
	};
	child.stdout.on('data', capture);
	child.stderr.on('data', capture);
	child.once('exit', (code, signal) => {
		logStream.end();
		void recorder.recordEvent('dev_server', 'exit', { code, signal });
	});

	return {
		child,
		logPath,
		getOutput: () => output,
	};
}

async function resolveBaseUrl() {
	if (BASE_URL) {
		const server = launchDevServer();
		await recorder.recordEvent('dev_server', 'external_url', { url: BASE_URL });
		const result = await pollHttp(BASE_URL, {
			source: 'dev_server',
			readyStatus: [200, 399],
			intervalMs: 250,
			timeoutMs: 30_000,
			onEvent,
		});
		if (result.status !== 'ready') {
			throw new Error(`Playground Web URL did not become ready: ${BASE_URL}\nOutput:\n${server.getOutput()}`);
		}
		return BASE_URL;
	}

	const server = launchDevServer();
	const url = 'http://127.0.0.1:5400/website-server/';
	await recorder.recordEvent('dev_server', 'url_seen', { url });
	const result = await pollHttp(url, {
		source: 'dev_server',
		readyStatus: [200, 399],
		intervalMs: 250,
		timeoutMs: 60_000,
		onEvent,
	});
	if (result.status !== 'ready') {
		throw new Error(`Playground Web dev server did not become ready: ${url}`);
	}
	return url;
}

function buildUrl(baseUrl, variant) {
	const url = new URL(baseUrl);
	url.searchParams.set('url', '/');
	url.searchParams.set('trace-run', `${variant}-${Date.now()}`);
	url.searchParams.set('homeboy-trace', '1');
	if (variant === 'seeded') {
		url.searchParams.set('preinstalled-sqlite-template', TEMPLATE_PATH);
	}
	url.hash = JSON.stringify({ preferredVersions: { wp: WP_VERSION, php: PHP_VERSION } });
	return url.toString();
}

function installHomeboyTraceBridge(page, variant) {
	page.on('console', async (message) => {
		const text = typeof message.text === 'function' ? message.text() : String(message);
		if (!text.startsWith('trace:')) {
			return;
		}
		try {
			const payload = JSON.parse(text.slice('trace:'.length));
			if (!payload || typeof payload.source !== 'string' || typeof payload.event !== 'string') {
				return;
			}
			await recorder.recordEvent(`${payload.source}.${variant}`, payload.event, {
				variant,
				source: payload.source,
				...(payload.data || {}),
			});
		} catch {
			await recorder.recordEvent(`browser.${variant}`, 'trace_parse_error', { text });
		}
	});
}

async function collectResources(page, variant) {
	const resources = await page.evaluate(() =>
		performance.getEntriesByType('resource').map((entry) => ({
			name: entry.name,
			initiatorType: entry.initiatorType,
			startTime: Math.round(entry.startTime * 1000) / 1000,
			duration: Math.round(entry.duration * 1000) / 1000,
			transferSize: entry.transferSize,
			encodedBodySize: entry.encodedBodySize,
			decodedBodySize: entry.decodedBodySize,
		}))
	);
	const resourcesPath = path.join(ARTIFACT_DIR, `${variant}-resources.json`);
	await writeFile(resourcesPath, JSON.stringify(resources, null, 2));
	recorder.addArtifact(`${variant} resource timing`, resourcesPath, 'json');
	return resources;
}

async function measure(browser, baseUrl, variant) {
	await recorder.recordEvent(`measurement.${variant}`, 'start', {
		wp_version: WP_VERSION,
		php_version: PHP_VERSION,
		template_path: variant === 'seeded' ? TEMPLATE_PATH : null,
	});
	const context = await browser.newContext();
	const page = await context.newPage();
	installHomeboyTraceBridge(page, variant);

	try {
		await page.goto(buildUrl(baseUrl, variant), { waitUntil: 'commit', timeout: TIMEOUT_MS });
		await recorder.recordEvent(`measurement.${variant}`, 'goto.commit');
		await page.waitForFunction(() => Boolean(window.playgroundSites?.getClient()), { timeout: TIMEOUT_MS });
		await recorder.recordEvent(`measurement.${variant}`, 'client.ready');
		const body = page.frameLocator('#playground-viewport:visible,.playground-viewport:visible').frameLocator('#wp').locator('body');
		await body.waitFor({ state: 'visible', timeout: TIMEOUT_MS });
		await page.waitForFunction(
			() => document.querySelector('#playground-viewport, .playground-viewport')?.contentDocument?.querySelector('#wp')?.contentDocument?.body?.innerText?.trim().length > 0,
			{ timeout: TIMEOUT_MS }
		);
		await recorder.recordEvent(`measurement.${variant}`, 'wp_iframe.body_ready');

		const options = await page.evaluate(async () => {
			const playground = window.playgroundSites.getClient();
			const result = await playground.run({
				code: `<?php
require_once '/wordpress/wp-load.php';
echo wp_json_encode([
	'home' => get_option('home'),
	'siteurl' => get_option('siteurl'),
	'permalink_structure' => get_option('permalink_structure'),
]);
`,
			});
			return JSON.parse(result.text);
		});
		await recorder.recordEvent(`measurement.${variant}`, 'wordpress.options.ready', options);
		const resources = await collectResources(page, variant);
		await recorder.recordEvent(`measurement.${variant}`, 'resources.captured', { count: resources.length });
		recorder.recordAssertion(`${variant}-home-specialized`, String(options.home || '').includes('/scope:') ? 'pass' : 'fail', `${variant} home option is scope-specialized`, options);
		recorder.recordAssertion(`${variant}-siteurl-specialized`, String(options.siteurl || '').includes('/scope:') ? 'pass' : 'fail', `${variant} siteurl option is scope-specialized`, options);
		recorder.recordAssertion(`${variant}-permalinks`, options.permalink_structure === '/%year%/%monthnum%/%day%/%postname%/' ? 'pass' : 'fail', `${variant} permalink structure is expected`, options);
		await recorder.recordEvent(`measurement.${variant}`, 'ready');
		return { variant, options, resources: resources.length };
	} finally {
		await context.close();
	}
}

try {
	await recorder.recordEvent('scenario', 'start', { playground_path: PLAYGROUND_PATH });
	const baseUrl = await resolveBaseUrl();
	const browser = await playwright.chromium.launch({ headless: true });
	try {
		await measure(browser, baseUrl, 'baseline');
		await measure(browser, baseUrl, 'seeded');
	} finally {
		await browser.close();
	}
	await recorder.recordEvent('scenario', 'ready');
	await writeTraceResults({ status: 'pass', summary: 'Playground Web startup trace captured' });
} catch (error) {
	const message = error instanceof Error ? error.stack || error.message : String(error);
	recorder.recordAssertion('playground-web-startup', 'fail', message);
	await writeTraceResults({ status: 'error', summary: 'Playground Web startup trace failed', failure: message });
	process.exitCode = 1;
} finally {
	for (const child of startedProcesses) {
		if (!child.pid || child.exitCode !== null) {
			continue;
		}
		try {
			process.kill(-child.pid, 'SIGTERM');
		} catch {
			child.kill('SIGTERM');
		}
	}
}
