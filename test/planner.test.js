'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { plan } = require('../public/planner.js');
const data = require('../data');
const { buildRows } = require('../lib/calc');

// Brute force reference: every combination of 1..k items (with or without repetition) that reaches
// the target and is minimal (dropping any one item falls short).
function brute(rows, target, k, distinct) {
  const c = rows.filter((r) => r.priceSgd > 0 && r.miles > 0);
  const out = [];
  const rec = (start, pick) => {
    if (pick.length) {
      const miles = pick.reduce((s, p) => s + p.miles, 0);
      const okDistinct = !distinct || new Set(pick.map((p) => p.code)).size === pick.length;
      const minimal = pick.length === 1 || miles - Math.min(...pick.map((p) => p.miles)) < target;
      if (okDistinct && miles >= target && minimal) out.push(pick.reduce((s, p) => s + p.priceSgd, 0));
    }
    if (pick.length === k) return;
    for (let i = start; i < c.length; i++) rec(distinct ? i + 1 : i, [...pick, c[i]]);
  };
  rec(0, []);
  return out.sort((a, b) => a - b);
}

function rand(seed) { return () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648); }

test('matches brute force on random inputs (distinct and repeat)', () => {
  const r = rand(42);
  for (let t = 0; t < 40; t++) {
    const rows = Array.from({ length: 9 }, (_, i) => ({
      key: `X:${i}`, code: `C${Math.floor(r() * 6)}`,
      miles: Math.round(1000 + r() * 20000), priceSgd: Math.round(200 + r() * 2500),
    }));
    for (const distinct of [true, false]) {
      const k = 1 + Math.floor(r() * 4);
      const target = Math.round(r() * 40000);
      const expected = brute(rows, target, k, distinct).slice(0, 10);
      const got = plan(rows, { target, trips: k, distinct, limit: 10 }).results.map((x) => x.cost);
      assert.deepEqual(got, expected, `case ${t} k=${k} target=${target} distinct=${distinct}`);
    }
  }
});

test('default plan: 50,000 miles over up to 5 trips', () => {
  const rows = buildRows(data);
  const out = plan(rows, { target: 50000, trips: 5, distinct: true });
  assert.ok(out.results.length > 0);
  const first = out.results[0];
  assert.ok(first.miles >= 50000);
  assert.ok(first.rows.length >= 1 && first.rows.length <= 5);
  assert.equal(new Set(first.rows.map((t) => t.code)).size, first.rows.length);
  // minimal: dropping the smallest trip falls short
  if (first.rows.length > 1) assert.ok(first.miles - Math.min(...first.rows.map((t) => t.miles)) < 50000);
  for (let i = 1; i < out.results.length; i++) assert.ok(out.results[i].cost >= out.results[i - 1].cost);
});

test('unreachable target returns no results and reports max miles', () => {
  const rows = buildRows(data);
  const out = plan(rows, { target: 10_000_000, trips: 2 });
  assert.equal(out.results.length, 0);
  assert.ok(out.maxMiles > 0);
});

test('up to N: a single trip that reaches the target is included', () => {
  const rows = [
    { key: 'a', code: 'A', miles: 20000, priceSgd: 2000 },
    { key: 'b', code: 'B', miles: 6000, priceSgd: 500 },
    { key: 'c', code: 'C', miles: 6000, priceSgd: 600 },
  ];
  const out = plan(rows, { target: 12000, trips: 3 });
  assert.deepEqual(out.results.map((r) => r.rows.map((t) => t.key).join('+')), ['b+c', 'a']);
});

test('5 trips over the full dataset stays fast', () => {
  const rows = buildRows(data);
  const t0 = Date.now();
  const out = plan(rows, { target: 60000, trips: 5, distinct: false });
  assert.ok(out.results.length > 0);
  assert.ok(Date.now() - t0 < 2000, `took ${Date.now() - t0}ms`);
});

test('unpriced and zero-mile rows are ignored', () => {
  const rows = [
    { key: 'a', code: 'A', miles: 10000, priceSgd: null },
    { key: 'b', code: 'B', miles: 0, priceSgd: 100 },
    { key: 'c', code: 'C', miles: 5000, priceSgd: 500 },
  ];
  const out = plan(rows, { target: 1000, trips: 1 });
  assert.equal(out.candidates, 1);
  assert.equal(out.results[0].rows[0].key, 'c');
});
