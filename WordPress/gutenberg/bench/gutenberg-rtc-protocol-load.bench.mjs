import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import {
  GUTENBERG_PATH,
  artifactDir,
  metric,
  percentile,
  redact,
  runId,
  runWpEnvTest,
  setting,
  writeJson,
  writeText,
} from './lib/gutenberg-rtc-bench.mjs';

const requireFromGutenberg = createRequire(path.join(GUTENBERG_PATH, 'package.json'));

const DEFAULT_BASE_URL = 'http://localhost:8889';

function intSetting(key, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const value = Number.parseInt(setting(key, String(fallback)), 10);
  if (!Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, value));
}

function base64FromUint8Array(value) {
  return Buffer.from(value).toString('base64');
}

function uint8ArrayFromBase64(value) {
  return new Uint8Array(Buffer.from(value, 'base64'));
}

function loadYjs() {
  try {
    return requireFromGutenberg('yjs');
  } catch {
    return null;
  }
}

function hash(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

async function wpCli(args, options = {}) {
  return runWpEnvTest(['run', 'cli', 'wp', ...args], {
    timeoutMs: 180000,
    ...options,
  });
}

async function fetchJson(url, { authHeader, body }) {
  const started = performance.now();
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: authHeader,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const elapsedMs = performance.now() - started;
  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    // Preserve text in the caller's artifact.
  }
  return {
    elapsedMs,
    json,
    ok: response.ok,
    status: response.status,
    text,
  };
}

async function prepareWordPress({ baseUrl, runName }) {
  const start = await runWpEnvTest(['start'], { timeoutMs: 300000, allowFailure: true });
  if (start.code !== 0) {
    throw new Error(`wp-env-test start failed; stderr=${redact(start.stderr).slice(0, 1600)}`);
  }

  await wpCli(['option', 'update', 'wp_collaboration_enabled', '1']);

  const appPassword = await wpCli([
    'user',
    'application-password',
    'create',
    'admin',
    `Homeboy RTC ${runName}`,
    '--porcelain',
  ]);
  const password = appPassword.stdout.trim().replace(/\s+/g, '');
  const authHeader = `Basic ${Buffer.from(`admin:${password}`).toString('base64')}`;

  const post = await wpCli([
    'post',
    'create',
    '--post_type=post',
    '--post_status=draft',
    `--post_title=Homeboy RTC Protocol Load ${runName}`,
    '--porcelain',
  ]);
  const postId = Number.parseInt(post.stdout.trim(), 10);
  if (!Number.isFinite(postId) || postId <= 0) {
    throw new Error(`wp post create did not return a valid post id: ${post.stdout}`);
  }

  return {
    authHeader,
    postId,
    room: `postType/post:${postId}`,
    syncUrl: `${baseUrl.replace(/\/$/, '')}/index.php?rest_route=/wp-sync/v1/updates`,
  };
}

function createClient(index, Y) {
  const doc = Y ? new Y.Doc() : null;
  const text = doc ? doc.getText('content') : null;
  return {
    clientId: index + 1,
    cursor: 0,
    doc,
    seenUpdateHashes: new Set(),
    text,
  };
}

function createUpdate(client, round, operationProfile, Y) {
  if (!Y) {
    const data = Buffer.from(`client:${client.clientId}:round:${round}:profile:${operationProfile}`).toString('base64');
    client.seenUpdateHashes.add(hash(data));
    return {
      data,
      type: 'update',
    };
  }

  client.doc.transact(() => {
    if (operationProfile === 'churn' && round % 3 === 2 && client.text.length > 0) {
      client.text.delete(0, Math.min(3, client.text.length));
    }
    client.text.insert(0, `[c${client.clientId}:r${round}]`);
  });
  const data = base64FromUint8Array(Y.encodeStateAsUpdateV2(client.doc));
  client.seenUpdateHashes.add(hash(data));
  return {
    data,
    type: 'update',
  };
}

function createCompactionUpdate(client, Y) {
  return {
    data: Y ? base64FromUint8Array(Y.encodeStateAsUpdateV2(client.doc)) : Buffer.from(`compact:${client.clientId}:${client.cursor}`).toString('base64'),
    type: 'compaction',
  };
}

function applyServerUpdates(client, updates, Y) {
  let applied = 0;
  for (const update of updates || []) {
    if (update?.data && (update.type === 'update' || update.type === 'compaction')) {
      if (Y) {
        Y.applyUpdateV2(client.doc, uint8ArrayFromBase64(update.data));
      }
      client.seenUpdateHashes.add(hash(update.data));
      applied++;
    }
  }
  return applied;
}

export default async function gutenbergRtcProtocolLoad() {
  const clientCount = intSetting('rtc_clients', 10, { min: 1, max: 5000 });
  const rounds = intSetting('rtc_rounds', 3, { min: 1, max: 100 });
  const batchSize = intSetting('rtc_batch_size', 25, { min: 1, max: 50 });
  const operationProfile = setting('rtc_operation_profile', 'smoke');
  const baseUrl = setting('wp_base_url', process.env.WP_BASE_URL || DEFAULT_BASE_URL);
  const currentRunId = runId('gutenberg-rtc-protocol-load');
  const outDir = path.join(artifactDir('gutenberg-rtc-protocol-load'), currentRunId);
  const rawResultFile = path.join(outDir, 'result.json');
  const responseLogFile = path.join(outDir, 'responses.jsonl');
  const responseRows = [];
  const Y = loadYjs();

  const wordpress = await prepareWordPress({ baseUrl, runName: currentRunId });
  const clients = Array.from({ length: clientCount }, (_, index) => createClient(index, Y));
  const latencies = [];
  const statuses = new Map();
  let requestsTotal = 0;
  let updatesSent = 0;
  let updatesApplied = 0;
  let compactionRequests = 0;
  let http4xx = 0;
  let http5xx = 0;

  const started = performance.now();
  for (let round = 0; round < rounds; round++) {
    for (let offset = 0; offset < clients.length; offset += batchSize) {
      const batch = clients.slice(offset, offset + batchSize);
      const rooms = batch.map((client) => {
        const updates = [createUpdate(client, round, operationProfile, Y)];
        updatesSent += updates.length;
        return {
          after: client.cursor,
          awareness: {
            user: { name: `RTC ${client.clientId}` },
            cursor: { round, offset: client.clientId },
          },
          client_id: client.clientId,
          room: wordpress.room,
          updates,
        };
      });

      const response = await fetchJson(wordpress.syncUrl, {
        authHeader: wordpress.authHeader,
        body: { rooms },
      });
      requestsTotal++;
      latencies.push(response.elapsedMs);
      statuses.set(response.status, (statuses.get(response.status) || 0) + 1);
      if (response.status >= 400 && response.status < 500) {
        http4xx++;
      }
      if (response.status >= 500) {
        http5xx++;
      }

      responseRows.push({
        round,
        offset,
        status: response.status,
        elapsed_ms: response.elapsedMs,
        room_count: rooms.length,
        body_preview: response.ok ? undefined : redact(response.text).slice(0, 1000),
      });

      if (!response.ok || !response.json?.rooms) {
        throw new Error(`sync request failed with HTTP ${response.status}; raw_result=${rawResultFile}`);
      }

      for (const [index, roomResponse] of response.json.rooms.entries()) {
        const client = batch[index];
        client.cursor = roomResponse.end_cursor ?? client.cursor;
        updatesApplied += applyServerUpdates(client, roomResponse.updates, Y);
        if (roomResponse.should_compact) {
          compactionRequests++;
          const compactResponse = await fetchJson(wordpress.syncUrl, {
            authHeader: wordpress.authHeader,
            body: {
              rooms: [
                {
                  after: client.cursor,
                  awareness: null,
                  client_id: client.clientId,
                  room: wordpress.room,
                  updates: [createCompactionUpdate(client, Y)],
                },
              ],
            },
          });
          requestsTotal++;
          latencies.push(compactResponse.elapsedMs);
          statuses.set(compactResponse.status, (statuses.get(compactResponse.status) || 0) + 1);
        }
      }
    }
  }

  // One catch-up pass with no new updates lets late clients apply the final room state.
  for (let offset = 0; offset < clients.length; offset += batchSize) {
    const batch = clients.slice(offset, offset + batchSize);
    const response = await fetchJson(wordpress.syncUrl, {
      authHeader: wordpress.authHeader,
      body: {
        rooms: batch.map((client) => ({
          after: client.cursor,
          awareness: null,
          client_id: client.clientId,
          room: wordpress.room,
          updates: [],
        })),
      },
    });
    requestsTotal++;
    latencies.push(response.elapsedMs);
    statuses.set(response.status, (statuses.get(response.status) || 0) + 1);
    if (!response.ok || !response.json?.rooms) {
      throw new Error(`catch-up request failed with HTTP ${response.status}; raw_result=${rawResultFile}`);
    }
    for (const [index, roomResponse] of response.json.rooms.entries()) {
      const client = batch[index];
      client.cursor = roomResponse.end_cursor ?? client.cursor;
      updatesApplied += applyServerUpdates(client, roomResponse.updates, Y);
    }
  }

  const elapsedMs = performance.now() - started;
  const expectedUpdateHashes = new Set();
  for (const client of clients) {
    for (const updateHash of client.seenUpdateHashes) {
      expectedUpdateHashes.add(updateHash);
    }
  }
  const texts = Y ? clients.map((client) => client.text.toString()) : clients.map((client) => [...client.seenUpdateHashes].sort().join(','));
  const finalTextHash = hash(texts[0] || '');
  const divergentClients = texts.filter((text) => hash(text) !== finalTextHash).length;
  const finalStateHashes = Y
    ? clients.map((client) => hash(Buffer.from(Y.encodeStateAsUpdateV2(client.doc))))
    : clients.map((client) => hash([...client.seenUpdateHashes].sort().join(',')));
  const uniqueFinalStateHashes = new Set(finalStateHashes).size;

  const result = {
    id: 'gutenberg-rtc-protocol-load',
    base_url: baseUrl,
    post_id: wordpress.postId,
    room: wordpress.room,
    client_count: clientCount,
    rounds,
    batch_size: batchSize,
    operation_profile: operationProfile,
    payload_mode: Y ? 'yjs' : 'opaque',
    elapsed_ms: elapsedMs,
    requests_total: requestsTotal,
    updates_sent: updatesSent,
    updates_applied: updatesApplied,
    compaction_requests: compactionRequests,
    statuses: Object.fromEntries(statuses.entries()),
    latency_ms: {
      p50: percentile(latencies, 50),
      p95: percentile(latencies, 95),
      p99: percentile(latencies, 99),
      max: Math.max(...latencies),
    },
    convergence: {
      final_text_hash: finalTextHash,
      divergent_clients: divergentClients,
      unique_final_state_hashes: uniqueFinalStateHashes,
      sample_text: texts[0]?.slice(0, 1000) || '',
      expected_update_hashes: expectedUpdateHashes.size,
    },
  };

  await writeJson(rawResultFile, result);
  await writeText(responseLogFile, responseRows.map((row) => JSON.stringify(row)).join('\n'));

  if (divergentClients > 0) {
    throw new Error(`synthetic clients did not converge; divergent_clients=${divergentClients}; raw_result=${rawResultFile}`);
  }

  return {
    metrics: {
      success_rate: 1,
      client_count: clientCount,
      rounds,
      batch_size: batchSize,
      requests_total: requestsTotal,
      requests_per_second: metric(requestsTotal / (elapsedMs / 1000)),
      updates_sent: updatesSent,
      updates_applied: updatesApplied,
      compaction_count: compactionRequests,
      sync_p50_ms: metric(result.latency_ms.p50),
      sync_p95_ms: metric(result.latency_ms.p95),
      sync_p99_ms: metric(result.latency_ms.p99),
      sync_max_ms: metric(result.latency_ms.max),
      http_4xx_count: http4xx,
      http_5xx_count: http5xx,
      divergent_clients: divergentClients,
      unique_final_state_hashes: uniqueFinalStateHashes,
      payload_mode_yjs: Y ? 1 : 0,
      total_elapsed_ms: metric(elapsedMs),
    },
    artifacts: {
      raw_result: rawResultFile,
      response_log: responseLogFile,
    },
    metadata: {
      operation_profile: operationProfile,
      payload_mode: Y ? 'yjs' : 'opaque',
      room: wordpress.room,
      post_id: wordpress.postId,
    },
  };
}
