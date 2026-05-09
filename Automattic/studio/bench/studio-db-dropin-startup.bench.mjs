import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  artifactDir as studioArtifactDir,
  createStudioSite,
  metric,
  safeResult,
  setting,
  startStudioSite,
  stopStudioSite,
  studioSiteStatus,
  variant,
} from './lib/studio-bench.mjs';

const STOCK_DROPIN_COMMENT = 'This file is auto-generated and copied from the sqlite plugin';
const CUSTOM_DROPIN_COMMENT = 'Studio bench custom db.php drop-in';

function startOrder() {
  const order = setting('studio_db_dropin_start_order') || process.env.STUDIO_DB_DROPIN_START_ORDER;
  return order === 'custom-first' ? 'custom-first' : 'stock-first';
}

function sha256(content) {
  return createHash('sha256').update(content).digest('hex');
}

function dbPhpPath(sitePath) {
  return path.join(sitePath, 'wp-content', 'db.php');
}

async function readDbPhp(sitePath) {
  return readFile(dbPhpPath(sitePath), 'utf8');
}

async function makeCustomDropin(sitePath) {
  const stockContent = await readDbPhp(sitePath);
  if (!stockContent.includes(STOCK_DROPIN_COMMENT)) {
    throw new Error(`Expected stock SQLite db.php comment in ${dbPhpPath(sitePath)}`);
  }
  if (!stockContent.includes('SQLITE_DB_DROPIN_VERSION')) {
    throw new Error(`Expected SQLITE_DB_DROPIN_VERSION in ${dbPhpPath(sitePath)}`);
  }

  const customContent = stockContent.replace(STOCK_DROPIN_COMMENT, CUSTOM_DROPIN_COMMENT);
  await writeFile(dbPhpPath(sitePath), customContent);

  return {
    before_hash: sha256(stockContent),
    custom_hash: sha256(customContent),
    custom_bytes: Buffer.byteLength(customContent),
  };
}

async function createStoppedSite(sitePath, nameSuffix) {
  return createStudioSite(sitePath, {
    name: `Studio Bench ${variant()} DB Drop-in ${nameSuffix} ${process.pid}`,
    start: false,
    timeoutMs: 240000,
  });
}

async function runStartScenario(sitePath, nameSuffix, customizeDbPhp = false) {
  const create = await createStoppedSite(sitePath, nameSuffix);
  const custom = customizeDbPhp ? await makeCustomDropin(sitePath) : null;
  const start = await startStudioSite(sitePath, { timeoutMs: 240000 });
  const status = await studioSiteStatus(sitePath, { allowFailure: true, timeoutMs: 90000 });
  const afterContent = await readDbPhp(sitePath);
  const stop = await stopStudioSite(sitePath, { timeoutMs: 90000 });

  return {
    sitePath,
    create,
    custom,
    start,
    status,
    stop,
    after: {
      hash: sha256(afterContent),
      bytes: Buffer.byteLength(afterContent),
      has_custom_comment: afterContent.includes(CUSTOM_DROPIN_COMMENT),
      has_stock_comment: afterContent.includes(STOCK_DROPIN_COMMENT),
      defines_sqlite_version: afterContent.includes('SQLITE_DB_DROPIN_VERSION'),
    },
  };
}

export default async function studioDbDropinStartupBench() {
  const currentVariant = variant();
  const runId = `${currentVariant}-db-dropin-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const artifactDir = studioArtifactDir('studio-db-dropin-startup-artifacts');
  const sitesDir = path.join(artifactDir, 'sites');
  const stockSitePath = path.join(sitesDir, `${runId}-stock`);
  const customSitePath = path.join(sitesDir, `${runId}-custom`);
  await mkdir(sitesDir, { recursive: true });

  const started = Date.now();
  const order = startOrder();
  let stock;
  let custom;
  if (order === 'custom-first') {
    custom = await runStartScenario(customSitePath, 'Custom', true);
    stock = await runStartScenario(stockSitePath, 'Stock', false);
  } else {
    stock = await runStartScenario(stockSitePath, 'Stock', false);
    custom = await runStartScenario(customSitePath, 'Custom', true);
  }
  const totalElapsedMs = Date.now() - started;

  const customPreserved = custom.custom?.custom_hash === custom.after.hash;
  const startupDeltaMs = metric(custom.start.elapsedMs) - metric(stock.start.elapsedMs);

  const artifactFile = path.join(artifactDir, `result-${runId}.json`);
  await mkdir(artifactDir, { recursive: true });
  await writeFile(
    artifactFile,
    JSON.stringify(
      {
        variant: currentVariant,
        startOrder: order,
        sites: {
          stock: stockSitePath,
          custom: customSitePath,
        },
        timings: {
          stock_create_ms: stock.create.elapsedMs,
          stock_start_ms: stock.start.elapsedMs,
          custom_create_ms: custom.create.elapsedMs,
          custom_start_ms: custom.start.elapsedMs,
          custom_minus_stock_start_ms: startupDeltaMs,
          total_elapsed_ms: totalElapsedMs,
        },
        dbDropin: {
          custom_preserved: customPreserved,
          stock_after: stock.after,
          custom_before: custom.custom,
          custom_after: custom.after,
        },
        commands: {
          stockCreate: safeResult(stock.create),
          stockStart: safeResult(stock.start),
          stockStatus: safeResult(stock.status),
          stockStop: safeResult(stock.stop),
          customCreate: safeResult(custom.create),
          customStart: safeResult(custom.start),
          customStatus: safeResult(custom.status),
          customStop: safeResult(custom.stop),
        },
      },
      null,
      2
    )
  );

  if (!customPreserved) {
    throw new Error(`Custom db.php drop-in was not preserved; raw_result=${artifactFile}`);
  }

  return {
    metrics: {
      success_rate: 1,
      custom_dropin_preserved_rate: customPreserved ? 1 : 0,
      elapsed_ms: totalElapsedMs,
      stock_create_ms: metric(stock.create.elapsedMs),
      stock_start_ms: metric(stock.start.elapsedMs),
      custom_create_ms: metric(custom.create.elapsedMs),
      custom_start_ms: metric(custom.start.elapsedMs),
      custom_minus_stock_start_ms: startupDeltaMs,
      total_elapsed_ms: totalElapsedMs,
    },
    metadata: {
      start_order: order,
    },
    artifacts: {
      raw_result: artifactFile,
      stock_site_path: stockSitePath,
      custom_site_path: customSitePath,
    },
  };
}
