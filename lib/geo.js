'use strict';

const EARTH_RADIUS_MI = 3958.8;
const rad = (d) => (d * Math.PI) / 180;

// Great-circle distance in statute miles.
function greatCircleMiles(a, b) {
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return Math.round(2 * EARTH_RADIUS_MI * Math.asin(Math.sqrt(h)));
}

// KrisFlyer credits partner flights per segment flown, so sum the legs.
function itineraryMiles(airports, codes) {
  let total = 0;
  for (let i = 1; i < codes.length; i++) total += greatCircleMiles(airports[codes[i - 1]], airports[codes[i]]);
  return total;
}

module.exports = { greatCircleMiles, itineraryMiles };
