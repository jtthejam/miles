'use strict';

const { itineraryMiles } = require('./geo');
const { tierForClass, tierAppliesTo, milesEarned } = require('./accrual');

const CABINS = ['economy', 'premium'];

const rowKey = (carrier, to, cabin) => `${carrier}:${to}:${cabin}`;

/**
 * One row per fare x cabin the carrier sells.
 * The booking class comes from the sale fare (fare entry, else the airline's saleFare class);
 * accrual % follows from that class via the KrisFlyer chart.
 *
 * opts.classOverrides: { "SQ:JFK:premium": "S" }  user's quote is in a different class
 * opts.priceOverrides: { "SQ:JFK:premium": 1700 } return fares in SGD
 * opts.roundTrip:      default true
 */
function buildRows(data, opts = {}) {
  const roundTrip = opts.roundTrip !== false;
  const classOverrides = opts.classOverrides || {};
  const priceOverrides = opts.priceOverrides || {};
  const rows = [];

  for (const f of data.fares) {
    const carrier = data.carriers[f.carrier];
    const path = [data.origin, ...f.via, f.to];
    const distance = itineraryMiles(data.airports, path);
    const dest = data.airports[f.to];

    for (const cabin of CABINS) {
      if (!carrier.accrual[cabin].length) continue; // carrier has no such cabin
      if (f.cabins && !f.cabins.includes(cabin)) continue; // e.g. no Premium Economy on the connecting flight

      const key = rowKey(f.carrier, f.to, cabin);
      const sale = carrier.saleFare[cabin];
      const saleClass = f.class?.[cabin] || sale.class;
      const override = String(classOverrides[key] || '').toUpperCase();
      const bookingClass = /^[A-Z]$/.test(override) ? override : saleClass;

      const tier = tierForClass(carrier, cabin, bookingClass);
      const eligible = tierAppliesTo(tier, f.to);
      const pct = eligible ? tier.pct : 0;

      const ret = Number(priceOverrides[key] ?? f.price[cabin]) || null;
      const price = ret == null ? null : Math.round(roundTrip ? ret : ret / 2);
      const miles = milesEarned(distance, pct, roundTrip);
      const sourceKey = priceOverrides[key] == null ? f.source?.[cabin] : null;

      rows.push({
        key,
        carrier: f.carrier,
        carrierName: carrier.name,
        code: f.to,
        city: dest.city,
        region: dest.region,
        via: f.via,
        cabin,
        distance,
        bookingClass,
        saleClass,
        classOverridden: bookingClass !== saleClass,
        fareFamily: bookingClass === saleClass ? sale.family : null,
        classConfidence: bookingClass === saleClass ? sale.confidence : 'yours',
        accrualPct: pct,
        eligible,
        ineligibleReason: eligible ? null : (tier ? `Class ${bookingClass} earns only to ${tier.onlyTo.join('/')}` : `Class ${bookingClass} earns no KrisFlyer miles`),
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
