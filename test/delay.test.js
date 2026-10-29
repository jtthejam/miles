'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// fast-flights searches: one at a time, with a normally distributed pause (mean 1 s, sd 0.25 s).
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'miles-delay-'));
const log = path.join(tmp, 'starts.log');
const fakePy = path.join(tmp, 'fake-python');
fs.writeFileSync(fakePy, `#!/bin/sh
if [ "$1" = "-c" ]; then exit 0; fi
node -e "process.stdout.write(String(Date.now()))" >> "${log}"; echo >> "${log}"
sleep 0.2
echo '{"lowest": 1000, "average": 1000, "offers": 1, "skipped": 0}'
`, { mode: 0o755 });
process.env.PYTHON = fakePy;
process.env.MILES_DB_DIR = path.join(tmp, 'db');
process.env.MILES_COMMUNITY_DIR = path.join(tmp, 'community');
process.env.MILES_CONFIG_DIR = path.join(tmp, '.local');
process.env.MILES_DB_REUSE_HOURS = '0';
process.env.MILES_FF_DELAY_MEAN_MS = '300'; // scaled down for the test; same distribution shape
process.env.MILES_FF_DELAY_SD_MS = '75';
delete process.env.SERPAPI_KEY;
const live = require('../lib/live');

test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

test('gaussian: mean 1 s, standard deviation 0.25 s, never negative', () => {
  const xs = Array.from({ length: 20000 }, () => live.gaussian(1000, 250));
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const sd = Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / xs.length);
  assert.ok(Math.abs(mean - 1000) < 15, `mean ${mean}`);
  assert.ok(Math.abs(sd - 250) < 10, `sd ${sd}`);
  assert.ok(Array.from({ length: 5000 }, () => live.ffDelay()).every((d) => d >= 0));
});

test('fast-flights searches run one at a time with a pause between them', async () => {
  await live.checkFastFlights();
  live._test.cache.clear();
  // ±2 days = 5 searches; date pairs would otherwise run 2 at a time.
  await live.lowestFareInWindow({ carrier: 'SQ', dest: 'LAX', cabin: 'economy', outbound: '2027-05-10', inbound: '2027-05-17', flex: 2 });
  const starts = fs.readFileSync(log, 'utf8').trim().split('\n').map(Number);
  assert.equal(starts.length, 5);
  const gaps = starts.slice(1).map((t, i) => t - starts[i]);
  // Each gap = previous search (~200 ms) + pause (300 ± 75 ms): never overlapping, never back to back.
  for (const g of gaps) assert.ok(g >= 200 + 50, `gap ${g} ms`);
  const meanGap = gaps.reduce((a, b) => a + b, 0) / gaps.length;
  assert.ok(meanGap > 400 && meanGap < 800, `mean gap ${meanGap} ms`);
});
