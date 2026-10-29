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
const db = require('./db');

const SERPAPI = 'https://serpapi.com/search.json';
const TRAVEL_CLASS = { economy: 1, premium: 2 }; // Google Flights: 1 economy, 2 premium economy
const TTL_MS = 6 * 60 * 60 * 1000;
const PYTHON = process.env.PYTHON || 'python3';
const FF_SCRIPT = path.join(__dirname, '..', 'scripts', 'ff_quote.py');
const FF_TIMEOUT_MS = Number(process.env.MILES_FF_TIMEOUT_MS) || 45000;
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

// Route shape for searches: carriers (every airline on the ticket), via (connections) and, for mixed
// routes, segmentCarriers (who flies each segment, in order) + airlineNames (as Google shows them).
function validate({ carriers, dest, cabin, outbound, inbound, via = [], segmentCarriers = null }) {
  if (!Array.isArray(via) || via.length > 2 || !via.every((v) => /^[A-Z]{3}$/.test(v))) throw new Error('via must be up to 2 IATA codes');
  if (!Array.isArray(carriers) || !carriers.length || !carriers.every((c) => /^[A-Z0-9]{2}$/.test(c))) throw new Error('carrier must be a 2-letter airline code');
  if (segmentCarriers && segmentCarriers.length !== via.length + 1) throw new Error('segmentCarriers must list one airline per segment');
  if (!TRAVEL_CLASS[cabin]) throw new Error('cabin must be economy or premium');
  if (!/^[A-Z]{3}$/.test(dest)) throw new Error('dest must be an IATA code');
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
// Mixed routes: each outbound segment must be flown (marketed) by the route's airline for it, e.g. SQ then LX.
const flownBy = (flights, segmentCarriers) => flights.length >= segmentCarriers.length &&
  segmentCarriers.every((c, i) => String(flights[i].flight_number || '').replace(/\s+/g, '').toUpperCase().startsWith(c));

async function viaSerpApi({ carriers, dest, cabin, outbound, inbound, via = [], segmentCarriers = null }, apiKey) {
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
    include_airlines: carriers.join(','), // accrual depends on the operating airline
    api_key: apiKey,
  });
  params.set('stops', String(via.length + 1)); // SerpApi: 1 = nonstop, 2 = 1 stop or fewer, 3 = 2 stops or fewer
  const res = await fetch(`${SERPAPI}?${params}`);
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.error) throw new Error(`SerpApi: ${json.error || `HTTP ${res.status}`}`);

  let all = [...(json.best_flights || []), ...(json.other_flights || [])];
  const total = all.length;
  // Only offers with the row's exact routing: nonstop rows skip connecting offers (e.g. SQ via Narita
  // to Los Angeles), connecting rows keep only their connection. The row's miles assume that routing.
  all = all.filter((f) => connectsVia((f.layovers || []).map((l) => l.id), via));
  if (segmentCarriers) all = all.filter((f) => flownBy(f.flights || [], segmentCarriers));
  const offers = all.map((f) => f.price).filter((p) => typeof p === 'number');
  return {
    // price_insights covers every routing, so it isn't used: the lowest matching offer is.
    lowest: offers.length ? Math.min(...offers) : null,
    otherConnections: total - all.length,
    average: offers.length ? Math.round(offers.reduce((s, p) => s + p, 0) / offers.length) : null,
    offers: offers.length,
    typicalRange: json.price_insights?.typical_price_range ?? null,
  };
}

// fast-flights searches run one at a time with a random pause between them (normal distribution,
// mean 1 s, standard deviation 0.25 s, never negative), to go easy on Google Flights.
const FF_DELAY_MEAN_MS = Number(process.env.MILES_FF_DELAY_MEAN_MS ?? 1000);
const FF_DELAY_SD_MS = Number(process.env.MILES_FF_DELAY_SD_MS ?? 250);
function gaussian(mean, sd, rand = Math.random) {
  // Box–Muller transform
  const u = 1 - rand(), v = rand();
  return mean + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
const ffDelay = () => Math.max(0, gaussian(FF_DELAY_MEAN_MS, FF_DELAY_SD_MS));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ffQueue = Promise.resolve();
let ffRan = false; // no pause before the very first search
function ffQueued(task) {
  const run = ffQueue.then(async () => {
    if (ffRan) await sleep(ffDelay());
    ffRan = true;
    return task();
  });
  ffQueue = run.catch(() => {}); // a failed search doesn't stop the queue
  return run;
}

function viaFastFlights(q) {
  return ffQueued(() => runFastFlights(q));
}

function runFastFlights({ carriers, dest, cabin, outbound, inbound, via = [], airlineNames = null }) {
  const args = [FF_SCRIPT, dest, cabin, outbound, inbound, carriers.join(','), via.join(',') || '-'];
  if (airlineNames) args.push(airlineNames.join('|')); // mixed routes: itinerary must use exactly these airlines
  return new Promise((resolve, reject) => {
    execFile(PYTHON, args, { timeout: FF_TIMEOUT_MS }, (err, stdout, stderr) => {
      // Lines: {"url": ...} first (printed before fetching), then the result.
      const lines = String(stdout).trim().split('\n').map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
      const url = lines.map((l) => l.url).find(Boolean) || null;
      const out = lines.length ? lines[lines.length - 1] : null;
      const tag = `${outbound}–${inbound} ${carriers.join('+')} ${dest}`;
      if (out && ('lowest' in out) && !out.error) {
        console.log(`[fast-flights] ${tag}: ${url}`);
        return resolve({ ...out, url, typicalRange: null });
      }
      // Say why: the script's own error, a timeout, or a Python crash (last line of its traceback).
      const lastErr = String(stderr || '').trim().split('\n').filter(Boolean).pop();
      const why = out?.error
        || (err && (err.killed || err.signal) ? `fast-flights timed out after ${FF_TIMEOUT_MS / 1000} s` : null)
        || (lastErr ? `fast-flights crashed: ${lastErr}` : null)
        || `fast-flights failed${err ? `: ${err.message.split('\n')[0]}` : ''}`;
      const e = new Error(why.slice(0, 400));
      e.url = url; // the Google Flights URL fast-flights requested, for checking by hand
      console.log(`[fast-flights] FAILED ${tag}: ${url} — ${e.message}`);
      reject(e);
    });
  });
}

// ---------- public ----------

// Accepts { carrier: "TK" } (single airline) or { carriers: ["SQ", "LX"], segmentCarriers, airlineNames }.
function normalise(q) {
  const carriers = q.carriers || [q.carrier || 'SQ'];
  return { ...q, carriers, carrier: carriers[0], via: q.via || [], segmentCarriers: q.segmentCarriers || null, airlineNames: q.airlineNames || null };
}

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
  q = normalise(q);
  const win = datePairs(q);
  // One search id per ↻, so the database can group this search's date pairs.
  const range = { outbound: win.outbound, inbound: win.inbound, flex: win.flex };
  const searchId = db.newSearchId();
  const results = await mapLimit(win.pairs, FLEX_CONCURRENCY, (p) => lowestReturnFare({ ...q, range, searchId, outbound: p.outbound, inbound: p.inbound }));

  const byDate = win.pairs.map((p, i) => ({
    outbound: p.outbound,
    inbound: p.inbound,
    shift: p.shift,
    lowest: results[i].ok ? results[i].value.lowest : null,
    fromDb: results[i].ok ? !!results[i].value.fromDb : undefined, // reused a saved price: no search spent
    url: results[i].ok ? results[i].value.url : results[i].error.url, // fast-flights request URL, if used
    error: results[i].ok ? undefined : results[i].error.message,
  }));
  const ok = results.filter((r) => r.ok).map((r) => r.value);
  if (!ok.length) { // every date failed: surface the first reason, with every URL tried
    const e = results[0].error;
    e.urls = byDate.map((d) => d.url).filter(Boolean);
    throw e;
  }

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
    reused: byDate.filter((d) => d.fromDb).length,
    searchId,
    providers,
    byDate,
  };
}

async function lowestReturnFare(q) {
  q = normalise(q);
  validate(q);
  const key = [q.carriers.join('+'), q.dest, q.via.join('-'), (q.segmentCarriers || []).join('-'), q.cabin, q.outbound, q.inbound].join('|');
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return { ...hit.value, cached: true };

  // A price saved in the last 24 h (data/db) for exactly this route, cabin and dates: no new search.
  const saved = q.route ? db.reusable({ route: q.route, cabin: q.cabin, outbound: q.outbound, inbound: q.inbound }) : null;
  if (saved) {
    return { ...q, lowest: saved.price, average: null, offers: saved.offers ?? null, typicalRange: null,
      provider: saved.provider, fromDb: true, searchedAt: saved.searchedAt };
  }

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

  // Keep every fresh result (including "no fares found") in the price database, tagged with the
  // search range it belongs to and when it was searched.
  if (q.route) {
    const at = new Date();
    db.save([{
      v: 1, searchId: q.searchId || db.newSearchId(at), searchedAt: at.toISOString(),
      route: q.route, carriers: q.carriers, dest: q.dest, via: q.via, cabin: q.cabin,
      range: q.range || { outbound: q.outbound, inbound: q.inbound, flex: 0 },
      outbound: q.outbound, inbound: q.inbound,
      price: typeof value.lowest === 'number' ? value.lowest : null, currency: 'SGD',
      provider: value.provider, offers: value.offers ?? null,
    }]);
  }
  return value;
}

module.exports = { gaussian, ffDelay, lowestReturnFare, lowestFareInWindow, datePairs, status, enabled, checkFastFlights, MAX_FLEX, _test: { cache } };
