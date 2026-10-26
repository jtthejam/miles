'use strict';

const { greatCircleMiles } = require('./geo');
const { tierForClass, tierAppliesTo, milesEarned } = require('./accrual');

const CABINS = ['economy', 'premium'];

// Row key = route id + cabin. Single-airline route ids are "SQ:JFK" (unchanged since v1.0, so saved
// prices keep working); mixed-airline ids are "SQ+LX:BOD".
const rowKey = (routeId, cabin) => `${routeId}:${cabin}`;

/**
 * One row per route x cabin that every airline on the route sells.
 * KrisFlyer credits each segment by the airline that flies it: segment distance x that airline's %
 * for its booking class. The class comes from the sale fare (segment/fare entry, else the airline's
 * saleFare class) unless the user overrides it.
 *
 * opts.classOverrides: { "SQ:JFK:premium": "S" }        single airline: whole row
 *                      { "SQ+LX:BOD:economy|LX": "Y" }   mixed: per airline on the row
 * opts.priceOverrides: { "SQ:JFK:premium": 1700 }       return fares in SGD
 * opts.roundTrip:      default true
 */
function buildRows(data, opts = {}) {
  const roundTrip = opts.roundTrip !== false;
  const classOverrides = opts.classOverrides || {};
  const priceOverrides = opts.priceOverrides || {};
  const rows = [];

  for (const f of data.fares) {
    const dest = data.airports[f.to];
    const legDistances = f.segments.map((s) => greatCircleMiles(data.airports[s.from], data.airports[s.to]));
    const distance = legDistances.reduce((a, b) => a + b, 0);

    for (const cabin of CABINS) {
      if (f.carriers.some((c) => !data.carriers[c].accrual[cabin].length)) continue; // an airline has no such cabin
      if (f.cabins && !f.cabins.includes(cabin)) continue; // e.g. no Premium Economy on the connecting flight

      const key = rowKey(f.routeId, cabin);

      // Booking class per airline on the route (one fare family per airline on a ticket).
      const byCarrier = {};
      for (const c of f.carriers) {
        const carrier = data.carriers[c];
        const sale = carrier.saleFare[cabin];
        const segClass = f.segments.find((s) => s.carrier === c && s.class?.[cabin])?.class[cabin];
        const saleClass = segClass || (!f.mixed && f.class?.[cabin]) || sale.class;
        const override = String(classOverrides[f.mixed ? `${key}|${c}` : key] || '').toUpperCase();
        const bookingClass = /^[A-Z]$/.test(override) ? override : saleClass;
        byCarrier[c] = { carrier, sale, saleClass, bookingClass, tier: tierForClass(carrier, cabin, bookingClass) };
      }

      // Miles per segment; grouped by airline+% so single-airline rows round exactly as before.
      const segments = f.segments.map((s, i) => {
        const b = byCarrier[s.carrier];
        const eligible = tierAppliesTo(b.tier, s.to);
        return {
          from: s.from, to: s.to, carrier: s.carrier, carrierName: b.carrier.name,
          distance: legDistances[i], bookingClass: b.bookingClass, pct: eligible ? b.tier.pct : 0, eligible,
          reason: eligible ? null : (b.tier ? `Class ${b.bookingClass} earns only to ${b.tier.onlyTo.join('/')}` : `Class ${b.bookingClass} earns no KrisFlyer miles`),
        };
      });
      const groups = new Map();
      for (const s of segments) {
        const g = `${s.carrier}|${s.pct}`;
        groups.set(g, { pct: s.pct, distance: (groups.get(g)?.distance || 0) + s.distance });
      }
      const miles = [...groups.values()].reduce((sum, g) => sum + milesEarned(g.distance, g.pct, roundTrip), 0);
      for (const s of segments) s.miles = milesEarned(s.distance, s.pct, roundTrip);

      const first = byCarrier[f.carrier];
      const eligibleAny = segments.some((s) => s.eligible);
      const pct = f.mixed
        ? Math.round((miles / (distance * (roundTrip ? 2 : 1))) * 100) // effective % over the whole trip
        : (segments[0].eligible ? first.tier.pct : 0);
      // Name the segment when only part of the trip earns (mixed routes, or e.g. NZ class K: SIN–AKL only).
      const partial = segments.some((s) => s.eligible);
      const reasons = [...new Set(segments.filter((s) => !s.eligible).map((s) => (partial || f.mixed ? `${s.from}–${s.to}: ${s.reason}` : s.reason)))];

      const ret = Number(priceOverrides[key] ?? f.price[cabin]) || null;
      const price = ret == null ? null : Math.round(roundTrip ? ret : ret / 2);
      const sourceKey = priceOverrides[key] == null ? f.source?.[cabin] : null;

      rows.push({
        key,
        routeId: f.routeId,
        carrier: f.carrier,
        carriers: f.carriers,
        mixed: f.mixed,
        carrierName: f.carriers.map((c) => data.carriers[c].name).join(' + '),
        code: f.to,
        city: dest.city,
        region: dest.region,
        via: f.via,
        segments,
        cabin,
        distance,
        // Single airline: that airline's class. Mixed: one class per airline, in route order.
        bookingClass: f.carriers.map((c) => byCarrier[c].bookingClass).join('+'),
        saleClass: f.carriers.map((c) => byCarrier[c].saleClass).join('+'),
        classes: Object.fromEntries(f.carriers.map((c) => [c, { saleClass: byCarrier[c].saleClass, bookingClass: byCarrier[c].bookingClass, pct: segments.find((s) => s.carrier === c).pct }])),
        classOverridden: f.carriers.some((c) => byCarrier[c].bookingClass !== byCarrier[c].saleClass),
        fareFamily: !f.mixed && first.bookingClass === first.saleClass ? first.sale.family : null,
        classConfidence: !f.mixed && first.bookingClass === first.saleClass ? first.sale.confidence : f.mixed ? 'mixed' : 'yours',
        accrualPct: pct,
        eligible: !reasons.length,
        partlyEligible: !!reasons.length && eligibleAny,
        ineligibleReason: reasons.length ? reasons.join('; ') : null,
        priceSgd: price,
        miles,
        milesPerSgd: price && miles ? +(miles / price).toFixed(2) : null,
        centsPerMile: price && miles ? +((price * 100) / miles).toFixed(2) : null,
        overridden: priceOverrides[key] != null,
        source: sourceKey ? data.sources[sourceKey] : null,
        seasonal: !!f.seasonal,
      });
    }
  }
  // Priced rows by value; unpriced rows last.
  return rows.sort((a, b) => (b.milesPerSgd ?? -1) - (a.milesPerSgd ?? -1));
}

module.exports = { buildRows, rowKey, CABINS };
