import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const PRELOAD_MARKER = 'HOMEBOY_SITE_EDITOR_PRELOAD_CANDIDATE';
const CAPTURE_MARKER = 'HOMEBOY_SITE_EDITOR_PRELOAD_CAPTURE';

// Verbatim route-aware preload block copied from WordPress/wordpress-develop#11766
// (head commit 360e7cbf02793323f9fa24fcbbea379a9ed7e4c9). This is the candidate
// under review for WordPress 7.1; the classic-theme evidence rig measures it
// unmodified so the wp_is_block_theme() guard decision can be made from data.
// Do not hand-edit the PHP below; refresh it from the PR diff when it changes.
const PR_11766_PRELOAD_BLOCK = `
// ${PRELOAD_MARKER} (pr-11766): begin — verbatim from WordPress/wordpress-develop#11766 @ 360e7cbf02793323f9fa24fcbbea379a9ed7e4c9
$template_slugs = array();
$front_page     = null;
if ( $block_editor_context->post && 'page' === $block_editor_context->post->post_type ) {
	$template_slugs[] = empty( $block_editor_context->post->post_name ) ? 'page' : 'page-' . $block_editor_context->post->post_name;
	$template_slugs[] = 'page';
} else {
	$template_slugs[] = 'front-page';

	$page_on_front = (int) get_option( 'page_on_front' );
	if ( 'page' === get_option( 'show_on_front' ) && $page_on_front > 0 ) {
		$front_page = get_post( $page_on_front );
		if ( $front_page instanceof WP_Post ) {
			$template_slugs[] = empty( $front_page->post_name ) ? 'page' : 'page-' . $front_page->post_name;
			$template_slugs[] = 'page';
		}
	} else {
		$template_slugs[] = 'home';
	}

	$template_slugs[] = 'index';
}

$template_slugs = array_values( array_unique( $template_slugs ) );
$templates      = get_block_templates(
	array(
		'slug__in' => $template_slugs,
	),
	'wp_template'
);
$priorities     = array_flip( $template_slugs );

usort(
	$templates,
	static function ( $template_a, $template_b ) use ( $priorities ) {
		return ( $priorities[ $template_a->slug ] ?? 999 ) - ( $priorities[ $template_b->slug ] ?? 999 );
	}
);

$template_part_ids = array();
$has_query         = false;
$walk_blocks       = static function ( array $blocks ) use ( &$walk_blocks, &$template_part_ids, &$has_query ) {
	foreach ( $blocks as $block ) {
		if ( 'core/template-part' === ( $block['blockName'] ?? '' ) && ! empty( $block['attrs']['slug'] ) ) {
			$theme               = ! empty( $block['attrs']['theme'] ) ? $block['attrs']['theme'] : get_stylesheet();
			$template_part_ids[] = $theme . '//' . $block['attrs']['slug'];
		}

		if ( 'core/query' === ( $block['blockName'] ?? '' ) ) {
			$has_query = true;
		}

		if ( ! empty( $block['innerBlocks'] ) ) {
			$walk_blocks( $block['innerBlocks'] );
		}
	}
};

if ( ! empty( $templates ) && ! empty( $templates[0]->content ) ) {
	$blocks = resolve_pattern_blocks( parse_blocks( $templates[0]->content ) );
	$walk_blocks( $blocks );
}

foreach ( array_unique( $template_part_ids ) as $template_part_id ) {
	$preload_paths[] = '/wp/v2/template-parts/' . $template_part_id . '?context=edit';
}

if ( $front_page instanceof WP_Post ) {
	$route_for_front_page = rest_get_route_for_post( $front_page );
	if ( $route_for_front_page ) {
		$preload_paths[] = add_query_arg( 'context', 'edit', $route_for_front_page );
	}
	$preload_paths[] = add_query_arg(
		'slug',
		empty( $front_page->post_name ) ? 'page' : 'page-' . $front_page->post_name,
		'/wp/v2/templates/lookup'
	);
	$preload_paths[] = '/wp/v2/types/page?context=edit';
}

if ( $has_query ) {
	$post_rest_route = rest_get_route_for_post_type_items( 'post' );
	$preload_paths[] = '/wp/v2/types/post?context=edit';
	foreach ( array( 10, 3 ) as $per_page ) {
		$preload_paths[] = add_query_arg(
			array(
				'context'       => 'edit',
				'offset'        => 0,
				'order'         => 'desc',
				'orderby'       => 'date',
				'per_page'      => $per_page,
				'ignore_sticky' => 'false',
			),
			$post_rest_route
		);
	}
}

$preload_paths[] = add_query_arg(
	array(
		'context'  => 'edit',
		'per_page' => 100,
		'_fields'  => 'id,link,menu_order,parent,title,type',
		'orderby'  => 'menu_order',
		'order'    => 'asc',
	),
	rest_get_route_for_post_type_items( 'page' )
);

$preload_paths[] = '/wp/v2/taxonomies?context=view';
// ${PRELOAD_MARKER} (pr-11766): end
`;

function quotePhpString(value) {
  return `'${String(value || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

function preloadExpression(spec) {
  if (typeof spec === 'string') {
    return quotePhpString(spec);
  }
  if (!spec || typeof spec !== 'object' || typeof spec.path !== 'string') {
    throw new Error('preload path specs must be strings or objects with a path');
  }
  if (!spec.method || String(spec.method).toUpperCase() === 'GET') {
    return quotePhpString(spec.path);
  }
  return `array( ${quotePhpString(spec.path)}, ${quotePhpString(String(spec.method).toUpperCase())} )`;
}

function preloadLinesFromJsonEnv(name) {
  const raw = process.env[name];
  if (!raw) {
    return [];
  }

  const specs = JSON.parse(raw);
  if (!Array.isArray(specs)) {
    throw new Error(`${name} must be an array`);
  }
  return specs.map((spec) => `$preload_paths[] = ${preloadExpression(spec)};`);
}

function dynamicPreloadLines() {
  const raw = process.env.HOMEBOY_SITE_EDITOR_DYNAMIC_PRELOADS_JSON;
  if (!raw) {
    return [];
  }
  const specs = JSON.parse(raw);
  if (!Array.isArray(specs)) {
    throw new Error('HOMEBOY_SITE_EDITOR_DYNAMIC_PRELOADS_JSON must be an array');
  }

  const lines = [];
  if (specs.includes('navigation-fallback')) {
    lines.push(`
$homeboy_navigation_fallback = class_exists( 'WP_Navigation_Fallback' ) ? WP_Navigation_Fallback::get_fallback() : null;
if ( $homeboy_navigation_fallback instanceof WP_Post ) {
	$preload_paths[] = '/wp-block-editor/v1/navigation-fallback?_embed=true';
	$preload_paths[] = '/wp/v2/navigation/' . $homeboy_navigation_fallback->ID . '?context=edit';
}
`);
  }
  return lines;
}

export function installSiteEditorPreloadCandidateSource(source, options = {}) {
	if (source.includes(PRELOAD_MARKER)) {
		return source;
	}

	const needle = 'block_editor_rest_api_preload( $preload_paths, $block_editor_context );';
	const mode = options.mode || process.env.HOMEBOY_SITE_EDITOR_PRELOAD_MODE || 'broad';
	let patch;

	if (mode === 'taxonomies') {
		patch = `
// ${PRELOAD_MARKER}: begin
	$preload_paths[] = '/wp/v2/taxonomies?context=view';
// ${PRELOAD_MARKER}: end
`;
	} else if (mode === 'template-aware') {
		patch = `
// ${PRELOAD_MARKER}: begin
$homeboy_template_slugs = array();
$homeboy_front_page     = null;
if ( ! empty( $block_editor_context->post ) && 'page' === $block_editor_context->post->post_type ) {
	$homeboy_template_slugs[] = empty( $block_editor_context->post->post_name ) ? 'page' : 'page-' . $block_editor_context->post->post_name;
	$homeboy_template_slugs[] = 'page';
} else {
	$homeboy_template_slugs[] = 'front-page';

	if ( 'page' === get_option( 'show_on_front' ) ) {
		$homeboy_front_page = get_post( (int) get_option( 'page_on_front' ) );
		if ( $homeboy_front_page instanceof WP_Post ) {
			$homeboy_template_slugs[] = empty( $homeboy_front_page->post_name ) ? 'page' : 'page-' . $homeboy_front_page->post_name;
			$homeboy_template_slugs[] = 'page';
		}
	} else {
		$homeboy_template_slugs[] = 'home';
	}

	$homeboy_template_slugs[] = 'index';
}

$homeboy_template_slugs = array_values( array_unique( $homeboy_template_slugs ) );
$homeboy_templates      = get_block_templates(
	array(
		'slug__in' => $homeboy_template_slugs,
	),
	'wp_template'
);
$homeboy_priorities     = array_flip( $homeboy_template_slugs );

usort(
	$homeboy_templates,
	static function ( $homeboy_template_a, $homeboy_template_b ) use ( $homeboy_priorities ) {
		return ( $homeboy_priorities[ $homeboy_template_a->slug ] ?? 999 ) - ( $homeboy_priorities[ $homeboy_template_b->slug ] ?? 999 );
	}
);

$homeboy_template_part_ids = array();
$homeboy_has_query         = false;
$homeboy_walk_blocks       = static function ( $homeboy_blocks ) use ( &$homeboy_walk_blocks, &$homeboy_template_part_ids, &$homeboy_has_query ) {
	foreach ( $homeboy_blocks as $homeboy_block ) {
		if ( 'core/template-part' === ( $homeboy_block['blockName'] ?? '' ) && ! empty( $homeboy_block['attrs']['slug'] ) ) {
			$homeboy_theme             = ! empty( $homeboy_block['attrs']['theme'] ) ? $homeboy_block['attrs']['theme'] : get_stylesheet();
			$homeboy_template_part_ids[] = $homeboy_theme . '//' . $homeboy_block['attrs']['slug'];
		}

		if ( 'core/query' === ( $homeboy_block['blockName'] ?? '' ) ) {
			$homeboy_has_query = true;
		}

		if ( ! empty( $homeboy_block['innerBlocks'] ) ) {
			$homeboy_walk_blocks( $homeboy_block['innerBlocks'] );
		}
	}
};

if ( ! empty( $homeboy_templates ) && ! empty( $homeboy_templates[0]->content ) ) {
	$homeboy_blocks = parse_blocks( $homeboy_templates[0]->content );
	if ( function_exists( 'resolve_pattern_blocks' ) ) {
		$homeboy_blocks = resolve_pattern_blocks( $homeboy_blocks );
	}
	$homeboy_walk_blocks( $homeboy_blocks );
}

foreach ( array_unique( $homeboy_template_part_ids ) as $homeboy_template_part_id ) {
	$preload_paths[] = '/wp/v2/template-parts/' . $homeboy_template_part_id . '?context=edit';
}

if ( $homeboy_front_page instanceof WP_Post ) {
	$homeboy_route_for_front_page = rest_get_route_for_post( $homeboy_front_page );
	if ( $homeboy_route_for_front_page ) {
		$preload_paths[] = add_query_arg( 'context', 'edit', $homeboy_route_for_front_page );
	}
	$preload_paths[] = add_query_arg(
		'slug',
		empty( $homeboy_front_page->post_name ) ? 'page' : 'page-' . $homeboy_front_page->post_name,
		'/wp/v2/templates/lookup'
	);
	$preload_paths[] = '/wp/v2/types/page?context=edit';
}

if ( $homeboy_has_query ) {
	$homeboy_post_rest_route = rest_get_route_for_post_type_items( 'post' );
	foreach ( array( 10, 3 ) as $homeboy_per_page ) {
		$preload_paths[] = add_query_arg(
			array(
				'context'       => 'edit',
				'offset'        => 0,
				'order'         => 'desc',
				'orderby'       => 'date',
				'per_page'      => $homeboy_per_page,
				'ignore_sticky' => 'false',
			),
			$homeboy_post_rest_route
		);
	}
}

$preload_paths[] = '/wp/v2/taxonomies?context=view';
// ${PRELOAD_MARKER}: end
`;
	} else if (mode === 'pr-11766') {
		patch = PR_11766_PRELOAD_BLOCK;
	} else {
		patch = `
// ${PRELOAD_MARKER}: begin
foreach ( get_block_templates( array(), 'wp_template_part' ) as $homeboy_template_part ) {
	$preload_paths[] = '/wp/v2/template-parts/' . $homeboy_template_part->id . '?context=edit';
}

$homeboy_post_rest_route = rest_get_route_for_post_type_items( 'post' );
foreach ( array( 10, 3 ) as $homeboy_per_page ) {
	$preload_paths[] = add_query_arg(
		array(
			'context'       => 'edit',
			'offset'        => 0,
			'order'         => 'desc',
			'orderby'       => 'date',
			'per_page'      => $homeboy_per_page,
			'ignore_sticky' => 'false',
		),
		$homeboy_post_rest_route
	);
}

$preload_paths[] = '/wp/v2/taxonomies?context=view';
// ${PRELOAD_MARKER}: end
`;
	}

	if (!source.includes(needle)) {
		throw new Error('site-editor.php preload call not found');
	}

  const extraLines = [
    ...preloadLinesFromJsonEnv('HOMEBOY_SITE_EDITOR_EXTRA_PRELOAD_PATHS_JSON'),
    ...dynamicPreloadLines(),
  ];
  if (extraLines.length > 0) {
    patch += `
// ${PRELOAD_MARKER}_EXTRA: begin
${extraLines.join('\n')}
// ${PRELOAD_MARKER}_EXTRA: end
`;
  }

  return source.replace(needle, `${patch}\n${needle}`);
}

export async function installSiteEditorPreloadCandidate(sitePath, options = {}) {
  const file = path.join(sitePath, 'wp-admin/site-editor.php');
  const source = await readFile(file, 'utf8');
  await writeFile(file, installSiteEditorPreloadCandidateSource(source, options));
}

// Injects a snapshot of the final $preload_paths array to a JSON file right
// before block_editor_rest_api_preload() runs. Install the candidate FIRST so
// the capture observes the post-candidate preload set; install capture-only on
// the baseline site to record the default WordPress preload set for comparison.
export function installSiteEditorPreloadCaptureSource(source, { capturePath } = {}) {
  if (!capturePath || source.includes(CAPTURE_MARKER)) {
    return source;
  }
  const needle = 'block_editor_rest_api_preload( $preload_paths, $block_editor_context );';
  if (!source.includes(needle)) {
    throw new Error('site-editor.php preload call not found');
  }
  const capture = `
// ${CAPTURE_MARKER}: begin
@file_put_contents( ${quotePhpString(capturePath)}, wp_json_encode( array_values( array_unique( $preload_paths ) ) ) );
// ${CAPTURE_MARKER}: end
`;
  return source.replace(needle, `${capture}\n${needle}`);
}

export async function installSiteEditorPreloadCapture(sitePath, options = {}) {
  const file = path.join(sitePath, 'wp-admin/site-editor.php');
  const source = await readFile(file, 'utf8');
  await writeFile(file, installSiteEditorPreloadCaptureSource(source, options));
}

function normalizePreloadEntry(entry) {
  if (typeof entry === 'string') {
    return { path: entry, method: 'GET' };
  }
  if (Array.isArray(entry) && typeof entry[0] === 'string') {
    return { path: entry[0], method: String(entry[1] || 'GET').toUpperCase() };
  }
  if (entry && typeof entry === 'object' && typeof entry.path === 'string') {
    return { path: entry.path, method: String(entry.method || 'GET').toUpperCase() };
  }
  return null;
}

export async function collectPreloadedRestPaths(capturePath) {
  let raw;
  try {
    raw = await readFile(capturePath, 'utf8');
  } catch {
    return [];
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(data)) {
    return [];
  }
  return data.map(normalizePreloadEntry).filter(Boolean);
}

// Normalize a REST URL/path (preloaded or client-fetched) to a comparable shape.
// Strips the /wp-json root, decodes percent-encoding (e.g. the `//` in template
// part IDs), drops client-only query args (_locale, _method), and sorts the rest.
export function normalizeRestEntry(raw, defaultMethod = 'GET') {
  if (!raw) {
    return null;
  }
  let pathStr;
  let method = defaultMethod;
  if (typeof raw === 'string') {
    pathStr = raw;
  } else if (typeof raw === 'object') {
    pathStr = raw.path || raw.url || raw.uri || '';
    method = raw.method || defaultMethod;
  } else {
    return null;
  }
  if (!pathStr) {
    return null;
  }
  let parsed;
  try {
    parsed = new URL(pathStr, 'http://site-editor-preload.local');
  } catch {
    return null;
  }
  let pathname = decodeURIComponent(parsed.pathname || '/');
  pathname = pathname.replace(/^\/+wp-json\/?/, '/');
  if (!pathname.startsWith('/')) {
    pathname = `/${pathname}`;
  }
  const params = new URLSearchParams(parsed.search || '');
  params.delete('_locale');
  params.delete('_method');
  return {
    pathname,
    params,
    method: String(method || 'GET').toUpperCase(),
    raw: pathStr,
  };
}

function restEntriesMatch(preload, client) {
  if (!preload || !client) {
    return false;
  }
  if (preload.method !== client.method) {
    return false;
  }
  if (preload.pathname !== client.pathname) {
    return false;
  }
  // Subset match: every preload query arg must be present on the client fetch
  // with the same value, so a preloaded response actually satisfies the request.
  for (const key of preload.params.keys()) {
    if (client.params.get(key) !== preload.params.get(key)) {
      return false;
    }
  }
  return true;
}

// For each server-side preloaded REST path, decides whether any client fetch
// (apiFetch attempt, falling back to network REST requests) consumed it.
export function classifyPreloadHitWaste({ preloaded, attempts = [], networkRequests = [] }) {
  const clients = []
    .concat(attempts || [])
    .concat(networkRequests || [])
    .map((entry) => normalizeRestEntry(entry))
    .filter(Boolean);
  const rows = (preloaded || []).map((item) => {
    const normalizedPreload = normalizeRestEntry(item);
    const match = normalizedPreload
      ? clients.find((client) => restEntriesMatch(normalizedPreload, client))
      : null;
    return {
      path: typeof item === 'string' ? item : item?.path,
      method: normalizedPreload?.method || (item?.method) || 'GET',
      consumed: Boolean(match),
      matched_client_url: match?.raw || null,
    };
  });
  const consumed = rows.filter((row) => row.consumed).length;
  return {
    rows,
    preloaded: rows.length,
    consumed,
    wasted: rows.length - consumed,
  };
}

function slowResourceFingerprint(resource) {
  return {
    url: resource.url,
    duration_ms: round(resource.durationMs),
    ttfb_ms: round(resource.ttfbMs),
  };
}

function round(value) {
  return typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : 0;
}

export function buildSiteEditorPreloadComparison({ baseline, candidate }) {
  const baselineMeasure = baseline?.measure?.readyMs || 0;
  const candidateMeasure = candidate?.measure?.readyMs || 0;
  const delta = candidateMeasure - baselineMeasure;
  const deltaPct = baselineMeasure > 0 ? (delta / baselineMeasure) * 100 : 0;

  return {
    baseline_measure_ms: round(baselineMeasure),
    candidate_measure_ms: round(candidateMeasure),
    delta_ms: round(delta),
    delta_pct: Math.round(deltaPct * 10) / 10,
    baseline_warmup_ms: round(baseline?.warmup?.readyMs),
    candidate_warmup_ms: round(candidate?.warmup?.readyMs),
    baseline_measure_resource_count: baseline?.measure?.resources?.count || 0,
    candidate_measure_resource_count: candidate?.measure?.resources?.count || 0,
    baseline_slowest_measure_resources: (baseline?.measure?.resources?.slowest || []).map(slowResourceFingerprint),
    candidate_slowest_measure_resources: (candidate?.measure?.resources?.slowest || []).map(slowResourceFingerprint),
    baseline_status: baseline?.measure?.status || 0,
    candidate_status: candidate?.measure?.status || 0,
  };
}

function botPathFingerprint(botPath) {
  const measureMs = botPath?.measure?.readyMs || 0;
  const restNetworkCount = botPath?.restNetworkCount || 0;
  const preloaded = botPath?.classification?.preloaded || 0;
  const consumed = botPath?.classification?.consumed || 0;
  const wasted = botPath?.classification?.wasted || 0;
  const status = botPath?.measure?.status || 0;
  return { measureMs, restNetworkCount, preloaded, consumed, wasted, status };
}

// Per-scenario roll-up that makes the wp_is_block_theme() guard decision legible
// at a glance: for each theme scenario it reports the candidate's wasted-preload
// count and the candidate-vs-baseline measure-time delta.
export function buildClassicThemePreloadRollUp(scenarios) {
  const list = Array.isArray(scenarios) ? scenarios : Object.values(scenarios || {});
  return list.map((scenario) => {
    const baseline = botPathFingerprint(scenario?.baseline);
    const candidate = botPathFingerprint(scenario?.candidate);
    const deltaMs = candidate.measureMs - baseline.measureMs;
    const deltaPct = baseline.measureMs > 0 ? (deltaMs / baseline.measureMs) * 100 : 0;
    return {
      scenario: scenario?.id,
      theme: scenario?.theme,
      is_block_theme: Boolean(scenario?.isBlockTheme),
      block_template_parts: Boolean(scenario?.blockTemplateParts),
      baseline_preloaded: baseline.preloaded,
      candidate_preloaded: candidate.preloaded,
      candidate_consumed: candidate.consumed,
      candidate_wasted: candidate.wasted,
      baseline_wasted: baseline.wasted,
      baseline_measure_ms: round(baseline.measureMs),
      candidate_measure_ms: round(candidate.measureMs),
      delta_ms: round(deltaMs),
      delta_pct: Math.round(deltaPct * 10) / 10,
      baseline_rest_network_count: baseline.restNetworkCount,
      candidate_rest_network_count: candidate.restNetworkCount,
      rest_network_delta: candidate.restNetworkCount - baseline.restNetworkCount,
      baseline_status: baseline.status,
      candidate_status: candidate.status,
    };
  });
}

export function formatClassicThemePreloadRollUpMarkdown(rollUp) {
  const rows = Array.isArray(rollUp) ? rollUp : [];
  const header = [
    'scenario',
    'theme',
    'block theme',
    'cand preloaded',
    'cand consumed',
    'cand wasted',
    'base measure ms',
    'cand measure ms',
    'delta ms',
    'delta %',
    'rest net delta',
  ];
  const lines = [
    `| ${header.join(' | ')} |`,
    `| ${header.map(() => '---:').join(' | ')} |`,
  ];
  for (const row of rows) {
    lines.push([
      row.scenario,
      row.theme,
      row.is_block_theme ? 'yes' : 'no',
      row.candidate_preloaded,
      row.candidate_consumed,
      row.candidate_wasted,
      row.baseline_measure_ms,
      row.candidate_measure_ms,
      row.delta_ms > 0 ? `+${row.delta_ms}` : String(row.delta_ms),
      row.delta_pct > 0 ? `+${row.delta_pct}` : String(row.delta_pct),
      row.rest_network_delta > 0 ? `+${row.rest_network_delta}` : String(row.rest_network_delta),
    ].join(' | '));
    lines[lines.length - 1] = `| ${lines[lines.length - 1]} |`;
  }
  return lines.join('\n');
}
