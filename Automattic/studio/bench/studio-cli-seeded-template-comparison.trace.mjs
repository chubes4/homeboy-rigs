import { execFile } from 'node:child_process';
import { access, copyFile, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import {
	STUDIO_PATH,
	parseStudioSiteStatus,
	redact,
	runCli,
	safeResult,
	stopStudioSite,
} from './lib/studio-bench.mjs';

const HELPER_DIR =
	process.env.HOMEBOY_TRACE_HELPER_DIR ||
	'/Users/chubes/Developer/homeboy-extensions/nodejs/scripts/trace/lib';
const ARTIFACT_DIR =
	process.env.HOMEBOY_TRACE_ARTIFACT_DIR ||
	path.join(tmpdir(), 'studio-seeded-template-trace-artifacts');
const TIMEOUT_MS = Number(process.env.STUDIO_TRACE_TIMEOUT_MS || 420_000);
const HTTP_REQUEST_TIMEOUT_MS = Number(process.env.STUDIO_TRACE_HTTP_REQUEST_TIMEOUT_MS || 5_000);
const SEED_DB_PATH = process.env.STUDIO_TRACE_SEED_DB_PATH || '';
const WP_VERSION = process.env.STUDIO_TRACE_WP_VERSION || 'latest';
const PHP_VERSION = process.env.STUDIO_TRACE_PHP_VERSION || '8.3';
const ADMIN_USERNAME = process.env.STUDIO_TRACE_ADMIN_USERNAME || 'homeboy-admin';
const ADMIN_PASSWORD = process.env.STUDIO_TRACE_ADMIN_PASSWORD || 'homeboy-password-123';
const ADMIN_EMAIL = process.env.STUDIO_TRACE_ADMIN_EMAIL || 'homeboy@example.com';
const BUNDLED_TEMPLATE_PATH = path.join(
	STUDIO_PATH,
	'apps/cli/dist/cli/wp-files/preinstalled-sqlite/latest/.ht.sqlite'
);
const TEMPLATE_LOCK_DIR = path.join(tmpdir(), 'homeboy-studio-seeded-template.lock');

const { createTraceRecorder } = await import(pathToFileURL(`${HELPER_DIR}/timeline.mjs`).href);
const { pollHttp } = await import(pathToFileURL(`${HELPER_DIR}/probes.mjs`).href);
const recorder = createTraceRecorder({ scenarioId: 'studio-cli-seeded-template-comparison' });
const execFileAsync = promisify(execFile);
recorder.timestampMs = () => Math.round(performance.now() - recorder.start);
const runId = `hs-${process.pid}-${Date.now()}-${Math.random()
	.toString(36)
	.slice(2)}`;
// Studio's daemon uses a Unix socket under HOME. macOS rejects long socket paths,
// so keep the isolated HOME/config/site root short and put only artifacts under tmpdir().
const sessionPath = path.join('/tmp', runId);
const sitesDir = path.join(sessionPath, 'sites');
const cliConfigPath = path.join(sessionPath, 'cliConfig');
const sharedConfigPath = path.join(sessionPath, 'sharedConfig');
const templateBackupPath = path.join(sessionPath, 'bundled-template.backup.ht.sqlite');
const externalSeedDbSnapshotPath = path.join(sessionPath, 'external-seed.ht.sqlite');
const generatedSeedDbPath = path.join(sessionPath, 'generated-seed.ht.sqlite');
const resultPath = path.join(ARTIFACT_DIR, `${runId}.json`);
const blueprintPath = path.join(sessionPath, 'blueprint.json');
const variants = [];
const diagnosedVariants = new Set();
let templateWasBundled = false;
let templateMovedToBackup = false;
let templateLockHeld = false;

await mkdir(ARTIFACT_DIR, { recursive: true });

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function exists(filePath) {
	try {
		await access(filePath);
		return true;
	} catch {
		return false;
	}
}

function safeArtifactName(value) {
	return String(value || 'unknown').replace(/[^a-z0-9._-]+/gi, '-').replace(/^-+|-+$/g, '') || 'unknown';
}

async function writeDiagnosticArtifact(name, content, kind = 'text') {
	const artifactPath = path.join(ARTIFACT_DIR, name);
	await mkdir(path.dirname(artifactPath), { recursive: true });
	await writeFile(artifactPath, content);
	recorder.addArtifact(name, artifactPath, kind);
	return artifactPath;
}

async function readJsonIfExists(filePath) {
	try {
		return JSON.parse(await readFile(filePath, 'utf8'));
	} catch {
		return null;
	}
}

async function captureProcessSnapshot(variant) {
	try {
		const { stdout } = await execFileAsync('ps', ['-axo', 'pid=,ppid=,stat=,comm=,args='], {
			maxBuffer: 1024 * 1024,
		});
		const patterns = [/wordpress-server-child\.mjs/, /playground-server-child\.mjs/, /daemon\.sock/, /studio.*site create/];
		const lines = stdout.split(/\r?\n/).filter((line) => patterns.some((pattern) => pattern.test(line)));
		const content = lines.length > 0 ? `${lines.join('\n')}\n` : 'No matching Studio process rows found.\n';
		const artifactPath = await writeDiagnosticArtifact(
			`${safeArtifactName(variant)}-process-snapshot.txt`,
			content
		);
		await recorder.recordEvent(`diagnostics.${variant}`, 'process_snapshot.captured', {
			path: artifactPath,
			match_count: lines.length,
		});
	} catch (error) {
		await recorder.recordEvent(`diagnostics.${variant}`, 'process_snapshot.failed', {
			error: error instanceof Error ? error.message : String(error),
		});
	}
}

async function captureDaemonLogs(variant) {
	const logsDir = path.join(cliEnv().HOME, '.studio/daemon/logs');
	if (!(await exists(logsDir))) {
		await recorder.recordEvent(`diagnostics.${variant}`, 'daemon_logs.missing', { path: logsDir });
		return;
	}

	try {
		const logs = [];
		for (const entry of (await readdir(logsDir, { withFileTypes: true })).filter((item) => item.isFile()).slice(0, 20)) {
			const filePath = path.join(logsDir, entry.name);
			const content = redact(await readFile(filePath, 'utf8').catch(() => ''));
			logs.push({ file: entry.name, tail: content.slice(-4000) });
		}
		const artifactPath = await writeDiagnosticArtifact(
			`${safeArtifactName(variant)}-daemon-log-tails.json`,
			JSON.stringify({ logs_dir: logsDir, logs }, null, 2),
			'json'
		);
		await recorder.recordEvent(`diagnostics.${variant}`, 'daemon_logs.captured', {
			path: artifactPath,
			log_count: logs.length,
		});
	} catch (error) {
		await recorder.recordEvent(`diagnostics.${variant}`, 'daemon_logs.failed', {
			error: error instanceof Error ? error.message : String(error),
		});
	}
}

async function captureConfigSnapshot(variant) {
	const cliConfigFile = path.join(cliConfigPath, 'cli.json');
	const sharedConfigFile = path.join(sharedConfigPath, 'shared.json');
	const snapshot = {
		cli_config_path: cliConfigFile,
		shared_config_path: sharedConfigFile,
		cli_config: await readJsonIfExists(cliConfigFile),
		shared_config: await readJsonIfExists(sharedConfigFile),
	};
	const artifactPath = await writeDiagnosticArtifact(
		`${safeArtifactName(variant)}-config-snapshot.json`,
		redact(JSON.stringify(snapshot, null, 2)),
		'json'
	);
	await recorder.recordEvent(`diagnostics.${variant}`, 'config_snapshot.captured', { path: artifactPath });
	return snapshot;
}

async function capturePortSnapshot(variant, configSnapshot) {
	const urls = new Set();
	for (const site of configSnapshot?.cli_config?.sites || []) {
		if (site?.url) urls.add(site.url);
		if (site?.siteUrl) urls.add(site.siteUrl);
	}

	const ports = [...urls].map((url) => {
		try {
			const parsed = new URL(url);
			return Number(parsed.port || (parsed.protocol === 'https:' ? 443 : 80));
		} catch {
			return null;
		}
	}).filter((port) => Number.isFinite(port));

	const results = [];
	for (const port of [...new Set(ports)]) {
		results.push({ port, listening: await canConnectPort(port) });
	}

	const artifactPath = await writeDiagnosticArtifact(
		`${safeArtifactName(variant)}-port-snapshot.json`,
		JSON.stringify({ urls: [...urls], ports: results }, null, 2),
		'json'
	);
	await recorder.recordEvent(`diagnostics.${variant}`, 'port_snapshot.captured', {
		path: artifactPath,
		port_count: results.length,
	});
}

function canConnectPort(port) {
	return new Promise((resolve) => {
		const socket = createConnection({ host: '127.0.0.1', port, timeout: 500 });
		const done = (listening) => {
			socket.destroy();
			resolve(listening);
		};
		socket.once('connect', () => done(true));
		socket.once('timeout', () => done(false));
		socket.once('error', () => done(false));
	});
}

async function captureSiteManifest(variant, sitePath) {
	const entries = await directoryManifest(sitePath, 3);
	const artifactPath = await writeDiagnosticArtifact(
		`${safeArtifactName(variant)}-site-manifest.json`,
		JSON.stringify({ site_path: sitePath, entries }, null, 2),
		'json'
	);
	await recorder.recordEvent(`diagnostics.${variant}`, 'site_manifest.captured', {
		path: artifactPath,
		entry_count: entries.length,
	});
}

async function directoryManifest(root, maxDepth, current = root, depth = 0) {
	try {
		const rows = [];
		for (const entry of await readdir(current, { withFileTypes: true })) {
			const absolute = path.join(current, entry.name);
			const relative = path.relative(root, absolute);
			const metadata = await stat(absolute).catch(() => null);
			rows.push({
				path: relative,
				type: entry.isDirectory() ? 'directory' : 'file',
				bytes: metadata?.isFile() ? metadata.size : undefined,
			});
			if (entry.isDirectory() && depth < maxDepth) {
				rows.push(...(await directoryManifest(root, maxDepth, absolute, depth + 1)));
			}
		}
		return rows;
	} catch (error) {
		return [{ path: path.relative(root, current) || '.', type: 'error', error: error.message }];
	}
}

async function captureVariantFailureDiagnostics(variant, sitePath, details = {}) {
	if (diagnosedVariants.has(variant)) {
		return;
	}
	diagnosedVariants.add(variant);
	await recorder.recordEvent(`diagnostics.${variant}`, 'capture.start', {
		site_path: sitePath,
		error: details.error ? redact(String(details.error)).split('\n')[0] : null,
		code: details.result?.code ?? null,
	});
	await captureProcessSnapshot(variant);
	await captureDaemonLogs(variant);
	const configSnapshot = await captureConfigSnapshot(variant);
	await capturePortSnapshot(variant, configSnapshot);
	await captureSiteManifest(variant, sitePath);
	await recorder.recordEvent(`diagnostics.${variant}`, 'capture.ready');
}

async function acquireTemplateLock() {
	const deadline = Date.now() + 120_000;
	while (Date.now() < deadline) {
		try {
			await mkdir(TEMPLATE_LOCK_DIR);
			templateLockHeld = true;
			await recorder.recordEvent('template', 'lock.acquired', { path: TEMPLATE_LOCK_DIR });
			return;
		} catch {
			await sleep(250);
		}
	}
	throw new Error(`Timed out waiting for template lock at ${TEMPLATE_LOCK_DIR}`);
}

async function releaseTemplateLock() {
	if (!templateLockHeld) {
		return;
	}
	await rm(TEMPLATE_LOCK_DIR, { recursive: true, force: true });
	templateLockHeld = false;
}

function cliEnv() {
	return {
		E2E: 'true',
		E2E_CLI_CONFIG_PATH: cliConfigPath,
		E2E_SHARED_CONFIG_PATH: sharedConfigPath,
		HOME: path.join(sessionPath, 'home'),
	};
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

async function runStudioCli(args, variant, eventName, options = {}) {
	await recorder.recordEvent(`cli.${variant}`, `${eventName}.start`, { args: redact(args.join(' ')) });
	const result = await runCli(args, {
		allowFailure: true,
		timeoutMs: options.timeoutMs || TIMEOUT_MS,
		env: { ...cliEnv(), ...(options.env || {}) },
	});
	await recorder.recordEvent(`cli.${variant}`, `${eventName}.ready`, {
		code: result.code,
		elapsed_ms: result.elapsedMs,
		stdout_tail: redact(result.stdout).slice(-1000),
		stderr_tail: redact(result.stderr).slice(-1000),
	});
	if (result.code !== 0 && options.allowFailure !== true) {
		await recorder.recordEvent(`cli.${variant}`, `${eventName}.failed`, {
			code: result.code,
			stderr_tail: redact(result.stderr).slice(-1000),
		});
		throw new Error(
			`studio ${args.join(' ')} exited ${result.code}; stderr=${redact(result.stderr).slice(-4000)}`
		);
	}
	return result;
}

async function removeBundledTemplateForBaseline() {
	templateWasBundled = await exists(BUNDLED_TEMPLATE_PATH);
	await mkdir(path.dirname(BUNDLED_TEMPLATE_PATH), { recursive: true });
	if (!templateWasBundled) {
		await recorder.recordEvent('template', 'baseline.no_bundled_template', {
			path: BUNDLED_TEMPLATE_PATH,
		});
		return;
	}
	await rename(BUNDLED_TEMPLATE_PATH, templateBackupPath);
	templateMovedToBackup = true;
	await recorder.recordEvent('template', 'baseline.template_moved', {
		from: BUNDLED_TEMPLATE_PATH,
		to: templateBackupPath,
	});
}

async function installBundledTemplateForSeeded(source) {
	if (!source || !(await exists(source))) {
		throw new Error(
			`Seeded comparison needs a template DB. Tried ${source || '(none)'}. Set STUDIO_TRACE_SEED_DB_PATH or let the baseline run generate one.`
		);
	}
	await mkdir(path.dirname(BUNDLED_TEMPLATE_PATH), { recursive: true });
	await copyFile(source, BUNDLED_TEMPLATE_PATH);
	await recorder.recordEvent('template', 'seeded.template_installed', {
		source,
		target: BUNDLED_TEMPLATE_PATH,
	});
}

async function removeCurrentBundledTemplate(reason) {
	await rm(BUNDLED_TEMPLATE_PATH, { force: true });
	await recorder.recordEvent('template', 'current_template_removed', {
		path: BUNDLED_TEMPLATE_PATH,
		reason,
	});
}

async function generateSeedFromBaseline(baseline) {
	const source = baseline?.databasePath;
	if (!source || !(await exists(source))) {
		throw new Error(`Cannot generate seed DB from baseline; missing database at ${source || '(none)'}`);
	}
	await copyFile(source, generatedSeedDbPath);
	await recorder.recordEvent('template', 'seed.generated_from_baseline', {
		source,
		target: generatedSeedDbPath,
	});
	return generatedSeedDbPath;
}

async function snapshotExternalSeedDb() {
	if (!SEED_DB_PATH) {
		return '';
	}
	if (!(await exists(SEED_DB_PATH))) {
		throw new Error(`Explicit seed DB does not exist at ${SEED_DB_PATH}`);
	}
	await copyFile(SEED_DB_PATH, externalSeedDbSnapshotPath);
	await recorder.recordEvent('template', 'external_seed.snapshotted', {
		source: SEED_DB_PATH,
		target: externalSeedDbSnapshotPath,
	});
	return externalSeedDbSnapshotPath;
}

async function restoreBundledTemplate() {
	if (templateMovedToBackup) {
		await mkdir(path.dirname(BUNDLED_TEMPLATE_PATH), { recursive: true });
		await rm(BUNDLED_TEMPLATE_PATH, { force: true });
		await rename(templateBackupPath, BUNDLED_TEMPLATE_PATH);
		return;
	}
	if (!templateWasBundled) {
		await rm(BUNDLED_TEMPLATE_PATH, { force: true });
	}
}

function parseJsonFromOutput(stdout) {
	const text = String(stdout || '');
	const start = text.indexOf('{');
	const end = text.lastIndexOf('}');
	if (start === -1 || end === -1 || end < start) {
		throw new Error(`Expected JSON object in output: ${redact(text).slice(-1000)}`);
	}
	return JSON.parse(text.slice(start, end + 1));
}

async function waitForOnlineStatus(sitePath, variant) {
	const deadline = Date.now() + TIMEOUT_MS;
	let latest;
	while (Date.now() < deadline) {
		const result = await runStudioCli(
			['site', 'status', '--path', sitePath, '--format', 'json'],
			variant,
			'site_status',
			{ allowFailure: true, timeoutMs: 90_000 }
		);
		if (result.code === 0) {
			latest = parseStudioSiteStatus(result.stdout);
			if (String(latest.status || '').includes('Online') && latest.siteUrl) {
				await recorder.recordEvent(`probe.${variant}`, 'site_status.online', latest);
				return latest;
			}
		}
		await sleep(500);
	}
	throw new Error(`${variant} site did not become online; latest=${JSON.stringify(latest || null)}`);
}

async function assertEndpoint(variant, siteUrl, pathName, label, accepted = (status) => status >= 200 && status < 400) {
	const url = new URL(pathName, siteUrl).toString();
	const response = await fetch(url, { signal: AbortSignal.timeout(HTTP_REQUEST_TIMEOUT_MS) });
	const finalUrl = response.url;
	await recorder.recordEvent(`probe.${variant}`, 'http_endpoint.checked', {
		label,
		path: pathName,
		status: response.status,
		final_url: finalUrl,
	});
	recorder.recordAssertion(
		`${variant}-${label}-http`,
		accepted(response.status) ? 'pass' : 'fail',
		`${variant} ${label} returns an acceptable HTTP status`,
		{ status: response.status, final_url: finalUrl }
	);
	if (label === 'wp-admin') {
		recorder.recordAssertion(
			`${variant}-wp-admin-no-upgrade-redirect`,
			finalUrl.includes('/wp-admin/upgrade.php') ? 'fail' : 'pass',
			`${variant} wp-admin does not require a database upgrade`,
			{ final_url: finalUrl }
		);
	}
}

async function queryWordPressState(sitePath, variant) {
	const php = `echo wp_json_encode([
	'home' => get_option('home'),
	'siteurl' => get_option('siteurl'),
	'permalink_structure' => get_option('permalink_structure'),
	'blogname' => get_option('blogname'),
	'blogdescription' => get_option('blogdescription'),
	'WPLANG' => get_option('WPLANG'),
	'users' => count_users()['total_users'],
]);`;
	const result = await runStudioCli(['wp', '--path', sitePath, 'eval', php], variant, 'wp_state', {
		timeoutMs: 120_000,
	});
	return parseJsonFromOutput(result.stdout);
}

async function assertAdminPassword(sitePath, variant) {
	const result = await runStudioCli(
		['wp', '--path', sitePath, 'user', 'check-password', ADMIN_USERNAME, ADMIN_PASSWORD],
		variant,
		'admin_password_check',
		{ allowFailure: true, timeoutMs: 120_000 }
	);
	recorder.recordAssertion(
		`${variant}-admin-password`,
		result.code === 0 ? 'pass' : 'fail',
		`${variant} admin credentials authenticate with WP-CLI`,
		{ code: result.code, stderr: redact(result.stderr).slice(-1000) }
	);
}

async function writeBlueprintFixture() {
	await writeFile(
		blueprintPath,
		JSON.stringify(
			{
				landingPage: '/',
				steps: [
					{
						step: 'setSiteOptions',
						options: {
							blogdescription: 'Homeboy blueprint applied',
						},
					},
				],
			},
			null,
			2
		)
	);
	await recorder.recordEvent('blueprint', 'fixture.written', { path: blueprintPath });
	return blueprintPath;
}

async function measureVariant(variant, options = {}) {
	const siteName = options.siteName || `Homeboy ${variant} Seeded Template ${process.pid}`;
	const sitePath = path.join(sitesDir, variant);
	try {
		await recorder.recordEvent(`measurement.${variant}`, 'start', {
			studio_path: STUDIO_PATH,
			wp_version: WP_VERSION,
			php_version: PHP_VERSION,
			site_path: sitePath,
			blueprint: options.blueprint || null,
		});

		const createResult = await runStudioCli(
			[
				'site',
				'create',
				'--name',
				siteName,
				'--path',
				sitePath,
				'--wp',
				WP_VERSION,
				'--php',
				PHP_VERSION,
				'--admin-username',
				ADMIN_USERNAME,
				'--admin-password',
				ADMIN_PASSWORD,
				'--admin-email',
				ADMIN_EMAIL,
				...(options.blueprint ? ['--blueprint', options.blueprint] : []),
				'--skip-browser',
				'--skip-log-details',
			],
			variant,
			'site_create',
			{ allowFailure: true }
		);
		if (createResult.code !== 0) {
			await recorder.recordEvent(`cli.${variant}`, 'site_create.failed', {
				code: createResult.code,
				stderr_tail: redact(createResult.stderr).slice(-1000),
			});
			await captureVariantFailureDiagnostics(variant, sitePath, { result: createResult });
			throw new Error(
				`studio site create failed for ${variant}; exit=${createResult.code}; stderr=${redact(createResult.stderr).slice(-4000)}`
			);
		}

		const status = await waitForOnlineStatus(sitePath, variant);
		await pollHttp(status.siteUrl, {
			source: `probe.${variant}`,
			readyStatus: [200, 399],
			intervalMs: 250,
			requestTimeoutMs: HTTP_REQUEST_TIMEOUT_MS,
			timeoutMs: 60_000,
			onEvent: recorder.recordEvent.bind(recorder),
		});
		await assertEndpoint(variant, status.siteUrl, '/', 'frontend');
		await assertEndpoint(variant, status.siteUrl, '/wp-json/', 'rest-api');
		await assertEndpoint(variant, status.siteUrl, '/wp-admin/', 'wp-admin');

		const databasePath = path.join(sitePath, 'wp-content/database/.ht.sqlite');
		const hasDatabase = await exists(databasePath);
		recorder.recordAssertion(
			`${variant}-sqlite-database`,
			hasDatabase ? 'pass' : 'fail',
			`${variant} site has a SQLite database file`,
			{ database_path: databasePath }
		);

		const wordpressState = await queryWordPressState(sitePath, variant);
		await recorder.recordEvent(`measurement.${variant}`, 'wordpress_state.ready', wordpressState);
		recorder.recordAssertion(
			`${variant}-home-siteurl-match`,
			wordpressState.home === wordpressState.siteurl ? 'pass' : 'fail',
			`${variant} home and siteurl match`,
			wordpressState
		);
		recorder.recordAssertion(
			`${variant}-home-uses-site-url`,
			wordpressState.home === status.siteUrl.replace(/\/$/, '') ? 'pass' : 'fail',
			`${variant} home option matches Studio site URL`,
			{ home: wordpressState.home, siteUrl: status.siteUrl }
		);
		recorder.recordAssertion(
			`${variant}-permalink-structure`,
			wordpressState.permalink_structure === '/%year%/%monthnum%/%day%/%postname%/' ? 'pass' : 'fail',
			`${variant} permalink structure matches Studio default`,
			wordpressState
		);
		recorder.recordAssertion(
			`${variant}-blogname`,
			wordpressState.blogname === siteName ? 'pass' : 'fail',
			`${variant} blogname matches requested site name`,
			wordpressState
		);
		if (options.expectedBlogdescription) {
			recorder.recordAssertion(
				`${variant}-blueprint-blogdescription`,
				wordpressState.blogdescription === options.expectedBlogdescription ? 'pass' : 'fail',
				`${variant} Blueprint-applied blogdescription is preserved`,
				wordpressState
			);
		}
		recorder.recordAssertion(
			`${variant}-users`,
			Number(wordpressState.users) >= 1 ? 'pass' : 'fail',
			`${variant} has at least one WordPress user`,
			wordpressState
		);
		await assertAdminPassword(sitePath, variant);

		const stopResult = await stopStudioSite(sitePath, {
			allowFailure: true,
			timeoutMs: 120_000,
			env: cliEnv(),
		});
		await recorder.recordEvent(`cli.${variant}`, 'site_stop.ready', safeResult(stopResult));

		const measurement = {
			variant,
			siteName,
			sitePath,
			status,
			databasePath,
			wordpressState,
			timings: {
				site_create_ms: createResult.elapsedMs,
				site_create_no_start_ms: createResult.elapsedMs,
				site_start_ms: 0,
			},
			commands: {
				create: safeResult(createResult),
				stop: safeResult(stopResult),
			},
		};
		variants.push(measurement);
		await recorder.recordEvent(`measurement.${variant}`, 'ready', measurement.timings);
		return measurement;
	} catch (error) {
		await captureVariantFailureDiagnostics(variant, sitePath, { error }).catch(() => {});
		throw error;
	}
}

try {
	await mkdir(sitesDir, { recursive: true });
	await mkdir(cliConfigPath, { recursive: true });
	await mkdir(sharedConfigPath, { recursive: true });
	await recorder.recordEvent('scenario', 'start', {
		studio_path: STUDIO_PATH,
		bundled_template_path: BUNDLED_TEMPLATE_PATH,
		seed_db_path: SEED_DB_PATH || null,
	});

	await acquireTemplateLock();
	const externalSeedDb = await snapshotExternalSeedDb();
	await removeBundledTemplateForBaseline();
	const baseline = await measureVariant('baseline');
	const seedSource = externalSeedDb || (await generateSeedFromBaseline(baseline));
	await installBundledTemplateForSeeded(seedSource);
	const seeded = await measureVariant('seeded');
	const blueprint = await writeBlueprintFixture();
	await removeCurrentBundledTemplate('blueprint baseline should exercise missing-template fallback');
	const blueprintBaseline = await measureVariant('blueprint_baseline', {
		blueprint,
		expectedBlogdescription: 'Homeboy blueprint applied',
	});
	await installBundledTemplateForSeeded(seedSource);
	const blueprintSeeded = await measureVariant('blueprint_seeded', {
		blueprint,
		expectedBlogdescription: 'Homeboy blueprint applied',
	});

	const deltaMs = seeded.timings.site_create_ms - baseline.timings.site_create_ms;
	const deltaPercent = baseline.timings.site_create_ms
		? (deltaMs / baseline.timings.site_create_ms) * 100
		: 0;
	await recorder.recordEvent('comparison', 'ready', {
		baseline_site_create_ms: baseline.timings.site_create_ms,
		seeded_site_create_ms: seeded.timings.site_create_ms,
		delta_ms: Math.round(deltaMs),
		delta_percent: Math.round(deltaPercent * 10) / 10,
		blueprint_baseline_site_create_ms: blueprintBaseline.timings.site_create_ms,
		blueprint_seeded_site_create_ms: blueprintSeeded.timings.site_create_ms,
		blueprint_delta_ms: Math.round(
			blueprintSeeded.timings.site_create_ms - blueprintBaseline.timings.site_create_ms
		),
	});

	await writeFile(
		resultPath,
		JSON.stringify({ baseline, seeded, blueprintBaseline, blueprintSeeded, deltaMs, deltaPercent }, null, 2)
	);
	recorder.addArtifact('seeded template comparison result', resultPath, 'json');
	await recorder.recordEvent('scenario', 'ready');
	await writeTraceResults({
		summary: 'Studio CLI baseline and seeded-template create-site comparison completed',
	});
} catch (error) {
	const message = redact(error instanceof Error ? error.stack || error.message : String(error));
	recorder.recordAssertion('studio-cli-seeded-template-comparison', 'fail', message.split('\n')[0]);
	await writeFile(resultPath, JSON.stringify({ variants, failure: message }, null, 2)).catch(() => {});
	recorder.addArtifact('seeded template comparison result', resultPath, 'json');
	await writeTraceResults({
		status: 'error',
		summary: 'Studio CLI seeded-template comparison failed',
		failure: message,
	});
	process.exitCode = 1;
} finally {
	await restoreBundledTemplate().catch(() => {});
	await releaseTemplateLock().catch(() => {});
	await rm(sessionPath, { recursive: true, force: true }).catch(() => {});
}
