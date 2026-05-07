import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const PRELOAD_MARKER = 'HOMEBOY_SITE_EDITOR_PRELOAD_CANDIDATE';

export function installSiteEditorPreloadCandidateSource(source) {
  if (source.includes(PRELOAD_MARKER)) {
    return source;
  }

  const needle = 'block_editor_rest_api_preload( $preload_paths, $block_editor_context );';
  const patch = `
// ${PRELOAD_MARKER}: begin
foreach ( get_block_templates( array(), 'wp_template_part' ) as $homeboy_template_part ) {
	if ( ! empty( $homeboy_template_part->id ) ) {
		$preload_paths[] = '/wp/v2/template-parts/' . $homeboy_template_part->id . '?context=edit';
	}
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

  if (!source.includes(needle)) {
    throw new Error('site-editor.php preload call not found');
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
    duration_ms: round(resource.duration_ms),
    ttfb_ms: round(resource.ttfb_ms),
  };
}

export function buildSiteEditorPreloadComparison({ baseline, candidate }) {
  const baselineMeasure = baseline?.measure?.duration_ms || 0;
  const candidateMeasure = candidate?.measure?.duration_ms || 0;
  const delta = candidateMeasure - baselineMeasure;
  const deltaPct = baselineMeasure > 0 ? (delta / baselineMeasure) * 100 : 0;

  return {
    baseline_measure_ms: round(baselineMeasure),
    candidate_measure_ms: round(candidateMeasure),
    delta_ms: round(delta),
    delta_pct: Math.round(deltaPct * 10) / 10,
    baseline_warmup_ms: round(baseline?.warmup?.duration_ms),
    candidate_warmup_ms: round(candidate?.warmup?.duration_ms),
    baseline_measure_resource_count: baseline?.measure?.resourceTimings?.length || 0,
    candidate_measure_resource_count: candidate?.measure?.resourceTimings?.length || 0,
    baseline_slowest_measure_resources: (baseline?.measure?.resourceTimings || [])
      .slice(0, 10)
      .map(slowResourceFingerprint),
    candidate_slowest_measure_resources: (candidate?.measure?.resourceTimings || [])
      .slice(0, 10)
      .map(slowResourceFingerprint),
    baseline_status: baseline?.measure?.status || 0,
    candidate_status: candidate?.measure?.status || 0,
  };
}
