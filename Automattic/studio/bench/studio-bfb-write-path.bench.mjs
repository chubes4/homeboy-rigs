import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  artifactDir as studioArtifactDir,
  createStudioSite,
  expandHome,
  runCli,
  setting,
  stopStudioSite,
  variant,
} from './lib/studio-bench.mjs';
import { probePageQuality } from './lib/wordpress-quality.mjs';

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

function cliEnv(extra = {}) {
  const bfbPath = expandHome(
    setting('studio_bfb_plugin_path') || process.env.STUDIO_BFB_MU_PLUGIN_PATH || ''
  );
  return {
    ...(bfbPath ? { STUDIO_BFB_MU_PLUGIN_PATH: bfbPath } : {}),
    ...extra,
  };
}

async function runStudioCli(args, options = {}) {
  return runCli(args, { ...options, env: cliEnv(options.env) });
}

async function createFreshSite(sitePath) {
  await createStudioSite(sitePath, {
    name: `Studio Bench ${variant()} Write Path ${process.pid}`,
    env: cliEnv(),
  });
}

async function stopSite(sitePath) {
  await stopStudioSite(sitePath, { env: cliEnv() });
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

  const { stdout } = await runStudioCli(['wp', '--path', sitePath, '--php-version', '8.3', 'eval', insertCode]);
  const jsonStart = stdout.indexOf('{');
  if (jsonStart === -1) {
    throw new Error(`write step did not emit JSON: ${stdout.slice(0, 1000)}`);
  }
  return JSON.parse(stdout.slice(jsonStart));
}

export default async function studioBfbWritePathBench() {
  const currentVariant = variant();
  const runId = `${currentVariant}-write-path-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const artifactDir = studioArtifactDir('studio-bfb-write-path-artifacts');
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
  const quality = await probePageQuality(sitePath, writeResult.page_id, { runCli: runStudioCli });
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
    },
  };
}
