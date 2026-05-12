import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

const MARKER = 'HOMEBOY_BOOTSTRAP_TIMELINE';
const ARTIFACT_RELATIVE_PATH = 'wp-content/homeboy-bootstrap-timeline.jsonl';
const BACKUP_DIR_RELATIVE_PATH = 'wp-content/homeboy-bootstrap-timeline-backups';

const BOOTSTRAP_MARKS = [
  {
    search: "require_wp_db();",
    event: 'wp-settings.after_require_wp_db',
  },
  {
    search: "wp_start_object_cache();",
    event: 'wp-settings.after_object_cache',
  },
  {
    search: "require ABSPATH . WPINC . '/default-filters.php';",
    event: 'wp-settings.after_default_filters',
  },
  {
    search: "register_shutdown_function( 'shutdown_action_hook' );",
    event: 'wp-settings.after_shutdown_hook',
  },
  {
    search: "require_once ABSPATH . WPINC . '/class-wp-locale-switcher.php';",
    event: 'wp-settings.after_l10n_library',
  },
  {
    search: 'wp_not_installed();',
    event: 'wp-settings.after_not_installed_check',
  },
  {
    search: '// Load most of WordPress.',
    event: 'wp-settings.before_load_most',
    before: true,
  },
  {
    search: "require ABSPATH . WPINC . '/post.php';",
    event: 'wp-settings.after_post_core',
  },
  {
    search: "require ABSPATH . WPINC . '/rest-api.php';",
    event: 'wp-settings.after_rest_api_base',
  },
  {
    search: "require ABSPATH . WPINC . '/rest-api/endpoints/class-wp-rest-navigation-fallback-controller.php';",
    event: 'wp-settings.after_rest_controllers',
  },
  {
    search: "require ABSPATH . WPINC . '/blocks/index.php';",
    event: 'wp-settings.after_blocks_index',
  },
  {
    search: "require ABSPATH . WPINC . '/speculative-loading.php';",
    event: 'wp-settings.after_load_most',
  },
  {
    search: 'wp_plugin_directory_constants();',
    event: 'wp-settings.after_plugin_directory_constants',
  },
  {
    search: 'unset( $mu_plugin, $_wp_plugin_file );',
    event: 'wp-settings.after_mu_plugins_included',
  },
  {
    search: "do_action( 'muplugins_loaded' );",
    event: 'wp-settings.after_muplugins_loaded',
  },
];

function bootstrapArtifactPath(sitePath) {
  return path.join(sitePath, ARTIFACT_RELATIVE_PATH);
}

function backupPath(sitePath, fileName) {
  return path.join(sitePath, BACKUP_DIR_RELATIVE_PATH, `${fileName}.bak`);
}

function indexInstrumentation() {
  return `
/* ${MARKER}: begin */
$GLOBALS['homeboy_bootstrap_timeline_start'] = microtime( true );
$GLOBALS['homeboy_bootstrap_timeline_id'] = function_exists( 'random_bytes' ) ? bin2hex( random_bytes( 8 ) ) : uniqid( '', true );
$GLOBALS['homeboy_bootstrap_timeline_uri'] = $_SERVER['REQUEST_URI'] ?? '';
$GLOBALS['homeboy_bootstrap_timeline_method'] = $_SERVER['REQUEST_METHOD'] ?? '';
$GLOBALS['homeboy_bootstrap_timeline_file'] = __DIR__ . '/${ARTIFACT_RELATIVE_PATH}';
if ( ! function_exists( 'homeboy_bootstrap_timeline_record' ) ) {
	function homeboy_bootstrap_timeline_record( $event ) {
		$start = $GLOBALS['homeboy_bootstrap_timeline_start'] ?? null;
		$file = $GLOBALS['homeboy_bootstrap_timeline_file'] ?? null;
		if ( ! $start || ! $file ) {
			return;
		}
		$line = json_encode(
				array(
					'event'      => $event,
					'request_id' => $GLOBALS['homeboy_bootstrap_timeline_id'] ?? '',
					'uri'        => $GLOBALS['homeboy_bootstrap_timeline_uri'] ?? '',
					'method'     => $GLOBALS['homeboy_bootstrap_timeline_method'] ?? '',
					't_ms'       => ( microtime( true ) - $start ) * 1000,
					'time'       => microtime( true ),
				)
			) . "\\n";
		@file_put_contents( $file, $line, FILE_APPEND | LOCK_EX );
	}
}
homeboy_bootstrap_timeline_record( 'entry.start' );
register_shutdown_function( static function () {
	homeboy_bootstrap_timeline_record( 'entry.shutdown' );
} );
/* ${MARKER}: end */
`;
}

function wpSettingsInstrumentation() {
  return `
/* ${MARKER}: begin */
if ( ! function_exists( 'homeboy_bootstrap_timeline_mark' ) ) {
	function homeboy_bootstrap_timeline_mark( $event ) {
		if ( function_exists( 'homeboy_bootstrap_timeline_record' ) ) {
			homeboy_bootstrap_timeline_record( $event );
		}
	}
}
homeboy_bootstrap_timeline_mark( 'wp-settings.start' );
/* ${MARKER}: end */
`;
}

export function instrumentIndexPhp(source) {
  if (source.includes(MARKER)) {
    return source;
  }
  return source.replace('<?php', `<?php${indexInstrumentation()}`);
}

export function instrumentWpSettingsPhp(source) {
  if (source.includes(MARKER)) {
    return source;
  }
  let instrumented = source.replace('<?php', `<?php${wpSettingsInstrumentation()}`);
  for (const mark of BOOTSTRAP_MARKS) {
    const markerCall = `homeboy_bootstrap_timeline_mark( '${mark.event}' );`;
    if (!instrumented.includes(mark.search) || instrumented.includes(markerCall)) {
      continue;
    }
    instrumented = mark.before
      ? instrumented.replace(mark.search, `${markerCall}\n${mark.search}`)
      : instrumented.replace(mark.search, `${mark.search}\n${markerCall}`);
  }
  return instrumented;
}

async function backupAndWrite(sitePath, fileName, transform) {
  const filePath = path.join(sitePath, fileName);
  const backup = backupPath(sitePath, fileName);
  const source = await readFile(filePath, 'utf8');
  if (!existsSync(backup)) {
    await writeFile(backup, source);
  }
  await writeFile(filePath, transform(source));
}

export async function installWordPressBootstrapTimeline(sitePath, options = {}) {
  const artifactPath = bootstrapArtifactPath(sitePath);
  await mkdir(path.dirname(artifactPath), { recursive: true });
  await mkdir(path.join(sitePath, BACKUP_DIR_RELATIVE_PATH), { recursive: true });
  if (options.clearArtifact !== false) {
    await writeFile(artifactPath, '');
  }
  await backupAndWrite(sitePath, 'index.php', instrumentIndexPhp);
  await backupAndWrite(sitePath, 'wp-settings.php', instrumentWpSettingsPhp);
  return { artifactPath };
}

export async function uninstallWordPressBootstrapTimeline(sitePath) {
  for (const fileName of ['index.php', 'wp-settings.php']) {
    const backup = backupPath(sitePath, fileName);
    if (existsSync(backup)) {
      await writeFile(path.join(sitePath, fileName), await readFile(backup, 'utf8'));
    }
  }
  await rm(path.join(sitePath, BACKUP_DIR_RELATIVE_PATH), { recursive: true, force: true });
}

export async function collectWordPressBootstrapTimeline(sitePath) {
  const artifactPath = bootstrapArtifactPath(sitePath);
  if (!existsSync(artifactPath)) {
    return [];
  }
  const raw = await readFile(artifactPath, 'utf8');
  return raw
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

export function summarizeWordPressBootstrapTimeline(rows, options = {}) {
  const limit = Math.max(1, Number(options.limit ?? 40));
  const byRequest = new Map();
  for (const row of rows || []) {
    const id = row.request_id || 'unknown';
    if (!byRequest.has(id)) {
      byRequest.set(id, []);
    }
    byRequest.get(id).push(row);
  }

  return [...byRequest.values()]
    .map((events) => {
      events.sort((a, b) => (a.t_ms || 0) - (b.t_ms || 0));
      const last = events[events.length - 1] || {};
      let previous = 0;
      return {
        uri: last.uri || '',
        method: last.method || '',
        duration_ms: last.t_ms || 0,
        events: events.map((event) => {
          const delta = (event.t_ms || 0) - previous;
          previous = event.t_ms || 0;
          return {
            event: event.event,
            t_ms: event.t_ms || 0,
            delta_from_previous_ms: delta,
          };
        }),
      };
    })
    .sort((a, b) => b.duration_ms - a.duration_ms)
    .slice(0, limit);
}
