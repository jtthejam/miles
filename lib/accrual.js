'use strict';

// Accrual helpers over carriers loaded from data/carriers.json.

function tierForClass(carrier, cabin, bookingClass) {
  const c = String(bookingClass || '').toUpperCase();
  return (carrier.accrual[cabin] || []).find((t) => t.classes.includes(c)) || null;
}

function pctForClass(carrier, cabin, bookingClass) {
  const tier = tierForClass(carrier, cabin, bookingClass);
  return tier ? tier.pct : null;
}

// A tier may be restricted to certain destinations (e.g. Air NZ L/S/G/K: SIN–AKL only).
function tierAppliesTo(tier, dest) {
  return !!tier && (!tier.onlyTo || tier.onlyTo.includes(dest));
}

// Miles = distance flown x accrual %. Round trip doubles the distance.
function milesEarned(oneWayMiles, pct, roundTrip = true) {
  const legs = roundTrip ? 2 : 1;
  return Math.round(oneWayMiles * legs * (pct / 100));
}

module.exports = { tierForClass, pctForClass, tierAppliesTo, milesEarned };
