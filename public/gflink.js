// Google Flights links and imports. Runs in the browser (window.GFLink) and in Node (require) for tests.
//
// Links: Google Flights encodes a search in the `tfs` URL parameter, a base64 protobuf (same schema as
// fast-flights): legs with date, airline filter and airports; cabin; passengers; trip type.
// Imports: the "Send to Miles Maximiser" bookmarklet reads prices off a Google Flights page the user
// is viewing and opens the app with them in the URL hash. The page's own `tfs` tells us which
// route, airline and cabin the prices are for.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.GFLink = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const SEAT = { economy: 1, premium: 2 }; // Google Flights: 1 economy, 2 premium economy, 3 business, 4 first
  const CABIN_BY_SEAT = { 1: 'economy', 2: 'premium' };
  const MONTHS = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };
  const DAY_MS = 864e5;
  // Operators that earn no KrisFlyer miles even when the airline filter includes them (KrisFlyer chart note 7).
  const NO_ACCRUAL = { LH: /lufthansa city/i };

  // ---------- protobuf (just enough for tfs) ----------

  function varint(n) {
    const out = [];
    do { let b = n % 128; n = Math.floor(n / 128); if (n) b |= 128; out.push(b); } while (n);
    return out;
  }
  const utf8 = (s) => Array.from(new TextEncoder().encode(s));
  const field = (num, wire) => varint(num * 8 + wire);
  const bytesField = (num, bytes) => [...field(num, 2), ...varint(bytes.length), ...bytes];
  const strField = (num, s) => bytesField(num, utf8(s));
  const intField = (num, v) => [...field(num, 0), ...varint(v)];

  function toBase64(bytes) {
    let bin = '';
    for (const b of bytes) bin += String.fromCharCode(b);
    return typeof btoa === 'function' ? btoa(bin) : Buffer.from(bin, 'binary').toString('base64');
  }
  function fromBase64(s) {
    s = String(s).replace(/-/g, '+').replace(/_/g, '/').replace(/\s/g, '');
    s += '='.repeat((4 - (s.length % 4)) % 4);
    const bin = typeof atob === 'function' ? atob(s) : Buffer.from(s, 'base64').toString('binary');
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
  }

  // Parse one message into { fieldNumber: [values] }. Skips fields it doesn't know.
  function readMessage(buf) {
    const out = {};
    let i = 0;
    const readVarint = () => {
      let r = 0, mul = 1, b;
      do {
        if (i >= buf.length) throw new Error('truncated');
        b = buf[i++]; r += (b & 127) * mul; mul *= 128;
      } while (b & 128);
      return r;
    };
    while (i < buf.length) {
      const key = readVarint();
      const num = Math.floor(key / 8), wire = key % 8;
      let val;
      if (wire === 0) val = readVarint();
      else if (wire === 2) { const n = readVarint(); if (i + n > buf.length) throw new Error('truncated'); val = buf.slice(i, i + n); i += n; }
      else if (wire === 5) { i += 4; continue; }
      else if (wire === 1) { i += 8; continue; }
      else throw new Error(`unsupported wire type ${wire}`);
      (out[num] = out[num] || []).push(val);
    }
    return out;
  }
  const text = (bytes) => new TextDecoder().decode(bytes);

  // ---------- links ----------

  // Round trip SIN ⇄ dest on one airline (accrual depends on the operating carrier), 1 adult.
  // maxStops pins connecting routes: with a one-airline filter, "TK, at most 1 stop" to BOD can only be via IST.
  // carriers: every airline on a mixed route (Google keeps itineraries using only those airlines).
  function encodeTfs({ origin = 'SIN', dest, outbound, inbound, carrier, carriers, cabin, maxStops = null }) {
    if (!SEAT[cabin]) throw new Error('cabin must be economy or premium');
    const airlines = carriers || (carrier ? [carrier] : []);
    const leg = (date, from, to) => [
      ...strField(2, date),
      ...(maxStops != null ? intField(5, maxStops) : []),
      ...airlines.flatMap((c) => strField(6, c)),
      ...bytesField(13, strField(2, from)),
      ...bytesField(14, strField(2, to)),
    ];
    const bytes = [
      ...bytesField(3, leg(outbound, origin, dest)),
      ...bytesField(3, leg(inbound, dest, origin)),
      ...bytesField(8, [1]), // passengers (packed): 1 adult
      ...intField(9, SEAT[cabin]),
      ...intField(19, 1), // round trip
    ];
    return toBase64(bytes);
  }

  function linkFor(q) {
    return `https://www.google.com/travel/flights/search?tfs=${encodeURIComponent(encodeTfs(q))}&hl=en&gl=sg&curr=SGD`;
  }

  // Decode a tfs from a Google Flights URL (ours, or Google's own after the user changes filters).
  function decodeTfs(tfs) {
    const msg = readMessage(fromBase64(tfs));
    const airport = (b) => (b ? text((readMessage(b)[2] || [])[0] || []) : null);
    const legs = (msg[3] || []).map((b) => {
      const l = readMessage(b);
      return {
        date: l[2] ? text(l[2][0]) : null,
        maxStops: l[5] ? l[5][0] : null,
        airlines: (l[6] || []).map(text),
        from: airport(l[13] && l[13][0]),
        to: airport(l[14] && l[14][0]),
      };
    });
    return { legs, seat: msg[9] ? msg[9][0] : null, trip: msg[19] ? msg[19][0] : null };
  }

  // ---------- imports ----------

  const iso = (t) => new Date(t).toISOString().slice(0, 10);
  const dayDiff = (a, b) => Math.round((Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / DAY_MS);

  // "Nov 28" → the ISO date in the year closest to `anchor` (grid labels carry no year).
  function resolveDay(label, anchor) {
    const m = /^([A-Z][a-z]{2})\s(\d{1,2})$/.exec(String(label).trim());
    if (!m || !(m[1] in MONTHS)) return null;
    const y0 = Number(anchor.slice(0, 4));
    const options = [y0 - 1, y0, y0 + 1].map((y) => iso(Date.UTC(y, MONTHS[m[1]], Number(m[2]))));
    return options.sort((a, b) => Math.abs(dayDiff(a, anchor)) - Math.abs(dayDiff(b, anchor)))[0];
  }

  const amount = (s) => Number(String(s).replace(/[^\d]/g, '')) || null;

  // Work out which route the page is for, and its prices.
  //   payload: { href, grid: [[price, "Nov 28", "Dec 5", currency]], list: [[price, currencyName, airlinesText, stops]] }
  //   ctx: { carriers: {SQ: {name}},
  //          routes: [{ routeId, carriers, dest, via }] (or legacy { "TK:BOD": ["IST"] }),
  //          pending: { routeId, dest, cabin } | null  (row whose G link was opened last),
  //          window: { outbound, inbound, flex } | null }
  // Returns { routeId, carrier, carriers, dest, cabin, outbound, inbound, lowest, source, considered, notes } or { error }.
  function interpretImport(payload, ctx) {
    const notes = [];
    let tfs = null;
    try { tfs = new URL(payload.href).searchParams.get('tfs'); } catch { /* not a URL */ }
    if (!payload.href || !/google\.[a-z.]+\/travel\/flights/.test(payload.href)) {
      return { error: 'That page isn\'t a Google Flights search.' };
    }

    let q = null;
    if (tfs) {
      try { q = decodeTfs(tfs); } catch { q = null; }
    }
    const legs = (q && q.legs) || [];
    const out = legs[0] || {}, back = legs[1] || {};
    const pending = ctx.pending || {};
    const routes = normaliseRoutes(ctx.routes);
    const pendingRoute = routes.find((r) => r.routeId === pending.routeId) ||
      (pending.carrier ? { routeId: `${pending.carrier}:${pending.dest}`, carriers: [pending.carrier], dest: pending.dest, via: [] } : null);

    if (legs.length && out.from && out.from !== 'SIN') return { error: `This search departs from ${out.from}; the app only covers flights from Singapore.` };
    if (legs.length > 2 || (q && q.trip && q.trip !== 1)) return { error: 'Use a round-trip search (one way and multi-city aren\'t supported).' };

    const dest = /^[A-Z]{3}$/.test(out.to || '') ? out.to : pending.dest;
    const cabin = q && q.seat ? CABIN_BY_SEAT[q.seat] : pending.cabin;
    if (q && q.seat && !cabin) return { error: 'Set the cabin to Economy or Premium economy.' };

    // The airline filter must match the route's airlines on both legs: accrual depends on who flies you.
    const sets = legs.map((l) => l.airlines.slice().sort().join(','));
    const filtered = legs.length ? (sets.every((x) => x === sets[0]) ? legs[0].airlines : null) : (pendingRoute ? pendingRoute.carriers : null);
    if (!filtered || !filtered.length) {
      return { error: 'Filter to the route\'s airline first (Airlines → "<airline> only"). Without it the prices can be on any airline, and miles depend on the airline.' };
    }
    const unknown = filtered.find((c) => !ctx.carriers[c]);
    if (unknown) return { error: `${unknown} isn't one of the airlines in this app.` };
    if (!dest || !cabin) return { error: 'Couldn\'t tell the route or cabin from that page. Open it with the "Google Flights" link on a row, then try again.' };

    const want = filtered.slice().sort().join(',');
    const matches = routes.filter((r) => r.dest === dest && r.carriers.slice().sort().join(',') === want);
    let route = matches.find((r) => pendingRoute && r.routeId === pendingRoute.routeId) || matches[0];
    if (!route) {
      if (filtered.length > 1) return { error: `No route in the table flies ${filtered.join(' + ')} to ${dest}.` };
      route = { routeId: `${filtered[0]}:${dest}`, carriers: filtered, dest, via: [] }; // the app reports it isn't in the table
    }
    if (matches.length > 1 && !(pendingRoute && matches.some((r) => r.routeId === pendingRoute.routeId))) {
      notes.push(`more than one ${filtered.join(' + ')} route to ${dest}; saved to the one via ${route.via.join(', ') || 'nonstop'}`);
    }
    const carrier = route.carriers[0];
    const mixed = route.carriers.length > 1;
    const names = route.carriers.map((c) => ctx.carriers[c].name.toLowerCase());

    // Connecting routes (e.g. TK to BOD via IST): miles assume that connection.
    const via = route.via || [];
    if (via.length && legs.length && legs.some((l) => l.maxStops == null || l.maxStops > via.length)) {
      notes.push(`Google's stops filter is off, so prices may include connections other than ${via.join(', ')}`);
    }
    const outbound = out.date || null, inbound = back.date || null;
    const anchorOut = outbound || iso(Date.now()), anchorIn = inbound || anchorOut;

    // Date grid cells first (many dates per click), else the result list for the page's dates.
    let cells = (payload.grid || [])
      .filter((c) => c[3] === 'SGD')
      .map((c) => ({ outbound: resolveDay(c[1], anchorOut), inbound: resolveDay(c[2], anchorIn), price: amount(c[0]) }))
      .filter((c) => c.outbound && c.inbound && c.price && c.inbound >= c.outbound);
    let source = 'grid';
    if ((payload.grid || []).length && !cells.length) {
      if ((payload.grid || []).some((c) => c[3] !== 'SGD')) return { error: 'Prices aren\'t in SGD. Use the link from the app (it sets SGD), or change currency to SGD.' };
    }
    if (!cells.length) {
      source = 'results';
      const list = (payload.list || []).filter((r) => /singapore dollars?/i.test(r[1]));
      if ((payload.list || []).length && !list.length) return { error: 'Prices aren\'t in SGD. Use the link from the app (it sets SGD), or change currency to SGD.' };
      // Keep only results flown by exactly the route's airlines ("Singapore Airlines and Austrian" isn't
      // a Singapore Airlines result; "Singapore Airlines and SWISS" is the SQ + SWISS route).
      const airlinesOf = (t) => [...new Set(String(t).toLowerCase().split(/,\s*|\s+and\s+/).map((x) => x.trim()).filter(Boolean))].sort().join('|');
      const wantNames = [...new Set(names)].sort().join('|');
      let own = list.filter((r) => airlinesOf(r[2]) === wantNames);
      const cityOnly = NO_ACCRUAL[carrier] ? list.filter((r) => NO_ACCRUAL[carrier].test(r[2])).length : 0;
      // r[3] = stops on the outbound (newer bookmarklets). Connecting rows need exactly that many.
      const stopsKnown = own.filter((r) => typeof r[3] === 'number');
      if (stopsKnown.length) {
        const right = own.filter((r) => r[3] === via.length);
        if (!right.length) {
          return { error: via.length ? `None of the results on that page have exactly ${via.length} stop${via.length > 1 ? 's' : ''} (this route connects via ${via.join(', ')}).` : 'None of the results on that page are nonstop.' };
        }
        if (right.length < own.length) notes.push(`${own.length - right.length} with a different number of stops skipped`);
        own = right;
      }
      if (cityOnly) notes.push(`${cityOnly} with Lufthansa City flights skipped (they earn no KrisFlyer miles)`);
      if (list.length && !own.length) {
        if (cityOnly === list.length) return { error: 'Every result on that page includes Lufthansa City flights, which earn no KrisFlyer miles.' };
        return { error: `None of the results on that page are ${route.carriers.map((c) => ctx.carriers[c].name).join(' + ')} flights.` };
      }
      if (!outbound || !inbound) return { error: 'Couldn\'t read the travel dates from that page.' };
      cells = own.map((r) => ({ outbound, inbound, price: amount(r[0]) })).filter((c) => c.price);
    }
    if (!cells.length) return { error: 'No prices found on that page. Wait for results to load (or open the Date grid), then click the bookmark again.' };

    // Keep to the user's travel dates ± flexibility, when set. The grid varies departure and return
    // independently, so both may move within the window.
    const w = ctx.window;
    if (w && w.outbound) {
      const wIn = w.inbound || iso(Date.parse(`${w.outbound}T00:00:00Z`) + 7 * DAY_MS);
      const f = Number(w.flex) || 0;
      const inside = cells.filter((c) => Math.abs(dayDiff(c.outbound, w.outbound)) <= f && Math.abs(dayDiff(c.inbound, wIn)) <= f);
      if (!inside.length) {
        return { error: `No prices on that page fall within your travel dates${f ? ` ± ${f} day${f > 1 ? 's' : ''}` : ''}. Open the row's Google Flights link (it uses your dates), or change the dates in the app.` };
      }
      if (inside.length < cells.length) notes.push(`${cells.length - inside.length} outside your dates ignored`);
      cells = inside;
    }

    if (source === 'grid' && NO_ACCRUAL[carrier]) notes.push('date grid can include Lufthansa City flights, which earn no miles: check the flight before booking');
    if (source === 'grid' && mixed) notes.push(`date grid doesn't show who flies each flight: check it's ${route.carriers.map((c) => ctx.carriers[c].name).join(' then ')} before booking`);
    const target = w && w.outbound ? w.outbound : anchorOut;
    const best = cells.slice().sort((a, b) => a.price - b.price ||
      Math.abs(dayDiff(a.outbound, target)) - Math.abs(dayDiff(b.outbound, target)))[0];
    return { routeId: route.routeId, carrier, carriers: route.carriers, dest, cabin, outbound: best.outbound, inbound: best.inbound, lowest: best.price, source, considered: cells.length, notes };
  }

  // Routes as [{ routeId, carriers, dest, via }]; also accepts the v1.11 map { "TK:BOD": ["IST"] }.
  function normaliseRoutes(routes) {
    if (!routes) return [];
    if (Array.isArray(routes)) return routes;
    return Object.entries(routes).map(([id, via]) => {
      const [c, d] = id.split(':');
      return { routeId: id, carriers: c.split('+'), dest: d, via };
    });
  }

  return { encodeTfs, decodeTfs, linkFor, interpretImport, resolveDay, SEAT };
});
