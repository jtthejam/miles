'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const data = require('../data');
const { buildRows } = require('../lib/calc');
const { pctForClass, milesEarned } = require('../lib/accrual');
const { greatCircleMiles, itineraryMiles } = require('../lib/geo');

const find = (rows, carrier, code, cabin) =>
  rows.find((r) => r.carrier === carrier && r.code === code && r.cabin === cabin);
const C = data.carriers;

test('accrual tables match KrisFlyer chart', () => {
  assert.equal(pctForClass(C.SQ, 'premium', 'S'), 125);
  assert.equal(pctForClass(C.SQ, 'economy', 'M'), 75);
  assert.equal(pctForClass(C.TK, 'economy', 'V'), 25);
  assert.equal(pctForClass(C.TK, 'economy', 'L'), 50);
  assert.equal(pctForClass(C.LH, 'economy', 'T'), 10);
  assert.equal(pctForClass(C.LH, 'premium', 'N'), 100);
  assert.equal(pctForClass(C.NH, 'premium', 'G'), 125);
  assert.equal(pctForClass(C.NH, 'economy', 'K'), 50);
  assert.equal(pctForClass(C.CA, 'premium', 'G'), 110);
  assert.equal(pctForClass(C.CA, 'economy', 'K'), null); // unlisted → no accrual
  assert.equal(pctForClass(C.NZ, 'premium', 'U'), 110);
  assert.equal(pctForClass(C.NZ, 'economy', 'G'), 10);
});

test('SIN-JFK distance ~9,530 mi', () => {
  const d = greatCircleMiles(data.airports.SIN, data.airports.JFK);
  assert.ok(d > 9450 && d < 9600, `got ${d}`);
});

test('SQ: NYC premium economy return at 100% ≈ 19,000 miles', () => {
  const r = find(buildRows(data), 'SQ', 'JFK', 'premium');
  assert.ok(r.miles > 18900 && r.miles < 19200, `got ${r.miles}`);
});

test('TK: connecting distance sums segments via IST', () => {
  const r = find(buildRows(data), 'TK', 'LHR', 'economy');
  const expected = itineraryMiles(data.airports, ['SIN', 'IST', 'LHR']);
  assert.equal(r.distance, expected);
  assert.ok(r.distance > greatCircleMiles(data.airports.SIN, data.airports.LHR));
  assert.equal(r.bookingClass, 'V'); // assumed sale class
  assert.equal(r.accrualPct, 25);
});

test('TK has no Premium Economy rows; Air China does (E 100%, G 110%)', () => {
  const rows = buildRows(data);
  assert.ok(!rows.some((r) => r.carrier === 'TK' && r.cabin === 'premium'));
  const caPY = find(rows, 'CA', 'PEK', 'premium');
  assert.equal(caPY.bookingClass, 'E');
  assert.equal(caPY.accrualPct, 100);
  assert.equal(pctForClass(C.CA, 'premium', 'G'), 110);
});

test('every airline has at least one route with a price', () => {
  const rows = buildRows(data);
  for (const code of Object.keys(C)) {
    // An airline may be exempt only with a stated reason (no advertised Singapore fare found).
    if (C[code].noAdvertisedFare) continue;
    const priced = rows.filter((r) => r.carrier === code && r.priceSgd > 0 && r.miles > 0);
    assert.ok(priced.length > 0, `${code} has no priced, earning route`);
  }
});

test('NZ: promo class K earns 10% to AKL and nothing to CHC', () => {
  const rows = buildRows(data);
  const akl = find(rows, 'NZ', 'AKL', 'economy');
  assert.equal(akl.bookingClass, 'K');
  assert.equal(akl.accrualPct, 10);
  const chc = find(rows, 'NZ', 'CHC', 'economy');
  assert.equal(chc.accrualPct, 0);
  assert.equal(chc.eligible, false);
  assert.match(chc.ineligibleReason, /AKL/);
  assert.equal(chc.milesPerSgd, null);
});

test('unpriced rows still show miles and sort last', () => {
  const rows = buildRows(data);
  const ca = find(rows, 'CA', 'PEK', 'premium');
  assert.equal(ca.priceSgd, null);
  assert.ok(ca.miles > 0);
  const firstUnpriced = rows.findIndex((r) => r.milesPerSgd == null);
  assert.ok(rows.slice(firstUnpriced).every((r) => r.milesPerSgd == null));
});

test('price override fills an unpriced partner row', () => {
  const rows = buildRows(data, { priceOverrides: { 'CA:PEK:economy': 400 } });
  const r = find(rows, 'CA', 'PEK', 'economy');
  assert.equal(r.priceSgd, 400);
  assert.equal(r.overridden, true);
  assert.equal(r.milesPerSgd, +(r.miles / 400).toFixed(2));
});

test('earn rate follows the sale-fare class', () => {
  const rows = buildRows(data);
  const sqY = find(rows, 'SQ', 'CDG', 'economy');
  assert.equal(sqY.bookingClass, 'K');
  assert.equal(sqY.accrualPct, 50); // Economy Lite
  assert.equal(sqY.classConfidence, 'stated');
  const sqPY = find(rows, 'SQ', 'JFK', 'premium');
  assert.equal(sqPY.bookingClass, 'R');
  assert.equal(sqPY.accrualPct, 100); // Premium Economy Lite
});

test('class override changes earn; invalid override falls back; unlisted class earns 0', () => {
  const rows = buildRows(data, { classOverrides: { 'SQ:CDG:economy': 'M', 'SQ:LHR:economy': 'zz', 'CA:PEK:economy': 'K' } });
  const cdg = find(rows, 'SQ', 'CDG', 'economy');
  assert.equal(cdg.accrualPct, 75);
  assert.equal(cdg.classOverridden, true);
  assert.equal(cdg.classConfidence, 'yours');
  assert.equal(find(rows, 'SQ', 'LHR', 'economy').bookingClass, 'K');
  const pek = find(rows, 'CA', 'PEK', 'economy');
  assert.equal(pek.accrualPct, 0);
  assert.match(pek.ineligibleReason, /no KrisFlyer miles/);
});

test('every airline cabin has a sale class that exists in its chart', () => {
  for (const [code, c] of Object.entries(C)) {
    for (const cab of ['economy', 'premium']) {
      if (!c.accrual[cab].length) continue;
      assert.ok(pctForClass(c, cab, c.saleFare[cab].class) != null, `${code} ${cab}`);
    }
  }
});

test('one-way halves both miles and price', () => {
  const rt = find(buildRows(data), 'SQ', 'LHR', 'economy');
  const ow = find(buildRows(data, { roundTrip: false }), 'SQ', 'LHR', 'economy');
  assert.ok(Math.abs(ow.miles * 2 - rt.miles) <= 1);
  assert.equal(ow.priceSgd, Math.round(rt.priceSgd / 2));
});

test('milesEarned rounds', () => {
  assert.equal(milesEarned(1000, 125, true), 2500);
  assert.equal(milesEarned(1001, 75, false), 751);
});

test('sales calendar data is complete', () => {
  const cal = data.salesCalendar;
  for (const c of Object.keys(data.carriers)) {
    const has = cal.sales.some((s) => s.carrier === c);
    assert.ok(has || cal.none[c], `${c} needs sales or a "none" note`);
    assert.match(cal.brand[c].light, /^#[0-9a-f]{6}$/i);
    assert.match(cal.brand[c].dark, /^#[0-9a-f]{6}$/i);
  }
  // At most one main sale per airline
  for (const c of Object.keys(data.carriers)) {
    assert.ok(cal.sales.filter((s) => s.carrier === c && s.tier === 'main').length <= 1, c);
  }
  assert.ok(cal.sales.every((s) => s.url.startsWith('https://')));
});

test('Bordeaux connecting routes: distance per segment, Economy only on SWISS', () => {
  const rows = buildRows(data).filter((r) => r.code === 'BOD' && !r.mixed);
  assert.deepEqual(rows.map((r) => [r.key, r.via.join()]).sort(), [['LX:BOD:economy', 'ZRH'], ['TK:BOD:economy', 'IST']]);
  for (const r of rows) {
    const direct = buildRows(data).find((x) => x.carrier === r.carrier && x.code === r.via[0] && x.cabin === 'economy');
    assert.ok(r.distance > direct.distance, `${r.key} counts both segments`);
  }
});

test('mixed-airline route: each segment earns at its own airline\'s class rate', () => {
  const row = buildRows(data).find((r) => r.key === 'SQ+LX:BOD:economy');
  assert.equal(row.carrierName, 'Singapore Airlines + SWISS');
  assert.deepEqual(row.segments.map((s) => [s.from, s.to, s.carrier, s.bookingClass, s.pct]), [['SIN', 'ZRH', 'SQ', 'K', 50], ['ZRH', 'BOD', 'LX', 'V', 50]]);
  assert.equal(row.miles, row.segments.reduce((a, s) => a + s.miles, 0));
  // Override only SWISS's class: only the Zurich-Bordeaux segment changes.
  const y = buildRows(data, { classOverrides: { 'SQ+LX:BOD:economy|LX': 'Y' } }).find((r) => r.key === 'SQ+LX:BOD:economy');
  assert.deepEqual(y.segments.map((s) => s.pct), [50, 100]);
  assert.equal(y.miles - row.miles, row.segments[1].miles);
  assert.equal(y.bookingClass, 'K+Y');
  assert.ok(y.classOverridden);
  // Mixed rows only exist in cabins every airline sells (and the route allows).
  assert.ok(!buildRows(data).some((r) => r.key === 'SQ+LX:BOD:premium'));
});

test('route data: mixed routes validated', () => {
  const ids = data.fares.map((f) => f.routeId);
  assert.equal(new Set(ids).size, ids.length);
  const m = data.fares.find((f) => f.routeId === 'SQ+LX:BOD');
  assert.deepEqual(m.via, ['ZRH']);
  assert.deepEqual(m.segments.map((s) => `${s.from}-${s.to}`), ['SIN-ZRH', 'ZRH-BOD']);
});
