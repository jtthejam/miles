'use strict';

const $ = (id) => document.getElementById(id);
const fmt = (n) => n.toLocaleString('en-SG');
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const CABIN_LABEL = { economy: 'Economy', premium: 'Premium Eco' };
const KEYS = { prices: 'mm-price-overrides-v2', classes: 'mm-classes-v1', carriers: 'mm-carriers-v1', view: 'mm-view-v1', plan: 'mm-plan-v2', keyPrompt: 'mm-key-prompt-dismissed' };

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

  const d = new Date(); d.setDate(d.getDate() + 60);
  $('out-date').value = d.toISOString().slice(0, 10);
  d.setDate(d.getDate() + 7);
  $('in-date').value = d.toISOString().slice(0, 10);
  initLive();

  ['cabin', 'region', 'sort', 'priced-only'].forEach((id) => $(id).addEventListener('change', render));
  $('roundtrip').addEventListener('change', refresh);
  $('reset').addEventListener('click', () => { overrides = {}; classOverrides = {}; store.set(KEYS.prices, overrides); store.set(KEYS.classes, classOverrides); refresh(); });

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
    const liveBtn = meta.liveEnabled ? `<button class="refresh" data-key="${r.key}" title="Fetch live lowest ${esc(r.carrierName)} fare for the dates above (${meta.live.provider})">↻</button>` : '';
    const flags = [
      !r.eligible ? r.ineligibleReason : '',
      r.seasonal ? 'Seasonal service' : '',
    ].filter(Boolean).map((f) => `<span class="flag">${esc(f)}</span>`).join('');
    const title = r.source ? `Source: ${r.source.label}` : r.overridden ? 'Your price' : '';
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
                 aria-label="Price for ${esc(r.city)} ${esc(r.carrierName)} ${CABIN_LABEL[r.cabin]}">${liveBtn}
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
  // Store as return fares regardless of the current trip toggle.
  if (v > 0) overrides[input.dataset.key] = $('roundtrip').checked ? v : v * 2;
  else delete overrides[input.dataset.key];
  store.set(KEYS.prices, overrides);
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
    const q = new URLSearchParams({ carrier, dest, cabin, outbound: $('out-date').value, inbound: $('in-date').value });
    const res = await (await fetch(`/api/live?${q}`)).json();
    if (res.error || res.lowest == null) throw new Error(res.error || `No ${carrier} fares found for those dates`);
    if (res.fallbackReason) console.warn(`SerpApi failed (${res.fallbackReason}); used fast-flights`);
    overrides[btn.dataset.key] = res.lowest;
    store.set(KEYS.prices, overrides);
    await refresh();
  } catch (err) {
    btn.textContent = '!'; btn.title = err.message; btn.disabled = false;
    alert(`${dest} ${CABIN_LABEL[cabin]} (${carrier}): ${err.message}`);
  }
});

init().catch((e) => { document.body.insertAdjacentHTML('beforeend', `<p class="err">Failed to load: ${esc(e.message)}</p>`); });
