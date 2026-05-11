import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

const REST_ENDPOINTS = [
  { key: 'pipelines', needle: '/datamachine/v1/pipelines' },
  { key: 'flows', needle: '/datamachine/v1/flows' },
  { key: 'handlers', needle: '/datamachine/v1/handlers' },
  { key: 'agents', needle: '/datamachine/v1/agents' },
];

function intEnv(name, fallback) {
  const value = Number(process.env[name] || fallback);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be a non-negative number`);
  }
  return Math.floor(value);
}

function metric(value) {
  const number = Number(value ?? 0);
  return Number.isFinite(number) ? Math.round(number) : 0;
}

function pageUrl(siteUrl, pagePath) {
  const base = siteUrl.endsWith('/') ? siteUrl : `${siteUrl}/`;
  return new URL(pagePath.replace(/^\/+/, ''), base).toString();
}

async function collectResources(page) {
  return page.evaluate(() =>
    performance.getEntriesByType('resource').map((entry) => ({
      name: entry.name,
      url: entry.name,
      initiatorType: entry.initiatorType,
      startTime: entry.startTime,
      responseStart: entry.responseStart,
      responseEnd: entry.responseEnd,
      requestStart: entry.requestStart,
      duration: entry.duration,
      transferSize: entry.transferSize,
      encodedBodySize: entry.encodedBodySize,
      decodedBodySize: entry.decodedBodySize,
    }))
  );
}

function normalizeUrl(url) {
  try {
    const parsed = new URL(url);
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return String(url || '');
  }
}

function summarizeResources(resources) {
  const mapped = resources.map((entry) => ({
    url: normalizeUrl(entry.url || entry.name),
    kind: String(entry.url || entry.name).includes('/wp-json/') ? 'rest' : 'other',
    initiatorType: entry.initiatorType,
    startMs: metric(entry.startTime),
    responseEndMs: metric(entry.responseEnd),
    durationMs: metric(entry.duration),
    ttfbMs: metric(entry.responseStart - entry.requestStart),
    transferSize: metric(entry.transferSize),
    encodedBodySize: metric(entry.encodedBodySize),
    decodedBodySize: metric(entry.decodedBodySize),
  }));

  return {
    count: mapped.length,
    restCount: mapped.filter((entry) => entry.kind === 'rest').length,
    slowest: mapped.slice().sort((a, b) => b.durationMs - a.durationMs).slice(0, 20),
    resources: mapped,
  };
}

function summarizeRestEndpoints(resources) {
  const summary = {};
  for (const endpoint of REST_ENDPOINTS) {
    const matches = resources
      .filter((entry) => String(entry.url || entry.name).includes(endpoint.needle))
      .map((entry) => ({
        url: normalizeUrl(entry.url || entry.name),
        startMs: metric(entry.startTime),
        responseEndMs: metric(entry.responseEnd),
        durationMs: metric(entry.duration),
        ttfbMs: metric(entry.responseStart - entry.requestStart),
        transferSize: metric(entry.transferSize),
        decodedBodySize: metric(entry.decodedBodySize),
      }))
      .sort((a, b) => b.durationMs - a.durationMs);

    summary[endpoint.key] = {
      count: matches.length,
      totalDurationMs: matches.reduce((sum, entry) => sum + entry.durationMs, 0),
      slowestDurationMs: matches[0]?.durationMs || 0,
      requests: matches,
    };
  }
  return summary;
}

function endpointKey(url) {
  for (const endpoint of REST_ENDPOINTS) {
    if (String(url || '').includes(endpoint.needle)) {
      return endpoint.key;
    }
  }
  return '';
}

async function markPhase(mark, name, started) {
  if (typeof mark === 'function') {
    await mark(`datamachine_pipelines_${name}`);
  }
  return Date.now() - started;
}

async function waitForProfileSelector(page, selector, options = {}) {
  try {
    await page.waitForSelector(selector, { timeout: options.timeout });
  } catch (error) {
    const url = typeof page.url === 'function' ? page.url() : '';
    const bodyText = await page.locator('body').innerText({ timeout: 1000 }).catch(() => '');
    const debug = await page.evaluate(() => ({
      dataMachineConfig: Boolean(window.dataMachineConfig),
      root: document.querySelector('#datamachine-react-root')?.outerHTML || '',
      dataMachineScripts: [...document.scripts].map((script) => script.src).filter((src) => src.includes('data-machine')),
      moduleScripts: [...document.scripts].filter((script) => script.type === 'module').map((script) => script.src).slice(-10),
    })).catch(() => ({}));
    const messages = (options.browserMessages || []).slice(-20);
    throw new Error(`${error.message}; current_url=${url}; body=${bodyText.slice(0, 500)}; messages=${JSON.stringify(messages).slice(0, 1000)}; debug=${JSON.stringify(debug).slice(0, 1000)}`);
  }
}

export async function setupWordPressPageProfile({ sitePath, artifactDir }) {
  const pipelineCount = intEnv('HOMEBOY_DATAMACHINE_PIPELINE_COUNT', 12);
  const flowsPerPipeline = intEnv('HOMEBOY_DATAMACHINE_FLOWS_PER_PIPELINE', 8);
  const stepsPerFlow = intEnv('HOMEBOY_DATAMACHINE_STEPS_PER_FLOW', 6);
  const configPayloadSize = intEnv('HOMEBOY_DATAMACHINE_CONFIG_PAYLOAD_SIZE', 1024);
  const seedSlug = process.env.HOMEBOY_DATAMACHINE_SCALE_SEED_SLUG || `homeboy-scale-${process.pid}`;
  const loaderPath = path.join(sitePath, 'wp-content', 'mu-plugins', 'homeboy-datamachine-scale-profile.php');
  const artifactPath = path.join(artifactDir, 'datamachine-scale-seed.json');
  const signature = JSON.stringify({ pipelineCount, flowsPerPipeline, stepsPerFlow, configPayloadSize, seedSlug });
  const php = `<?php
/**
 * Temporary Homeboy Data Machine scale profile loader.
 * Generated by homeboy-rigs and removed after the workload completes.
 */

add_action('muplugins_loaded', function () {
    $plugins = array(
        WP_PLUGIN_DIR . '/agents-api/agents-api.php',
        WP_PLUGIN_DIR . '/data-machine/data-machine.php',
    );
    foreach ($plugins as $plugin_file) {
        if (is_readable($plugin_file)) {
            require_once $plugin_file;
        }
    }
}, 1);

add_action('admin_init', function () {
    if (function_exists('datamachine_register_capabilities')) {
        datamachine_register_capabilities();
    }
    if (function_exists('datamachine_activate_defaults_for_site')) {
        datamachine_activate_defaults_for_site();
    }

    if (!current_user_can('manage_options')) {
        return;
    }

    $signature = ${JSON.stringify(signature)};
    if (get_option('homeboy_datamachine_scale_signature') === $signature) {
        return;
    }

    $pipeline_count = ${pipelineCount};
    $flows_per_pipeline = ${flowsPerPipeline};
    $steps_per_flow = ${stepsPerFlow};
    $config_payload_size = ${configPayloadSize};
    $seed_slug = sanitize_title(${JSON.stringify(seedSlug)});
    $payload = str_repeat('x', max(0, $config_payload_size));

    $pipelines = new \\DataMachine\\Core\\Database\\Pipelines\\Pipelines();
    $flows = new \\DataMachine\\Core\\Database\\Flows\\Flows();
    $pipelines->create_table();
    $pipelines->migrate_columns();
    $flows->create_table();
    $flows->migrate_columns();

    global $wpdb;
    $pipelines_table = $wpdb->prefix . 'datamachine_pipelines';
    $flows_table = $wpdb->prefix . 'datamachine_flows';
    $existing_ids = $wpdb->get_col(
      $wpdb->prepare("SELECT pipeline_id FROM \{$pipelines_table} WHERE portable_slug LIKE %s", $seed_slug . '-%')
    );
    if ($existing_ids) {
      $placeholders = implode(',', array_fill(0, count($existing_ids), '%d'));
      $wpdb->query($wpdb->prepare("DELETE FROM \{$flows_table} WHERE pipeline_id IN ($placeholders)", array_map('intval', $existing_ids)));
      $wpdb->query($wpdb->prepare("DELETE FROM \{$pipelines_table} WHERE pipeline_id IN ($placeholders)", array_map('intval', $existing_ids)));
    }

    $created_pipeline_ids = array();
    for ($pipeline_index = 1; $pipeline_index <= $pipeline_count; $pipeline_index++) {
      $pipeline_config = array();
      for ($step_index = 1; $step_index <= $steps_per_flow; $step_index++) {
        $step_id = sprintf('scale_pipeline_%03d_step_%03d', $pipeline_index, $step_index);
        $pipeline_config[$step_id] = array(
          'pipeline_step_id' => $step_id,
          'step_type' => $step_index % 2 === 0 ? 'ai' : 'system_task',
          'execution_order' => $step_index,
          'handler_config' => array(
            'task' => 'profile_scale_fixture',
            'payload' => $payload,
            'pipeline_index' => $pipeline_index,
            'step_index' => $step_index,
          ),
          'system_prompt' => 'Scale fixture prompt ' . $pipeline_index . '.' . $step_index . ' ' . $payload,
        );
      }

      $pipeline_id = $pipelines->create_pipeline(array(
        'pipeline_name' => sprintf('Homeboy Scale Pipeline %03d', $pipeline_index),
        'pipeline_config' => $pipeline_config,
        'user_id' => 1,
        'portable_slug' => sprintf('%s-pipeline-%03d', $seed_slug, $pipeline_index),
      ));
      if (!$pipeline_id) {
        throw new RuntimeException('Failed to create scale pipeline ' . $pipeline_index);
      }
      $created_pipeline_ids[] = $pipeline_id;

      for ($flow_index = 1; $flow_index <= $flows_per_pipeline; $flow_index++) {
        $flow_config = array();
        foreach ($pipeline_config as $step_id => $step_config) {
          $flow_config[$step_id] = array(
            'pipeline_step_id' => $step_id,
            'flow_step_id' => sprintf('scale_flow_%03d_%03d_%s', $pipeline_index, $flow_index, $step_id),
            'step_type' => $step_config['step_type'],
            'handler_config' => array_merge($step_config['handler_config'], array(
              'flow_index' => $flow_index,
              'payload' => $payload,
            )),
          );
        }

        $flow_id = $flows->create_flow(array(
          'pipeline_id' => $pipeline_id,
          'flow_name' => sprintf('Homeboy Scale Flow %03d.%03d', $pipeline_index, $flow_index),
          'flow_config' => $flow_config,
          'scheduling_config' => array('type' => 'manual'),
          'user_id' => 1,
          'portable_slug' => sprintf('%s-flow-%03d-%03d', $seed_slug, $pipeline_index, $flow_index),
        ));
        if (!$flow_id) {
          throw new RuntimeException('Failed to create scale flow ' . $pipeline_index . '.' . $flow_index);
        }
      }
    }

    update_option('homeboy_datamachine_scale_signature', $signature, false);
  });
`;

  await mkdir(path.dirname(loaderPath), { recursive: true });
  await writeFile(loaderPath, php);
  await writeFile(
    artifactPath,
    JSON.stringify({ pipelineCount, flowsPerPipeline, stepsPerFlow, configPayloadSize, seedSlug, loaderPath }, null, 2)
  );
  return { pipelineCount, flowsPerPipeline, stepsPerFlow, configPayloadSize, seedSlug, loaderPath, artifactPath };
}

export async function cleanupWordPressPageProfile({ setupProfile }) {
  if (setupProfile?.loaderPath) {
    await rm(setupProfile.loaderPath, { force: true });
  }
}

export async function profileWordPressPage({ page, siteUrl, pageSpec, mark }) {
  const spec = pageSpec || {};
  const url = pageUrl(siteUrl, spec.path || '/wp-admin/admin.php?page=datamachine-pipelines');
  const started = Date.now();
  const phaseTimings = {};
  const browserMessages = [];
  const restSeen = new Map();
  const restWaiters = new Map();

  function noteRestResponse(response) {
    const responseUrl = response.url();
    const key = endpointKey(responseUrl);
    if (!key) {
      return;
    }
    const record = { status: response.status(), url: normalizeUrl(responseUrl), elapsedMs: Date.now() - started };
    restSeen.set(key, record);
    browserMessages.push(`rest: ${record.status} ${record.url}`);
    const waiters = restWaiters.get(key) || [];
    restWaiters.delete(key);
    for (const resolve of waiters) {
      resolve(record);
    }
  }

  function waitForRest(key, timeout = spec.timeout || 120000) {
    if (restSeen.has(key)) {
      return Promise.resolve(restSeen.get(key));
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Timed out waiting for Data Machine REST ${key}`)), timeout);
      const waiters = restWaiters.get(key) || [];
      waiters.push((record) => {
        clearTimeout(timer);
        resolve(record);
      });
      restWaiters.set(key, waiters);
    });
  }

  page.on('console', (message) => {
    if (message.type() === 'error' || message.type() === 'warning') {
      browserMessages.push(`${message.type()}: ${message.text()}`);
    }
  });
  page.on('pageerror', (error) => {
    browserMessages.push(`pageerror: ${error.message}`);
  });
  page.on('response', (response) => {
    noteRestResponse(response);
  });

  const response = await page.goto(url, {
    waitUntil: 'commit',
    timeout: spec.timeout || 120000,
  });
  if (typeof mark === 'function') {
    await mark('datamachine_pipelines_commit');
  }

  const waitOptions = { timeout: spec.timeout || 120000, browserMessages };

  await waitForProfileSelector(page, 'body.wp-admin, #wpbody-content', waitOptions);
  phaseTimings.adminShellReadyMs = await markPhase(mark, 'admin_shell_ready', started);

  await waitForProfileSelector(page, '.datamachine-pipelines-layout', waitOptions);
  phaseTimings.pipelineShellReadyMs = await markPhase(mark, 'pipeline_shell_ready', started);

  await waitForRest('pipelines');
  await waitForRest('handlers');
  phaseTimings.pipelineStepsReadyMs = await markPhase(mark, 'pipeline_steps_ready', started);

  await waitForRest('flows');
  phaseTimings.flowsSectionReadyMs = await markPhase(mark, 'flows_section_ready', started);

  await page.waitForLoadState('networkidle', { timeout: spec.timeout || 120000 });
  phaseTimings.networkIdleMs = await markPhase(mark, 'network_idle', started);

  const resources = await collectResources(page);
  const resourceSummary = summarizeResources(resources);
  const restEndpointTimings = summarizeRestEndpoints(resources);
  const readyMs = phaseTimings.flowsSectionReadyMs;

  return {
    id: spec.id || 'datamachine-pipelines-scale',
    label: spec.label || 'Data Machine Pipelines Scale Profile',
    url,
    path: new URL(url).pathname + new URL(url).search,
    status: response && typeof response.status === 'function' ? response.status() : 0,
    readyMs,
    phaseTimings,
    resources: resourceSummary,
    restEndpointTimings,
    restWaterfall: restEndpointTimings,
    metrics: {
      datamachine_pipelines_admin_shell_ready_ms: metric(phaseTimings.adminShellReadyMs),
      datamachine_pipelines_pipeline_shell_ready_ms: metric(phaseTimings.pipelineShellReadyMs),
      datamachine_pipelines_pipeline_steps_ready_ms: metric(phaseTimings.pipelineStepsReadyMs),
      datamachine_pipelines_flows_section_ready_ms: metric(phaseTimings.flowsSectionReadyMs),
      datamachine_pipelines_network_idle_ms: metric(phaseTimings.networkIdleMs),
      datamachine_pipelines_rest_pipelines_ms: metric(restEndpointTimings.pipelines?.slowestDurationMs),
      datamachine_pipelines_rest_flows_ms: metric(restEndpointTimings.flows?.slowestDurationMs),
      datamachine_pipelines_rest_handlers_ms: metric(restEndpointTimings.handlers?.slowestDurationMs),
      datamachine_pipelines_rest_agents_ms: metric(restEndpointTimings.agents?.slowestDurationMs),
    },
  };
}
