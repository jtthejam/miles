'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Isolated database folder + a fake "python" for fast-flights (prices depend on the outbound date).
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'miles-db-'));
const DIR = path.join(tmp, 'db');
const fakePy = path.join(tmp, 'fake-python');
const calls = path.join(tmp, 'calls.log');
fs.writeFileSync(fakePy, `#!/bin/sh
if [ "$1" = "-c" ]; then exit 0; fi
echo "$4" >> "${calls}"
case "$4" in
  2027-03-02) echo '{"lowest": 1100, "average": 1200, "offers": 2}' ;;
  *) echo '{"lowest": 1300, "average": 1400, "offers": 2}' ;;
esac
`, { mode: 0o755 });
fs.mkdirSync(DIR, { recursive: true });
process.env.MILES_DB_DIR = DIR;
process.env.MILES_CONFIG_DIR = path.join(tmp, '.local');
process.env.PYTHON = fakePy;
delete process.env.SERPAPI_KEY;

const day = 864e5;
const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString();
const rec = (o) => ({
  v: 1, searchId: 's1', searchedAt: iso(0), route: 'TK:BOD', carriers: ['TK'], dest: 'BOD', via: ['IST'], cabin: 'economy',
  range: { outbound: '2027-03-01', inbound: '2027-03-08', flex: 1 }, outbound: '2027-03-01', inbound: '2027-03-08',
  price: 1200, currency: 'SGD', provider: 'serpapi', offers: 3, ...o,
});

// Files already in the folder at startup (an older search + one bad line), loaded automatically.
fs.writeFileSync(path.join(DIR, 'prices-2026-09.jsonl'), [
  JSON.stringify(rec({ searchId: 'old', searchedAt: iso(20 * day), price: 990 })),
  '{not json',
  JSON.stringify({ v: 1, route: 'TK:BOD' }), // invalid record
].join('\n') + '\n');

const db = require('../lib/db');
const live = require('../lib/live');
const server = require('../server');

test.after(() => { server.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

test('loads every .jsonl file in the folder; bad lines are skipped, not fatal', () => {
  const s = db.load();
  assert.deepEqual(s, { files: 1, records: 1, skipped: 2 });
});

test('save appends to the month\'s file and never rewrites earlier lines', () => {
  const before = fs.readFileSync(path.join(DIR, 'prices-2026-09.jsonl'), 'utf8');
  const saved = db.save([rec({ searchId: 'new', price: 1250 }), rec({ searchId: 'new', outbound: '2027-03-02', inbound: '2027-03-09', price: 1150 }), { bad: true }]);
  assert.equal(saved.length, 2);
  assert.equal(fs.readFileSync(path.join(DIR, 'prices-2026-09.jsonl'), 'utf8'), before);
  const month = new Date().toISOString().slice(0, 7);
  const lines = fs.readFileSync(path.join(DIR, `prices-${month}.jsonl`), 'utf8').trim().split('\n');
  assert.equal(lines.length, 2);
  assert.equal(db.load().records, 3); // reload from disk: still every search
});

test('prices for a range: latest search shown, every earlier search kept as reference', () => {
  const p = db.pricesForRange({ outbound: '2027-03-01', inbound: '2027-03-08', flex: 1 })['TK:BOD:economy'];
  assert.equal(p.latest.searchId, 'new');
  assert.equal(p.latest.price, 1150); // cheapest date pair of the latest search
  assert.equal(p.latest.preliminary, false);
  assert.deepEqual(p.history.map((h) => [h.searchId, h.price]), [['new', 1150], ['old', 990]]);
  assert.equal(p.lowest.price, 990);
  assert.equal(p.history[1].preliminary, true); // 20 days old > 14
  assert.equal(p.history[1].ageDays, 20);
  // Outside the range: not matched.
  assert.equal(db.pricesForRange({ outbound: '2027-04-01', inbound: '2027-04-08', flex: 3 })['TK:BOD:economy'], undefined);
  // Exact dates only: the 2 Mar pair is outside ±0.
  assert.equal(db.pricesForRange({ outbound: '2027-03-01', inbound: '2027-03-08', flex: 0 })['TK:BOD:economy'].latest.price, 1250);
});

test('saved searches list: one entry per search range, newest first', () => {
  const s = db.searches();
  assert.equal(s.length, 1);
  assert.deepEqual([s[0].outbound, s[0].inbound, s[0].flex, s[0].routes, s[0].prices], ['2027-03-01', '2027-03-08', 1, 1, 3]);
});

test('live search: reuses prices saved in the last 24 h, searches the rest, saves fresh results', async () => {
  fs.writeFileSync(calls, '');
  live._test.cache.clear();
  // 1 Mar and 2 Mar pairs were saved just now; flex 1 adds 28 Feb, which must be searched.
  const out = await live.lowestFareInWindow({ route: 'TK:BOD', carrier: 'TK', dest: 'BOD', via: ['IST'], cabin: 'economy', outbound: '2027-03-01', inbound: '2027-03-08', flex: 1 });
  assert.deepEqual(fs.readFileSync(calls, 'utf8').trim().split('\n'), ['2027-02-28']);
  assert.equal(out.reused, 2);
  assert.equal(out.lowest, 1150); // saved 2 Mar price beats the fresh 1,300
  const fresh = db._test.all().filter((r) => r.searchId === out.searchId);
  assert.equal(fresh.length, 1);
  assert.deepEqual([fresh[0].outbound, fresh[0].price, fresh[0].provider], ['2027-02-28', 1300, 'fast-flights']);
  assert.deepEqual(fresh[0].range, { outbound: '2027-03-01', inbound: '2027-03-08', flex: 1 });
  assert.ok(Date.now() - Date.parse(fresh[0].searchedAt) < 60e3);
});

test('API: routes carry saved prices for the range; your own price still wins', async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  let res = await (await fetch(`${base}/api/routes?outbound=2027-03-01&inbound=2027-03-08&flex=1`)).json();
  let row = res.rows.find((r) => r.key === 'TK:BOD:economy');
  assert.deepEqual(res.range, { outbound: '2027-03-01', inbound: '2027-03-08', flex: 1 });
  assert.equal(row.priceFrom, 'search');
  assert.equal(row.priceSgd, 1150);
  assert.equal(row.search.searches, 3);
  res = await (await fetch(`${base}/api/routes?outbound=2027-03-01&inbound=2027-03-08&flex=1&overrides=${encodeURIComponent('{"TK:BOD:economy":999}')}`)).json();
  row = res.rows.find((r) => r.key === 'TK:BOD:economy');
  assert.deepEqual([row.priceFrom, row.priceSgd], ['yours', 999]);
  // Advertised fares still show when there's no saved search.
  row = res.rows.find((r) => r.key === 'TK:IST:economy');
  assert.equal(row.priceFrom, 'advertised');

  const s = await (await fetch(`${base}/api/db/searches`)).json();
  assert.equal(s.searches[0].outbound, '2027-03-01');
  assert.equal(s.preliminaryDays, 14);
});

test('API: Google Flights imports are saved with the route\'s details from the data', async () => {
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (body, type = 'application/json') => fetch(`${base}/api/db/records`, { method: 'POST', headers: { 'Content-Type': type }, body: JSON.stringify(body) });
  let res = await post({ route: 'SQ+LX:BOD', cabin: 'economy', source: 'grid', range: { outbound: '2027-05-01', inbound: '2027-05-08', flex: 3 },
    prices: [{ outbound: '2027-05-01', inbound: '2027-05-08', price: 1050 }, { outbound: '2027-05-02', inbound: '2027-05-08', price: 990 }, { outbound: 'bad', inbound: 'x', price: 1 }] });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).saved, 2);
  const saved = db._test.all().filter((r) => r.route === 'SQ+LX:BOD');
  assert.deepEqual(saved[0].carriers, ['SQ', 'LX']);
  assert.deepEqual(saved[0].via, ['ZRH']);
  assert.equal(saved[0].provider, 'google-flights');
  assert.equal((await post({ route: 'XX:YYY', cabin: 'economy', prices: [] })).status, 400);
  assert.equal((await post({ route: 'SQ+LX:BOD', cabin: 'economy', prices: [] }, 'text/plain')).status, 415);
});

test('a range searched only long ago still shows its price, flagged preliminary', () => {
  const p = db.pricesForRange({ outbound: '2027-03-01', inbound: '2027-03-08', flex: 0 }, Date.now() + 30 * day)['TK:BOD:economy'];
  assert.equal(p.latest.preliminary, true);
  assert.ok(p.latest.ageDays >= 30);
  // A newer search for a date pair replaces the older result for that pair, but both stay in history.
  assert.ok(p.history.length >= 2);
});
