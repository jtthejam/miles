'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const G = require('../public/gflink');

const carriers = { SQ: { name: 'Singapore Airlines' }, LH: { name: 'Lufthansa' }, TK: { name: 'Turkish Airlines' } };

// Reference strings from fast-flights 3.1.0 create_query(...).to_str() for SIN⇄LHR 2026-12-01/08, 1 adult.
const FF_SQ_PREMIUM = 'Gh4SCjIwMjYtMTItMDEyAlNRagUSA1NJTnIFEgNMSFIaHhIKMjAyNi0xMi0wODICU1FqBRIDTEhScgUSA1NJTkIBAUgCmAEB';
const FF_TK_ECONOMY = 'Gh4SCjIwMjYtMTItMDEyAlRLagUSA1NJTnIFEgNMSFIaHhIKMjAyNi0xMi0wODICVEtqBRIDTEhScgUSA1NJTkIBAUgBmAEB';

// Shaped like the tfs Google writes after changing filters in its UI (captured 2026-10-25): url-safe base64,
// extra top-level fields, an airport type field, unpacked passengers.
const GOOGLE_UI_LH = 'CBwQAhoiEgoyMDI2LTEyLTAxMgJMSGoHCAESA1NJTnIHCAESA0xIUhoiEgoyMDI2LTEyLTA4MgJMSGoHCAESA0xIUnIHCAESA1NJTkABSAFwAYIBCwj___________8BmAEB';

const q = { dest: 'LHR', outbound: '2026-12-01', inbound: '2026-12-08' };
const href = (tfs) => `https://www.google.com/travel/flights/search?tfs=${encodeURIComponent(tfs)}&hl=en&gl=sg&curr=SGD`;

test('links encode exactly like fast-flights', () => {
  assert.equal(G.encodeTfs({ ...q, carrier: 'SQ', cabin: 'premium' }), FF_SQ_PREMIUM);
  assert.equal(G.encodeTfs({ ...q, carrier: 'TK', cabin: 'economy' }), FF_TK_ECONOMY);
  assert.equal(G.linkFor({ ...q, carrier: 'SQ', cabin: 'premium' }), href(FF_SQ_PREMIUM));
  assert.throws(() => G.encodeTfs({ ...q, carrier: 'SQ', cabin: 'first' }), /cabin/);
});

test('decodes our links and Google\'s rewritten ones', () => {
  assert.deepEqual(G.decodeTfs(FF_SQ_PREMIUM), {
    legs: [
      { date: '2026-12-01', maxStops: null, airlines: ['SQ'], from: 'SIN', to: 'LHR' },
      { date: '2026-12-08', maxStops: null, airlines: ['SQ'], from: 'LHR', to: 'SIN' },
    ],
    seat: 2,
    trip: 1,
  });
  const g = G.decodeTfs(GOOGLE_UI_LH);
  assert.deepEqual(g.legs.map((l) => [l.date, l.airlines.join(), l.from, l.to]), [['2026-12-01', 'LH', 'SIN', 'LHR'], ['2026-12-08', 'LH', 'LHR', 'SIN']]);
  assert.equal(g.seat, 1);
  assert.equal(g.trip, 1);
});

test('grid labels get the year nearest the search dates', () => {
  assert.equal(G.resolveDay('Nov 28', '2026-12-01'), '2026-11-28');
  assert.equal(G.resolveDay('Jan 2', '2026-12-30'), '2027-01-02');
  assert.equal(G.resolveDay('Dec 30', '2027-01-02'), '2026-12-30');
  assert.equal(G.resolveDay('price unknown', '2026-12-01'), null);
});

// Grid as the bookmarklet sends it: [price, departure, return, currency]
const grid = [
  ['1,927', 'Nov 28', 'Dec 5', 'SGD'],
  ['1,470', 'Nov 30', 'Dec 6', 'SGD'],
  ['1,384', 'Dec 1', 'Dec 7', 'SGD'],
  ['1,384', 'Dec 2', 'Dec 7', 'SGD'],
  ['1,719', 'Dec 1', 'Dec 8', 'SGD'],
  ['2,874', 'Dec 4', 'Dec 11', 'SGD'],
];

test('date grid import: cheapest cell, nearest to the asked date on ties', () => {
  const r = G.interpretImport({ href: href(FF_SQ_PREMIUM), grid }, { carriers });
  assert.deepEqual(
    { ...r, notes: undefined },
    { carrier: 'SQ', dest: 'LHR', cabin: 'premium', outbound: '2026-12-01', inbound: '2026-12-07', lowest: 1384, source: 'grid', considered: 6, notes: undefined },
  );
});

test('date grid import keeps to the app\'s travel dates ± flexibility', () => {
  const exact = G.interpretImport({ href: href(FF_SQ_PREMIUM), grid }, { carriers, window: { outbound: '2026-12-01', inbound: '2026-12-08', flex: 0 } });
  assert.equal(exact.lowest, 1719);
  assert.match(exact.notes[0], /5 outside your dates/);
  const flex1 = G.interpretImport({ href: href(FF_SQ_PREMIUM), grid }, { carriers, window: { outbound: '2026-12-01', inbound: '2026-12-08', flex: '1' } });
  assert.equal(flex1.lowest, 1384);
  assert.equal(flex1.outbound, '2026-12-01');
  const none = G.interpretImport({ href: href(FF_SQ_PREMIUM), grid }, { carriers, window: { outbound: '2027-03-01', inbound: '2027-03-08', flex: 3 } });
  assert.match(none.error, /within your travel dates ± 3 days/);
});

test('results-list import: only results on the filtered airline, SGD only', () => {
  const list = [
    ['1063', 'Singapore dollars', 'Singapore Airlines and Austrian'],
    ['1719', 'Singapore dollars', 'Singapore Airlines'],
    ['1034', 'Singapore dollars', 'Lufthansa and Lufthansa City Airlines'],
    ['1059', 'Singapore dollars', 'Lufthansa'],
  ];
  const r = G.interpretImport({ href: href(FF_SQ_PREMIUM), list }, { carriers });
  assert.equal(r.lowest, 1063);
  assert.equal(r.source, 'results');
  assert.equal(r.outbound, '2026-12-01');
  const lh = G.interpretImport({ href: href(GOOGLE_UI_LH), list }, { carriers });
  assert.equal(lh.carrier, 'LH');
  assert.equal(lh.cabin, 'economy');
  assert.equal(lh.lowest, 1059); // S$1,034 includes Lufthansa City (no KrisFlyer miles), so it's skipped
  assert.match(lh.notes[0], /Lufthansa City/);
  const usd = G.interpretImport({ href: href(FF_SQ_PREMIUM), list: [['900', 'US dollars', 'Singapore Airlines']] }, { carriers });
  assert.match(usd.error, /SGD/);
});

test('refuses pages it can\'t attribute to one airline', () => {
  const noFilter = G.encodeTfs({ ...q, cabin: 'economy' });
  assert.match(G.interpretImport({ href: href(noFilter), grid }, { carriers }).error, /one airline/);
  assert.match(G.interpretImport({ href: 'https://example.com/?tfs=x', grid }, { carriers }).error, /isn't a Google Flights/);
  const fromKul = G.encodeTfs({ ...q, origin: 'KUL', carrier: 'SQ', cabin: 'economy' });
  assert.match(G.interpretImport({ href: href(fromKul), grid }, { carriers }).error, /departs from KUL/);
  const nz = G.encodeTfs({ ...q, carrier: 'QF', cabin: 'economy' });
  assert.match(G.interpretImport({ href: href(nz), grid }, { carriers }).error, /QF isn't one of the airlines/);
  assert.match(G.interpretImport({ href: href(FF_SQ_PREMIUM), grid: [], list: [] }, { carriers }).error, /No prices/);
});

test('falls back to the row last opened when the URL has no tfs', () => {
  const r = G.interpretImport(
    { href: 'https://www.google.com/travel/flights?q=x', list: [['1500', 'Singapore dollars', 'Turkish Airlines']] },
    { carriers, pending: { carrier: 'TK', dest: 'IST', cabin: 'economy' } },
  );
  assert.equal(r.error, 'Couldn\'t read the travel dates from that page.'); // list needs dates; grid would not
  const g = G.interpretImport(
    { href: 'https://www.google.com/travel/flights?q=x', grid: [['1500', 'Dec 1', 'Dec 8', 'SGD']] },
    { carriers, pending: { carrier: 'TK', dest: 'IST', cabin: 'economy' } },
  );
  assert.equal(g.carrier, 'TK');
  assert.equal(g.dest, 'IST');
  assert.equal(g.lowest, 1500);
});

test('real Google Flights date grid payload (Lufthansa SIN-LHR, captured 2026-10-25)', () => {
  const fx = require('./fixtures/gf-grid-lh-sin-lhr.json');
  const all = G.interpretImport(fx, { carriers });
  assert.equal(all.considered, 49);
  assert.deepEqual([all.carrier, all.dest, all.cabin, all.lowest, all.outbound], ['LH', 'LHR', 'economy', 1034, '2026-12-01']);
  assert.match(all.notes.join(), /Lufthansa City/);
  // Exact dates: the 1-8 Dec cell. 3-10 Dec ±1: cheapest within 2-4 Dec × 9-11 Dec.
  const exact = G.interpretImport(fx, { carriers, window: { outbound: '2026-12-01', inbound: '2026-12-08', flex: 0 } });
  assert.deepEqual([exact.lowest, exact.inbound, exact.considered], [1034, '2026-12-08', 1]);
  const late = G.interpretImport(fx, { carriers, window: { outbound: '2026-12-03', inbound: '2026-12-10', flex: 1 } });
  assert.deepEqual([late.lowest, late.outbound, late.considered], [1085, '2026-12-03', 9]); // 2-4 Dec × 9-11 Dec
});

test('connecting routes: links limit stops (byte-identical to fast-flights max_stops)', () => {
  // fast-flights 3.1.0, FlightQuery(..., airlines=["TK"], max_stops=1) SIN⇄BOD 2026-12-01/08 economy
  const FF_TK_BOD_1STOP = 'GiASCjIwMjYtMTItMDEoATICVEtqBRIDU0lOcgUSA0JPRBogEgoyMDI2LTEyLTA4KAEyAlRLagUSA0JPRHIFEgNTSU5CAQFIAZgBAQ==';
  const bod = { dest: 'BOD', outbound: '2026-12-01', inbound: '2026-12-08', carrier: 'TK', cabin: 'economy' };
  assert.equal(G.encodeTfs({ ...bod, maxStops: 1 }), FF_TK_BOD_1STOP);
  assert.deepEqual(G.decodeTfs(FF_TK_BOD_1STOP).legs.map((l) => l.maxStops), [1, 1]);
  assert.equal(G.decodeTfs(FF_SQ_PREMIUM).legs[0].maxStops, null);
});

test('connecting routes: import keeps results with the route\'s stops and flags a removed stops filter', () => {
  const tk = { ...carriers, TK: { name: 'Turkish Airlines' } };
  const routes = { 'TK:BOD': ['IST'], 'SQ:LHR': [] };
  const bod = { dest: 'BOD', outbound: '2026-12-01', inbound: '2026-12-08', carrier: 'TK', cabin: 'economy' };
  const list = [['980', 'Singapore dollars', 'Turkish Airlines', 2], ['1180', 'Singapore dollars', 'Turkish Airlines', 1], ['1250', 'Singapore dollars', 'Turkish Airlines', 1]];

  const pinned = G.interpretImport({ href: href(G.encodeTfs({ ...bod, maxStops: 1 })), list }, { carriers: tk, routes });
  assert.equal(pinned.lowest, 1180);
  assert.deepEqual(pinned.notes, ['1 with a different number of stops skipped']);

  const unpinned = G.interpretImport({ href: href(G.encodeTfs(bod)), list }, { carriers: tk, routes });
  assert.equal(unpinned.lowest, 1180);
  assert.match(unpinned.notes[0], /stops filter is off.*IST/);

  const none = G.interpretImport({ href: href(G.encodeTfs(bod)), list: [list[0]] }, { carriers: tk, routes });
  assert.match(none.error, /exactly 1 stop .*via IST/);

  // Nonstop rows: connecting results don't count (their miles would differ).
  const sq = G.interpretImport({ href: href(FF_SQ_PREMIUM), list: [['1063', 'Singapore dollars', 'Singapore Airlines and Austrian', 2], ['1719', 'Singapore dollars', 'Singapore Airlines', 0]] }, { carriers, routes });
  assert.equal(sq.lowest, 1719);
});
