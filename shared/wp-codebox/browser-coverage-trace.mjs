import { loadWordPressHelperModule } from '../wordpress-helper-loader.mjs';

function loadBrowserCoverageHelper() {
	return loadWordPressHelperModule( {
		helperName: 'wp-codebox-browser-coverage',
		manifestFileName: 'wp-codebox-browser-coverage.js',
	} );
}

export async function runBrowserCoverageTrace( config ) {
	return loadBrowserCoverageHelper().runWpCodeboxBrowserCoverageTrace( config );
}
