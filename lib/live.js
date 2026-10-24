'use strict';

// Optional live pricing via SerpApi's Google Flights engine.
// Set SERPAPI_KEY to enable. Free tier: 250 searches/month, so results are cached.
const ENDPOINT = 'https://serpapi.com/search.json';
const TRAVEL_CLASS = { economy: 1, premium: 2 }; // Google Flights: 1 economy, 2 premium economy
const TTL_MS = 6 * 60 * 60 * 1000;
const cache = new Map();

const enabled = () => !!process.env.SERPAPI_KEY;

async function lowestReturnFare({ carrier = 'SQ', dest, cabin, outbound, inbound }) {
  if (!enabled()) throw new Error('Live pricing disabled: set SERPAPI_KEY');
  if (!TRAVEL_CLASS[cabin]) throw new Error('cabin must be economy or premium');
  if (!/^[A-Z]{3}$/.test(dest)) throw new Error('dest must be an IATA code');
  if (!/^[A-Z0-9]{2}$/.test(carrier)) throw new Error('carrier must be a 2-letter airline code');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(outbound) || !/^\d{4}-\d{2}-\d{2}$/.test(inbound)) {
    throw new Error('dates must be YYYY-MM-DD');
  }

  const key = [carrier, dest, cabin, outbound, inbound].join('|');
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return { ...hit.value, cached: true };

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
    api_key: process.env.SERPAPI_KEY,
  });

  const res = await fetch(`${ENDPOINT}?${params}`);
  if (!res.ok) throw new Error(`SerpApi HTTP ${res.status}`);
  const json = await res.json();
  if (json.error) throw new Error(`SerpApi: ${json.error}`);

  const offers = [...(json.best_flights || []), ...(json.other_flights || [])]
    .map((f) => f.price)
    .filter((p) => typeof p === 'number');
  const lowest = json.price_insights?.lowest_price ?? (offers.length ? Math.min(...offers) : null);
  const average = offers.length ? Math.round(offers.reduce((s, p) => s + p, 0) / offers.length) : null;

  const value = { carrier, dest, cabin, outbound, inbound, lowest, average, offers: offers.length, typicalRange: json.price_insights?.typical_price_range ?? null };
  cache.set(key, { at: Date.now(), value });
  return value;
}

module.exports = { enabled, lowestReturnFare };
