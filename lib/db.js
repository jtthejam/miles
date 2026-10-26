'use strict';

// Price database: every price found (live searches and Google Flights imports) is kept as one JSON
// line in data/db/*.jsonl. Files are append-only: nothing is ever deleted, so old searches stay
// available as a price reference. On startup every *.jsonl file in the folder is loaded, so you can
// also drop in files from another computer.
//
// One record = one priced date pair:
// {"v":1, "searchId":"…", "searchedAt":"2026-10-27T08:35:12.345Z",
//  "route":"SQ+LX:BOD", "carriers":["SQ","LX"], "dest":"BOD", "via":["ZRH"], "cabin":"economy",
//  "range":{"outbound":"2026-12-01","inbound":"2026-12-08","flex":1},   <- the search you asked for
//  "outbound":"2026-11-30", "inbound":"2026-12-07",                     <- the dates this price is for
//  "price":1050, "currency":"SGD", "provider":"serpapi", "offers":3}
// price is null when the search ran but found no fares.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const DIR = process.env.MILES_DB_DIR || path.join(__dirname, '..', 'data', 'db');
const DAY_MS = 864e5;
const PRELIMINARY_DAYS = 14; // older searches are shown as preliminary prices
const REUSE_HOURS = Number(process.env.MILES_DB_REUSE_HOURS ?? 24); // reuse a saved price instead of searching again
const PROVIDERS = ['serpapi', 'fast-flights', 'google-flights'];

let records = [];
let loaded = false;
let skipped = 0;

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const isDay = (d) => ISO_DAY.test(String(d)) && !Number.isNaN(Date.parse(`${d}T00:00:00Z`));
const dayDiff = (a, b) => Math.round((Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / DAY_MS);

function valid(r) {
  return r && r.v === 1 && typeof r.route === 'string' && ['economy', 'premium'].includes(r.cabin) &&
    isDay(r.outbound) && isDay(r.inbound) && !Number.isNaN(Date.parse(r.searchedAt)) &&
    (r.price === null || (Number.isFinite(r.price) && r.price > 0)) && PROVIDERS.includes(r.provider) &&
    r.range && isDay(r.range.outbound) && isDay(r.range.inbound);
}

// Load every *.jsonl file in the folder. Bad lines are skipped (and counted), never fatal.
function load() {
  records = [];
  skipped = 0;
  let files = [];
  try { files = fs.readdirSync(DIR).filter((f) => f.endsWith('.jsonl')).sort(); } catch { /* no folder yet */ }
  for (const f of files) {
    const text = fs.readFileSync(path.join(DIR, f), 'utf8');
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      let r;
      try { r = JSON.parse(line); } catch { skipped++; continue; }
      if (valid(r)) records.push(r); else skipped++;
    }
  }
  records.sort((a, b) => a.searchedAt.localeCompare(b.searchedAt));
  loaded = true;
  return { files: files.length, records: records.length, skipped };
}

const ensure = () => { if (!loaded) load(); };

const newSearchId = (at = new Date()) => `${at.toISOString()}-${crypto.randomBytes(3).toString('hex')}`;

// Append records (one search) to this month's file. Returns the records as saved.
function save(list) {
  ensure();
  const ok = list.filter(valid);
  if (!ok.length) return [];
  fs.mkdirSync(DIR, { recursive: true });
  const byFile = new Map();
  for (const r of ok) {
    const f = path.join(DIR, `prices-${r.searchedAt.slice(0, 7)}.jsonl`);
    byFile.set(f, (byFile.get(f) || '') + JSON.stringify(r) + '\n');
  }
  for (const [f, text] of byFile) fs.appendFileSync(f, text);
  records.push(...ok);
  return ok;
}

// A saved price for exactly this route, cabin and date pair, found within REUSE_HOURS (newest first).
function reusable({ route, cabin, outbound, inbound }, now = Date.now()) {
  ensure();
  if (!(REUSE_HOURS > 0)) return null;
  for (let i = records.length - 1; i >= 0; i--) {
    const r = records[i];
    if (now - Date.parse(r.searchedAt) > REUSE_HOURS * 3600e3) break; // sorted by time
    if (r.route === route && r.cabin === cabin && r.outbound === outbound && r.inbound === inbound) return r;
  }
  return null;
}

const ageDays = (r, now = Date.now()) => Math.floor((now - Date.parse(r.searchedAt)) / DAY_MS);
const brief = (r, now) => ({
  price: r.price, outbound: r.outbound, inbound: r.inbound, searchedAt: r.searchedAt, provider: r.provider,
  searchId: r.searchId, ageDays: ageDays(r, now), preliminary: ageDays(r, now) > PRELIMINARY_DAYS,
});

// Saved prices for a date range: records whose dates fall within range.outbound/inbound ± flex.
// Per route + cabin ("SQ+LX:BOD:economy"):
//   latest:  the current price (what the table shows): the newest price for each date pair, then the
//            cheapest of those. Pairs searched in the last 14 days win over older (preliminary) ones.
//   history: cheapest price of every search, newest first (price reference; never discarded)
//   lowest:  cheapest price ever saved in the range
function pricesForRange(range, now = Date.now()) {
  ensure();
  const flex = Number(range.flex) || 0;
  const out = {};
  for (const r of records) { // records are in search order, so later ones replace earlier per pair
    if (Math.abs(dayDiff(r.outbound, range.outbound)) > flex || Math.abs(dayDiff(r.inbound, range.inbound)) > flex) continue;
    const key = `${r.route}:${r.cabin}`;
    const e = (out[key] = out[key] || { bySearch: new Map(), byPair: new Map() });
    e.byPair.set(`${r.outbound}|${r.inbound}`, r); // newest result per date pair (a "no fares" result too)
    if (r.price == null) continue;
    const cur = e.bySearch.get(r.searchId);
    if (!cur || r.price < cur.price) e.bySearch.set(r.searchId, r);
  }
  for (const key of Object.keys(out)) {
    const history = [...out[key].bySearch.values()]
      .sort((a, b) => b.searchedAt.localeCompare(a.searchedAt))
      .map((r) => brief(r, now));
    const current = [...out[key].byPair.values()].filter((r) => r.price != null).map((r) => brief(r, now));
    if (!history.length || !current.length) { delete out[key]; continue; }
    const pool = current.some((c) => !c.preliminary) ? current.filter((c) => !c.preliminary) : current;
    const latest = pool.sort((a, b) => a.price - b.price || b.searchedAt.localeCompare(a.searchedAt))[0];
    out[key] = {
      latest,
      lowest: history.reduce((m, h) => (h.price < m.price ? h : m), history[0]),
      history,
    };
  }
  return out;
}

// Distinct search ranges you've searched, newest first, for the "Saved searches" picker.
function searches(now = Date.now()) {
  ensure();
  const m = new Map();
  for (const r of records) {
    const k = `${r.range.outbound}|${r.range.inbound}|${Number(r.range.flex) || 0}`;
    const e = m.get(k) || { outbound: r.range.outbound, inbound: r.range.inbound, flex: Number(r.range.flex) || 0, routes: new Set(), prices: 0, firstSearched: r.searchedAt, lastSearched: r.searchedAt };
    e.routes.add(`${r.route}:${r.cabin}`);
    if (r.price != null) e.prices++;
    if (r.searchedAt > e.lastSearched) e.lastSearched = r.searchedAt;
    if (r.searchedAt < e.firstSearched) e.firstSearched = r.searchedAt;
    m.set(k, e);
  }
  return [...m.values()]
    .map((e) => ({ ...e, routes: e.routes.size, ageDays: Math.floor((now - Date.parse(e.lastSearched)) / DAY_MS) }))
    .sort((a, b) => b.lastSearched.localeCompare(a.lastSearched));
}

function stats() {
  ensure();
  return { dir: DIR, records: records.length, skipped, reuseHours: REUSE_HOURS, preliminaryDays: PRELIMINARY_DAYS };
}

module.exports = {
  load, save, reusable, pricesForRange, searches, stats, newSearchId, valid,
  DIR, PRELIMINARY_DAYS, PROVIDERS, _test: { all: () => records, reset: () => { records = []; loaded = true; } },
};
