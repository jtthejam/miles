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
 * opts.priceOverrides: { "SQ:JFK:premium": 1700 }       your own prices (return fares in SGD)
 * opts.searchPrices:   { "SQ:JFK:premium": { latest, lowest, history } }  saved searches for the date
 *                      range (lib/db.js pricesForRange).
 * opts.communityPrices:{ "SQ:JFK:premium": { latest, files } }  anonymised shared prices (communityForRange)
 * Price shown: yours > your latest search > community > advertised.
 * opts.roundTrip:      default true
 */
function buildRows(data, opts = {}) {
  const roundTrip = opts.roundTrip !== false;
  const classOverrides = opts.classOverrides || {};
  const priceOverrides = opts.priceOverrides || {};
  const searchPrices = opts.searchPrices || {};
  const communityPrices = opts.communityPrices || {};
  const rows = [];

  for (const f of data.fares) {
    const dest = data.airports[f.to];

    for (const cabin of CABINS) {
      if (f.carriers.some((c) => !data.carriers[c].accrual[cabin].length)) continue; // an airline has no such cabin
      if (f.cabins && !f.cabins.includes(cabin)) continue; // e.g. no Premium Economy on the connecting flight

      const key = rowKey(f.routeId, cabin);

      // Price first: on flexible rows the connection (and so the miles) follows the price shown.
      const search = searchPrices[key] || null;
      const community = communityPrices[key] || null;
      const priceFrom = priceOverrides[key] != null ? 'yours' : search ? 'search' : community ? 'community' : f.price[cabin] != null ? 'advertised' : null;
      const priced = priceFrom === 'search' ? search.latest : priceFrom === 'community' ? community.latest : null;
      const pricedVia = f.flexible && Array.isArray(priced?.via) && priced.via.length === 1 && f.hubs.includes(priced.via[0]) ? priced.via : null;
      const via = pricedVia || f.via;
      const routeSegs = pricedVia
        ? [{ carrier: f.carrier, from: data.origin, to: via[0] }, { carrier: f.carrier, from: via[0], to: f.to }]
        : f.segments;
      const legDistances = routeSegs.map((s) => greatCircleMiles(data.airports[s.from], data.airports[s.to]));
      const distance = legDistances.reduce((a, b) => a + b, 0);

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
      const segments = routeSegs.map((s, i) => {
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

      const ret = Number(priceOverrides[key] ?? search?.latest.price ?? community?.latest.price ?? f.price[cabin]) || null;
      const price = ret == null ? null : Math.round(roundTrip ? ret : ret / 2);
      const sourceKey = priceFrom === 'advertised' ? f.source?.[cabin] : null;

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
        via,
        // Flexible rows: the airline's other hubs this route may connect at; via follows the price shown.
        flexible: f.flexible,
        hubs: f.hubs,
        defaultVia: f.via,
        viaFromPrice: !!pricedVia,
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
        priceFrom,
        // Saved searches for this row in the date range: latest (shown), lowest, and every earlier search.
        search: search ? { latest: search.latest, lowest: search.lowest, history: search.history.slice(0, 10), searches: search.history.length } : null,
        // Shared by other users (anonymised); also shown as a reference when you have your own price.
        community,
        source: sourceKey ? data.sources[sourceKey] : null,
        seasonal: !!f.seasonal,
      });
    }
  }
  // Priced rows by value; unpriced rows last.
  return rows.sort((a, b) => (b.milesPerSgd ?? -1) - (a.milesPerSgd ?? -1));
}

module.exports = { buildRows, rowKey, CABINS };
