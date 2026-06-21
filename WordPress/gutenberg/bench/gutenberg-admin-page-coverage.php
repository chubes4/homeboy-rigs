<?php
/**
 * Bounded read-only wp-admin/editor page enumeration for Gutenberg.
 */
return function (): array {
	$limit = max( 1, min( 80, (int) ( getenv( 'GUTENBERG_ADMIN_PAGE_COVERAGE_LIMIT' ) ?: 40 ) ) );

	if ( ! file_exists( WP_PLUGIN_DIR . '/gutenberg/gutenberg.php' ) ) {
		throw new RuntimeException( 'Gutenberg plugin entrypoint is not mounted.' );
	}

	$normalize_admin_url = static function ( string $page ): string {
		if ( preg_match( '#^https?://#', $page ) ) {
			return $page;
		}
		if ( false !== strpos( $page, '.php' ) ) {
			return admin_url( ltrim( $page, '/' ) );
		}
		return admin_url( 'admin.php?page=' . rawurlencode( $page ) );
	};

	$unsafe_reasons = static function ( string $url ): array {
		$parts = wp_parse_url( $url );
		$path  = isset( $parts['path'] ) ? basename( $parts['path'] ) : '';
		parse_str( $parts['query'] ?? '', $query );
		$reasons = array();

		if ( in_array( $path, array( 'plugin-install.php', 'update-core.php', 'import.php', 'export.php', 'theme-install.php' ), true ) ) {
			$reasons[] = 'install_update_import_export_screen';
		}
		foreach ( array( 'action', 'action2', 'delete', 'trash', 'untrash', 'activate', 'deactivate', 'reset' ) as $key ) {
			if ( isset( $query[ $key ] ) ) {
				$reasons[] = 'unsafe_query_arg_' . $key;
			}
		}
		if ( isset( $query['_wpnonce'] ) ) {
			$reasons[] = 'nonce_action_url';
		}

		return array_values( array_unique( $reasons ) );
	};

	wp_set_current_user( get_current_user_id() ?: 1 );
	require_once ABSPATH . 'wp-admin/includes/admin.php';
	if ( file_exists( ABSPATH . 'wp-admin/menu.php' ) ) {
		require ABSPATH . 'wp-admin/menu.php';
	} elseif ( ! did_action( 'admin_menu' ) ) {
		do_action( 'admin_menu', '' );
	}

	global $menu, $submenu;
	$candidates = array(
		'editor-post-new'       => array( 'label' => 'Post editor', 'page' => 'post-new.php', 'surface' => 'post_editor' ),
		'editor-page-new'       => array( 'label' => 'Page editor', 'page' => 'post-new.php?post_type=page', 'surface' => 'post_editor' ),
		'site-editor'           => array( 'label' => 'Site Editor', 'page' => 'site-editor.php', 'surface' => 'site_editor' ),
		'template-editor'       => array( 'label' => 'Template editor', 'page' => 'site-editor.php?postType=wp_template', 'surface' => 'template_editor' ),
		'pattern-browser'       => array( 'label' => 'Pattern browser', 'page' => 'site-editor.php?p=%2Fpatterns', 'surface' => 'patterns' ),
		'pattern-management'    => array( 'label' => 'Pattern management', 'page' => 'edit.php?post_type=wp_block', 'surface' => 'patterns' ),
		'template-part-browser' => array( 'label' => 'Template parts', 'page' => 'site-editor.php?postType=wp_template_part', 'surface' => 'template_editor' ),
	);

	$add_candidate = static function ( string $source, array $item ) use ( &$candidates ): void {
		$page = isset( $item[2] ) ? (string) $item[2] : '';
		if ( '' === $page || false !== strpos( $page, 'separator' ) ) {
			return;
		}
		$key = $source . ':' . $page;
		$candidates[ $key ] = array(
			'label'      => isset( $item[0] ) ? wp_strip_all_tags( (string) $item[0] ) : '',
			'capability' => isset( $item[1] ) ? (string) $item[1] : '',
			'page'       => $page,
			'surface'    => 'wp_admin_menu',
			'source'     => $source,
		);
	};
	foreach ( (array) $menu as $item ) {
		$add_candidate( 'menu', (array) $item );
	}
	foreach ( (array) $submenu as $parent => $items ) {
		foreach ( (array) $items as $item ) {
			$add_candidate( 'submenu:' . (string) $parent, (array) $item );
		}
	}

	$targets = array();
	$skipped = array();
	foreach ( $candidates as $id => $candidate ) {
		$url = $normalize_admin_url( (string) $candidate['page'] );
		$row = array_merge( $candidate, array( 'id' => (string) $id, 'url' => $url ) );
		$reasons = $unsafe_reasons( $url );
		if ( $reasons ) {
			$skipped[] = array_merge( $row, array( 'status' => 'skipped', 'reasons' => $reasons ) );
			continue;
		}
		$targets[] = $row;
		if ( count( $targets ) >= $limit ) {
			break;
		}
	}

	$skipped_reason_codes = array();
	foreach ( $skipped as $row ) {
		$skipped_reason_codes = array_merge( $skipped_reason_codes, (array) ( $row['reasons'] ?? array() ) );
	}

	$artifact = array(
		'schema'               => 'homeboy-rigs/gutenberg-admin-page-coverage/v1',
		'limit'                => $limit,
		'targets'              => $targets,
		'skipped'              => $skipped,
		'skipped_reason_codes' => array_values( array_unique( $skipped_reason_codes ) ),
		'surfaces'             => array_values( array_unique( array_column( $targets, 'surface' ) ) ),
	);

	$artifact_path = '';
	$shared_state  = getenv( 'HOMEBOY_BENCH_SHARED_STATE' );
	if ( $shared_state ) {
		$artifact_dir = rtrim( $shared_state, '/' ) . '/gutenberg-admin-page-coverage';
		wp_mkdir_p( $artifact_dir );
		$artifact_path = $artifact_dir . '/admin-page-coverage.json';
		file_put_contents( $artifact_path, wp_json_encode( $artifact, JSON_PRETTY_PRINT ) . "\n" );
	}

	return array(
		'metrics'   => array(
			'enumerated_admin_url_count'   => count( $candidates ),
			'covered_admin_url_count'      => count( $targets ),
			'skipped_destructive_url_count' => count( $skipped ),
		),
		'metadata'  => array(
			'runner'               => 'wp-codebox',
			'workload'             => 'gutenberg-admin-page-coverage',
			'safety_class'         => 'read_only',
			'skipped_reason_codes' => $artifact['skipped_reason_codes'],
		),
		'artifacts' => $artifact_path ? array( 'gutenberg_admin_page_coverage' => array( 'path' => $artifact_path, 'kind' => 'json' ) ) : array(),
	);
};
