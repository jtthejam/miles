'use strict';

// Loads and validates all static data. Fails fast on bad references.
const airports = require('./airports.json');
const { _source, ...carriers } = require('./carriers.json');
const sources = require('./sources.json');
const fares = [...require('./fares.sq.json'), ...require('./fares.partners.json')];
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

for (const f of fares) {
  if (!carriers[f.carrier]) throw new Error(`Unknown carrier ${f.carrier}`);
  for (const ap of [f.to, ...f.via]) if (!airports[ap]) throw new Error(`Unknown airport ${ap}`);
  for (const cab of f.cabins || []) {
    if (!carriers[f.carrier].accrual[cab]?.length) throw new Error(`${f.carrier}:${f.to} lists cabin ${cab} the airline doesn't have`);
  }
  if (f.via.includes(f.to) || f.via.includes('SIN')) throw new Error(`Bad connection on ${f.carrier}:${f.to}`);
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
  origin: 'SIN', airports, carriers, sources, fares, accrualSource: _source,
  salesCalendar: { about: salesAbout, ...salesCalendar },
};
