import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const PRELOAD_MARKER = 'HOMEBOY_SITE_EDITOR_PRELOAD_CANDIDATE';

function phpString(value) {
  return `'${String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

function extraPreloadDeclaration(entry) {
  if (typeof entry === 'string') {
    return `$preload_paths[] = ${phpString(entry)};`;
  }
  if (!entry || typeof entry !== 'object' || typeof entry.path !== 'string') {
    throw new Error('extra preload entries must be strings or objects with a path string');
  }
  const method = String(entry.method || 'GET').toUpperCase();
  if (method === 'GET') {
    return `$preload_paths[] = ${phpString(entry.path)};`;
  }
  return `$preload_paths[] = array( ${phpString(entry.path)}, ${phpString(method)} );`;
}

function extraPreloadPatch() {
  const raw = process.env.HOMEBOY_SITE_EDITOR_EXTRA_PRELOAD_PATHS_JSON;
  const entries = raw ? JSON.parse(raw) : [];
  if (!Array.isArray(entries)) {
    throw new Error('HOMEBOY_SITE_EDITOR_EXTRA_PRELOAD_PATHS_JSON must be an array');
  }
  if (entries.length === 0 && process.env.HOMEBOY_SITE_EDITOR_PRELOAD_NAVIGATION_FALLBACK !== '1') {
    return '';
  }

  const lines = [
    `// ${PRELOAD_MARKER}_EXTRA: begin`,
    ...entries.map(extraPreloadDeclaration),
  ];
  if (process.env.HOMEBOY_SITE_EDITOR_PRELOAD_NAVIGATION_FALLBACK === '1') {
    lines.push(
      "$homeboy_navigation_fallback = class_exists( 'WP_Navigation_Fallback' ) ? WP_Navigation_Fallback::get_fallback() : null;",
      'if ( $homeboy_navigation_fallback instanceof WP_Post ) {',
      "\t$preload_paths[] = '/wp/v2/navigation/' . $homeboy_navigation_fallback->ID . '?context=edit';",
      '}'
    );
  }
  lines.push(`// ${PRELOAD_MARKER}_EXTRA: end`);
  return lines.join('\n');
}

export function installSiteEditorPreloadCandidateSource(source) {
	if (source.includes(PRELOAD_MARKER)) {
		return source;
	}

	const needle = 'block_editor_rest_api_preload( $preload_paths, $block_editor_context );';
	const mode = process.env.HOMEBOY_SITE_EDITOR_PRELOAD_MODE || 'broad';
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

  const extraPatch = extraPreloadPatch();
  if (extraPatch) {
    patch += `\n${extraPatch}\n`;
  }

  return source.replace(needle, `${patch}\n${needle}`);
}

export async function installSiteEditorPreloadCandidate(sitePath) {
  const file = path.join(sitePath, 'wp-admin/site-editor.php');
  const source = await readFile(file, 'utf8');
  await writeFile(file, installSiteEditorPreloadCandidateSource(source));
}

function round(value) {
  return typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : 0;
}

function slowResourceFingerprint(resource) {
  return {
    url: resource.url,
    duration_ms: round(resource.durationMs),
    ttfb_ms: round(resource.ttfbMs),
  };
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
