import { test } from 'node:test';
import assert from 'node:assert/strict';
import { underwrite, factorFor, UnderwriteHalt } from '../src/underwrite.mjs';

const NOW = new Date('2026-08-07T12:00:00.000Z');

test('low ARV band, no contract_price (M3 fixture 1)', () => {
  const r = underwrite({ arv: 90000, repairs: 20000, property_address: '123 Low St' }, { now: NOW });
  assert.equal(r.arv_minus_repairs, 70000);
  assert.equal(r.factor_used, 0.70);
  assert.equal(r.new_mao, 39000); // 70,000 × 0.70 − 10,000
  assert.equal(r.uw_spread, null);
  assert.equal(r.uw_ratio, null);
  assert.match(r.uw_reason, /contract pending/);
  assert.equal(r.computed_at, NOW.toISOString());
});

test('mid ARV band with contract_price (M3 fixture 2)', () => {
  const r = underwrite(
    { arv: 180000, repairs: 30000, contract_price: 95000, property_address: '456 Mid Ave' },
    { now: NOW },
  );
  assert.equal(r.arv_minus_repairs, 150000);
  assert.equal(r.factor_used, 0.78);
  assert.equal(r.new_mao, 107000); // 150,000 × 0.78 − 10,000
  assert.equal(r.uw_spread, 12000);
  assert.equal(r.uw_ratio, 0.5278); // stored as decimal, ×100 for display
  assert.match(r.uw_reason, /spread \$12,000 \/ ratio 52\.8%/);
});

test('high ARV band (M3 fixture 3)', () => {
  const r = underwrite({ arv: 350000, repairs: 50000 }, { now: NOW });
  assert.equal(r.factor_used, 0.849);
  assert.equal(r.new_mao, 244700); // 300,000 × 0.849 − 10,000
});

test('factor table band boundaries are inclusive', () => {
  assert.equal(factorFor(100000), 0.70);
  assert.equal(factorFor(100001), 0.75);
  assert.equal(factorFor(150000), 0.75);
  assert.equal(factorFor(200000), 0.78);
  assert.equal(factorFor(300000), 0.82);
  assert.equal(factorFor(300001), 0.849);
});

test('MAO is always rounded to a whole dollar', () => {
  const r = underwrite({ arv: 123456, repairs: 7891 }, { now: NOW });
  assert.equal(r.new_mao, Math.round((123456 - 7891) * 0.75 - 10000));
  assert.ok(Number.isInteger(r.new_mao));
});

test('halts on missing or zero arv', () => {
  assert.throws(() => underwrite({ repairs: 20000 }), UnderwriteHalt);
  assert.throws(() => underwrite({ arv: 0, repairs: 20000 }), UnderwriteHalt);
  assert.throws(() => underwrite({ arv: '', repairs: 20000 }), UnderwriteHalt);
});

test('halts on missing or zero repairs', () => {
  assert.throws(() => underwrite({ arv: 90000 }), UnderwriteHalt);
  assert.throws(() => underwrite({ arv: 90000, repairs: 0 }), UnderwriteHalt);
});

test('Baserow single-select objects and numeric strings are normalized', () => {
  const r = underwrite(
    {
      arv: '150000.00',
      repairs: '25000.00',
      property_type: { id: 1, value: 'SFR', color: 'blue' },
      confidence: { id: 2, value: 'High', color: 'green' },
    },
    { now: NOW },
  );
  assert.equal(r.property_type, 'SFR');
  assert.equal(r.confidence, 'High');
  assert.equal(r.factor_used, 0.75);
  assert.equal(r.new_mao, Math.round(125000 * 0.75 - 10000));
});

test('jv_opportunity_value passes through untouched; blank becomes null', () => {
  assert.equal(underwrite({ arv: 90000, repairs: 20000, jv_opportunity_value: 5000 }).jv_opportunity_value, 5000);
  assert.equal(underwrite({ arv: 90000, repairs: 20000, jv_opportunity_value: '' }).jv_opportunity_value, null);
  assert.equal(underwrite({ arv: 90000, repairs: 20000 }).jv_opportunity_value, null);
});

test('seller_draft nudges a call and never contains the offer number', () => {
  const r = underwrite(
    { arv: 180000, repairs: 30000, property_address: '456 Mid Ave', decision_makers: 'Marie Boudreaux' },
    { now: NOW },
  );
  assert.match(r.seller_draft, /^Hey Marie — ran your numbers on 456 Mid Ave/);
  assert.doesNotMatch(r.seller_draft, /107,000|107000|\$/);
});
