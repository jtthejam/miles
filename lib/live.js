'use strict';

// Live fares. Provider order:
//   1. SerpApi (official Google Flights API; free tier 250 searches/month) when a key is set
//   2. fast-flights (unofficial Python scraper; free, may break) as the fallback
// Results are cached for 6 hours per airline/route/cabin/dates.
// Travel dates are optional (default: ~60 days out, 7 nights). Flexible dates (±1-3 days) search each
// shifted trip (same length) and return the cheapest, with the dates it was found on.
const { execFile } = require('node:child_process');
const path = require('node:path');
const settings = require('./settings');

const SERPAPI = 'https://serpapi.com/search.json';
const TRAVEL_CLASS = { economy: 1, premium: 2 }; // Google Flights: 1 economy, 2 premium economy
const TTL_MS = 6 * 60 * 60 * 1000;
const PYTHON = process.env.PYTHON || 'python3';
const FF_SCRIPT = path.join(__dirname, '..', 'scripts', 'ff_quote.py');
const cache = new Map();
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_FLEX = 3;
const FLEX_CONCURRENCY = 2; // be gentle with SerpApi / Google
const DEFAULT_LEAD_DAYS = 60;
const DEFAULT_NIGHTS = 7;

// ---------- provider availability ----------

let ffAvailable = null; // null = not checked yet
function checkFastFlights() {
  return new Promise((resolve) => {
    execFile(PYTHON, ['-c', 'import fast_flights'], { timeout: 15000 }, (err) => {
      ffAvailable = !err;
      resolve(ffAvailable);
    });
  });
}

function status() {
  const key = settings.keySource();
  const provider = key ? 'serpapi' : ffAvailable ? 'fast-flights' : null;
  return { provider, serpApiKey: key, fastFlights: !!ffAvailable };
}

const enabled = () => !!status().provider;

// ---------- validation ----------

function validate({ carrier, dest, cabin, outbound, inbound, via = [] }) {
  if (!Array.isArray(via) || via.length > 2 || !via.every((v) => /^[A-Z]{3}$/.test(v))) throw new Error('via must be up to 2 IATA codes');
  if (!TRAVEL_CLASS[cabin]) throw new Error('cabin must be economy or premium');
  if (!/^[A-Z]{3}$/.test(dest)) throw new Error('dest must be an IATA code');
  if (!/^[A-Z0-9]{2}$/.test(carrier)) throw new Error('carrier must be a 2-letter airline code');
  if (!isRealDate(String(outbound)) || !isRealDate(String(inbound))) {
    throw new Error('dates must be YYYY-MM-DD');
  }
}

// ---------- travel dates ----------

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const isRealDate = (d) => {
  if (!ISO.test(d)) return false;
  const t = Date.parse(`${d}T00:00:00Z`);
  return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === d; // rejects e.g. 2027-02-30
};
const addDays = (d, n) => new Date(Date.parse(`${d}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
const nightsBetween = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY_MS);
// Flights depart Singapore, so "today" is Singapore's date (UTC+8).
const todaySgt = () => new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);

// Resolve optional dates and flex into the list of round trips to search.
// Each pair shifts departure and return by the same number of days, so trip length stays as chosen.
function datePairs({ outbound, inbound, flex = 0, today = todaySgt() } = {}) {
  flex = Number(flex || 0);
  if (!Number.isInteger(flex) || flex < 0 || flex > MAX_FLEX) throw new Error(`flex must be 0 to ${MAX_FLEX} days`);
  if (!outbound && inbound) throw new Error('Add a departure date, or clear the return date');
  if (!outbound) outbound = addDays(today, DEFAULT_LEAD_DAYS);
  if (!isRealDate(outbound)) throw new Error('dates must be YYYY-MM-DD');
  if (!inbound) inbound = addDays(outbound, DEFAULT_NIGHTS);
  if (!isRealDate(inbound)) throw new Error('dates must be YYYY-MM-DD');
  if (inbound < outbound) throw new Error('Return date must be on or after the departure date');
  if (outbound < today) throw new Error('Departure date is in the past');

  const pairs = [];
  for (let d = 0 - flex; d <= flex; d++) { // 0 - flex, not -flex: avoids a -0 shift
    const out = addDays(outbound, d);
    if (out < today) continue; // can't search past departures
    pairs.push({ outbound: out, inbound: addDays(inbound, d), shift: d });
  }
  return { outbound, inbound, flex, nights: nightsBetween(outbound, inbound), pairs };
}

// ---------- providers ----------

// Connecting routes: the row's miles assume a specific connection (e.g. SIN-IST-BOD), so only offers
// that connect there count. Offers are matched on their outbound layover airports.
const connectsVia = (layovers, via) => layovers.length === via.length && layovers.every((id, i) => id === via[i]);

async function viaSerpApi({ carrier, dest, cabin, outbound, inbound, via = [] }, apiKey) {
  const params = new URLSearchParams({
    engine: 'google_flights',
    departure_id: 'SIN',
    arrival_id: dest,
    outbound_date: outbound,
    return_date: inbound,
    type: '1', // round trip
    travel_class: String(TRAVEL_CLASS[cabin]),
    currency: 'SGD',
    hl: 'en',
    gl: 'sg',
    include_airlines: carrier, // accrual depends on the operating carrier
    api_key: apiKey,
  });
  if (via.length) params.set('stops', String(via.length + 1)); // SerpApi: 2 = 1 stop or fewer, 3 = 2 stops or fewer
  const res = await fetch(`${SERPAPI}?${params}`);
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.error) throw new Error(`SerpApi: ${json.error || `HTTP ${res.status}`}`);

  let all = [...(json.best_flights || []), ...(json.other_flights || [])];
  const total = all.length;
  if (via.length) all = all.filter((f) => connectsVia((f.layovers || []).map((l) => l.id), via));
  const offers = all.map((f) => f.price).filter((p) => typeof p === 'number');
  return {
    // price_insights covers every connection, so it's only used for nonstop rows.
    lowest: (via.length ? null : json.price_insights?.lowest_price) ?? (offers.length ? Math.min(...offers) : null),
    otherConnections: via.length ? total - all.length : undefined,
    average: offers.length ? Math.round(offers.reduce((s, p) => s + p, 0) / offers.length) : null,
    offers: offers.length,
    typicalRange: json.price_insights?.typical_price_range ?? null,
  };
}

function viaFastFlights({ carrier, dest, cabin, outbound, inbound, via = [] }) {
  return new Promise((resolve, reject) => {
    execFile(PYTHON, [FF_SCRIPT, dest, cabin, outbound, inbound, carrier, via.join(',') || '-'], { timeout: 45000 }, (err, stdout) => {
      let out;
      try { out = JSON.parse(String(stdout).trim().split('\n').pop()); } catch { out = null; }
      if (out && !out.error) return resolve({ ...out, typicalRange: null });
      reject(new Error(out?.error || `fast-flights failed${err ? `: ${err.message}` : ''}`));
    });
  });
}

// ---------- public ----------

// Run fn over items with at most `limit` in flight; returns settled results in input order.
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      try { out[i] = { ok: true, value: await fn(items[i]) }; } catch (e) { out[i] = { ok: false, error: e }; }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

// Lowest round-trip fare within the chosen travel dates (± flex days). Dates are optional.
// Returns the cheapest trip's fare and dates, plus the fare found for each date searched.
async function lowestFareInWindow(q) {
  q = { carrier: 'SQ', ...q };
  const win = datePairs(q);
  const results = await mapLimit(win.pairs, FLEX_CONCURRENCY, (p) => lowestReturnFare({ ...q, outbound: p.outbound, inbound: p.inbound }));

  const byDate = win.pairs.map((p, i) => ({
    outbound: p.outbound,
    inbound: p.inbound,
    shift: p.shift,
    lowest: results[i].ok ? results[i].value.lowest : null,
    error: results[i].ok ? undefined : results[i].error.message,
  }));
  const ok = results.filter((r) => r.ok).map((r) => r.value);
  if (!ok.length) throw results[0].error; // every date failed: surface the first reason

  const priced = ok.filter((v) => typeof v.lowest === 'number');
  // Cheapest; ties go to the date closest to the one asked for.
  const best = priced.sort((a, b) => a.lowest - b.lowest ||
    Math.abs(nightsBetween(win.outbound, a.outbound)) - Math.abs(nightsBetween(win.outbound, b.outbound)))[0] || ok[0];
  const providers = [...new Set(ok.map((v) => v.provider))];

  return {
    ...best,
    lowest: best.lowest ?? null,
    requested: { outbound: win.outbound, inbound: win.inbound, flex: win.flex, nights: win.nights },
    window: { from: win.pairs[0].outbound, to: win.pairs[win.pairs.length - 1].inbound },
    searched: win.pairs.length,
    failed: byDate.filter((d) => d.error).length,
    providers,
    byDate,
  };
}

async function lowestReturnFare(q) {
  q = { carrier: 'SQ', ...q };
  validate(q);
  q.via = q.via || [];
  const key = [q.carrier, q.dest, q.via.join('-'), q.cabin, q.outbound, q.inbound].join('|');
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return { ...hit.value, cached: true };

  if (ffAvailable === null) await checkFastFlights();
  const apiKey = settings.serpApiKey();
  let value;
  if (apiKey) {
    try {
      value = { ...(await viaSerpApi(q, apiKey)), provider: 'serpapi' };
    } catch (e) {
      // Quota exhausted or bad key: fall back to fast-flights if available.
      if (!ffAvailable) throw e;
      value = { ...(await viaFastFlights(q)), provider: 'fast-flights', fallbackReason: e.message };
    }
  } else if (ffAvailable) {
    value = { ...(await viaFastFlights(q)), provider: 'fast-flights' };
  } else {
    throw new Error('Live prices are off: add a SerpApi key, or run "pip install fast-flights"');
  }

  value = { ...q, ...value };
  cache.set(key, { at: Date.now(), value });
  return value;
}

module.exports = { lowestReturnFare, lowestFareInWindow, datePairs, status, enabled, checkFastFlights, MAX_FLEX, _test: { cache } };
