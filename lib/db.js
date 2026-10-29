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
//  "price":1050, "currency":"SGD", "provider":"serpapi", "offers":3,
//  "layoverMin":95, "maxLayover":240}
// price is null when the search ran but found no fares.
// layoverMin (v1.19+): longest connection of the priced itinerary in minutes (0 nonstop; absent = unknown).
// maxLayover (v1.19+): the "Max connection" limit the search used (absent/null = any).

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const DIR = process.env.MILES_DB_DIR || path.join(__dirname, '..', 'data', 'db');
// Community prices: anonymised files shared by other users (pull requests to the repo), committed in
// data/community. Loaded as a separate, clearly labelled layer, never mixed into your own searches.
const COMMUNITY_DIR = process.env.MILES_COMMUNITY_DIR || path.join(__dirname, '..', 'data', 'community');
const DAY_MS = 864e5;
const PRELIMINARY_DAYS = 14; // older searches are shown as preliminary prices
const REUSE_HOURS = Number(process.env.MILES_DB_REUSE_HOURS ?? 24); // reuse a saved price instead of searching again
const PROVIDERS = ['serpapi', 'fast-flights', 'google-flights'];

let records = [];
let community = []; // { ...record, file }
let loaded = false;
let skipped = 0;
let communitySkipped = 0;

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const isDay = (d) => ISO_DAY.test(String(d)) && !Number.isNaN(Date.parse(`${d}T00:00:00Z`));
const dayDiff = (a, b) => Math.round((Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / DAY_MS);

function valid(r) {
  return r && r.v === 1 && typeof r.route === 'string' && ['economy', 'premium'].includes(r.cabin) &&
    isDay(r.outbound) && isDay(r.inbound) && !Number.isNaN(Date.parse(r.searchedAt)) &&
    (r.price === null || (Number.isFinite(r.price) && r.price > 0)) && PROVIDERS.includes(r.provider) &&
    r.range && isDay(r.range.outbound) && isDay(r.range.inbound) &&
    (r.layoverMin == null || (Number.isInteger(r.layoverMin) && r.layoverMin >= 0)) &&
    (r.maxLayover == null || (Number.isInteger(r.maxLayover) && r.maxLayover > 0));
}

// "Max connection" filter (minutes; null = any).
const limitOf = (m) => (Number.isInteger(Number(m)) && Number(m) > 0 ? Number(m) : null);
// The priced itinerary's longest connection is within the limit (unknown counts as within).
const withinLimit = (r, max) => max == null || r.layoverMin == null || r.layoverMin <= max;
// The search behind a record looked at least as widely as the current limit, so its cheapest
// (or "no fares") result still holds under it.
const searchedAsWide = (r, max) => r.maxLayover == null || (max != null && r.maxLayover >= max);

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
  const c = loadCommunity();
  loaded = true;
  return { files: files.length, records: records.length, skipped, community: c };
}

// ---------- community prices (anonymised) ----------

// A shared record has exactly these fields: no search id, no time of day, no search range.
const COMMUNITY_FIELDS = ['v', 'route', 'cabin', 'outbound', 'inbound', 'price', 'currency', 'provider', 'searchedOn'];
const COMMUNITY_OPTIONAL = ['via', 'layoverMin'];
function communityProblem(r, now = Date.now()) {
  if (!r || typeof r !== 'object' || Array.isArray(r)) return 'not an object';
  // Optional: "via", the connection priced (e.g. ["TFU"]): it decides the miles on flexible rows;
  // "layoverMin", that itinerary's longest connection (minutes), for the "Max connection" filter.
  const keys = Object.keys(r).filter((k) => !COMMUNITY_OPTIONAL.includes(k)).sort();
  if ('via' in r && !(Array.isArray(r.via) && r.via.length <= 2 && r.via.every((v) => /^[A-Z]{3}$/.test(v)))) return 'via must be up to 2 IATA codes';
  if ('layoverMin' in r && !(Number.isInteger(r.layoverMin) && r.layoverMin >= 0 && r.layoverMin <= 4320)) return 'layoverMin must be whole minutes up to 3 days';
  if (keys.join() !== COMMUNITY_FIELDS.slice().sort().join()) {
    const extra = keys.filter((k) => !COMMUNITY_FIELDS.includes(k));
    return extra.length ? `fields not allowed (could identify you): ${extra.join(', ')}` : `missing fields: ${COMMUNITY_FIELDS.filter((k) => !keys.includes(k)).join(', ')}`;
  }
  if (r.v !== 1) return 'v must be 1';
  if (!/^[A-Z0-9+]+:[A-Z]{3}(@[A-Z]{3})?$/.test(r.route)) return 'bad route';
  if (!['economy', 'premium'].includes(r.cabin)) return 'bad cabin';
  if (!isDay(r.outbound) || !isDay(r.inbound) || r.inbound < r.outbound) return 'bad dates';
  if (!Number.isInteger(r.price) || r.price < 50 || r.price > 50000) return 'price must be a whole number of SGD between 50 and 50,000';
  if (r.currency !== 'SGD') return 'currency must be SGD';
  if (!PROVIDERS.includes(r.provider)) return 'bad provider';
  if (!isDay(r.searchedOn) || Date.parse(`${r.searchedOn}T00:00:00Z`) > now + DAY_MS) return 'bad searchedOn';
  return null;
}

function loadCommunity() {
  community = [];
  communitySkipped = 0;
  let files = [];
  try { files = fs.readdirSync(COMMUNITY_DIR).filter((f) => f.endsWith('.jsonl')).sort(); } catch { /* none yet */ }
  for (const f of files) {
    for (const line of fs.readFileSync(path.join(COMMUNITY_DIR, f), 'utf8').split('\n')) {
      if (!line.trim()) continue;
      let r;
      try { r = JSON.parse(line); } catch { communitySkipped++; continue; }
      if (communityProblem(r)) { communitySkipped++; continue; }
      community.push({ ...r, file: f });
    }
  }
  return { files: files.length, records: community.length, skipped: communitySkipped };
}

// Your saved prices, anonymised for sharing:
//  - only priced records (no "no fares" results), from searches at least minAgeDays old
//  - search time cut to the day; search id and your search range dropped
//  - one record per route + cabin + date pair + day (the lowest price), so a session can't be
//    picked out as a group; shuffled so file order says nothing
//  - records already in data/community are left out
function anonymise(list, { minAgeDays = 2, now = Date.now(), shared = [] } = {}) {
  const sharedKeys = new Set(shared.map((r) => [r.route, r.cabin, r.outbound, r.inbound, r.searchedOn, r.price].join('|')));
  const best = new Map();
  for (const r of list) {
    if (r.price == null || now - Date.parse(r.searchedAt) < minAgeDays * DAY_MS) continue;
    const out = { v: 1, route: r.route, cabin: r.cabin, outbound: r.outbound, inbound: r.inbound,
      price: Math.round(r.price), currency: 'SGD', provider: r.provider, searchedOn: r.searchedAt.slice(0, 10) };
    if (Array.isArray(r.via) && r.via.length) out.via = r.via; // which connection was priced (not personal)
    if (Number.isInteger(r.layoverMin)) out.layoverMin = r.layoverMin;
    if (communityProblem(out, now)) continue;
    const k = [out.route, out.cabin, out.outbound, out.inbound, out.searchedOn].join('|');
    if (!best.has(k) || out.price < best.get(k).price) best.set(k, out);
  }
  const res = [...best.values()].filter((r) => !sharedKeys.has([r.route, r.cabin, r.outbound, r.inbound, r.searchedOn, r.price].join('|')));
  for (let i = res.length - 1; i > 0; i--) { // shuffle
    const j = crypto.randomInt(i + 1);
    [res[i], res[j]] = [res[j], res[i]];
  }
  return res;
}

// What you've already shared, so nothing is shared twice even after the files leave your working copy
// (e.g. committed on a pull-request branch). Kept next to your database, never shared itself.
const LEDGER = path.join(DIR, 'shared.ledger');
// Names of the share files you created: your own prices aren't counted as community reports.
const OWN_FILES = path.join(DIR, 'shared-files.ledger');
const ownFiles = () => { try { return new Set(fs.readFileSync(OWN_FILES, 'utf8').split('\n').filter(Boolean)); } catch { return new Set(); } };
function ledger() {
  try {
    return fs.readFileSync(LEDGER, 'utf8').split('\n').filter(Boolean).map((l) => {
      const [route, cabin, outbound, inbound, searchedOn, price] = l.split('|');
      return { route, cabin, outbound, inbound, searchedOn, price: Number(price) };
    });
  } catch { return []; }
}

// Write your anonymised prices to data/community/prices-YYYY-MM-<random>.jsonl, ready to commit.
function share({ minAgeDays = 2, now = Date.now() } = {}) {
  ensure();
  const list = anonymise(records, { minAgeDays, now, shared: [...community, ...ledger()] });
  if (!list.length) return { file: null, count: 0 };
  fs.mkdirSync(COMMUNITY_DIR, { recursive: true });
  const name = `prices-${new Date(now).toISOString().slice(0, 7)}-${crypto.randomBytes(3).toString('hex')}.jsonl`;
  fs.writeFileSync(path.join(COMMUNITY_DIR, name), list.map((r) => JSON.stringify(r)).join('\n') + '\n');
  fs.mkdirSync(DIR, { recursive: true });
  fs.appendFileSync(LEDGER, list.map((r) => [r.route, r.cabin, r.outbound, r.inbound, r.searchedOn, r.price].join('|')).join('\n') + '\n');
  fs.appendFileSync(OWN_FILES, `${name}\n`);
  community.push(...list.map((r) => ({ ...r, file: name })));
  return { file: path.join(path.relative(path.join(__dirname, '..'), COMMUNITY_DIR), name), count: list.length };
}

const median = (xs) => { const a = xs.slice().sort((x, y) => x - y); const m = a.length >> 1; return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2; };

// Community prices for a date range, per route + cabin:
//   latest:  newest report per date pair, then the cheapest (fresh reports preferred), with
//            reports = how many shared files gave that pair a price within 10% of it
//   files:   how many shared files reported anything for this row in the range
// Implausible prices (under half or over 3x the typical shared price for the route) are ignored
// once there are 3+ reports to compare against.
function communityForRange(range, now = Date.now()) {
  ensure();
  const flex = Number(range.flex) || 0;
  const mine = ownFiles();
  const max = limitOf(range.maxLayover);
  const others = community.filter((r) => !mine.has(r.file));
  const typical = new Map();
  for (const r of others) {
    const k = `${r.route}:${r.cabin}`;
    (typical.get(k) || typical.set(k, []).get(k)).push(r.price);
  }
  const plausible = (r) => {
    const all = typical.get(`${r.route}:${r.cabin}`);
    if (all.length < 3) return true;
    const m = median(all);
    return r.price >= m / 2 && r.price <= m * 3;
  };
  const by = {};
  for (const r of others) {
    if (Math.abs(dayDiff(r.outbound, range.outbound)) > flex || Math.abs(dayDiff(r.inbound, range.inbound)) > flex) continue;
    if (!plausible(r) || !withinLimit(r, max)) continue;
    const k = `${r.route}:${r.cabin}`;
    (by[k] = by[k] || []).push(r);
  }
  const out = {};
  for (const [k, list] of Object.entries(by)) {
    const pairs = new Map();
    for (const r of list) {
      const p = `${r.outbound}|${r.inbound}`;
      const cur = pairs.get(p);
      if (!cur || r.searchedOn > cur.searchedOn || (r.searchedOn === cur.searchedOn && r.price < cur.price)) pairs.set(p, r);
    }
    const cand = [...pairs.values()].map((r) => {
      const age = Math.floor((now - Date.parse(`${r.searchedOn}T00:00:00Z`)) / DAY_MS);
      const reports = new Set(list.filter((x) => x.outbound === r.outbound && x.inbound === r.inbound && Math.abs(x.price - r.price) <= r.price * 0.1).map((x) => x.file)).size;
      return { price: r.price, outbound: r.outbound, inbound: r.inbound, via: r.via, layoverMin: r.layoverMin, searchedOn: r.searchedOn, provider: r.provider, ageDays: age, preliminary: age > PRELIMINARY_DAYS, reports };
    });
    const pool = cand.some((c) => !c.preliminary) ? cand.filter((c) => !c.preliminary) : cand;
    const latest = pool.sort((a, b) => a.price - b.price || b.searchedOn.localeCompare(a.searchedOn))[0];
    out[k] = { latest, files: new Set(list.map((x) => x.file)).size };
  }
  return out;
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
function reusable({ route, cabin, outbound, inbound, maxLayover }, now = Date.now()) {
  ensure();
  const max = limitOf(maxLayover);
  if (!(REUSE_HOURS > 0)) return null;
  for (let i = records.length - 1; i >= 0; i--) {
    const r = records[i];
    if (now - Date.parse(r.searchedAt) > REUSE_HOURS * 3600e3) break; // sorted by time
    // Only priced results are reused: a "no fares found" result is cheap to retry and may have been a glitch.
    // Under a "Max connection" limit, only a search at least as wide whose itinerary fits counts.
    if (r.price != null && r.route === route && r.cabin === cabin && r.outbound === outbound && r.inbound === inbound &&
        searchedAsWide(r, max) && withinLimit(r, max)) return r;
  }
  return null;
}

const ageDays = (r, now = Date.now()) => Math.floor((now - Date.parse(r.searchedAt)) / DAY_MS);
const brief = (r, now) => ({
  price: r.price, outbound: r.outbound, inbound: r.inbound, via: Array.isArray(r.via) ? r.via : undefined,
  layoverMin: Number.isInteger(r.layoverMin) ? r.layoverMin : undefined, searchedAt: r.searchedAt, provider: r.provider,
  searchId: r.searchId, ageDays: ageDays(r, now), preliminary: ageDays(r, now) > PRELIMINARY_DAYS,
});

// Saved prices for a date range: records whose dates fall within range.outbound/inbound ± flex.
// Per route + cabin ("SQ+LX:BOD:economy"):
//   latest:  the current price (what the table shows): the newest price for each date pair, then the
//            cheapest of those. Pairs searched in the last 14 days win over older (preliminary) ones.
//   history: cheapest price of every search, newest first (price reference; never discarded)
//   lowest:  cheapest price ever saved in the range
// range.maxLayover (minutes): leave out prices whose itinerary has a longer connection, and "no fares"
// results from narrower searches. Saved prices re-filter without searching again.
function pricesForRange(range, now = Date.now()) {
  ensure();
  const flex = Number(range.flex) || 0;
  const max = limitOf(range.maxLayover);
  const out = {};
  for (const r of records) { // records are in search order, so later ones replace earlier per pair
    if (Math.abs(dayDiff(r.outbound, range.outbound)) > flex || Math.abs(dayDiff(r.inbound, range.inbound)) > flex) continue;
    if (r.price != null ? !withinLimit(r, max) : !searchedAsWide(r, max)) continue;
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
  return { dir: DIR, records: records.length, skipped, reuseHours: REUSE_HOURS, preliminaryDays: PRELIMINARY_DAYS,
    community: { records: community.length, files: new Set(community.map((r) => r.file)).size, skipped: communitySkipped } };
}

module.exports = {
  load, save, reusable, pricesForRange, searches, stats, newSearchId, valid,
  anonymise, share, communityForRange, communityProblem, loadCommunity, COMMUNITY_FIELDS, COMMUNITY_OPTIONAL, limitOf,
  DIR, COMMUNITY_DIR, PRELIMINARY_DAYS, PROVIDERS,
  _test: { all: () => records, community: () => community, reset: () => { records = []; community = []; loaded = true; } },
};
