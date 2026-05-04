import { mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const SHARED_STATE = process.env.HOMEBOY_BENCH_SHARED_STATE || os.tmpdir();
const ENABLED = process.env.HOMEBOY_ENABLE_SSI_WOO_FIXTURE === '1';

const DEPENDENCIES = [
  'https://github.com/chubes4/static-site-importer/issues/111',
  'https://github.com/chubes4/static-site-importer/issues/112',
  'https://github.com/chubes4/static-site-importer/issues/113',
];

function setting(key) {
  try {
    const settings = JSON.parse(process.env.HOMEBOY_SETTINGS_JSON || '{}');
    if (settings && typeof settings[key] === 'string') {
      return settings[key];
    }
  } catch {
    // Ignore malformed settings and fall back to direct env/debug defaults.
  }
  const envKey = `HOMEBOY_SETTINGS_${key.toUpperCase()}`;
  return process.env[envKey] || '';
}

function expandHome(value) {
  if (!value) return value;
  if (value === '~') return os.homedir();
  if (value.startsWith('~/')) return path.join(os.homedir(), value.slice(2));
  return value;
}

async function fixtureSummary() {
  const fixtureDir = fixturePath();
  const productsFile = path.join(fixtureDir, 'products.json');
  const manifest = JSON.parse(await readFile(productsFile, 'utf8'));
  const products = Array.isArray(manifest.products) ? manifest.products : [];
  return {
    fixture_dir: fixtureDir,
    products_file: productsFile,
    product_count: products.length,
    product_handles: products.map((product) => product.handle).filter(Boolean),
    product_categories: [...new Set(products.flatMap((product) => product.categories || []))],
    prices: products.map((product) => ({ handle: product.handle, price: product.price })),
    images: products.map((product) => ({ handle: product.handle, images: product.images || [] })),
  };
}

function staticSiteImporterPath() {
  return expandHome(
    process.env.HOMEBOY_SSI_PATH || setting('studio_static_site_importer_plugin_path') || '~/Developer/static-site-importer'
  );
}

function fixturePath() {
  return path.join(staticSiteImporterPath(), 'tests', 'fixtures', 'ssi-woo-store');
}

async function writeArtifact(payload) {
  const artifactDir = path.join(SHARED_STATE, 'studio-ssi-woo-fixture-validation-artifacts');
  await mkdir(artifactDir, { recursive: true });
  const artifactFile = path.join(artifactDir, `result-${Date.now()}-${process.pid}.json`);
  await writeFile(artifactFile, JSON.stringify(payload, null, 2));
  return artifactFile;
}

async function assertStaticSiteImporterHasWooPrimitives(staticSiteImporterPath) {
  const cliPath = path.join(staticSiteImporterPath, 'includes', 'class-static-site-importer-cli-command.php');
  const cli = await readFile(cliPath, 'utf8');
  const requiredMarkers = ['products.json', 'WooCommerce', 'product context'];
  const missingMarkers = requiredMarkers.filter((marker) => !cli.includes(marker));

  if (missingMarkers.length > 0) {
    throw new Error(
      `Static Site Importer WooCommerce primitives are not available; missing markers: ${missingMarkers.join(', ')}`
    );
  }
}

export default async function studioSsiWooFixtureValidationBench() {
  const summary = await fixtureSummary();

  if (!ENABLED) {
    const artifactFile = await writeArtifact({
      status: 'skipped',
      reason: 'SSI WooCommerce primitives are dependency-gated; set HOMEBOY_ENABLE_SSI_WOO_FIXTURE=1 only when testing an SSI branch that implements them.',
      dependencies: DEPENDENCIES,
      fixture: summary,
    });

    return {
      metrics: {
        success_rate: 1,
        skipped: 1,
        dependency_ready: 0,
        product_count: summary.product_count,
        imported_product_count: 0,
        core_html_blocks: 0,
        fallback_count: 0,
      },
      artifacts: {
        raw_result: artifactFile,
        fixture_dir: summary.fixture_dir,
        products_json: summary.products_file,
      },
    };
  }

  await assertStaticSiteImporterHasWooPrimitives(staticSiteImporterPath());

  throw new Error(
    'HOMEBOY_ENABLE_SSI_WOO_FIXTURE=1 requested, but the executable validation path is intentionally blocked until SSI defines the manifest CLI contract. Do not seed WooCommerce products in this rig.'
  );
}
