import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(readFileSync(path.join(__dirname, 'scale-profiles.json'), 'utf8'));

const hbexScaleProfileSchema = 'homeboy/wordpress-workload-scale-profile/v1';
const knownHbexDimensionIds = new Set([
  'catalog-content-volume',
  'resource-volume',
  'taxonomy-density',
  'meta-density',
  'option-pollution',
  'transient-pollution',
  'queue-backlog',
  'media-volume',
  'account-volume',
  'admin-list-table-scale',
  'rest-collection-scale',
]);

const requiredProfileIds = new Set([
  'woo-large-catalog',
  'woo-many-variations',
  'woo-hpos-high-order-history',
  'woo-customer-volume',
  'woo-coupon-volume',
  'woo-layered-nav-attributes',
  'woo-shipping-tax-zones',
  'woo-action-scheduler-backlog',
  'woo-polluted-options-transients',
  'woo-admin-list-table-scale',
  'woo-rest-pagination-search-filter-scale',
]);

function assertPlainObject(value, field) {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value), `${field} must be an object`);
}

test('Woo scale profiles expose HBEX-compatible workload scale profile schema', () => {
  assert.equal(manifest.schema, 'homeboy-rigs/woocommerce-scale-profiles/v1');
  assert.equal(manifest.hbex_scale_profile_schema, hbexScaleProfileSchema);
  assert.ok(Array.isArray(manifest.profiles), 'manifest.profiles must be an array');
  assert.ok(manifest.profiles.length >= requiredProfileIds.size, 'manifest must declare every required Woo scale profile');

  const profileIds = new Set(manifest.profiles.map((profile) => profile.id));
  assert.deepEqual(profileIds, requiredProfileIds);

  for (const profile of manifest.profiles) {
    assert.equal(typeof profile.id, 'string', 'profile.id must be a string');
    assert.equal(typeof profile.label, 'string', `${profile.id}.label must be a string`);
    assert.equal(typeof profile.intent, 'string', `${profile.id}.intent must be a string`);

    const scaleProfile = profile.workload_scale_profile;
    assertPlainObject(scaleProfile, `${profile.id}.workload_scale_profile`);
    assert.equal(scaleProfile.schema, hbexScaleProfileSchema, `${profile.id} must feed the HBEX generic scale profile schema`);
    assert.equal(scaleProfile.id, profile.id, `${profile.id} scale profile id must match the owning Woo profile`);
      assert.ok(Array.isArray(scaleProfile.dimensions), `${profile.id}.dimensions must be an array`);
      assert.ok(scaleProfile.dimensions.length > 0, `${profile.id} must declare at least one dimension`);
    assert.ok(JSON.stringify(scaleProfile).includes('woo') || JSON.stringify(scaleProfile).includes('wc_'), `${profile.id} must stay scoped to Woo-owned targets or values`);
  }
});

test('all Woo profile dimensions map to known HBEX generic WordPress scale dimension ids', () => {
  for (const profile of manifest.profiles) {
    for (const [index, dimension] of profile.workload_scale_profile.dimensions.entries()) {
      const field = `${profile.id}.dimensions[${index}]`;
      assertPlainObject(dimension, field);
      assert.equal(typeof dimension.id, 'string', `${field}.id must be a string`);
      assert.equal(dimension.category, dimension.dimension_id, `${field}.category must be the generic HBEX dimension id`);
      assert.ok(knownHbexDimensionIds.has(dimension.dimension_id), `${field}.dimension_id must be a known HBEX generic scale dimension id`);
      assert.equal(dimension.executable_state, 'plan-only', `${field} must not claim executable generic generation`);
      assertPlainObject(dimension.target, `${field}.target`);
      assertPlainObject(dimension.values, `${field}.values`);
      assert.ok(Object.keys(dimension.values).length > 0, `${field}.values must provide Woo-specific scale values`);
    }
  }
});

test('Woo scale profile dimensions cover the requested production scale surfaces', () => {
  const dimensionsByProfile = new Map(
    manifest.profiles.map((profile) => [
      profile.id,
      new Set(profile.workload_scale_profile.dimensions.map((dimension) => dimension.dimension_id)),
    ])
  );

  assert.ok(dimensionsByProfile.get('woo-large-catalog').has('catalog-content-volume'));
  assert.ok(dimensionsByProfile.get('woo-many-variations').has('resource-volume'));
  assert.ok(dimensionsByProfile.get('woo-many-variations').has('meta-density'));
  assert.ok(dimensionsByProfile.get('woo-hpos-high-order-history').has('resource-volume'));
  assert.ok(dimensionsByProfile.get('woo-customer-volume').has('account-volume'));
  assert.ok(dimensionsByProfile.get('woo-coupon-volume').has('resource-volume'));
  assert.ok(dimensionsByProfile.get('woo-layered-nav-attributes').has('taxonomy-density'));
  assert.ok(dimensionsByProfile.get('woo-shipping-tax-zones').has('resource-volume'));
  assert.ok(dimensionsByProfile.get('woo-action-scheduler-backlog').has('queue-backlog'));
  assert.ok(dimensionsByProfile.get('woo-polluted-options-transients').has('option-pollution'));
  assert.ok(dimensionsByProfile.get('woo-polluted-options-transients').has('transient-pollution'));
  assert.ok(dimensionsByProfile.get('woo-admin-list-table-scale').has('admin-list-table-scale'));
  assert.ok(dimensionsByProfile.get('woo-rest-pagination-search-filter-scale').has('rest-collection-scale'));
});

test('Woo profiles do not embed generic generation steps or proof claims', () => {
  const serialized = JSON.stringify(manifest);
  assert.equal(serialized.includes('benchmark_proof'), false, 'scale profiles must not claim benchmark proof');
  assert.equal(serialized.includes('fuzz_proof'), false, 'scale profiles must not claim fuzz proof');
  assert.equal(serialized.includes('generation_step'), false, 'scale profiles must not implement generic generation');
  assert.equal(serialized.includes('generator'), false, 'scale profiles must not declare a generic generator');
});
