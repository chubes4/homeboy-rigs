import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { request as httpRequest } from 'node:http';
import { join } from 'node:path';

const backendRoot = process.cwd();
const seed = process.env.HOMEBOY_FUZZ_SEED || 'tb-backend-demo-2026';
const runId = process.env.HOMEBOY_FUZZ_RUN_ID || `tb-backend-${seed}`;
const resultsFile = process.env.HOMEBOY_FUZZ_RESULTS_FILE || '.homeboy-fuzz-results.json';
const artifactsDir = process.env.HOMEBOY_FUZZ_ARTIFACTS_DIR || '.homeboy-fuzz-artifacts';
const port = 9100 + (Number.parseInt(createHash('sha256').update(seed).digest('hex').slice(0, 4), 16) % 400);
const mongoPort =
  27017 + (Number.parseInt(createHash('sha256').update(`${seed}-mongo`).digest('hex').slice(0, 3), 16) % 1000);
const origin = `http://127.0.0.1:${port}`;
const mongoName = `tb-fuzz-mongo-${seed.replace(/[^a-z0-9]/gi, '').slice(0, 24)}`;
const jwtSecret = 'homeboy-isolated-fuzz-jwt';

if (!existsSync(join(backendRoot, 'index.js'))) {
  throw new Error(`TB-Backend entrypoint not found in ${backendRoot}`);
}

mkdirSync(artifactsDir, { recursive: true });

function httpCall({ method, path, body, headers, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
    const req = httpRequest(
      `${origin}${path}`,
      {
        method,
        headers: {
          ...(payload ? { 'content-type': 'application/json', 'content-length': String(payload.length) } : {}),
          ...headers,
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          resolve({ status: res.statusCode ?? null, text });
        });
      },
    );
    const timer = setTimeout(() => req.destroy(new Error(`timeout after ${timeoutMs}ms`)), timeoutMs);
    req.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    req.on('close', () => clearTimeout(timer));
    if (payload) req.write(payload);
    req.end();
  });
}

function leak(text) {
  return /at\s+\S+\s+\(|MongoServerError|MongoError|ECONNREFUSED|ValidationError|node_modules|\.js:\d+:\d+/.test(
    text || '',
  );
}

const casesSpec = [
  { id: 'users.email-lookup', method: 'GET', path: '/api/users?email=nobody@example.com', expect: 'no-500' },
  { id: 'users.email-operator', method: 'GET', path: '/api/users?email[$ne]=', expect: 'no-500' },
  { id: 'users.all-unauth', method: 'GET', path: '/api/users/all', expect: 'deny' },
  { id: 'newsletter.stats-unauth', method: 'GET', path: '/api/newsletter/stats', expect: 'deny' },
  { id: 'analytics.overview-unauth', method: 'GET', path: '/api/analytics/dashboard/overview', expect: 'deny' },
  { id: 'listings.private-count', method: 'GET', path: '/api/listings/countTrickLists?userId[$ne]=', expect: 'no-500' },
  { id: 'listings.userId-operator', method: 'GET', path: '/api/listings?userId[$gt]=', expect: 'no-500' },
  { id: 'blog.invalid-id', method: 'GET', path: '/api/blog/not-an-object-id', expect: 'no-500' },
  { id: 'blog.operator-id', method: 'GET', path: '/api/blog/' + encodeURIComponent('{"$ne":null}'), expect: 'no-500' },
  { id: 'trickipedia.invalid-id', method: 'GET', path: '/api/trickipedia/id/zzzz', expect: 'no-500' },
  { id: 'spots.garbage', method: 'GET', path: '/api/spots/' + 'a'.repeat(2048), expect: 'no-500' },
  { id: 'auth.empty-json', method: 'POST', path: '/api/auth', body: {}, expect: 'no-500' },
  {
    id: 'auth.operator-email',
    method: 'POST',
    path: '/api/auth',
    body: { email: { $gt: '' }, password: 'x' },
    expect: 'no-500',
  },
  {
    id: 'auth.huge-password',
    method: 'POST',
    path: '/api/auth',
    body: { email: 'a@b.c', password: 'x'.repeat(20000) },
    expect: 'no-500',
  },
  {
    id: 'users.register-operator',
    method: 'POST',
    path: '/api/users',
    body: { name: 'fuzzer', email: { $ne: null }, password: 'abcde' },
    expect: 'no-500',
  },
  { id: 'dm.unauth', method: 'GET', path: '/api/dm/conversations', expect: 'deny' },
  { id: 'payments.unauth', method: 'GET', path: '/api/payments/subscription', expect: 'deny' },
  {
    id: 'jwt.none',
    method: 'GET',
    path: '/api/users/homies',
    headers: { 'x-auth-token': 'eyJhbGciOiJub25lIn0.eyJ1c2VySWQiOiIxIiwicm9sZSI6ImFkbWluIn0.' },
    expect: 'deny',
  },
  {
    id: 'jwt.garbage',
    method: 'GET',
    path: '/api/users/homies',
    headers: { 'x-auth-token': 'not-a-jwt' },
    expect: 'deny',
  },
  { id: 'admin.blog-unauth', method: 'POST', path: '/api/blog', body: { title: 'x', content: 'y' }, expect: 'deny' },
  { id: 'null-bytes', method: 'GET', path: '/api/users?email=%00admin@example.com', expect: 'no-500' },
];

const docker = spawnSync(
  'docker',
  ['run', '-d', '--rm', '--name', mongoName, '-p', `127.0.0.1:${mongoPort}:27017`, 'mongo:7'],
  { encoding: 'utf8' },
);
if (docker.status !== 0) {
  writeFileSync(join(artifactsDir, 'docker.log'), `${docker.stdout || ''}\n${docker.stderr || ''}`);
  throw new Error('Failed to start isolated MongoDB');
}

const server = spawn('node', ['index.js'], {
  cwd: backendRoot,
  env: {
    ...process.env,
    ATLAS_URI: `mongodb://127.0.0.1:${mongoPort}`,
    JWT_SECRET: jwtSecret,
    PORT: String(port),
    FRONTEND_URL: 'http://127.0.0.1:9',
    EMAIL_USER: '',
    EMAIL_PASSWORD: '',
    STRIPE_SECRET_KEY: 'sk_test_fuzz',
    STRIPE_WEBHOOK_SECRET: 'whsec_fuzz',
    OPENROUTER_API_KEY: '',
    OPENAI_API_KEY: '',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
  detached: true,
});

let serverOutput = '';
server.stdout.on('data', (chunk) => {
  serverOutput += chunk;
});
server.stderr.on('data', (chunk) => {
  serverOutput += chunk;
});

async function waitForServer() {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error(`API exited ${server.exitCode}: ${serverOutput.slice(-800)}`);
    try {
      const result = await httpCall({ method: 'GET', path: '/api/blog', timeoutMs: 2000 });
      if (result.status && result.status < 500) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  throw new Error(`Timed out waiting for API: ${serverOutput.slice(-800)}`);
}

const cases = [];
const findings = [];

try {
  await waitForServer();
  for (const [index, spec] of casesSpec.entries()) {
    console.error(`case ${index + 1}/${casesSpec.length} ${spec.id}`);
    const startedAt = performance.now();
    let status = null;
    let text = '';
    let requestError = null;
    try {
      const result = await httpCall({
        method: spec.method,
        path: spec.path,
        body: spec.body,
        headers: spec.headers,
        timeoutMs: 4000,
      });
      status = result.status;
      text = result.text.slice(0, 2000);
    } catch (error) {
      requestError = error.message;
    }
    const durationMs = Math.round(performance.now() - startedAt);
    const leaked = leak(text);
    const crashed = requestError !== null || status === null || status >= 500;
    const denyFailed = spec.expect === 'deny' && status !== null && status < 400;
    const failed = crashed || leaked || denyFailed;
    const fingerprint = failed
      ? createHash('sha256').update(JSON.stringify({ status, requestError, leaked, denyFailed })).digest('hex').slice(0, 16)
      : null;
    const fuzzCase = {
      schema: 'homeboy/fuzz-case/v1',
      id: `api:${index}`,
      target_id: spec.id,
      operation_id: `${spec.method.toLowerCase()}.${spec.expect}`,
      workload_id: 'tb-backend-api-fuzz',
      seed_id: seed,
      replay_id: `${runId}:${index}`,
      case: index,
      status: failed ? 'failed' : 'passed',
      passed: !failed,
      input: { method: spec.method, path: spec.path, body: spec.body || null },
      expected: { expect: spec.expect, maximum_status: 499 },
      observed: { status, request_error: requestError, leaked, deny_failed: denyFailed, body: text.slice(0, 400) },
      metadata: { duration_ms: durationMs, failure_fingerprint: fingerprint },
    };
    cases.push(fuzzCase);
    if (failed) {
      findings.push({
        schema: 'homeboy/fuzz-finding/v1',
        id: `finding-${spec.id}`,
        status: 'open',
        severity: crashed || leaked ? 'high' : 'medium',
        title: `API fuzz failure: ${spec.id}`,
        case_id: fuzzCase.id,
        failure_fingerprint: fingerprint,
        replay_id: fuzzCase.replay_id,
        details: fuzzCase.observed,
      });
    }
  }
} catch (error) {
  findings.push({
    schema: 'homeboy/fuzz-finding/v1',
    id: 'finding-harness',
    status: 'open',
    severity: 'high',
    title: 'Backend fuzz harness failed before completing the campaign',
    details: { message: error.message },
  });
} finally {
  try {
    if (server.pid) process.kill(-server.pid, 'SIGKILL');
  } catch {
    server.kill('SIGKILL');
  }
  spawnSync('docker', ['rm', '-f', mongoName], { encoding: 'utf8' });
}

const caseLog = cases
  .map((entry) =>
    JSON.stringify({
      schema: 'homeboy/fuzz-case-log/v1',
      version: 1,
      case_id: entry.id,
      target_id: entry.target_id,
      operation_id: entry.operation_id,
      operation_family: 'query',
      seed,
      input_hash: createHash('sha256').update(JSON.stringify(entry.input)).digest('hex'),
      status: entry.status,
      duration_ms: entry.metadata.duration_ms,
      failure_fingerprint: entry.metadata.failure_fingerprint,
      metadata: { replay_id: entry.replay_id },
    }),
  )
  .join('\n');

writeFileSync(join(artifactsDir, 'case-log.jsonl'), `${caseLog}\n`);
writeFileSync(
  join(artifactsDir, 'replay-data.json'),
  JSON.stringify({ seed, cases: cases.map(({ id, input, replay_id }) => ({ id, input, replay_id })) }, null, 2),
);
writeFileSync(join(artifactsDir, 'server.log'), serverOutput);

const campaign = {
  schema: 'homeboy/fuzz-campaign/v1',
  version: 1,
  id: runId,
  title: 'TrickBook backend isolated API fuzzing',
  status: findings.length ? 'fail' : 'pass',
  safety_class: 'isolated_mutation',
  seed,
  cases,
  findings,
  metrics: {
    total_cases: cases.length,
    passed_cases: cases.filter((entry) => entry.passed).length,
    failed_cases: cases.filter((entry) => !entry.passed).length,
    open_findings: findings.length,
  },
  coverage_summary: {
    schema: 'homeboy/fuzz-coverage-summary/v1',
    version: 1,
    declared_targets: casesSpec.length,
    executable_targets: casesSpec.length,
    proven_targets: new Set(cases.map((entry) => entry.target_id)).size,
    declared_operations: 2,
    executable_operations: 2,
    proven_operations: cases.length ? 2 : 0,
  },
  artifacts: [
    { schema: 'homeboy/fuzz-artifact/v1', id: 'case-log', kind: 'case_log', path: 'case-log.jsonl' },
    { schema: 'homeboy/fuzz-artifact/v1', id: 'replay-data', kind: 'replay_data', path: 'replay-data.json' },
    { schema: 'homeboy/fuzz-artifact/v1', id: 'server-log', kind: 'text', path: 'server.log' },
  ],
  provenance: {
    schema: 'homeboy/fuzz-provenance/v1',
    producer: 'homeboy-rigs/wbaxterh/TB-Backend',
    invocation: 'wbaxterh/TB-Backend/fuzz/api-fuzz-runner.mjs',
    run_id: runId,
  },
  replay: {
    schema: 'homeboy/fuzz-replay/v1',
    command: 'homeboy',
    args: ['fuzz', 'run', '--rig', 'tb-backend-api-fuzz', '--profile', 'isolated'],
    seed,
  },
};

writeFileSync(resultsFile, JSON.stringify(campaign, null, 2));
console.log(JSON.stringify(campaign.metrics));
