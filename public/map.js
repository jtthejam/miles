'use strict';

// Route map: interactive 3D globe (orthographic) or flat world map.
// Depends on vendored d3-array, d3-geo, topojson-client (globals d3, topojson).
window.RouteMap = (() => {
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const SIN_ROT = [-103.9915, -20]; // globe start: Singapore centred, tilted to show the north
  // Miles per SGD bins → rainbow: red <2, orange 2–4, yellow 4–6, green 6–8, blue 8–10, purple 10+ (v0..v5)
  const BINS = [2, 4, 6, 8, 10];
  // Carrier colours: categorical slots in fixed order, keyed by carrier code (never by rank).
  const CARRIER_ORDER = ['SQ', 'TK', 'LH', 'LX', 'NH', 'CA', 'NZ', 'UA', 'BR', 'TG'];

  let W = 960, H = 560;
  let kind = 'globe';
  let mode = 'value';
  let rot = [...SIN_ROT];
  let zoom = 1;
  let projection, path;

  let root, frame, svg, gBase, gRoutes, gDots, tip, legendEl;
  let airports, carriers, world, land, borders;
  let lastRows = [];
  let routeEls = []; // { vis, hit, geo }
  let dotEls = [];   // { nodes:[...], code, label? }

  const el = (tag, attrs = {}) => {
    const n = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) if (v != null) n.setAttribute(k, v);
    return n;
  };
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = (n) => n.toLocaleString('en-SG');
  const binOf = (v) => BINS.filter((b) => v >= b).length; // 0..5
  const coord = (code) => [airports[code].lon, airports[code].lat];

  // ---------- projection ----------

  function makeProjection() {
    if (kind === 'globe') {
      const p = d3.geoOrthographic().clipAngle(90).precision(0.3).rotate(rot);
      p.fitExtent([[12, 12], [W - 12, H - 12]], { type: 'Sphere' });
      p.scale(p.scale() * zoom).translate([W / 2, H / 2]);
      return p;
    }
    return d3.geoNaturalEarth1().rotate([-150, 0]).fitExtent([[4, 4], [W - 4, H - 4]], { type: 'Sphere' });
  }

  // Points on the far side of the globe are hidden.
  function visible(c) {
    if (kind !== 'globe') return true;
    return d3.geoDistance(c, [-rot[0], -rot[1]]) < Math.PI / 2 - 0.01;
  }

  function setSize() {
    const narrow = frame.clientWidth < 600;
    if (kind === 'globe') { W = narrow ? 600 : 960; H = narrow ? 600 : 560; }
    else { W = 960; H = 500; }
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.classList.toggle('globe', kind === 'globe');
    frame.classList.toggle('flat', kind !== 'globe');
  }

  // ---------- drawing ----------

  function drawBase() {
    gBase.replaceChildren(
      el('path', { d: path({ type: 'Sphere' }), class: 'map-sphere' }),
      el('path', { d: path(d3.geoGraticule10()), class: 'map-graticule' }),
      el('path', { d: path(land), class: 'map-land' }),
      el('path', { d: path(borders), class: 'map-borders' }),
      ...(kind === 'globe' ? [el('path', { d: path({ type: 'Sphere' }), class: 'map-rim' })] : []),
    );
  }

  // Fast path during drag/zoom: recompute geometry only, keep nodes + listeners.
  function redraw() {
    projection = makeProjection();
    path = d3.geoPath(projection);
    drawBase();
    for (const r of routeEls) {
      const d = path(r.geo) || '';
      r.vis.setAttribute('d', d);
      r.hit.setAttribute('d', d);
    }
    for (const dot of dotEls) {
      const c = coord(dot.code);
      const show = visible(c);
      const [x, y] = projection(c);
      for (const n of dot.nodes) {
        n.style.display = show ? '' : 'none';
        if (n.tagName === 'text') { n.setAttribute('x', x + 9); n.setAttribute('y', y + 4); }
        else { n.setAttribute('cx', x); n.setAttribute('cy', y); }
      }
    }
  }

  function groupRoutes(rows) {
    const groups = new Map();
    for (const r of rows) {
      const stops = ['SIN', ...r.via, r.code];
      const k = `${r.routeId}|${stops.join('-')}`; // one line per route (mixed routes are coloured by their first airline)
      if (!groups.has(k)) groups.set(k, { carrier: r.carrier, stops, rows: [] });
      groups.get(k).rows.push(r);
    }
    for (const g of groups.values()) {
      const priced = g.rows.filter((r) => r.milesPerSgd != null);
      g.best = priced.length ? Math.max(...priced.map((r) => r.milesPerSgd)) : null;
    }
    return [...groups.values()].sort((a, b) => (a.best ?? -1) - (b.best ?? -1)); // best drawn on top
  }

  const strokeClass = (g) =>
    g.best == null ? 'route unpriced'
      : mode === 'value' ? `route v${binOf(g.best)}`
        : `route c${CARRIER_ORDER.indexOf(g.carrier) + 1}`;

  function render(rows) {
    lastRows = rows;
    if (!svg || !world) return;
    hideTip();
    gRoutes.replaceChildren();
    gDots.replaceChildren();
    routeEls = [];
    dotEls = [];
    projection = makeProjection();
    path = d3.geoPath(projection);
    drawBase();

    const groups = groupRoutes(rows);
    for (const g of groups) {
      const geo = { type: 'LineString', coordinates: g.stops.map(coord) };
      const d = path(geo) || '';
      const vis = el('path', { d, class: strokeClass(g) });
      const hit = el('path', { d, class: 'route-hit', tabindex: '0', 'aria-label': `${g.rows[0].city} on ${g.rows[0].carrierName}` });
      const show = (e) => { if (dragging) return; clearActive(); vis.classList.add('active'); showTip(e, routeTip(g)); };
      hit.addEventListener('pointermove', show);
      hit.addEventListener('click', (e) => { show(e); searchUnpriced(g.rows, `${g.rows[0].city} (${g.stops.join('–')})`); });
      hit.addEventListener('focus', show);
      hit.addEventListener('pointerleave', () => vis.classList.remove('active'));
      gRoutes.append(vis, hit);
      routeEls.push({ vis, hit, geo });
    }

    const dests = new Map();
    const hubs = new Set();
    for (const g of groups) {
      g.stops.slice(1, -1).forEach((h) => hubs.add(h));
      const dest = g.stops[g.stops.length - 1];
      if (!dests.has(dest)) dests.set(dest, []);
      dests.get(dest).push(...g.rows);
    }
    for (const h of hubs) if (!dests.has(h)) {
      const n = el('circle', { r: 3, class: 'hub' });
      gDots.append(n);
      dotEls.push({ code: h, nodes: [n] });
    }
    for (const [code, list] of dests) {
      const dot = el('circle', { r: 4, class: 'dest', tabindex: '0', 'aria-label': airports[code].city });
      const hitDot = el('circle', { r: 11, class: 'dot-hit' });
      const show = (e) => { if (!dragging) showTip(e, cityTip(code, list)); };
      [dot, hitDot].forEach((n) => {
        n.addEventListener('pointermove', show);
        n.addEventListener('click', (e) => { show(e); searchUnpriced(list, airports[code].city); });
      });
      dot.addEventListener('focus', show);
      gDots.append(hitDot, dot);
      dotEls.push({ code, nodes: [hitDot, dot] });
    }
    const origin = el('circle', { r: 6, class: 'origin' });
    const lbl = el('text', { class: 'origin-label' });
    lbl.textContent = 'Singapore';
    gDots.append(origin, lbl);
    dotEls.push({ code: 'SIN', nodes: [origin, lbl] });

    redraw();
    renderLegend(groups);
  }

  function renderLegend(groups) {
    const unpriced = groups.some((g) => g.best == null) ? '<span class="lg"><i class="sw dashed"></i>No price</span>' : '';
    if (mode === 'value') {
      const labels = [`< ${BINS[0]}`, ...BINS.slice(0, -1).map((b, i) => `${b}–${BINS[i + 1]}`), `${BINS[BINS.length - 1]}+`];
      legendEl.innerHTML = '<span class="lg-title">Miles per S$</span>' +
        labels.map((l, i) => `<span class="lg"><i class="sw v${i}"></i>${l}</span>`).join('') + unpriced;
    } else {
      const present = CARRIER_ORDER.filter((c) => groups.some((g) => g.carrier === c));
      legendEl.innerHTML = present.map((c) => `<span class="lg"><i class="sw c${CARRIER_ORDER.indexOf(c) + 1}"></i>${esc(carriers[c].name)}</span>`).join('') + unpriced;
    }
  }

  // ---------- tooltips ----------

  const rowLine = (r) => `
    <tr><td>${esc(r.carrierName)}</td><td${r.mixedCabin ? ` title="${esc(r.cabinNote)}"` : ''}>${r.cabin === 'premium' ? (r.mixedCabin ? 'Prem Eco + Eco*' : 'Prem Eco') : 'Economy'} · ${r.bookingClass}</td>
    <td class="num">${fmt(r.miles)}</td><td class="num">${r.priceSgd != null ? 'S$' + fmt(r.priceSgd) : '—'}</td>
    <td class="num"><b>${r.milesPerSgd ?? '—'}</b></td></tr>`;

  const TT_HEAD = '<tr class="tt-th"><th>Airline</th><th>Cabin</th><th class="num">Miles earned</th><th class="num">Fare</th><th class="num">mi/S$</th></tr>';

  // "Click to search": shown when some fares have no price and live search is on.
  const searchHint = (list) => {
    const n = list.filter((r) => r.priceSgd == null).length;
    if (!n || !onSearch) return '';
    return `<div class="tt-search">${searching ? 'A search is running…' : `Click to search the ${n === 1 ? 'fare' : `${n} fares`} without a price`}</div>`;
  };

  const routeTip = (g) => `<div class="tt-h">${esc(g.rows[0].city)} <span>${g.stops.join(' → ')}</span></div>
    <div class="tt-s">${fmt(g.rows[0].distance)} mi each way</div><table>${TT_HEAD}${g.rows.map(rowLine).join('')}</table>${searchHint(g.rows)}`;

  const cityTip = (code, list) => `<div class="tt-h">${esc(airports[code].city)} <span>${code}</span></div>
    <table>${TT_HEAD}${[...list].sort((a, b) => (b.milesPerSgd ?? -1) - (a.milesPerSgd ?? -1)).map(rowLine).join('')}</table>${searchHint(list)}`;

  // ---------- click to search ----------

  // onSearch(rows, onProgress) is set by the app when live prices are on; it searches the rows one
  // by one, saves the prices and re-renders the map. One search at a time.
  let onSearch = null;
  let searching = false;
  function setStatus(text) {
    const s = root && root.querySelector('#map-status');
    if (s) { s.textContent = text; s.hidden = !text; }
  }
  async function searchUnpriced(list, label) {
    if (dragging || !onSearch) return;
    const todo = list.filter((r) => r.priceSgd == null);
    if (!todo.length) return;
    if (searching) { setStatus('A search is already running; wait for it to finish.'); return; }
    searching = true;
    try {
      const n = todo.length;
      setStatus(`Searching ${label}: ${n} fare${n === 1 ? '' : 's'} without a price…`);
      const out = await onSearch(todo, (i, r) => setStatus(`Searching ${label}: ${i + 1} of ${n} (${r.carrierName} · ${r.cabin === 'premium' ? 'Premium Economy' : 'Economy'})…`));
      setStatus(`${label}: ${out.priced} of ${n} priced${out.notFound ? `, ${out.notFound} with no fares` : ''}${out.failed ? `, ${out.failed} failed (see the console)` : ''}.`);
    } catch (e) {
      setStatus(`${label}: search failed: ${e.message}`);
    } finally {
      searching = false;
    }
  }

  function showTip(e, html) {
    tip.innerHTML = html;
    tip.hidden = false;
    if (getComputedStyle(tip).position === 'static') return; // docked below the map on phones
    const box = frame.getBoundingClientRect();
    let x, y;
    if (e && e.clientX) { x = e.clientX - box.left; y = e.clientY - box.top; }
    else { const b = e.target.getBoundingClientRect(); x = b.left - box.left + b.width / 2; y = b.top - box.top; }
    const tw = tip.offsetWidth, th = tip.offsetHeight;
    tip.style.left = `${Math.min(Math.max(8, x + 14), box.width - tw - 8)}px`;
    tip.style.top = `${y + th + 20 > box.height ? Math.max(8, y - th - 12) : y + 14}px`;
  }

  function clearActive() { gRoutes?.querySelectorAll('.active').forEach((n) => n.classList.remove('active')); }
  function hideTip() { if (tip) tip.hidden = true; clearActive(); }

  // ---------- globe interaction: drag to spin, wheel/pinch to zoom, double-tap to reset ----------

  let dragging = false;
  const pointers = new Map();
  let dragStart = null;
  let pinchStart = null;
  let raf = 0;
  const schedule = () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; redraw(); }); };
  const clampZoom = (z) => Math.min(6, Math.max(0.8, z));

  function onDown(e) {
    if (kind !== 'globe') return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 1) dragStart = { x: e.clientX, y: e.clientY, rot: [...rot], moved: false };
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      pinchStart = { dist: Math.hypot(a.x - b.x, a.y - b.y), zoom };
    }
  }

  function onMove(e) {
    if (kind !== 'globe' || !pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 2 && pinchStart) {
      const [a, b] = [...pointers.values()];
      zoom = clampZoom(pinchStart.zoom * Math.hypot(a.x - b.x, a.y - b.y) / pinchStart.dist);
      dragging = true;
      schedule();
      return;
    }
    if (!dragStart) return;
    const dx = e.clientX - dragStart.x, dy = e.clientY - dragStart.y;
    if (!dragStart.moved && Math.hypot(dx, dy) < 4) return; // a tap, not a drag
    if (!dragStart.moved) { dragStart.moved = true; dragging = true; hideTip(); svg.setPointerCapture(e.pointerId); svg.classList.add('grabbing'); }
    const k = (0.4 / zoom) * (960 / frame.clientWidth); // degrees per CSS px, scaled for view size
    rot = [dragStart.rot[0] + dx * k, Math.max(-90, Math.min(90, dragStart.rot[1] - dy * k)), 0];
    schedule();
  }

  function onUp(e) {
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinchStart = null;
    if (pointers.size === 0) {
      dragStart = null;
      svg.classList.remove('grabbing');
      setTimeout(() => { dragging = false; }, 0); // swallow the click that ends a drag
    }
  }

  function onWheel(e) {
    if (kind !== 'globe') return;
    e.preventDefault();
    zoom = clampZoom(zoom * Math.exp(-e.deltaY * 0.0015));
    schedule();
  }

  // Animate back to Singapore.
  function resetView() {
    const from = [...rot], fromZ = zoom, t0 = performance.now(), ms = 650;
    const interp = d3.geoInterpolate([-from[0], -from[1]], [-SIN_ROT[0], -SIN_ROT[1]]);
    const step = (t) => {
      const p = Math.min(1, (t - t0) / ms), ease = 1 - (1 - p) ** 3;
      const [lon, lat] = interp(ease);
      rot = [-lon, -lat, 0];
      zoom = fromZ + (1 - fromZ) * ease;
      redraw();
      if (p < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  // Flat map on phones scrolls sideways; start with Singapore in view.
  function centreOnOrigin() {
    if (kind === 'globe') return;
    const [x] = projection(coord('SIN'));
    frame.scrollLeft = (x / W) * svg.clientWidth - frame.clientWidth / 2;
  }

  // ---------- init ----------

  async function init(container, meta, opts = {}) {
    root = container;
    airports = meta.airports;
    carriers = meta.carriers;
    root.innerHTML = `
      <div class="map-toolbar">
        <label>Colour by
          <select id="map-mode"><option value="value">Miles per SGD</option><option value="carrier">Airline</option></select>
        </label>
        <label>View
          <select id="map-kind"><option value="globe">3D globe</option><option value="flat">Flat world map</option></select>
        </label>
        <button type="button" id="map-reset" class="ghost">Recentre</button>
        <div class="map-legend" id="map-legend" aria-label="Legend"></div>
      </div>
      <div class="map-frame"></div>
      <div class="map-tip" role="tooltip" hidden></div>
      <p class="map-status" id="map-status" role="status" hidden></p>
      <p class="hint" id="map-hint"></p>`;
    frame = root.querySelector('.map-frame');
    tip = root.querySelector('.map-tip');
    frame.append(tip); // overlays on desktop; CSS docks it below on phones
    legendEl = root.querySelector('#map-legend');

    svg = el('svg', { class: 'map-svg', role: 'img', 'aria-label': 'Map of routes from Singapore' });
    svg.innerHTML = `<defs><radialGradient id="ocean" cx="38%" cy="32%" r="75%">
      <stop offset="0%" style="stop-color: var(--globe-hi)"/><stop offset="100%" style="stop-color: var(--globe-lo)"/></radialGradient></defs>`;
    gBase = el('g'); gRoutes = el('g', { class: 'map-routes' }); gDots = el('g', { class: 'map-dots' });
    svg.append(gBase, gRoutes, gDots);
    frame.prepend(svg);

    const hint = () => {
      const click = onSearch ? ' Click a dashed route or a city to search its missing prices (your dates and Max connection apply).' : '';
      root.querySelector('#map-hint').textContent = (kind === 'globe'
        ? 'Drag to spin · scroll or pinch to zoom · double-click to recentre. Tap a route or city for details; dashed = no price yet. Filters above apply.'
        : 'Hover or tap a route or city for details; dashed = no price yet. Lines are great-circle paths. Filters above apply.') + click;
    };
    onSearch = opts.onSearch || null;
    root.querySelector('#map-mode').addEventListener('change', (e) => { mode = e.target.value; render(lastRows); });
    root.querySelector('#map-kind').addEventListener('change', (e) => {
      kind = e.target.value === 'flat' ? 'flat' : 'globe';
      setSize(); hint(); render(lastRows); centreOnOrigin();
    });
    root.querySelector('#map-reset').addEventListener('click', () => (kind === 'globe' ? resetView() : centreOnOrigin()));

    svg.addEventListener('pointerdown', onDown);
    svg.addEventListener('pointermove', onMove);
    svg.addEventListener('pointerup', onUp);
    svg.addEventListener('pointercancel', onUp);
    svg.addEventListener('wheel', onWheel, { passive: false });
    svg.addEventListener('dblclick', (e) => { e.preventDefault(); if (kind === 'globe') resetView(); });
    svg.addEventListener('pointerleave', (e) => { if (!dragging && e.pointerType === 'mouse') hideTip(); });
    svg.addEventListener('click', (e) => {
      if (!dragging && (e.target === svg || e.target.closest('.map-base'))) hideTip();
    });
    window.addEventListener('resize', () => { const k = kind; setSize(); if (k) redraw(); });

    world = await (await fetch('vendor/countries-110m.json')).json();
    land = topojson.feature(world, world.objects.countries);
    borders = topojson.mesh(world, world.objects.countries, (a, b) => a !== b);
    setSize();
    hint();
  }

  return { init, render };
})();
