'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Isolated config dir + a fake "python" that imitates fast-flights, set before modules load.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'miles-'));
const fakePy = path.join(tmp, 'fake-python');
fs.writeFileSync(fakePy, `#!/bin/sh
# "python -c 'import fast_flights'" succeeds; "python ff_quote.py DEST CABIN OUT IN CARRIER" prints a quote.
if [ "$1" = "-c" ]; then exit 0; fi
if [ "$2" = "XXX" ]; then echo '{"error": "fast-flights failed: blocked"}'; exit 1; fi
# Mixed route: carriers "SQ,LX" (6th), connection (7th), airline names (8th).
if [ "$6" = "SQ,LX" ] && [ "$7" = "ZRH" ] && [ "$8" = "Singapore Airlines|SWISS" ]; then echo '{"lowest": 4321, "average": 4321, "offers": 1}'; exit 0; fi
# Connecting route: the helper gets the connection as its 7th argument.
if [ "$7" = "IST" ]; then echo '{"lowest": 1234, "average": 1300, "offers": 3}'; exit 0; fi
# Date-dependent fares for flexible-date tests: cheapest departing 2027-03-03; 2027-03-04 fails.
case "$4" in
  2027-03-03) echo '{"lowest": 1400, "average": 1500, "offers": 2}' ;;
  2027-03-04) echo '{"error": "fast-flights failed: timeout"}'; exit 1 ;;
  2027-03-05) echo '{"lowest": 1400, "average": 1450, "offers": 2}' ;;
  *) echo '{"lowest": 1650, "average": 1900, "offers": 4}' ;;
esac
`, { mode: 0o755 });
process.env.MILES_CONFIG_DIR = path.join(tmp, '.local');
process.env.MILES_DB_DIR = path.join(tmp, 'db'); // never touch the real data/db
process.env.MILES_COMMUNITY_DIR = path.join(tmp, 'community');
process.env.MILES_DB_REUSE_HOURS = '0'; // these tests exercise the providers; reuse is tested in db.test.js
process.env.PYTHON = fakePy;
process.env.MILES_FF_DELAY_MEAN_MS = '0'; // no pause between fake searches (tested in delay.test.js)
process.env.MILES_FF_DELAY_SD_MS = '0';
delete process.env.SERPAPI_KEY;

const settings = require('../lib/settings');
const live = require('../lib/live');
const server = require('../server');

const q = (o = {}) => ({ carrier: 'SQ', dest: 'JFK', cabin: 'premium', outbound: '2027-03-01', inbound: '2027-03-10', ...o });
const KEY = 'a'.repeat(64);

test.after(() => { server.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

test('no key + fast-flights installed → fast-flights provider', async () => {
  await live.checkFastFlights();
  assert.deepEqual(live.status(), { provider: 'fast-flights', serpApiKey: null, fastFlights: true });
  live._test.cache.clear();
  const out = await live.lowestReturnFare(q());
  assert.equal(out.provider, 'fast-flights');
  assert.equal(out.lowest, 1650);
});

test('fast-flights errors are surfaced', async () => {
  live._test.cache.clear();
  await assert.rejects(live.lowestReturnFare(q({ dest: 'XXX' })), /blocked/);
});

test('key validation and file permissions', () => {
  assert.throws(() => settings.saveSerpApiKey('short'), /does not look like/);
  assert.throws(() => settings.saveSerpApiKey('bad key with spaces and more chars'), /does not look like/);
  settings.saveSerpApiKey(KEY);
  assert.equal(settings.serpApiKey(), KEY);
  assert.equal(settings.keySource(), 'saved');
  assert.equal(fs.statSync(settings.FILE).mode & 0o777, 0o600);
  settings.clearSerpApiKey();
  assert.equal(settings.serpApiKey(), null);
});

test('with a key, SerpApi is used; on failure it falls back to fast-flights', async () => {
  settings.saveSerpApiKey(KEY);
  const realFetch = global.fetch;
  try {
    global.fetch = async () => ({ ok: true, json: async () => ({ price_insights: { lowest_price: 1599 }, best_flights: [{ price: 1599 }, { price: 1801 }] }) });
    live._test.cache.clear();
    let out = await live.lowestReturnFare(q());
    assert.equal(out.provider, 'serpapi');
    assert.equal(out.lowest, 1599);
    assert.equal(out.average, 1700);

    global.fetch = async () => ({ ok: false, status: 429, json: async () => ({ error: 'Your account has run out of searches.' }) });
    live._test.cache.clear();
    out = await live.lowestReturnFare(q());
    assert.equal(out.provider, 'fast-flights');
    assert.match(out.fallbackReason, /run out of searches/);
  } finally {
    global.fetch = realFetch;
    settings.clearSerpApiKey();
  }
});

test('input validation', async () => {
  await assert.rejects(live.lowestReturnFare(q({ cabin: 'first' })), /cabin/);
  await assert.rejects(live.lowestReturnFare(q({ dest: 'jfk' })), /IATA/);
  await assert.rejects(live.lowestReturnFare(q({ outbound: '1/3/27' })), /YYYY-MM-DD/);
});

test('settings endpoint: save, status in meta, remove; rejects non-JSON posts', async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  let res = await fetch(`${base}/api/settings/serpapi`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify({ key: KEY }) });
  assert.equal(res.status, 415);

  res = await fetch(`${base}/api/settings/serpapi`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: 'nope' }) });
  assert.equal(res.status, 400);

  res = await fetch(`${base}/api/settings/serpapi`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: KEY }) });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).live.provider, 'serpapi');

  const meta = await (await fetch(`${base}/api/meta`)).json();
  assert.equal(meta.live.serpApiKey, 'saved');
  assert.ok(!JSON.stringify(meta).includes(KEY), 'key must never be sent to the browser');

  res = await fetch(`${base}/api/settings/serpapi`, { method: 'DELETE' });
  assert.equal((await res.json()).live.provider, 'fast-flights');
});

test('datePairs: optional dates default to ~60 days out for 7 nights', () => {
  const w = live.datePairs({ today: '2026-10-25' });
  assert.deepEqual(w.pairs, [{ outbound: '2026-12-24', inbound: '2026-12-31', shift: 0 }]);
  assert.equal(live.datePairs({ outbound: '2027-03-01', today: '2026-10-25' }).inbound, '2027-03-08');
});

test('datePairs: flex shifts both dates, keeps trip length, skips past days', () => {
  const w = live.datePairs({ outbound: '2027-03-01', inbound: '2027-03-10', flex: 2, today: '2026-10-25' });
  assert.deepEqual(w.pairs.map((p) => [p.outbound, p.inbound]), [
    ['2027-02-27', '2027-03-08'], ['2027-02-28', '2027-03-09'], ['2027-03-01', '2027-03-10'],
    ['2027-03-02', '2027-03-11'], ['2027-03-03', '2027-03-12'],
  ]);
  assert.equal(w.nights, 9);
  const near = live.datePairs({ outbound: '2026-10-26', inbound: '2026-10-30', flex: 3, today: '2026-10-25' });
  assert.equal(near.pairs[0].outbound, '2026-10-25');
  assert.equal(near.pairs.length, 5);
});

test('datePairs: validation', () => {
  const t = { today: '2026-10-25' };
  assert.throws(() => live.datePairs({ ...t, outbound: '2027-02-30' }), /YYYY-MM-DD/);
  assert.throws(() => live.datePairs({ ...t, inbound: '2027-03-01' }), /departure date/);
  assert.throws(() => live.datePairs({ ...t, outbound: '2027-03-05', inbound: '2027-03-01' }), /on or after/);
  assert.throws(() => live.datePairs({ ...t, outbound: '2026-10-01' }), /past/);
  assert.throws(() => live.datePairs({ ...t, outbound: '2027-03-01', flex: 4 }), /flex/);
  assert.throws(() => live.datePairs({ ...t, outbound: '2027-03-01', flex: 'x' }), /flex/);
});

test('flexible dates: returns the cheapest trip, its dates and per-date results', async () => {
  live._test.cache.clear();
  const out = await live.lowestFareInWindow(q({ outbound: '2027-03-01', inbound: '2027-03-08', flex: 3 }));
  assert.equal(out.lowest, 1400);
  // 03-03 and 03-05 tie at 1400; the one closer to the requested date wins.
  assert.equal(out.outbound, '2027-03-03');
  assert.equal(out.inbound, '2027-03-10');
  assert.equal(out.searched, 7);
  assert.equal(out.failed, 1); // 2027-03-04
  assert.match(out.byDate.find((d) => d.outbound === '2027-03-04').error, /timeout/);
  assert.deepEqual(out.window, { from: '2027-02-26', to: '2027-03-11' });
  assert.deepEqual(out.requested, { outbound: '2027-03-01', inbound: '2027-03-08', flex: 3, nights: 7 });
});

test('exact dates: one search, constrained to those dates', async () => {
  live._test.cache.clear();
  const out = await live.lowestFareInWindow(q({ outbound: '2027-03-01', inbound: '2027-03-08' }));
  assert.equal(out.searched, 1);
  assert.equal(out.lowest, 1650);
  assert.equal(out.outbound, '2027-03-01');
});

test('every date failing surfaces the error', async () => {
  live._test.cache.clear();
  await assert.rejects(live.lowestFareInWindow(q({ outbound: '2027-03-04', inbound: '2027-03-08' })), /timeout/);
});

test('flexible dates via SerpApi send one request per shifted date', async () => {
  settings.saveSerpApiKey(KEY);
  const realFetch = global.fetch;
  const seen = [];
  try {
    global.fetch = async (url) => {
      const p = new URL(url).searchParams;
      seen.push([p.get('outbound_date'), p.get('return_date')]);
      const price = p.get('outbound_date') === '2027-03-02' ? 1300 : 1700;
      return { ok: true, json: async () => ({ best_flights: [{ price }] }) };
    };
    live._test.cache.clear();
    const out = await live.lowestFareInWindow(q({ outbound: '2027-03-01', inbound: '2027-03-10', flex: 1 }));
    assert.deepEqual(seen.sort(), [['2027-02-28', '2027-03-09'], ['2027-03-01', '2027-03-10'], ['2027-03-02', '2027-03-11']]);
    assert.equal(out.lowest, 1300);
    assert.equal(out.provider, 'serpapi');
  } finally {
    global.fetch = realFetch;
    settings.clearSerpApiKey();
  }
});

test('/api/live accepts optional dates and flex', async () => {
  if (!server.listening) await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  live._test.cache.clear();
  let res = await fetch(`${base}/api/live?carrier=SQ&dest=JFK&cabin=economy&outbound=2027-03-01&inbound=2027-03-08&flex=2`);
  let out = await res.json();
  assert.equal(res.status, 200);
  assert.equal(out.outbound, '2027-03-03');
  assert.equal(out.searched, 5);

  res = await fetch(`${base}/api/live?carrier=SQ&dest=JFK&cabin=economy`);
  out = await res.json();
  assert.equal(res.status, 200);
  assert.equal(out.searched, 1);
  assert.equal(out.requested.nights, 7);

  res = await fetch(`${base}/api/live?carrier=SQ&dest=JFK&cabin=economy&outbound=2027-03-01&flex=9`);
  assert.equal(res.status, 502);
  assert.match((await res.json()).error, /flex/);
});

test('connecting routes: SerpApi limits stops and keeps only offers via the row\'s hub', async () => {
  settings.saveSerpApiKey(KEY);
  const realFetch = global.fetch;
  let params;
  try {
    global.fetch = async (url) => {
      params = new URL(url).searchParams;
      return { ok: true, json: async () => ({
        price_insights: { lowest_price: 900 }, // covers every connection: must be ignored
        best_flights: [{ price: 900, layovers: [{ id: 'FRA' }] }, { price: 1180, layovers: [{ id: 'IST' }] }],
        other_flights: [{ price: 1250, layovers: [{ id: 'IST' }] }, { price: 1000, layovers: [{ id: 'IST' }, { id: 'MUC' }] }],
      }) };
    };
    live._test.cache.clear();
    const out = await live.lowestReturnFare({ ...q(), dest: 'BOD', carrier: 'TK', cabin: 'economy', via: ['IST'] });
    assert.equal(params.get('stops'), '2'); // SerpApi: 1 stop or fewer
    assert.equal(params.get('include_airlines'), 'TK');
    assert.equal(out.lowest, 1180);
    assert.equal(out.offers, 2);
    assert.equal(out.otherConnections, 2);

    // Nonstop rows: nonstop only (stops=1), and connecting offers don't count. Every mocked offer
    // connects, so there's no nonstop price; price_insights (900, any routing) isn't used.
    live._test.cache.clear();
    const direct = await live.lowestReturnFare({ ...q(), dest: 'IST', carrier: 'TK', cabin: 'economy' });
    assert.equal(params.get('stops'), '1');
    assert.equal(direct.lowest, null);
  } finally {
    global.fetch = realFetch;
    settings.clearSerpApiKey();
  }
});

test('mixed route with no fitting offers: SerpApi reports what Google has instead', async () => {
  settings.saveSerpApiKey(KEY);
  const realFetch = global.fetch;
  try {
    global.fetch = async () => ({ ok: true, json: async () => ({
      other_flights: [{ price: 1451, layovers: [{ id: 'ZRH' }], flights: [
        { flight_number: 'LX 177', airline: 'SWISS', departure_airport: { id: 'SIN' }, arrival_airport: { id: 'ZRH' } },
        { flight_number: 'LX 550', airline: 'SWISS', departure_airport: { id: 'ZRH' }, arrival_airport: { id: 'BOD' } }] }],
    }) });
    live._test.cache.clear();
    const out = await live.lowestFareInWindow({ route: 'SQ+LX:BOD', carriers: ['SQ', 'LX'], dest: 'BOD', via: ['ZRH'], segmentCarriers: ['SQ', 'LX'], cabin: 'economy', outbound: '2027-03-01', inbound: '2027-03-08' });
    assert.equal(out.lowest, null);
    assert.deepEqual(out.others.map((o) => [o.price, o.airlines.join(), o.path.join('-')]), [[1451, 'SWISS', 'SIN-ZRH-BOD']]);
  } finally {
    global.fetch = realFetch;
    settings.clearSerpApiKey();
  }
});

test('connecting routes: fast-flights gets the connection; cache keeps routes apart', async () => {
  live._test.cache.clear();
  const viaIst = await live.lowestReturnFare({ ...q(), dest: 'BOD', carrier: 'TK', cabin: 'economy', via: ['IST'] });
  assert.equal(viaIst.lowest, 1234);
  const any = await live.lowestReturnFare({ ...q(), dest: 'BOD', carrier: 'TK', cabin: 'economy' });
  assert.equal(any.lowest, 1650);
  await assert.rejects(live.lowestReturnFare({ ...q(), via: ['ist'] }), /via/);
});

test('/api/live uses the route\'s connection from the data', async () => {
  if (!server.listening) await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  live._test.cache.clear();
  const out = await (await fetch(`${base}/api/live?carrier=TK&dest=BOD&cabin=economy&outbound=2027-03-01&inbound=2027-03-08`)).json();
  assert.equal(out.lowest, 1234);
  assert.deepEqual(out.via, ['IST']);
});

test('mixed routes: SerpApi gets every airline and keeps offers flown SQ then LX via ZRH', async () => {
  settings.saveSerpApiKey(KEY);
  const realFetch = global.fetch;
  let params;
  try {
    global.fetch = async (url) => {
      params = new URL(url).searchParams;
      const offer = (price, nums, via) => ({ price, layovers: via.map((id) => ({ id })), flights: nums.map((n) => ({ flight_number: n })) });
      return { ok: true, json: async () => ({
        price_insights: { lowest_price: 700 },
        best_flights: [offer(700, ['LX 177', 'LX 642'], ['ZRH']), offer(1050, ['SQ 346', 'LX 642'], ['ZRH'])],
        other_flights: [offer(980, ['SQ 326', 'LH 1234'], ['FRA']), offer(1200, ['SQ 346', 'LX 644'], ['ZRH'])],
      }) };
    };
    live._test.cache.clear();
    const out = await live.lowestReturnFare({ carriers: ['SQ', 'LX'], dest: 'BOD', cabin: 'economy', outbound: '2027-03-01', inbound: '2027-03-08', via: ['ZRH'], segmentCarriers: ['SQ', 'LX'] });
    assert.equal(params.get('include_airlines'), 'SQ,LX');
    assert.equal(params.get('stops'), '2');
    assert.equal(out.lowest, 1050);
    assert.equal(out.offers, 2);
  } finally {
    global.fetch = realFetch;
    settings.clearSerpApiKey();
  }
});

test('/api/live by route id passes the route\'s airlines to fast-flights', async () => {
  if (!server.listening) await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  live._test.cache.clear();
  const out = await (await fetch(`${base}/api/live?route=${encodeURIComponent('SQ+LX:BOD')}&cabin=economy&outbound=2027-03-01&inbound=2027-03-08`)).json();
  assert.equal(out.route, 'SQ+LX:BOD');
  assert.deepEqual(out.carriers, ['SQ', 'LX']);
  assert.deepEqual(out.segmentCarriers, ['SQ', 'LX']);
  assert.equal(out.lowest, 4321); // fake fast-flights answers 4321 when given SQ,LX + names
  const bad = await fetch(`${base}/api/live?route=XX:YYY&cabin=economy`);
  assert.match((await bad.json()).error, /Unknown route/);
});

test('searching every region at once needs a SerpApi key', async () => {
  if (!server.listening) await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  settings.clearSerpApiKey();
  let res = await fetch(`${base}/api/live?route=TK:BOD&cabin=economy&outbound=2027-03-01&inbound=2027-03-08&batch=all`);
  assert.equal(res.status, 403);
  assert.match((await res.json()).error, /needs a SerpApi key/);
  // One region with fast-flights is fine.
  live._test.cache.clear();
  res = await fetch(`${base}/api/live?route=TK:BOD&cabin=economy&outbound=2027-03-01&inbound=2027-03-08&batch=region`);
  assert.equal(res.status, 200);
});

test('flexible rows: SerpApi accepts any hub and reports which one priced', async () => {
  settings.saveSerpApiKey(KEY);
  const realFetch = global.fetch;
  try {
    global.fetch = async () => ({ ok: true, json: async () => ({ other_flights: [
      { price: 1707, layovers: [{ id: 'PEK' }], flights: [{ flight_number: 'CA 976' }, { flight_number: 'CA 855' }] },
      { price: 1423, layovers: [{ id: 'TFU' }], flights: [{ flight_number: 'CA 404' }, { flight_number: 'CA 423' }] },
      { price: 999, layovers: [{ id: 'CAN' }], flights: [{ flight_number: 'CA 1' }, { flight_number: 'CA 2' }] },
    ] }) });
    live._test.cache.clear();
    const out = await live.lowestReturnFare({ carrier: 'CA', dest: 'LHR', cabin: 'economy', outbound: '2027-04-30', inbound: '2027-05-09', via: ['PEK'], viaOptions: [['PEK'], ['TFU'], ['PVG']] });
    assert.deepEqual([out.lowest, out.via], [1423, ['TFU']]);
  } finally {
    global.fetch = realFetch;
    settings.clearSerpApiKey();
  }
});
