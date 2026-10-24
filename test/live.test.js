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
echo '{"lowest": 1650, "average": 1900, "offers": 4}'
`, { mode: 0o755 });
process.env.MILES_CONFIG_DIR = path.join(tmp, '.local');
process.env.PYTHON = fakePy;
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
