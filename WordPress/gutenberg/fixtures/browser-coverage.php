<?php
$post_id = wp_insert_post(
	array(
		'post_title'   => 'Gutenberg fuzz rendering fixture',
		'post_name'    => 'gutenberg-fuzz-rendering-fixture',
		'post_status'  => 'publish',
		'post_type'    => 'page',
		'post_content' => '<!-- wp:paragraph --><p>Gutenberg fuzz rendering fixture.</p><!-- /wp:paragraph -->',
	)
);

if ( is_wp_error( $post_id ) ) {
	throw new RuntimeException( $post_id->get_error_message() );
}

update_option( 'show_on_front', 'page' );
update_option( 'page_on_front', $post_id );
flush_rewrite_rules();
