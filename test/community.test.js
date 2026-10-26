'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Checks every file committed in the real data/community folder (pull requests run this).
// MILES_COMMUNITY_CHECK_DIR lets the data repo's own check point this test at its files.
const REAL = process.env.MILES_COMMUNITY_CHECK_DIR || path.join(__dirname, '..', 'data', 'community');
const realFiles = (() => { try { return fs.readdirSync(REAL).filter((f) => f.endsWith('.jsonl')); } catch { return []; } })();
const realLines = realFiles.flatMap((f) => fs.readFileSync(path.join(REAL, f), 'utf8').split('\n').filter((l) => l.trim()).map((l, i) => ({ f, i: i + 1, l })));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'miles-community-'));
process.env.MILES_DB_DIR = path.join(tmp, 'db');
process.env.MILES_COMMUNITY_DIR = path.join(tmp, 'community');
process.env.MILES_CONFIG_DIR = path.join(tmp, '.local');
fs.mkdirSync(process.env.MILES_DB_DIR, { recursive: true });
fs.mkdirSync(process.env.MILES_COMMUNITY_DIR, { recursive: true });

const data = require('../data');
const db = require('../lib/db');

const day = 864e5;
const own = (o) => ({
  v: 1, searchId: 'abc', searchedAt: new Date(Date.now() - 5 * day).toISOString(), route: 'TK:BOD', carriers: ['TK'], dest: 'BOD', via: ['IST'],
  cabin: 'economy', range: { outbound: '2027-03-01', inbound: '2027-03-08', flex: 1 }, outbound: '2027-03-01', inbound: '2027-03-08',
  price: 1200, currency: 'SGD', provider: 'serpapi', offers: 3, ...o,
});
const shared = (o) => ({ v: 1, route: 'TK:BOD', cabin: 'economy', outbound: '2027-03-01', inbound: '2027-03-08', price: 1200, currency: 'SGD', provider: 'serpapi', searchedOn: new Date(Date.now() - 2 * day).toISOString().slice(0, 10), ...o });

test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

test('committed community files contain only anonymised, valid prices for known routes', () => {
  const routes = new Set(data.fares.map((f) => f.routeId));
  for (const { f, i, l } of realLines) {
    let r;
    assert.doesNotThrow(() => { r = JSON.parse(l); }, `${f}:${i} is not JSON`);
    assert.equal(db.communityProblem(r), null, `${f}:${i}: ${db.communityProblem(r)}`);
    assert.ok(routes.has(r.route), `${f}:${i}: unknown route ${r.route}`);
  }
});

test('anonymise: only the fields needed; search day only; no ids, times or search ranges', () => {
  const out = db.anonymise([own({})]);
  assert.equal(out.length, 1);
  assert.deepEqual(Object.keys(out[0]).sort(), db.COMMUNITY_FIELDS.slice().sort());
  assert.match(out[0].searchedOn, /^\d{4}-\d{2}-\d{2}$/);
  const text = JSON.stringify(out);
  for (const leak of ['searchId', 'searchedAt', 'range', 'abc', 'offers', 'T0', 'Z"']) assert.ok(!text.includes(leak), `leaks ${leak}`);
  assert.equal(db.communityProblem(out[0]), null);
});

test('anonymise: merges a session to one price per date pair and day, skips recent, unpriced and already-shared', () => {
  const list = [
    own({ price: 1300 }), own({ price: 1250, searchId: 'other' }), // same pair + day: keep the lowest
    own({ outbound: '2027-03-02', inbound: '2027-03-09', price: 1100 }),
    own({ outbound: '2027-03-03', inbound: '2027-03-10', price: null }), // no fares found: not shared
    own({ outbound: '2027-03-04', inbound: '2027-03-11', searchedAt: new Date().toISOString() }), // too recent
  ];
  const out = db.anonymise(list, { minAgeDays: 2 });
  assert.deepEqual(out.map((r) => r.price).sort(), [1100, 1250]);
  const again = db.anonymise(list, { minAgeDays: 2, shared: out });
  assert.equal(again.length, 0);
  assert.equal(db.anonymise(list, { minAgeDays: 0 }).length, 3);
});

test('validation rejects anything that could identify you or is malformed', () => {
  assert.match(db.communityProblem(shared({ searchedAt: '2026-10-27T08:35:12Z' })), /not allowed.*searchedAt/);
  assert.match(db.communityProblem(shared({ range: {} })), /not allowed.*range/);
  assert.match(db.communityProblem(shared({ price: 12.5 })), /whole number/);
  assert.match(db.communityProblem(shared({ price: 5 })), /between 50/);
  assert.match(db.communityProblem(shared({ currency: 'USD' })), /SGD/);
  assert.match(db.communityProblem(shared({ inbound: '2027-02-01' })), /dates/);
  assert.equal(db.communityProblem(shared({})), null);
});

test('share writes a new file that loads as community prices and is never re-shared', () => {
  fs.writeFileSync(path.join(process.env.MILES_DB_DIR, 'prices-test.jsonl'), [own({}), own({ outbound: '2027-03-02', inbound: '2027-03-09', price: 1100 })].map((r) => JSON.stringify(r)).join('\n') + '\n');
  db.load();
  const res = db.share({ minAgeDays: 2 });
  assert.equal(res.count, 2);
  assert.match(res.file, /prices-\d{4}-\d{2}-[0-9a-f]{6}\.jsonl$/);
  const lines = fs.readFileSync(path.join(process.env.MILES_COMMUNITY_DIR, path.basename(res.file)), 'utf8').trim().split('\n').map(JSON.parse);
  for (const r of lines) assert.equal(db.communityProblem(r), null);
  assert.equal(db.share({ minAgeDays: 2 }).count, 0);
  assert.equal(db.load().community.records, 2);
  // Your own shared file isn't a community report.
  assert.equal(db.communityForRange({ outbound: '2027-03-01', inbound: '2027-03-08', flex: 1 })['TK:BOD:economy'], undefined);
  // Files committed on a pull-request branch leave the working copy: still not shared again.
  fs.renameSync(path.join(process.env.MILES_COMMUNITY_DIR, path.basename(res.file)), path.join(tmp, 'moved.jsonl'));
  db.load();
  assert.equal(db.share({ minAgeDays: 2 }).count, 0);
});

test('community prices: reports counted across files; implausible prices ignored', () => {
  const dir = process.env.MILES_COMMUNITY_DIR;
  for (const f of fs.readdirSync(dir)) fs.unlinkSync(path.join(dir, f));
  const write = (name, list) => fs.writeFileSync(path.join(dir, name), list.map((r) => JSON.stringify(r)).join('\n') + '\n');
  write('a.jsonl', [shared({ price: 1200 })]);
  write('b.jsonl', [shared({ price: 1250 })]); // within 10% of 1,200: a second report
  write('c.jsonl', [shared({ price: 400, outbound: '2027-03-02', inbound: '2027-03-09' })]); // under half the typical price
  write('d.jsonl', ['{"v":1,"route":"TK:BOD","searchedAt":"x"}']); // rejected
  const s = db.load();
  assert.deepEqual(s.community, { files: 4, records: 3, skipped: 1 });
  const c = db.communityForRange({ outbound: '2027-03-01', inbound: '2027-03-08', flex: 1 })['TK:BOD:economy'];
  assert.equal(c.latest.price, 1200);
  assert.equal(c.latest.reports, 2);
  assert.equal(c.files, 2);
});

test('rows: your search wins, then community, then advertised; community kept as reference', () => {
  const { buildRows } = require('../lib/calc');
  const range = { outbound: '2027-03-01', inbound: '2027-03-08', flex: 1 };
  const rows = buildRows(data, { searchPrices: {}, communityPrices: db.communityForRange(range) });
  let row = rows.find((r) => r.key === 'TK:BOD:economy');
  assert.deepEqual([row.priceFrom, row.priceSgd, row.community.latest.reports], ['community', 1200, 2]);
  const withMine = buildRows(data, { searchPrices: db.pricesForRange(range), communityPrices: db.communityForRange(range) });
  row = withMine.find((r) => r.key === 'TK:BOD:economy');
  assert.equal(row.priceFrom, 'search');
  assert.ok(row.community, 'community price stays available as a reference');
});
