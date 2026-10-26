#!/usr/bin/env node
'use strict';

// Share your saved prices with other users, anonymised.
//
//   node scripts/share_prices.js [--min-age-days 2]
//
// Writes data/community/prices-YYYY-MM-<random>.jsonl from data/db: priced results only, at least
// --min-age-days old, with the search time cut to the day and your search ranges and search ids
// removed (see lib/db.js anonymise). Then commit it and open a pull request, e.g.:
//   git checkout -b share-prices && git add data/community && git commit -m "Share prices" && git push -u origin share-prices
const db = require('../lib/db');

const i = process.argv.indexOf('--min-age-days');
const minAgeDays = i > 0 ? Number(process.argv[i + 1]) : 2;
if (!(minAgeDays >= 0)) { console.error('--min-age-days must be 0 or more'); process.exit(1); }

db.load();
const { file, count } = db.share({ minAgeDays });
if (!count) {
  console.log(`Nothing new to share (prices must be at least ${minAgeDays} day(s) old and not already in data/community).`);
} else {
  console.log(`Wrote ${count} anonymised price(s) to ${file}`);
  console.log('Check the file, then commit it and open a pull request:');
  console.log('  git checkout -b share-prices && git add data/community && git commit -m "Share prices" && git push -u origin share-prices');
}
