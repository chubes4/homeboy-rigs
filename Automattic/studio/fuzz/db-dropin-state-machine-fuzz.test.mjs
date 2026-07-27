import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const packageRoot = path.resolve( path.dirname( fileURLToPath( import.meta.url ) ), '..' );
const manifestPath = path.join( packageRoot, 'fuzz/db-dropin-state-machine-fuzz.json' );
const rigPath = path.join( packageRoot, 'rigs/studio-db-dropin-fuzz/rig.json' );

test( 'Studio db.php fuzz workload is wired through its owning rig', () => {
  const manifest = JSON.parse( fs.readFileSync( manifestPath, 'utf8' ) );
  const importManifest = JSON.parse(
    fs.readFileSync( path.join( packageRoot, 'fuzz/import-db-dropin-pr-4356-fuzz.json' ), 'utf8' )
  );
  const rig = JSON.parse( fs.readFileSync( rigPath, 'utf8' ) );

  assert.equal( manifest.schema, 'homeboy/fuzz-workload/v1' );
  assert.equal( manifest.safety_class, 'isolated_mutation' );
  assert.equal( manifest.case_budget, 84 );
  assert.equal( manifest.metadata.tracker, 'github_issue:Automattic/studio#4355' );
  assert.deepEqual( rig.fuzz_profiles.provider, [ manifest.id ] );
  assert.deepEqual( rig.fuzz_profiles[ 'pr-4356' ], [ 'import-db-dropin-pr-4356-fuzz' ] );
  assert.match( rig.fuzz_workloads.nodejs[ 0 ].path, /db-dropin-state-machine-fuzz\.json$/ );
  assert.match( rig.fuzz_workloads.nodejs[ 1 ].path, /import-db-dropin-pr-4356-fuzz\.json$/ );
  assert.equal( manifest.operations.length, 4 );
  assert.equal( manifest.metadata.dimensions.length, 6 );
  assert.equal( importManifest.case_budget, 19 );
  assert.equal( importManifest.metadata.tracker, 'github_pr:Automattic/studio#4356' );
  assert.equal( importManifest.metadata.dimensions.length, 7 );
} );
