// Black-box lifecycle proof for Studio's shared email inbox (Mailpit).
//
// Drives the built Studio CLI in an isolated config and daemon, and checks how the
// inbox starts, is shared, stops, recovers and fails, and that email lands in it at
// each step. Each check is a trace assertion; the timeline records every CLI call,
// the Mailpit processes seen and the Tracks props each site start would send.
import { execFile, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const HELPER_DIR = process.env.HOMEBOY_TRACE_HELPER_DIR;
const STUDIO_PATH = process.env.HOMEBOY_COMPONENT_PATH;
if (!HELPER_DIR || !STUDIO_PATH) {
	throw new Error('HOMEBOY_TRACE_HELPER_DIR and HOMEBOY_COMPONENT_PATH are required');
}
const { createTraceRecorder } = await import(pathToFileURL(`${HELPER_DIR}/timeline.mjs`).href);
const recorder = createTraceRecorder({ scenarioId: 'studio-site-email-lifecycle' });
const execFileAsync = promisify(execFile);

const CLI = path.join(STUDIO_PATH, 'apps/cli/dist/cli/main.mjs');
const REAL_STUDIO = path.join(os.homedir(), '.studio');
// Short and directly under /tmp: the daemon's control socket path is length-limited.
const root = path.join('/tmp', `hse-${process.pid.toString(36)}`);

function makeEnv(name, { emptyMailpitBin = false } = {}) {
	const configDir = path.join(root, name, 'c');
	const daemonHome = path.join(root, name, 'd');
	mkdirSync(configDir, { recursive: true });
	mkdirSync(daemonHome, { recursive: true });
	symlinkSync(path.join(REAL_STUDIO, 'server-files'), path.join(configDir, 'server-files'));
	symlinkSync(path.join(REAL_STUDIO, 'php-bin'), path.join(configDir, 'php-bin'));
	if (!emptyMailpitBin) {
		mkdirSync(path.join(REAL_STUDIO, 'mailpit-bin'), { recursive: true });
		symlinkSync(path.join(REAL_STUDIO, 'mailpit-bin'), path.join(configDir, 'mailpit-bin'));
	}
	writeFileSync(
		path.join(configDir, 'cli.json'),
		JSON.stringify({ version: 1, sites: [], snapshots: [], lastDependencyCheckTime: Date.now() })
	);
	return {
		name,
		configDir,
		sitesDir: path.join(root, name, 's'),
		vars: {
			DEV_CONFIG_DIR: configDir,
			STUDIO_PROCESS_MANAGER_HOME: daemonHome,
			E2E: '1',
			E2E_APP_DATA_PATH: path.join(root, name),
			// Logs the Tracks props each command would send (the E2E flag keeps them local).
			STUDIO_FORCE_CLI_TELEMETRY: '1',
		},
	};
}

function cli(env, args, extraVars = {}) {
	const started = Date.now();
	return new Promise((resolve) => {
		const child = spawn(process.execPath, [CLI, ...args], {
			stdio: ['ignore', 'pipe', 'pipe'],
			env: { ...process.env, ...env.vars, ...extraVars },
		});
		let stdout = '';
		let stderr = '';
		child.stdout.on('data', (chunk) => (stdout += chunk));
		child.stderr.on('data', (chunk) => (stderr += chunk));
		child.on('close', async (code) => {
			await recorder.recordEvent(`cli.${env.name}`, args.slice(0, 2).join(' '), {
				code,
				elapsed_ms: Date.now() - started,
				output_tail: `${stdout}\n${stderr}`.slice(-600),
			});
			resolve({ code, stdout, stderr, output: `${stdout}\n${stderr}` });
		});
	});
}

const sitePath = (env, site) => path.join(env.sitesDir, site);
const portsPath = (env) => path.join(env.configDir, 'mailpit', 'ports.json');
const readPorts = (env) =>
	existsSync(portsPath(env)) ? JSON.parse(readFileSync(portsPath(env), 'utf8')) : undefined;

async function createSite(env, site, extraVars) {
	return cli(
		env,
		['site', 'create', '--name', site, '--path', sitePath(env, site), '--wp', 'latest', '--skip-browser', '--skip-log-details'],
		extraVars
	);
}
const startSite = (env, site, extraVars) =>
	cli(env, ['site', 'start', '--path', sitePath(env, site), '--skip-browser', '--skip-log-details'], extraVars);
const stopSite = (env, site) => cli(env, ['site', 'stop', '--path', sitePath(env, site)]);

async function mailpitPids(env) {
	const { stdout } = await execFileAsync('ps', ['-axo', 'pid=,args=']);
	const binary = path.join(env.configDir, 'mailpit-bin');
	return stdout
		.split('\n')
		// The binary itself, not the Node wrapper that is passed its path.
		.filter((line) => line.includes(binary) && line.includes('--listen') && !line.includes('mailpit-daemon'))
		.map((line) => Number(line.trim().split(/\s+/)[0]));
}

// How long Mailpit took to exit, or -1 if it is still running after 10s.
async function waitForMailpitExit(env) {
	const started = Date.now();
	while ((await mailpitPids(env)).length > 0) {
		if (Date.now() - started > 10_000) return -1;
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	await recorder.recordEvent(`mailpit.${env.name}`, 'exited', { after_ms: Date.now() - started });
	return Date.now() - started;
}

// The process daemon: the parent of the Mailpit wrapper, found by this config's ports path.
async function daemonPid(env) {
	const { stdout } = await execFileAsync('ps', ['-axo', 'pid=,ppid=,args=']);
	const wrapper = stdout.split('\n').find((line) => line.includes('mailpit-daemon') && line.includes(portsPath(env)));
	return wrapper ? Number(wrapper.trim().split(/\s+/)[1]) : undefined;
}

async function inboxCount(env) {
	const ports = readPorts(env);
	if (!ports) return undefined;
	try {
		const response = await fetch(`http://127.0.0.1:${ports.httpPort}/api/v1/info`);
		return (await response.json()).Messages;
	} catch {
		return undefined;
	}
}

// Sends one email the way a WordPress site does, through WP-CLI's `wp_mail`.
async function sendMail(env, site, subject) {
	const result = await cli(env, [
		'wp',
		'--path',
		sitePath(env, site),
		'eval',
		`echo wp_mail('someone@example.com', '${subject}', 'body') ? 'SENT' : 'FAILED';`,
	]);
	return result.stdout.includes('SENT');
}

// Sends one email from the running site's own PHP (the lost-password form).
async function sendMailFromSite(env, site) {
	const config = JSON.parse(readFileSync(path.join(env.configDir, 'cli.json'), 'utf8'));
	const port = config.sites.find((s) => s.path === sitePath(env, site))?.port;
	const response = await fetch(`http://localhost:${port}/wp-login.php?action=lostpassword`, {
		method: 'POST',
		body: new URLSearchParams({ user_login: 'admin', redirect_to: '' }),
		redirect: 'manual',
	});
	return (response.headers.get('location') ?? '').includes('checkemail=confirm');
}

async function sendmailPath(env, site) {
	const result = await cli(env, ['wp', '--path', sitePath(env, site), 'eval', "echo ini_get('sendmail_path');"]);
	return result.stdout.trim();
}

function tracksProps(output) {
	const match = output.match(/Would have recorded Tracks event: studio_site_start (\{[\s\S]*?\n\})/);
	if (!match) return undefined;
	const props = {};
	for (const [, key, value] of match[1].matchAll(/^\s+(\w+): (.+?),?$/gm)) {
		props[key] = value.replace(/^'|'$/g, '');
	}
	return props;
}

function check(id, ok, message, data) {
	recorder.recordCheck(id, Boolean(ok), message, data);
	if (!ok) console.error(`FAIL ${id}: ${message} ${JSON.stringify(data ?? {})}`);
}

const main = makeEnv('main');
const offline = makeEnv('offline', { emptyMailpitBin: true });
let blocker;

try {
	await recorder.recordEvent('scenario', 'start', { studio_path: STUDIO_PATH });

	// 1. First site start: the inbox starts, says where it is, and catches the site's email.
	const createA = await createSite(main, 'a');
	const portsA = readPorts(main);
	check('first-start-starts-inbox', createA.code === 0 && portsA && (await mailpitPids(main)).length === 1,
		'The first site start starts one Mailpit and records its ports', { ports: portsA, code: createA.code });
	check('first-start-logs-inbox', createA.output.includes('Email inbox started at http://127.0.0.1:'),
		'Site start reports the inbox URL');
	check('first-start-tracks', tracksProps(createA.output)?.email_inbox === 'started',
		'studio_site_start carries email_inbox=started', tracksProps(createA.output));
	check('page-mail-lands', (await sendMailFromSite(main, 'a')) && (await inboxCount(main)) === 1,
		'Email sent by a page request lands in the inbox');
	check('wp-cli-mail-lands', (await sendMail(main, 'a', 'cli')) && (await inboxCount(main)) === 2,
		'Email sent through WP-CLI lands in the inbox');

	// 2. A second site shares the running inbox.
	const createB = await createSite(main, 'b');
	check('second-site-shares-inbox',
		createB.code === 0 && readPorts(main)?.httpPort === portsA.httpPort && (await mailpitPids(main)).length === 1,
		'A second site reuses the running Mailpit', { ports: readPorts(main) });
	check('second-start-tracks', tracksProps(createB.output)?.email_inbox === 'running' &&
		Number(tracksProps(createB.output)?.email_inbox_messages) === 2,
		'studio_site_start carries email_inbox=running and the message count', tracksProps(createB.output));

	// 3. The inbox outlives one stopped site, and stops with the last.
	await stopSite(main, 'a');
	check('inbox-outlives-one-site', (await mailpitPids(main)).length === 1 && readPorts(main),
		'Mailpit keeps running while another site runs');
	const stopB = await stopSite(main, 'b');
	check('inbox-stops-with-last-site',
		(await mailpitPids(main)).length === 0 && !readPorts(main) && stopB.output.includes('Email inbox stopped'),
		'Stopping the last site stops Mailpit and removes its ports file');
	const stoppedSendmail = await sendmailPath(main, 'a');
	check('stopped-inbox-not-targeted', stoppedSendmail.includes('sendmail') && !stoppedSendmail.includes('mailpit'),
		'With no inbox running, PHP keeps its default sendmail_path', { sendmail_path: stoppedSendmail });

	// 4. Two sites starting at once start one inbox, and both reach it.
	const [startA, startB] = await Promise.all([startSite(main, 'a'), startSite(main, 'b')]);
	check('concurrent-starts-one-inbox',
		startA.code === 0 && startB.code === 0 && (await mailpitPids(main)).length === 1,
		'Concurrent site starts leave exactly one Mailpit', { pids: await mailpitPids(main) });
	check('inbox-keeps-mail', (await inboxCount(main)) === 2, 'The inbox keeps its mail across restarts');
	check('concurrent-sites-send',
		(await sendMailFromSite(main, 'a')) && (await sendMailFromSite(main, 'b')) && (await inboxCount(main)) === 4,
		'Both concurrently started sites deliver to the inbox');

	// 5. Mailpit killed outright: the next site start brings it back.
	for (const pid of await mailpitPids(main)) process.kill(pid, 'SIGKILL');
	await waitForMailpitExit(main);
	await new Promise((resolve) => setTimeout(resolve, 500));
	check('crash-clears-ports', !readPorts(main), 'A crashed Mailpit leaves no ports file behind');
	await stopSite(main, 'a');
	const restartA = await startSite(main, 'a');
	check('crash-recovers-on-start',
		restartA.code === 0 && (await mailpitPids(main)).length === 1 && (await sendMailFromSite(main, 'a')),
		'The next site start restarts Mailpit and email lands again', { count: await inboxCount(main) });

	// 6. Its port taken: the inbox moves to a free one.
	const takenPort = readPorts(main).httpPort;
	await cli(main, ['site', 'stop', '--all']);
	await waitForMailpitExit(main);
	blocker = createServer().listen(takenPort, '127.0.0.1');
	await new Promise((resolve) => blocker.once('listening', resolve));
	const portStart = await startSite(main, 'a');
	const movedPorts = readPorts(main);
	check('port-conflict-moves-inbox',
		portStart.code === 0 && movedPorts && movedPorts.httpPort !== takenPort && (await sendMailFromSite(main, 'a')),
		'With its port taken, Mailpit starts on another port and email still lands', { takenPort, movedPorts });
	blocker.close();
	blocker = undefined;

	// 7. Stopping Studio's daemon leaves nothing running.
	await cli(main, ['site', 'stop', '--all']);
	const exitMs = await waitForMailpitExit(main);
	check('daemon-stop-leaves-nothing', exitMs >= 0 && exitMs < 5_000 && !readPorts(main),
		'`site stop --all` leaves no Mailpit process or ports file within 5s', { exit_ms: exitMs });

	// 8. The process daemon dies outright: Mailpit goes with it, and comes back with the next site.
	await startSite(main, 'a');
	const daemon = await daemonPid(main);
	if (daemon) process.kill(daemon, 'SIGKILL');
	const orphanExitMs = await waitForMailpitExit(main);
	check('daemon-crash-leaves-no-mailpit', daemon && orphanExitMs >= 0 && orphanExitMs < 5_000 && !readPorts(main),
		'When the process daemon is killed, Mailpit exits and its ports file is removed', { daemon, exit_ms: orphanExitMs });
	const afterCrash = await startSite(main, 'a');
	check('daemon-crash-recovers', afterCrash.code === 0 && (await mailpitPids(main)).length === 1 && (await sendMailFromSite(main, 'a')),
		'After the daemon is killed, the next site start brings the inbox back and email lands');

	// 9. Deleting the last running site stops the inbox, as stopping it does.
	await stopSite(main, 'a');
	await startSite(main, 'b');
	const deleteB = await cli(main, ['site', 'delete', '--path', sitePath(main, 'b'), '--files']);
	const deleteExitMs = await waitForMailpitExit(main);
	check('inbox-stops-with-last-site-delete', deleteB.code === 0 && deleteExitMs >= 0 && !readPorts(main),
		'Deleting the last running site stops Mailpit', { code: deleteB.code, exit_ms: deleteExitMs });

	// 10. Mailpit can't be downloaded: the site still starts, with a warning.
	// Every request off this machine fails; the site's own localhost requests still work.
	const offlineVars = {
		NODE_USE_ENV_PROXY: '1',
		HTTPS_PROXY: 'http://127.0.0.1:9',
		HTTP_PROXY: 'http://127.0.0.1:9',
		NO_PROXY: 'localhost,127.0.0.1',
	};
	const createOffline = await createSite(offline, 'a', offlineVars);
	check('offline-site-still-starts', createOffline.code === 0,
		'The site starts when Mailpit cannot be downloaded', { code: createOffline.code });
	check('offline-warns', createOffline.output.includes('Email the site sends will not reach the Studio inbox'),
		'Site start warns that email will not reach the inbox');
	check('offline-tracks', tracksProps(createOffline.output)?.email_inbox === 'download_failed',
		'studio_site_start carries email_inbox=download_failed', tracksProps(createOffline.output));
	const offlineSendmail = await sendmailPath(offline, 'a');
	check('offline-no-inbox-target', offlineSendmail.includes('sendmail') && !offlineSendmail.includes('mailpit'),
		'Without an inbox, PHP keeps its default sendmail_path', { sendmail_path: offlineSendmail });
	await cli(offline, ['site', 'stop', '--all']);

	await recorder.recordEvent('scenario', 'ready');
	await recorder.writeTraceResults({ summary: 'Studio email inbox lifecycle checked' });
	if (recorder.assertions.some((a) => a.status === 'fail')) process.exitCode = 1;
} catch (error) {
	const message = error instanceof Error ? error.stack || error.message : String(error);
	recorder.recordAssertion('studio-site-email-lifecycle', 'fail', message.split('\n')[0]);
	await recorder.writeTraceResults({ status: 'error', summary: 'Studio email inbox lifecycle trace failed', failure: message });
	process.exitCode = 1;
} finally {
	blocker?.close();
	await cli(main, ['site', 'stop', '--all']).catch(() => {});
	await cli(offline, ['site', 'stop', '--all']).catch(() => {});
	rmSync(root, { recursive: true, force: true });
}
