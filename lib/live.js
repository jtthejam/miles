'use strict';

// Live fares. Provider order:
//   1. SerpApi (official Google Flights API; free tier 250 searches/month) when a key is set
//   2. fast-flights (unofficial Python scraper; free, may break) as the fallback
// Results are cached for 6 hours per airline/route/cabin/dates.
const { execFile } = require('node:child_process');
const path = require('node:path');
const settings = require('./settings');

const SERPAPI = 'https://serpapi.com/search.json';
const TRAVEL_CLASS = { economy: 1, premium: 2 }; // Google Flights: 1 economy, 2 premium economy
const TTL_MS = 6 * 60 * 60 * 1000;
const PYTHON = process.env.PYTHON || 'python3';
const FF_SCRIPT = path.join(__dirname, '..', 'scripts', 'ff_quote.py');
const cache = new Map();

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

function validate({ carrier, dest, cabin, outbound, inbound }) {
  if (!TRAVEL_CLASS[cabin]) throw new Error('cabin must be economy or premium');
  if (!/^[A-Z]{3}$/.test(dest)) throw new Error('dest must be an IATA code');
  if (!/^[A-Z0-9]{2}$/.test(carrier)) throw new Error('carrier must be a 2-letter airline code');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(outbound) || !/^\d{4}-\d{2}-\d{2}$/.test(inbound)) {
    throw new Error('dates must be YYYY-MM-DD');
  }
}

// ---------- providers ----------

async function viaSerpApi({ carrier, dest, cabin, outbound, inbound }, apiKey) {
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
  const res = await fetch(`${SERPAPI}?${params}`);
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.error) throw new Error(`SerpApi: ${json.error || `HTTP ${res.status}`}`);

  const offers = [...(json.best_flights || []), ...(json.other_flights || [])]
    .map((f) => f.price)
    .filter((p) => typeof p === 'number');
  return {
    lowest: json.price_insights?.lowest_price ?? (offers.length ? Math.min(...offers) : null),
    average: offers.length ? Math.round(offers.reduce((s, p) => s + p, 0) / offers.length) : null,
    offers: offers.length,
    typicalRange: json.price_insights?.typical_price_range ?? null,
  };
}

function viaFastFlights({ carrier, dest, cabin, outbound, inbound }) {
  return new Promise((resolve, reject) => {
    execFile(PYTHON, [FF_SCRIPT, dest, cabin, outbound, inbound, carrier], { timeout: 45000 }, (err, stdout) => {
      let out;
      try { out = JSON.parse(String(stdout).trim().split('\n').pop()); } catch { out = null; }
      if (out && !out.error) return resolve({ ...out, typicalRange: null });
      reject(new Error(out?.error || `fast-flights failed${err ? `: ${err.message}` : ''}`));
    });
  });
}

// ---------- public ----------

async function lowestReturnFare(q) {
  q = { carrier: 'SQ', ...q };
  validate(q);
  const key = [q.carrier, q.dest, q.cabin, q.outbound, q.inbound].join('|');
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

module.exports = { lowestReturnFare, status, enabled, checkFastFlights, _test: { cache } };
