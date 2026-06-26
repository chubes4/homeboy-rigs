import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire( import.meta.url );

function loadBrowserCoverageHelper() {
	const explicit = process.env.HOMEBOY_WP_CODEBOX_BROWSER_COVERAGE_HELPER;
	if ( explicit ) {
		return require( explicit );
	}

	const manifestPath = process.env.HOMEBOY_WORDPRESS_HELPER_MANIFEST;
	if ( manifestPath ) {
		const manifestModule = require( manifestPath );
		const manifest = typeof manifestModule.getWordPressHelperManifest === 'function'
			? manifestModule.getWordPressHelperManifest()
			: manifestModule.WORDPRESS_HELPER_MANIFEST;
		if ( manifest?.extensionRoot ) {
			return require( path.join( manifest.extensionRoot, 'lib', 'wp-codebox-browser-coverage.js' ) );
		}
	}

	return require( 'homeboy-extension-wordpress/wp-codebox-browser-coverage' );
}

export async function runBrowserCoverageTrace( config ) {
	return loadBrowserCoverageHelper().runWpCodeboxBrowserCoverageTrace( config );
}
