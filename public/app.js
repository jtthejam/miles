'use strict';

const $ = (id) => document.getElementById(id);
const fmt = (n) => n.toLocaleString('en-SG');
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const CABIN_LABEL = { economy: 'Economy', premium: 'Premium Eco' };
const KEYS = { prices: 'mm-price-overrides-v2', classes: 'mm-classes-v1', carriers: 'mm-carriers-v1', view: 'mm-view-v1', plan: 'mm-plan-v2', keyPrompt: 'mm-key-prompt-dismissed', dates: 'mm-dates-v1', fareDates: 'mm-fare-dates-v1', gfPending: 'mm-gf-pending-v1' };

let meta = null;
let rows = [];
const store = {
  get(k, fallback) { try { return JSON.parse(localStorage.getItem(k)) ?? fallback; } catch { return fallback; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage unavailable */ } },
};

// v1.0.0 stored overrides as "JFK:premium" (SQ only); migrate to "SQ:JFK:premium".
function loadOverrides() {
  const v2 = store.get(KEYS.prices, null);
  if (v2) return v2;
  const v1 = store.get('mm-price-overrides', {});
  const out = {};
  for (const [k, v] of Object.entries(v1)) out[`SQ:${k}`] = v;
  store.set(KEYS.prices, out);
  return out;
}

let overrides = loadOverrides();
let classOverrides = store.get(KEYS.classes, {}); // only set when a user's quote is in a different class
let fareDates = store.get(KEYS.fareDates, {}); // row key -> { outbound, inbound, provider } of a live price
try { localStorage.removeItem('mm-tiers-v1'); } catch { /* old per-airline assumptions are no longer used */ }
let selected = null; // Set of carrier codes
let view = store.get(KEYS.view, 'table');
let mapReady = null; // Promise, created on first map view

function setView(v) {
  view = ['map', 'plan'].includes(v) ? v : 'table';
  store.set(KEYS.view, view);
  document.querySelectorAll('.views button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.view === view)));
  $('table-view').hidden = view !== 'table';
  $('map-view').hidden = view !== 'map';
  $('plan-view').hidden = view !== 'plan';
  if (view === 'map' && !mapReady) {
    mapReady = window.RouteMap.init($('map-view'), meta).catch((e) => {
      $('map-view').innerHTML = `<p class="err">Map failed to load: ${esc(e.message)}</p>`;
    });
  }
  if (view === 'map') mapReady.then(() => window.RouteMap.render(visibleRows()));
  if (view === 'plan') runPlan();
}

// ---------- Miles goal planner ----------

function loadPlanSettings() {
  const p = store.get(KEYS.plan, {});
  if (p.target) $('plan-target').value = p.target;
  if (p.trips) $('plan-trips').value = String(p.trips);
  if (typeof p.distinct === 'boolean') $('plan-distinct').checked = p.distinct;
}

function runPlan() {
  const target = Math.round(Number($('plan-target').value) || 0);
  const trips = Number($('plan-trips').value);
  const distinct = $('plan-distinct').checked;
  store.set(KEYS.plan, { target, trips, distinct });
  const out = $('plan-results');
  if (target <= 0) { out.innerHTML = '<p class="err">Enter how many miles you want to earn.</p>'; return; }

  const { results, candidates, maxMiles } = window.Planner.plan(visibleRows(), { target, trips, distinct, limit: 20 });
  const tripWord = (n) => `${n} trip${n === 1 ? '' : 's'}`;
  const upTo = (n) => (n === 1 ? '1 trip' : `up to ${n} trips`);
  if (!candidates) {
    out.innerHTML = '<p class="plan-empty">No priced routes match the current filters. Add prices or widen the filters above.</p>';
    return;
  }
  if (!results.length) {
    out.innerHTML = `<p class="plan-empty">No combination of ${upTo(trips)} reaches ${fmt(target)} miles with the current settings.` +
      (maxMiles ? ` The most ${upTo(trips)} can earn is about <b>${fmt(maxMiles)}</b> miles.` : '') +
      ' Try more trips, a higher booking class, Premium Economy, or allowing repeat destinations.</p>';
    return;
  }

  const trip = $('roundtrip').checked ? 'return' : 'one way';
  out.innerHTML = `<p class="plan-summary">${results.length === 20 ? 'Top 20' : results.length} combination${results.length === 1 ? '' : 's'} of ${upTo(trips)} reaching ${fmt(target)} miles, cheapest first (${trip} fares).</p>` +
    '<ol class="plan-list">' + results.map((r, i) => `
      <li class="plan-card${i === 0 ? ' top' : ''}">
        <div class="plan-head">
          <span class="plan-rank">#${i + 1}</span>
          <span class="plan-cost">S$${fmt(r.cost)}</span>
          <span class="plan-count">${tripWord(r.rows.length)}</span>
          <span class="plan-meta">${fmt(r.miles)} miles · +${fmt(r.surplus)} over target · ${r.centsPerMile}¢/mile</span>
        </div>
        <ul class="plan-trips">${r.rows.map((t) => `
          <li><span class="plan-city">${esc(t.city)} <span class="code">${t.code}</span></span>
            <span class="plan-how">${esc(t.carrierName)} · <span class="pill ${t.cabin}">${CABIN_LABEL[t.cabin]}</span> · class ${t.bookingClass} (${t.accrualPct}%)${t.via.length ? ` · via ${t.via.join(', ')}` : ''}</span>
            <span class="plan-num">${fmt(t.miles)} mi · S$${fmt(t.priceSgd)}</span></li>`).join('')}
        </ul>
      </li>`).join('') + '</ol>';
}

async function init() {
  meta = await (await fetch('/api/meta')).json();
  $('version').textContent = `v${meta.version}`;

  const codes = Object.keys(meta.carriers);
  selected = new Set(store.get(KEYS.carriers, codes).filter((c) => codes.includes(c)));
  if (!selected.size) codes.forEach((c) => selected.add(c));

  $('carrier-chips').innerHTML = codes.map((c) => `
    <label class="chip"><input type="checkbox" value="${c}" ${selected.has(c) ? 'checked' : ''}>${esc(meta.carriers[c].name)}</label>`).join('');
  $('carrier-chips').addEventListener('change', (e) => {
    if (e.target.checked) selected.add(e.target.value); else selected.delete(e.target.value);
    store.set(KEYS.carriers, [...selected]);
    render();
  });

  const used = [...new Set(Object.values(meta.sources).map((s) => `<a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.label)}</a>`))];
  $('sources').innerHTML =
    `<p>Prices are the lowest advertised return fares (SGD, all-in) from: ${used.join('; ')}. ` +
    `Rows without a price need a quote — type one in${meta.liveEnabled ? ' or tap ↻' : ''}.</p>` +
    `<p>Earn rates follow each fare's booking class: the class the sale fare books into (✓ published by the airline, ≈ assumed where the airline doesn't publish it). If your quote is in a different class, change it in the Earn column.</p>` +
    `<p>Accrual: ${esc(meta.accrualSource)} Distances are great-circle miles summed per segment flown; PPS/Elite bonuses not included.</p>` +
    `<p>Miles Maximiser v${esc(meta.version)}</p>`;

  initDates();
  initLive();

  ['cabin', 'region', 'sort', 'priced-only'].forEach((id) => $(id).addEventListener('change', render));
  $('roundtrip').addEventListener('change', refresh);
  $('reset').addEventListener('click', () => {
    overrides = {}; classOverrides = {}; fareDates = {};
    store.set(KEYS.prices, overrides); store.set(KEYS.classes, classOverrides); store.set(KEYS.fareDates, fareDates);
    refresh();
  });

  $('cal-open').addEventListener('click', () => window.SalesCalendar.open(meta));

  loadPlanSettings();
  $('plan-form').addEventListener('submit', (e) => { e.preventDefault(); runPlan(); });
  ['plan-trips', 'plan-distinct'].forEach((id) => $(id).addEventListener('change', runPlan));

  document.querySelector('.views').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-view]');
    if (b) setView(b.dataset.view);
  });

  await refresh();
  [...new Set(rows.map((r) => r.region))].sort().forEach((r) => $('region').add(new Option(r, r)));
  setView(view);
  window.name = 'miles-maximiser'; // lets the bookmarklet reuse this tab when it can
  initBookmarklet();
  await importFromHash();
  window.addEventListener('hashchange', importFromHash);
}

async function refresh() {
  const q = new URLSearchParams({
    classes: JSON.stringify(classOverrides),
    roundTrip: $('roundtrip').checked,
    overrides: JSON.stringify(overrides),
  });
  rows = (await (await fetch(`/api/routes?${q}`)).json()).rows;
  render();
}

function visibleRows() {
  const cabin = $('cabin').value;
  const region = $('region').value;
  const pricedOnly = $('priced-only').checked;
  const key = $('sort').value;
  const missing = key === 'priceSgd' ? Infinity : -Infinity;
  const val = (r) => r[key] ?? missing;
  return rows
    .filter((r) => selected.has(r.carrier))
    .filter((r) => (cabin === 'all' || r.cabin === cabin) && (region === 'all' || r.region === region))
    .filter((r) => !pricedOnly || r.priceSgd != null)
    .sort((a, b) => (key === 'priceSgd' ? val(a) - val(b) : val(b) - val(a)));
}

function render() {
  const list = visibleRows();
  const maxMps = Math.max(...list.map((r) => r.milesPerSgd || 0), 1);
  const trip = $('roundtrip').checked ? 'return' : 'one way';

  $('best').innerHTML = ['economy', 'premium']
    .map((c) => list.filter((r) => r.cabin === c && r.milesPerSgd).sort((a, b) => b.milesPerSgd - a.milesPerSgd)[0])
    .filter(Boolean)
    .map((r) => `
      <div class="card">
        <div class="k">Best ${CABIN_LABEL[r.cabin]} value</div>
        <div class="v">${esc(r.city)} · ${r.milesPerSgd} mi/S$</div>
        <div class="d">${esc(r.carrierName)} · ${fmt(r.miles)} miles for S$${fmt(r.priceSgd)} ${trip}</div>
      </div>`).join('');

  $('rows').innerHTML = list.map((r) => {
    const route = ['SIN', ...r.via, r.code].join(' → ');
    const gfBtn = `<a class="gf" href="${esc(gfLink(r))}" target="_blank" rel="noopener" data-key="${r.key}" title="Open ${esc(r.carrierName)} ${CABIN_LABEL[r.cabin]} to ${esc(r.city)} in Google Flights for ${esc(datesLabel())}, filtered to ${esc(r.carrierName)}. Then click your “Send to Miles Maximiser” bookmark.">G</a>`;
    const liveBtn = meta.liveEnabled ? `<button class="refresh" data-key="${r.key}" title="Fetch live lowest ${esc(r.carrierName)} fare for ${esc(datesLabel())} (${meta.live.provider})">↻</button>` : '';
    const flags = [
      !r.eligible ? r.ineligibleReason : '',
      r.seasonal ? 'Seasonal service' : '',
    ].filter(Boolean).map((f) => `<span class="flag">${esc(f)}</span>`).join('');
    const fd = r.overridden ? fareDates[r.key] : null;
    const title = fd ? `${fd.provider === 'google-flights' ? 'From Google Flights' : 'Live fare'}, ${fd.outbound} to ${fd.inbound}${fd.provider === 'google-flights' ? '' : ` (${fd.provider})`}` : r.source ? `Source: ${r.source.label}` : r.overridden ? 'Your price' : '';
    return `
      <tr class="${r.priceSgd == null ? 'unpriced' : ''}">
        <td>${esc(r.city)}<span class="code">${r.code}</span><span class="route">${route}</span></td>
        <td class="carrier">${esc(r.carrierName)}${flags}</td>
        <td><span class="pill ${r.cabin}">${CABIN_LABEL[r.cabin]}</span></td>
        <td class="num">${fmt(r.distance)} mi</td>
        <td class="num earn">${earnCell(r)}</td>
        <td class="num">${fmt(r.miles)}</td>
        <td class="num">
          <input class="price${r.overridden ? ' edited' : ''}" type="number" min="1" step="1" placeholder="add"
                 value="${r.priceSgd ?? ''}" data-key="${r.key}" title="${esc(title)}"
                 aria-label="Price for ${esc(r.city)} ${esc(r.carrierName)} ${CABIN_LABEL[r.cabin]}">${liveBtn}${gfBtn}
          ${fd ? `<span class="fare-dates">${shortRange(fd.outbound, fd.inbound)}</span>` : ''}
        </td>
        <td class="num mps">${r.milesPerSgd ? `<div class="bar" style="width:${(r.milesPerSgd / maxMps) * 100}%"></div><span>${r.milesPerSgd}</span>` : '—'}</td>
        <td class="num">${r.centsPerMile ?? '—'}</td>
      </tr>`;
  }).join('') || '<tr><td colspan="9">No routes match these filters.</td></tr>';

  if (view === 'map' && mapReady) mapReady.then(() => window.RouteMap.render(list));
  if (view === 'plan') runPlan(); // filters, prices and class settings all feed the planner
}

// Earn cell: accrual % plus the booking class it comes from. The class defaults to the sale fare's class;
// the compact select only matters if the user's own quote books into a different class.
function earnCell(r) {
  const car = meta.carriers[r.carrier];
  const sf = car.saleFare[r.cabin];
  const mark = r.classOverridden ? '' : sf.confidence === 'stated' ? '✓' : '≈';
  const tip = r.classOverridden
    ? `Your class ${r.bookingClass}. Sale fares book into ${r.saleClass}.`
    : `Sale fare class ${r.saleClass} (${sf.family}) — ${sf.confidence === 'stated' ? 'published by the airline' : 'assumed, not published'}. ${sf.basis}`;
  const opts = car.accrual[r.cabin].flatMap((t) => t.classes.map((c) => ({ c, pct: t.pct, only: t.onlyTo })))
    .sort((a, b) => b.pct - a.pct || a.c.localeCompare(b.c))
    .map(({ c, pct, only }) => `<option value="${c}" ${c === r.bookingClass ? 'selected' : ''}>${c} · ${pct}%${only ? ` (${only.join('/')} only)` : ''}${c === r.saleClass ? ' — sale' : ''}</option>`)
    .join('');
  return `<span class="pct">${r.accrualPct}%</span>
    <label class="cls${r.classOverridden ? ' changed' : ''}" title="${esc(tip)}"><span class="mark">${mark}</span><span class="letter">${r.bookingClass}</span><span class="caret">▾</span>
      <select data-key="${r.key}" data-sale="${r.saleClass}" aria-label="Booking class for ${esc(r.city)} ${esc(r.carrierName)} ${CABIN_LABEL[r.cabin]}">${opts}</select></label>`;
}

$('rows').addEventListener('change', (e) => {
  const sel = e.target.closest('label.cls select');
  if (sel) {
    if (sel.value === sel.dataset.sale) delete classOverrides[sel.dataset.key];
    else classOverrides[sel.dataset.key] = sel.value;
    store.set(KEYS.classes, classOverrides);
    refresh();
    return;
  }
  const input = e.target.closest('input.price');
  if (!input) return;
  const v = Number(input.value);
  delete fareDates[input.dataset.key]; // a typed price is the user's own quote, not a dated live fare
  store.set(KEYS.fareDates, fareDates);
  // Store as return fares regardless of the current trip toggle.
  if (v > 0) overrides[input.dataset.key] = $('roundtrip').checked ? v : v * 2;
  else delete overrides[input.dataset.key];
  store.set(KEYS.prices, overrides);
  refresh();
});

// ---------- Travel dates for live prices (optional) ----------

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const shortDate = (d) => `${Number(d.slice(8, 10))} ${MONTHS[Number(d.slice(5, 7)) - 1]}`;
const shortRange = (a, b) => `${shortDate(a)} – ${shortDate(b)}`;
const localToday = () => { const d = new Date(); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 10); };

// Only send what the user chose; the server fills in defaults (≈60 days out, 7 nights).
function dateParams() {
  const p = { flex: $('flex-days').value };
  if ($('out-date').value) p.outbound = $('out-date').value;
  if ($('in-date').value) p.inbound = $('in-date').value;
  return p;
}

function datesLabel() {
  const out = $('out-date').value, back = $('in-date').value, flex = Number($('flex-days').value);
  if (!out) return 'about 60 days out (7 nights)';
  return `${back ? shortRange(out, back) : `${shortDate(out)} (7 nights)`}${flex ? ` ± ${flex} day${flex > 1 ? 's' : ''}` : ''}`;
}

function renderDates() {
  const out = $('out-date').value, flex = Number($('flex-days').value);
  const today = localToday();
  $('out-date').min = today;
  $('in-date').min = out || today;
  $('flex-days').disabled = !out;
  if (!out) $('flex-days').value = '0';
  $('dates-clear').hidden = !out && !$('in-date').value;
  const searches = 2 * flex + 1;
  const cost = flex && meta.live.provider === 'serpapi' ? ` Uses up to ${searches} SerpApi searches per ↻.` :
    flex ? ` Searches ${searches} date options per ↻, so it takes longer.` : '';
  $('date-hint').textContent = !out
    ? 'Optional: add travel dates to price your trip. Without dates, ↻ checks a trip about 60 days out for 7 nights.'
    : `↻ finds the lowest fare for ${datesLabel()}${flex ? ', keeping the same trip length' : ''}.${cost}`;
  $('date-hint').hidden = !meta.live.provider;
  store.set(KEYS.dates, { outbound: out, inbound: $('in-date').value, flex });
}

function initDates() {
  const saved = store.get(KEYS.dates, {});
  const today = localToday();
  // Drop saved dates that are now in the past.
  if (saved.outbound && saved.outbound >= today) {
    $('out-date').value = saved.outbound;
    if (saved.inbound && saved.inbound >= saved.outbound) $('in-date').value = saved.inbound;
    if ([0, 1, 2, 3].includes(saved.flex)) $('flex-days').value = String(saved.flex);
  }
  $('out-date').addEventListener('change', () => {
    // Keep return on or after departure.
    if ($('in-date').value && $('out-date').value && $('in-date').value < $('out-date').value) $('in-date').value = '';
    renderDates(); render();
  });
  ['in-date', 'flex-days'].forEach((id) => $(id).addEventListener('change', () => { renderDates(); render(); }));
  $('dates-clear').addEventListener('click', () => { $('out-date').value = ''; $('in-date').value = ''; renderDates(); render(); });
  renderDates();
}

// ---------- Google Flights links + "Send to Miles Maximiser" bookmarklet ----------

const addDaysIso = (d, n) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 864e5).toISOString().slice(0, 10);

// Same defaults as the server: ~60 days out, 7 nights.
function linkDates() {
  const out = $('out-date').value || addDaysIso(localToday(), 60);
  return { outbound: out, inbound: $('in-date').value || addDaysIso(out, 7) };
}

const gfLink = (r) => window.GFLink.linkFor({ dest: r.code, carrier: r.carrier, cabin: r.cabin, ...linkDates() });

$('rows').addEventListener('click', (e) => {
  const a = e.target.closest('a.gf');
  if (!a) return;
  a.href = gfLink(rows.find((r) => r.key === a.dataset.key) || {}); // dates may have changed since render
  const [carrier, dest, cabin] = a.dataset.key.split(':');
  store.set(KEYS.gfPending, { carrier, dest, cabin, at: Date.now() }); // fallback if Google rewrites the URL
});

async function initBookmarklet() {
  try {
    const src = await (await fetch('bookmarklet.js')).text();
    const code = src.split('\n').filter((l) => !/^\s*\/\//.test(l)).join(' ').replace(/\s+/g, ' ')
      .replace('__APP__', location.origin);
    $('gf-bookmarklet').href = `javascript:${encodeURIComponent(code)}`;
  } catch { $('gf-help').hidden = true; }
  $('gf-bookmarklet').addEventListener('click', (e) => { e.preventDefault(); alert('Drag this button to your bookmarks bar, then click it on a Google Flights page.'); });
}

function gfMessage(html, kind) {
  const el = $('gf-msg');
  el.innerHTML = html; el.className = `gf-msg ${kind}`; el.hidden = false;
  el.scrollIntoView({ block: 'nearest' });
}

// Prices arrive in the URL hash from the bookmarklet: #gf=<json>.
async function importFromHash() {
  if (!location.hash.startsWith('#gf=')) return;
  let payload;
  try { payload = JSON.parse(decodeURIComponent(location.hash.slice(4))); } catch { payload = null; }
  history.replaceState(null, '', location.pathname + location.search); // don't re-import on reload
  if (!payload) { gfMessage('Couldn\'t read the data from Google Flights. Try the bookmark again.', 'err'); return; }

  const pending = store.get(KEYS.gfPending, null);
  const res = window.GFLink.interpretImport(payload, {
    carriers: meta.carriers,
    pending: pending && Date.now() - pending.at < 6 * 3600e3 ? pending : null,
    window: $('out-date').value ? { outbound: $('out-date').value, inbound: $('in-date').value, flex: $('flex-days').value } : null,
  });
  if (res.error) { gfMessage(esc(res.error), 'err'); return; }

  const key = `${res.carrier}:${res.dest}:${res.cabin}`;
  const row = rows.find((r) => r.key === key);
  if (!row) {
    gfMessage(`${esc(meta.carriers[res.carrier].name)} ${CABIN_LABEL[res.cabin]} to ${esc(res.dest)} isn't a route in the table, so nothing was saved.`, 'err');
    return;
  }
  overrides[key] = res.lowest; // return fare, like the other sources
  fareDates[key] = { outbound: res.outbound, inbound: res.inbound, provider: 'google-flights' };
  store.set(KEYS.prices, overrides);
  store.set(KEYS.fareDates, fareDates);
  await refresh();
  const how = res.source === 'grid' ? `cheapest of ${res.considered} date${res.considered === 1 ? '' : 's'} in the date grid` : 'cheapest result on the page';
  gfMessage(`Saved <b>S$${fmt(res.lowest)}</b> for ${esc(row.city)} ${res.dest} · ${esc(row.carrierName)} · ${CABIN_LABEL[res.cabin]}, ` +
    `${shortRange(res.outbound, res.inbound)} (${how}${res.notes.length ? `; ${esc(res.notes.join('; '))}` : ''}).`, 'ok');
}

// Another tab (e.g. one the bookmarklet opened) saved prices: pick them up here.
window.addEventListener('storage', (e) => {
  if (e.key !== KEYS.prices && e.key !== KEYS.fareDates) return;
  overrides = store.get(KEYS.prices, {});
  fareDates = store.get(KEYS.fareDates, {});
  refresh();
});

// ---------- Live prices: SerpApi key prompt, fast-flights fallback ----------

function renderLive() {
  const st = meta.live;
  meta.liveEnabled = !!st.provider;
  const status = {
    serpapi: `via <b>SerpApi</b>${st.serpApiKey === 'env' ? ' (key from SERPAPI_KEY)' : ''}${st.fastFlights ? ' · fast-flights as backup' : ''}`,
    'fast-flights': 'via <b>fast-flights</b> (free, unofficial — may stop working)',
  }[st.provider] || 'off — add a SerpApi key or install fast-flights (<code>pip install fast-flights</code>)';
  $('live-status').innerHTML = status;
  $('live-dates').hidden = !st.provider;
  $('key-toggle').hidden = st.serpApiKey === 'env';
  $('key-toggle').textContent = st.serpApiKey ? 'Remove SerpApi key' : 'Add SerpApi key';
  if (st.serpApiKey) $('key-form').hidden = true;
  if ($('flex-days')) renderDates(); // hint mentions SerpApi quota
}

function initLive() {
  renderLive();
  // Prompt for a key on load until the user saves one or says "Not now".
  if (!meta.live.serpApiKey && !store.get(KEYS.keyPrompt, false)) $('key-form').hidden = false;

  $('key-toggle').addEventListener('click', async () => {
    if (!meta.live.serpApiKey) { $('key-form').hidden = !$('key-form').hidden; $('key-input').focus(); return; }
    if (!confirm('Remove the saved SerpApi key from this computer?')) return;
    const res = await fetch('/api/settings/serpapi', { method: 'DELETE' });
    const out = await res.json();
    if (out.live) { meta.live = out.live; renderLive(); render(); }
  });
  $('key-later').addEventListener('click', () => { store.set(KEYS.keyPrompt, true); $('key-form').hidden = true; });
  $('key-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const msg = $('key-msg');
    msg.textContent = 'Saving…'; msg.className = 'key-msg';
    try {
      const res = await fetch('/api/settings/serpapi', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: $('key-input').value.trim() }),
      });
      const out = await res.json();
      if (!res.ok) throw new Error(out.error || `HTTP ${res.status}`);
      meta.live = out.live;
      $('key-input').value = '';
      msg.textContent = 'Saved. Tap ↻ on any row to fetch its current price.';
      msg.className = 'key-msg ok';
      renderLive(); render();
      $('key-form').hidden = false; // keep the confirmation visible briefly
      setTimeout(() => { $('key-form').hidden = true; msg.textContent = ''; }, 2500);
    } catch (err) {
      msg.textContent = err.message; msg.className = 'key-msg err';
    }
  });
}

$('rows').addEventListener('click', async (e) => {
  const btn = e.target.closest('button.refresh');
  if (!btn) return;
  const [carrier, dest, cabin] = btn.dataset.key.split(':');
  btn.disabled = true; btn.textContent = '…';
  try {
    const q = new URLSearchParams({ carrier, dest, cabin, ...dateParams() });
    if (Number(q.get('flex'))) btn.title = `Searching ${2 * q.get('flex') + 1} date options…`;
    const res = await (await fetch(`/api/live?${q}`)).json();
    if (res.error || res.lowest == null) throw new Error(res.error || `No ${carrier} fares found for ${datesLabel()}`);
    if (res.fallbackReason) console.warn(`SerpApi failed (${res.fallbackReason}); used fast-flights`);
    if (res.failed) console.warn(`${res.failed} of ${res.searched} date searches failed`, res.byDate.filter((d) => d.error));
    overrides[btn.dataset.key] = res.lowest;
    fareDates[btn.dataset.key] = { outbound: res.outbound, inbound: res.inbound, provider: res.provider };
    store.set(KEYS.prices, overrides);
    store.set(KEYS.fareDates, fareDates);
    await refresh();
  } catch (err) {
    btn.textContent = '!'; btn.title = err.message; btn.disabled = false;
    alert(`${dest} ${CABIN_LABEL[cabin]} (${carrier}): ${err.message}`);
  }
});

init().catch((e) => { document.body.insertAdjacentHTML('beforeend', `<p class="err">Failed to load: ${esc(e.message)}</p>`); });
