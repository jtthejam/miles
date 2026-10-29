'use strict';

// Loads and validates all static data. Fails fast on bad references.
const airports = require('./airports.json');
const { _source, _hubsNote, ...carriers } = require('./carriers.json');
const sources = require('./sources.json');
// fares.network.json: unpriced connecting routes built from verified schedules (scripts/build_network.py).
const fares = [...require('./fares.sq.json'), ...require('./fares.partners.json'), ...require('./fares.network.json')];
const { _about: salesAbout, ...salesCalendar } = require('./sales.json');

const tierId = (t) => `${t.pct}-${t.classes.join('')}`;

for (const [code, c] of Object.entries(carriers)) {
  for (const cabin of ['economy', 'premium']) {
    c.accrual[cabin] = (c.accrual[cabin] || []).map((t) => ({ ...t, id: tierId(t) }));
    const sf = c.saleFare?.[cabin];
    if (c.accrual[cabin].length && !sf) throw new Error(`${code}: no sale-fare class for ${cabin}`);
    if (sf && !c.accrual[cabin].some((t) => t.classes.includes(sf.class))) {
      throw new Error(`${code}: sale-fare class ${sf.class} not in ${cabin} accrual table`);
    }
    if (sf && !['stated', 'assumed'].includes(sf.confidence)) throw new Error(`${code}: bad confidence`);
  }
}

// Routes are flown as segments, each on its own operating airline (KrisFlyer credits each segment
// by the airline that flies it). Two ways to write a route in fares.*.json:
//   single airline: {"carrier": "TK", "to": "BOD", "via": ["IST"]}
//   mixed airlines: {"to": "BOD", "segments": [{"carrier": "SQ", "to": "ZRH"}, {"carrier": "LX", "to": "BOD"}]}
// Both are normalised to segments + carriers + via + a stable route id. Single-airline ids stay
// "CARRIER:DEST" so prices saved in browsers keep working; mixed ids are "SQ+LX:BOD".
const ORIGIN = 'SIN';
const routeIds = new Set();
for (const f of fares) {
  if (f.segments) {
    if (!Array.isArray(f.segments) || f.segments.length < 2) throw new Error(`Route to ${f.to}: segments needs 2 or more flights`);
    if (f.segments[f.segments.length - 1].to !== f.to) throw new Error(`Route to ${f.to}: last segment must end at ${f.to}`);
    if (f.carrier || f.via) throw new Error(`Route to ${f.to}: use either segments or carrier/via, not both`);
    f.via = f.segments.slice(0, -1).map((s) => s.to);
    f.carrier = f.segments[0].carrier; // first airline: colours, ordering
  } else {
    f.segments = [...f.via, f.to].map((to) => ({ carrier: f.carrier, to }));
  }
  f.segments = f.segments.map((s, i) => ({ ...s, from: i ? f.segments[i - 1].to : ORIGIN }));
  f.carriers = [...new Set(f.segments.map((s) => s.carrier))];
  f.mixed = f.carriers.length > 1;
  f.routeId = f.id || `${f.carriers.join('+')}:${f.to}`;
  // Flexible connection: a one-airline, one-stop route via one of the airline's hubs may connect at any
  // of its hubs (e.g. Air China to London via Beijing or Chengdu). Miles then follow the connection of
  // the price found; f.via stays the default (used when no price says otherwise).
  const hubs = (carriers[f.carrier]?.hubs || []).map((h) => h.code);
  f.flexible = !f.mixed && f.via.length === 1 && hubs.includes(f.via[0]) && f.fixed !== true;
  f.hubs = f.flexible ? hubs.filter((h) => h !== f.to) : [];
  if (routeIds.has(f.routeId)) throw new Error(`Duplicate route ${f.routeId}: give one an "id"`);
  routeIds.add(f.routeId);
}

for (const [code, c] of Object.entries(carriers)) {
  for (const h of c.hubs || []) {
    if (!airports[h.code]) throw new Error(`${code} hub ${h.code} isn't in airports.json`);
    if (!h.match) throw new Error(`${code} hub ${h.code} needs a "match" name`);
  }
}

for (const f of fares) {
  for (const s of f.segments) if (!carriers[s.carrier]) throw new Error(`Unknown carrier ${s.carrier} on ${f.routeId}`);
  if (!carriers[f.carrier]) throw new Error(`Unknown carrier ${f.carrier}`);
  for (const ap of [f.to, ...f.via]) if (!airports[ap]) throw new Error(`Unknown airport ${ap}`);
  for (const cab of f.cabins || []) {
    for (const c of f.carriers) {
      if (!carriers[c].accrual[cab]?.length) throw new Error(`${f.routeId} lists cabin ${cab} that ${c} doesn't have`);
    }
  }
  // mixedCabin: segment indexes flown in Economy on a Premium Economy ticket (no PE on that flight).
  if (f.mixedCabin) {
    const n = f.segments.length;
    if (!Array.isArray(f.mixedCabin) || !f.mixedCabin.length || f.mixedCabin.length >= n ||
        !f.mixedCabin.every((i) => Number.isInteger(i) && i >= 0 && i < n)) throw new Error(`${f.routeId}: bad mixedCabin`);
    if (f.cabins && !f.cabins.includes('premium')) throw new Error(`${f.routeId}: mixedCabin needs the premium cabin`);
    f.segments.forEach((s, i) => {
      if (!f.mixedCabin.includes(i) && !carriers[s.carrier].accrual.premium?.length) throw new Error(`${f.routeId}: ${s.carrier} has no Premium Economy`);
    });
  }
  if (f.via.includes(f.to) || f.via.includes('SIN')) throw new Error(`Bad connection on ${f.carrier}:${f.to}`);
  if (f.mixed && f.class) throw new Error(`${f.routeId}: set classes per segment ("class" on each segment) for mixed routes`);
  for (const seg of f.segments) {
    for (const [cab, cls] of Object.entries(seg.class || {})) {
      if (!carriers[seg.carrier].accrual[cab]?.length) throw new Error(`${seg.carrier} has no ${cab} cabin`);
      if (!/^[A-Z]$/.test(cls)) throw new Error(`Bad class ${cls} on ${f.routeId}`);
    }
  }
  for (const [cab, cls] of Object.entries(f.class || {})) {
    if (!carriers[f.carrier].accrual[cab]?.length) throw new Error(`${f.carrier} has no ${cab} cabin`);
    if (!/^[A-Z]$/.test(cls)) throw new Error(`Bad class ${cls} on ${f.carrier}:${f.to}`);
  }
  for (const key of Object.values(f.source || {})) {
    if (key && !sources[key]) throw new Error(`Unknown source ${key}`);
  }
}

// Sales calendar: MM-DD dates that exist in a leap year, known carriers/tiers, a brand colour per carrier.
const SALE_TIERS = ['small', 'large', 'main'];
const isMonthDay = (s) => {
  const m = /^(\d{2})-(\d{2})$/.exec(s);
  if (!m) return false;
  const d = new Date(Date.UTC(2024, +m[1] - 1, +m[2]));
  return d.getUTCMonth() === +m[1] - 1 && d.getUTCDate() === +m[2];
};
for (const code of Object.keys(carriers)) {
  if (!salesCalendar.brand[code]) throw new Error(`No brand colour for ${code}`);
}
for (const s of [...salesCalendar.sales, ...salesCalendar.fairs]) {
  if (!isMonthDay(s.start) || !isMonthDay(s.end)) throw new Error(`Bad sale dates: ${s.name}`);
}
for (const s of salesCalendar.sales) {
  if (!carriers[s.carrier]) throw new Error(`Sale for unknown carrier ${s.carrier}`);
  if (!SALE_TIERS.includes(s.tier)) throw new Error(`Bad sale tier ${s.tier} for ${s.name}`);
  if (!s.market) throw new Error(`Sale ${s.name} needs a market`);
}

module.exports = {
  origin: ORIGIN, airports, carriers, sources, fares, accrualSource: _source,
  salesCalendar: { about: salesAbout, ...salesCalendar },
};
