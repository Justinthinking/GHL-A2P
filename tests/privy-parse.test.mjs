import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parsePrivy, addressKey, normalizeAddress } from '../src/privy-parse.mjs';

const FIXTURE = readFileSync(new URL('./fixtures/privy-2116-hope-st.txt', import.meta.url), 'utf8');
const r = parsePrivy(FIXTURE);

test('extracts the subject address despite the missing space before the city', () => {
  assert.equal(r.street, '2116 Hope St');
  assert.equal(r.city, 'New Orleans');
  assert.equal(r.state, 'LA');
  assert.equal(r.zip, '70119');
  assert.equal(r.property_address, '2116 Hope St, New Orleans, LA 70119');
});

test('extracts the building spec fields', () => {
  assert.equal(r.beds, 3);
  assert.equal(r.baths, 2); // 2 full + 0 partial
  assert.equal(r.sqft, 1011);
  assert.equal(r.lot_sqft, 8586);
  assert.equal(r.year_built, 1920);
});

test('extracts assessor values, and never treats them as ARV', () => {
  assert.equal(r.assessor_market_improved, 122300);
  assert.equal(r.assessor_market_total, 148100);
  assert.equal(r.property_tax_annual, 1955);
  assert.ok(!('arv' in r), 'parser must never emit an arv field');
  assert.ok(!('repairs' in r), 'parser must never emit a repairs field');
});

test('extracts condition and ownership context', () => {
  assert.equal(r.building_condition, 'Average');
  assert.equal(r.construction_type, 'Frame');
  assert.equal(r.zoning, 'HU-RD2');
  assert.equal(r.owner_name, 'WOOD JOAN S');
  assert.equal(r.owner_occupied, true);
  assert.equal(r.land_use, 'Single Family Residential');
});

test('counts comps by section — this PDF has no sold comps', () => {
  assert.equal(r.sold_comp_count, 0);
  assert.equal(r.under_contract_count, 1);
  assert.equal(r.active_count, 2);
  assert.equal(r.rental_count, 94);
  assert.equal(r.has_sale_evidence, false);
});

test('isolates the comps block for the model, excluding public records', () => {
  assert.ok(r.comps_block.length > 100);
  assert.ok(r.comps_block.includes('RENTALS'));
  assert.ok(!r.comps_block.includes('Owner 1 Full Name'), 'must not leak owner PII to the model');
  assert.ok(!r.comps_block.includes('Market Improved Value'));
});

test('address keys match across Privy, GHL and hand-typed formatting', () => {
  const fromPrivy = addressKey('2116 Hope St, New Orleans, LA 70119');
  assert.equal(addressKey('2116 Hope St New Orleans LA 70119'), fromPrivy);
  assert.equal(addressKey('2116 HOPE ST, NEW ORLEANS, LA 70119'), fromPrivy);
  assert.equal(addressKey('2116 Hope St., New Orleans, LA 70119'), fromPrivy);
  assert.equal(r.address_key, fromPrivy);
});

test('address keys distinguish different properties on the same street', () => {
  assert.notEqual(addressKey('2116 Hope St, New Orleans, LA 70119'), addressKey('2153 Hope St, New Orleans, LA 70119'));
  assert.notEqual(addressKey('2116 Hope St, New Orleans, LA 70119'), addressKey('2116 Hope St, New Orleans, LA 70117'));
});

test('normalizeAddress collapses punctuation and whitespace', () => {
  assert.equal(normalizeAddress('  2116  Hope St., #B '), '2116 HOPE ST B');
});

test('returns nulls rather than throwing on unrelated text', () => {
  const empty = parsePrivy('this is not a privy document');
  assert.equal(empty.property_address, null);
  assert.equal(empty.beds, null);
  assert.equal(empty.assessor_market_improved, null);
  assert.equal(empty.has_sale_evidence, false);
  assert.equal(empty.comps_block, '');
});
