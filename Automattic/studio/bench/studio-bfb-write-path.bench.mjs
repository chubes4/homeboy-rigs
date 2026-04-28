import { mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const STUDIO_PATH = process.env.HOMEBOY_COMPONENT_PATH;
const SHARED_STATE = process.env.HOMEBOY_BENCH_SHARED_STATE || os.tmpdir();

if (!STUDIO_PATH) {
  throw new Error('HOMEBOY_COMPONENT_PATH is required');
}

const RAW_HTML = `
<main class="salt-star-page">
  <section class="hero">
    <p class="eyebrow">Charleston bakery</p>
    <h1>Salt &amp; Star</h1>
    <p>Small-batch pastries, coastal breads, and morning coffee baked steps from the harbor.</p>
    <p><a href="/order" class="button">Order weekend pastries</a></p>
  </section>
  <section class="highlights">
    <h2>Bakery favorites</h2>
    <ul>
      <li><strong>Sea Salt Croissants</strong> — layered butter pastry finished with Atlantic salt.</li>
      <li><strong>Brown Sugar Morning Buns</strong> — soft spirals with citrus, cinnamon, and caramelized edges.</li>
      <li><strong>Harbor Sourdough</strong> — a slow-fermented loaf with a blistered crust and tender crumb.</li>
    </ul>
  </section>
  <blockquote>
    <p>"The kind of neighborhood bakery that makes Saturday feel planned by someone who loves you."</p>
    <cite>Marina W., regular since opening week</cite>
  </blockquote>
  <section class="visit">
    <h2>Visit us</h2>
    <p>Open Wednesday-Sunday, 7am-2pm at 18 Queen Street, Charleston.</p>
  </section>
</main>
`;

function qualityProbeCode(pageId) {
  const encodedPageId = Buffer.from(String(pageId)).toString('base64');

  return String.raw`
function bench_count_blocks( $blocks, &$counts ) {
    foreach ( $blocks as $block ) {
        $name = isset( $block['blockName'] ) ? (string) $block['blockName'] : '';
        if ( '' !== $name ) {
            $counts['total_blocks']++;
            if ( 'core/html' === $name ) {
                $counts['core_html_blocks']++;
            }
        }
        if ( ! empty( $block['innerBlocks'] ) ) {
            bench_count_blocks( $block['innerBlocks'], $counts );
        }
    }
}

$page_id = absint( base64_decode( '${encodedPageId}' ) );
$post = get_post( $page_id );
if ( ! $post ) {
    fwrite( STDERR, 'Inserted page not found: ' . $page_id );
    exit( 1 );
}

$content = (string) $post->post_content;
$counts = array(
    'posts_seen' => '' === trim( $content ) ? 0 : 1,
    'posts_with_blocks' => false !== strpos( $content, '<!-- wp:' ) ? 1 : 0,
    'total_blocks' => 0,
    'core_html_blocks' => 0,
    'serialized_block_comments' => substr_count( $content, '<!-- wp:' ),
    'bfb_fallback_count' => (int) get_option( 'studio_bfb_unsupported_fallback_count', 0 ),
    'stored_content_hash' => hash( 'sha256', $content ),
    'stored_content_bytes' => strlen( $content ),
    'stored_content_preview' => substr( $content, 0, 2000 ),
);

if ( '' !== trim( $content ) ) {
    bench_count_blocks( parse_blocks( $content ), $counts );
}

echo wp_json_encode( $counts, JSON_PRETTY_PRINT ) . PHP_EOL;
`;
}

function expandHome(value) {
  if (!value) return value;
  if (value === '~') return os.homedir();
  if (value.startsWith('~/')) return path.join(os.homedir(), value.slice(2));
  return value;
}

function variant() {
  return setting('studio_bench_variant') || path.basename(STUDIO_PATH);
}

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

function cliEnv(extra = {}) {
  const bfbPath = expandHome(
    setting('studio_bfb_plugin_path') || process.env.STUDIO_BFB_MU_PLUGIN_PATH || ''
  );
  return {
    ...process.env,
    ...(bfbPath ? { STUDIO_BFB_MU_PLUGIN_PATH: bfbPath } : {}),
    ...extra,
  };
}

function run(args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: options.cwd || STUDIO_PATH,
      env: cliEnv(options.env),
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0 && options.allowFailure !== true) {
        reject(new Error(`${args.join(' ')} exited ${code}; stderr=${stderr.slice(0, 1500)}`));
        return;
      }
      resolve({ code, stdout, stderr });
    });
  });
}

async function runCli(args, options = {}) {
  const cliPath = path.join(STUDIO_PATH, 'apps/cli/dist/cli/main.mjs');
  return run([cliPath, ...args], options);
}

async function createFreshSite(sitePath) {
  await runCli([
    'site',
    'create',
    '--name',
    `Studio Bench ${variant()} Write Path ${process.pid}`,
    '--path',
    sitePath,
    '--skip-browser',
    '--skip-log-details',
  ]);
}

async function stopSite(sitePath) {
  await runCli(['site', 'stop', '--path', sitePath], { allowFailure: true });
}

async function writeRawHtmlPage(sitePath) {
  const encodedContent = Buffer.from(RAW_HTML).toString('base64');
  const insertCode = `
    $content = base64_decode('${encodedContent}');
    $page_id = wp_insert_post(array(
      'post_type' => 'page',
      'post_status' => 'publish',
      'post_title' => 'Salt & Star',
      'post_content' => $content,
    ), true);
    if (is_wp_error($page_id)) {
      fwrite(STDERR, $page_id->get_error_message());
      exit(1);
    }
    update_option('show_on_front', 'page');
    update_option('page_on_front', $page_id);
    echo wp_json_encode(array('page_id' => $page_id)) . PHP_EOL;
  `;

  const { stdout } = await runCli(['wp', '--path', sitePath, '--php-version', '8.3', 'eval', insertCode]);
  const jsonStart = stdout.indexOf('{');
  if (jsonStart === -1) {
    throw new Error(`write step did not emit JSON: ${stdout.slice(0, 1000)}`);
  }
  return JSON.parse(stdout.slice(jsonStart));
}

async function probeQuality(sitePath, pageId) {
  const { stdout } = await runCli(['wp', '--path', sitePath, '--php-version', '8.3', 'eval', qualityProbeCode(pageId)]);
  const jsonStart = stdout.indexOf('{');
  if (jsonStart === -1) {
    throw new Error(`quality probe did not emit JSON: ${stdout.slice(0, 1000)}`);
  }
  return JSON.parse(stdout.slice(jsonStart));
}

export default async function studioBfbWritePathBench() {
  const currentVariant = variant();
  const runId = `${currentVariant}-write-path-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const artifactDir = path.join(SHARED_STATE, 'studio-bfb-write-path-artifacts');
  const sitePath = path.join(artifactDir, 'sites', runId);
  await mkdir(path.dirname(sitePath), { recursive: true });

  const started = Date.now();
  const siteCreateStarted = Date.now();
  await createFreshSite(sitePath);
  await stopSite(sitePath);
  const siteCreateMs = Date.now() - siteCreateStarted;

  const writeStarted = Date.now();
  const writeResult = await writeRawHtmlPage(sitePath);
  const writeElapsedMs = Date.now() - writeStarted;

  const qualityProbeStarted = Date.now();
  const quality = await probeQuality(sitePath, writeResult.page_id);
  const qualityProbeMs = Date.now() - qualityProbeStarted;
  const totalElapsedMs = Date.now() - started;

  await mkdir(artifactDir, { recursive: true });
  const artifactFile = path.join(artifactDir, `result-${runId}.json`);
  await writeFile(
    artifactFile,
    JSON.stringify(
      {
        variant: currentVariant,
        sitePath,
        writeResult,
        timings: {
          site_create_ms: siteCreateMs,
          write_elapsed_ms: writeElapsedMs,
          quality_probe_ms: qualityProbeMs,
          total_elapsed_ms: totalElapsedMs,
        },
        quality,
        storedContentHash: quality.stored_content_hash,
        storedContentPreview: quality.stored_content_preview,
        storedContentBytes: quality.stored_content_bytes,
        rawHtml: RAW_HTML,
      },
      null,
      2
    )
  );

  return {
    metrics: {
      success_rate: 1,
      elapsed_ms: totalElapsedMs,
      site_create_ms: siteCreateMs,
      write_elapsed_ms: writeElapsedMs,
      quality_probe_ms: qualityProbeMs,
      total_elapsed_ms: totalElapsedMs,
      posts_seen: Number(quality.posts_seen || 0),
      posts_with_blocks: Number(quality.posts_with_blocks || 0),
      total_blocks: Number(quality.total_blocks || 0),
      core_html_blocks: Number(quality.core_html_blocks || 0),
      serialized_block_comments: Number(quality.serialized_block_comments || 0),
      bfb_fallback_count: Number(quality.bfb_fallback_count || 0),
    },
    artifacts: {
      raw_result: artifactFile,
      site_path: sitePath,
      page_id: writeResult.page_id,
      stored_content_hash: quality.stored_content_hash,
      stored_content_bytes: quality.stored_content_bytes,
    },
  };
}
