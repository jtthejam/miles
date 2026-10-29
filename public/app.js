'use strict';

const $ = (id) => document.getElementById(id);
const fmt = (n) => n.toLocaleString('en-SG');
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const CABIN_LABEL = { economy: 'Economy', premium: 'Premium Eco' };
const KEYS = { prices: 'mm-price-overrides-v2', classes: 'mm-classes-v1', carriers: 'mm-carriers-v1', view: 'mm-view-v1', plan: 'mm-plan-v2', keyPrompt: 'mm-key-prompt-dismissed', dates: 'mm-dates-v1', fareDates: 'mm-fare-dates-v1', gfPending: 'mm-gf-pending-v1', filters: 'mm-filters-v1' };

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
  // Price database: list saved searches; with no dates set, open the most recent saved search.
  await loadSavedSearches();
  if (!$('out-date').value && savedSearches.length) {
    const s = savedSearches[0];
    $('out-date').value = s.outbound; $('in-date').value = s.inbound; $('flex-days').value = String(Math.min(3, s.flex));
    renderDates();
    $('saved-searches').value = '0';
  }

  // Filters are remembered in this browser (they used to reset when the page reloaded, e.g. after a
  // Google Flights import opened the app again).
  const saveFilters = () => store.set(KEYS.filters, {
    cabin: $('cabin').value, region: $('region').value, sort: $('sort').value,
    pricedOnly: $('priced-only').checked, roundTrip: $('roundtrip').checked,
  });
  const savedFilters = store.get(KEYS.filters, {});
  for (const id of ['cabin', 'sort']) if (savedFilters[id] && [...$(id).options].some((o) => o.value === savedFilters[id])) $(id).value = savedFilters[id];
  if (typeof savedFilters.pricedOnly === 'boolean') $('priced-only').checked = savedFilters.pricedOnly;
  if (typeof savedFilters.roundTrip === 'boolean') $('roundtrip').checked = savedFilters.roundTrip;
  ['cabin', 'region', 'sort', 'priced-only'].forEach((id) => $(id).addEventListener('change', () => { saveFilters(); render(); }));
  $('roundtrip').addEventListener('change', () => { saveFilters(); refresh(); });
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
  if (savedFilters.region && [...$('region').options].some((o) => o.value === savedFilters.region)) {
    $('region').value = savedFilters.region; // options exist only after the first load
    render();
  }
  setView(view);
  window.name = 'miles-maximiser'; // lets the bookmarklet reuse this tab when it can
  initBookmarklet();
  await importFromHash();
  window.addEventListener('hashchange', importFromHash);
}

// Rows include saved search prices (data/db) for the current date range.
let range = null; // the range the server resolved (default ~60 days out, 7 nights, when no dates are set)
async function refresh() {
  const q = new URLSearchParams({
    classes: JSON.stringify(classOverrides),
    roundTrip: $('roundtrip').checked,
    overrides: JSON.stringify(overrides),
    ...dateParams(),
  });
  const res = await (await fetch(`/api/routes?${q}`)).json();
  rows = res.rows;
  range = res.range;
  render();
}

// ---------- Saved searches (price database) ----------

let savedSearches = [];
const rangeLabel = (s) => `${shortRange(s.outbound, s.inbound)} ${s.outbound.slice(0, 4)}${s.flex ? ` ± ${s.flex}` : ''}`;
const ago = (d) => (d <= 0 ? 'today' : d === 1 ? '1 day ago' : `${d} days ago`);

async function loadSavedSearches() {
  try {
    const res = await (await fetch('/api/db/searches')).json();
    savedSearches = res.searches || [];
    meta.preliminaryDays = res.preliminaryDays || 14;
    renderShareStatus(res);
  } catch { savedSearches = []; }
  const sel = $('saved-searches');
  sel.innerHTML = '<option value="">Choose a previous search…</option>' + savedSearches.map((s, i) =>
    `<option value="${i}">${esc(rangeLabel(s))} · searched ${esc(shortDate(s.lastSearched.slice(0, 10)))} · ${s.routes} route${s.routes === 1 ? '' : 's'}${s.ageDays > meta.preliminaryDays ? ' · preliminary' : ''}</option>`).join('');
  $('saved-wrap').hidden = !savedSearches.length;
  $('share-help').hidden = !savedSearches.length; // nothing to share until you've searched
  // Show which saved search matches the dates on screen, if any.
  const cur = savedSearches.findIndex((s) => s.outbound === $('out-date').value && s.inbound === $('in-date').value && s.flex === Number($('flex-days').value));
  sel.value = cur >= 0 ? String(cur) : '';
}

function renderShareStatus(res) {
  const a = res.autoShare || {};
  const n = a.uncommitted;
  $('share-status').textContent = n ? `· ${n} file${n === 1 ? '' : 's'} ready to send` : res.community && res.community.records ? `· ${fmt(res.community.records)} community prices loaded` : '';
  $('share-auto').innerHTML = a.enabled
    ? `<b>Automatic:</b> your saved prices are anonymised into <code>data/community/</code> once they're ${a.minAgeDays} days old (checked on startup and every 6 hours).` +
      (n ? ` <b>${n} file${n === 1 ? '' : 's'}</b> waiting to be committed.` : n === 0 ? ' Nothing waiting to be committed.' : '')
    : 'Automatic sharing is off (<code>MILES_AUTO_SHARE=0</code>). Use the button below to create a share file.';
  const repo = esc(a.repo || 'jtthejam/miles-prices');
  $('share-how').innerHTML = a.cloned
    ? `To send them, run <code>node scripts/share_prices.js --pr</code> (GitHub CLI) — it opens a pull request to the private repo <code>${repo}</code> — or commit them in <code>data/community/</code> and open the pull request yourself. Everyone's merged prices are pulled automatically when the app starts.`
    : `<b>To share and see other users' prices</b>, ask for access to the private repo <code>${repo}</code>, then clone it into this folder:<br><code>git clone https://github.com/${repo}.git data/community</code>` +
      (a.files ? `<br>Move the ${a.files} file${a.files === 1 ? '' : 's'} already in <code>data/community/</code> aside first, then copy ${a.files === 1 ? 'it' : 'them'} back into the clone.` : '');
}

async function sharePrices() {
  const msg = $('share-msg');
  msg.hidden = false; msg.textContent = 'Creating…';
  try {
    const res = await fetch('/api/db/share', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ minAgeDays: Number($('share-age').value) }) });
    const out = await res.json();
    if (!res.ok) throw new Error(out.error || `HTTP ${res.status}`);
    msg.textContent = out.count
      ? `Wrote ${out.count} anonymised price${out.count === 1 ? '' : 's'} to ${out.file}\n\nCheck the file, then send it as a pull request:\n` +
        '  node scripts/share_prices.js --pr        (GitHub CLI)\nor\n  git checkout -b share-prices\n  git add data/community\n  git commit -m "Share prices"\n  git push -u origin share-prices\nthen open the pull request to jtthejam/miles on GitHub.'
      : `Nothing new to share: prices must be at least ${out.minAgeDays} day${out.minAgeDays === 1 ? '' : 's'} old and not already in data/community.`;
    refresh();
    loadSavedSearches();
  } catch (e) {
    msg.textContent = e.message;
  }
}

function useSavedSearch(s) {
  $('out-date').value = s.outbound;
  $('in-date').value = s.inbound;
  $('flex-days').value = String(Math.min(3, s.flex));
  renderDates();
  refresh();
}

function visibleRows() {
  const cabin = $('cabin').value;
  const region = $('region').value;
  const pricedOnly = $('priced-only').checked;
  const key = $('sort').value;
  const missing = key === 'priceSgd' ? Infinity : -Infinity;
  const val = (r) => r[key] ?? missing;
  return rows
    .filter((r) => r.carriers.every((c) => selected.has(c))) // mixed rows need every airline on the trip selected
    .filter((r) => (cabin === 'all' || r.cabin === cabin) && (region === 'all' || r.region === region))
    .filter((r) => !pricedOnly || r.priceSgd != null)
    .sort((a, b) => (key === 'priceSgd' ? val(a) - val(b) : val(b) - val(a)));
}

const reportsLabel = (n) => `${n} report${n === 1 ? '' : 's'}`;
const PROVIDER_LABEL = { serpapi: 'SerpApi', 'fast-flights': 'fast-flights', 'google-flights': 'Google Flights' };

// Earlier searches for this row in the current range, as a price reference (tooltip lines).
function searchHistory(r) {
  if (!r.search || !r.search.history.length) return '';
  const lines = r.search.history.slice(0, 6).map((h) =>
    `${h.searchedAt.slice(0, 10)}: S$${fmt(h.price)} (${shortRange(h.outbound, h.inbound)}, ${PROVIDER_LABEL[h.provider] || h.provider})${h.preliminary ? ' · preliminary' : ''}`);
  const more = r.search.searches > 6 ? `\n…and ${r.search.searches - 6} earlier` : '';
  return `Searches for these dates (newest first; lowest S$${fmt(r.search.lowest.price)}):\n${lines.join('\n')}${more}`;
}

function render() {
  const list = visibleRows();
  renderBulk();
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
    // Mixed rows show who flies each segment: SIN → ZRH (SQ) → BOD (LX).
    const route = r.mixed
      ? ['SIN', ...r.segments.map((s) => `${s.to} <span class="seg-al">${s.carrier}</span>`)].join(' → ')
      : ['SIN', ...r.via, r.code].join(' → ') + (r.flexible
        ? ` <span class="flex-hub" title="${esc(`${r.carrierName} connects in ${r.hubs.map((h) => meta.airports[h]?.city || h).join(', ')}. Miles follow the connection of the price shown${r.viaFromPrice ? '' : ` (no price yet says which, so via ${r.defaultVia.join(', ')} is assumed)`}; the return is assumed to connect the same way.`)}">${r.viaFromPrice ? 'priced' : 'or'} ⇄</span>`
        : '');
    const gfBtn = `<a class="gf" href="${esc(gfLink(r))}" target="_blank" rel="noopener" data-key="${r.key}" title="Open ${esc(r.carrierName)} ${CABIN_LABEL[r.cabin]} to ${esc(r.city)} in Google Flights for ${esc(datesLabel())}, filtered to ${esc(r.carrierName)}. Then click your “Send to Miles Maximiser” bookmark.">G</a>`;
    const liveBtn = meta.liveEnabled ? `<button class="refresh" data-key="${r.key}" title="Fetch live lowest ${esc(r.carrierName)} fare for ${esc(datesLabel())} (${meta.live.provider})">↻</button>` : '';
    const flags = [
      !r.eligible ? (r.partlyEligible ? `Partly earns: ${r.ineligibleReason}` : r.ineligibleReason) : '',
      r.seasonal ? 'Seasonal service' : '',
      r.priceFrom === 'search' && r.search.latest.preliminary ? `Preliminary price: searched ${ago(r.search.latest.ageDays)}` : '',
      r.priceFrom === 'community' && r.community.latest.preliminary ? `Preliminary community price: searched ${ago(r.community.latest.ageDays)}` : '',
      r.priceFrom === 'community' && r.community.latest.reports < 2 ? 'Community price from one report: check it' : '',
    ].filter(Boolean).map((f) => `<span class="flag">${esc(f)}</span>`).join('');
    const fd = r.overridden ? fareDates[r.key] : null;
    const sl = r.priceFrom === 'search' ? r.search.latest : null;
    const cl = r.priceFrom === 'community' ? r.community.latest : null;
    const title = [
      fd ? `${fd.provider === 'google-flights' ? 'From Google Flights' : 'Live fare'}, ${fd.outbound} to ${fd.inbound}${fd.provider === 'google-flights' ? '' : ` (${fd.provider})`}`
        : sl ? `Saved search: S$${fmt(sl.price)} for ${sl.outbound} to ${sl.inbound}, searched ${sl.searchedAt.slice(0, 10)} (${PROVIDER_LABEL[sl.provider] || sl.provider})${sl.preliminary ? ', preliminary' : ''}`
        : cl ? `Community price (shared by other users): S$${fmt(cl.price)} for ${cl.outbound} to ${cl.inbound}, searched ${cl.searchedOn}, ${reportsLabel(cl.reports)}${cl.preliminary ? ', preliminary' : ''}`
        : r.source ? `Source: ${r.source.label}` : r.overridden ? 'Your price' : '',
      searchHistory(r),
      r.community && r.priceFrom !== 'community' ? `Community reference: S$${fmt(r.community.latest.price)} for ${r.community.latest.outbound} to ${r.community.latest.inbound}, searched ${r.community.latest.searchedOn} (${reportsLabel(r.community.latest.reports)})` : '',
    ].filter(Boolean).join('\n');
    return `
      <tr class="${r.priceSgd == null ? 'unpriced' : ''}">
        <td>${esc(r.city)}<span class="code">${r.code}</span><span class="route">${route}</span></td>
        <td class="carrier">${r.mixed ? r.carriers.map((c) => esc(meta.carriers[c].name)).join('<br>+ ') : esc(r.carrierName)}${flags}</td>
        <td><span class="pill ${r.cabin}">${CABIN_LABEL[r.cabin]}</span></td>
        <td class="num">${fmt(r.distance)} mi</td>
        <td class="num earn">${earnCell(r)}</td>
        <td class="num">${fmt(r.miles)}</td>
        <td class="num">
          <input class="price${r.overridden ? ' edited' : ''}" type="number" min="1" step="1" placeholder="add"
                 value="${r.priceSgd ?? ''}" data-key="${r.key}" title="${esc(title)}"
                 aria-label="Price for ${esc(r.city)} ${esc(r.carrierName)} ${CABIN_LABEL[r.cabin]}">${liveBtn}${gfBtn}
          ${fd ? `<span class="fare-dates">${shortRange(fd.outbound, fd.inbound)}</span>`
            : sl ? `<span class="fare-dates${sl.preliminary ? ' prelim' : ''}">${shortRange(sl.outbound, sl.inbound)} · ${sl.preliminary ? `preliminary, ${ago(sl.ageDays)}` : ago(sl.ageDays)}</span>`
            : cl ? `<span class="fare-dates community${cl.preliminary ? ' prelim' : ''}">community · ${shortRange(cl.outbound, cl.inbound)} · ${cl.preliminary ? `preliminary, ${ago(cl.ageDays)}` : ago(cl.ageDays)}</span>` : ''}
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
  if (r.mixed) return earnCellMixed(r);
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

// Mixed rows: effective % over the trip, plus one class picker per airline (each airline's segments earn
// at that airline's rate for its class). Overrides are stored per airline: "SQ+LX:BOD:economy|LX".
function earnCellMixed(r) {
  const pickers = r.carriers.map((code) => {
    const car = meta.carriers[code];
    const sf = car.saleFare[r.cabin];
    const c = r.classes[code];
    const changed = c.bookingClass !== c.saleClass;
    const mark = changed ? '' : sf.confidence === 'stated' ? '✓' : '≈';
    const legs = r.segments.filter((s) => s.carrier === code).map((s) => `${s.from}–${s.to}`).join(', ');
    const tip = `${car.name} (${legs}): ${changed ? `your class ${c.bookingClass}; sale fares book into ${c.saleClass}` : `sale fare class ${c.saleClass} (${sf.family}), ${sf.confidence === 'stated' ? 'published by the airline' : 'assumed, not published'}`}. Earns ${c.pct}%.`;
    const opts = car.accrual[r.cabin].flatMap((t) => t.classes.map((k) => ({ k, pct: t.pct, only: t.onlyTo })))
      .sort((a, b) => b.pct - a.pct || a.k.localeCompare(b.k))
      .map(({ k, pct, only }) => `<option value="${k}" ${k === c.bookingClass ? 'selected' : ''}>${k} · ${pct}%${only ? ` (${only.join('/')} only)` : ''}${k === c.saleClass ? ' — sale' : ''}</option>`)
      .join('');
    return `<label class="cls seg${changed ? ' changed' : ''}" title="${esc(tip)}"><span class="al">${code}</span><span class="mark">${mark}</span><span class="letter">${c.bookingClass}</span><span class="caret">▾</span>
      <select data-key="${r.key}|${code}" data-sale="${c.saleClass}" aria-label="Booking class on ${esc(car.name)} for ${esc(r.city)} ${CABIN_LABEL[r.cabin]}">${opts}</select></label>`;
  }).join('');
  return `<span class="pct" title="Effective rate over the whole trip">${r.accrualPct}%</span><span class="segs">${pickers}</span>`;
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
  // Dates work with or without a live provider: G links and Google Flights imports use them too.
  const live = !!meta.live.provider;
  const searches = 2 * flex + 1;
  const cost = flex && meta.live.provider === 'serpapi' ? ` Uses up to ${searches} SerpApi searches per ↻.` :
    flex ? ` Searches ${searches} date options per ↻, so it takes longer.` : '';
  const gf = !out ? '' : flex
    ? ` G opens Google Flights on these dates; with its Date grid open, the bookmark saves the cheapest departure and return each within ± ${flex} day${flex > 1 ? 's' : ''}.`
    : ' G opens Google Flights on these dates, and the bookmark saves only prices for these exact dates.';
  $('date-hint').textContent = !out
    ? `Optional: add travel dates to price your trip. Without dates, ${live ? '↻ and G check' : 'G checks'} a trip about 60 days out for 7 nights.`
    : live ? `↻ finds the lowest fare for ${datesLabel()}${flex ? ', keeping the same trip length' : ''}.${cost}${gf}` : gf.trim();
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
    renderDates(); refresh();
  });
  ['in-date', 'flex-days'].forEach((id) => $(id).addEventListener('change', () => { renderDates(); refresh(); }));
  $('dates-clear').addEventListener('click', () => { $('out-date').value = ''; $('in-date').value = ''; renderDates(); refresh(); });
  $('share-go').addEventListener('click', sharePrices);
  $('bulk-go').addEventListener('click', () => { bulkMessage = ''; runBulk(); });
  $('region').addEventListener('change', () => { if (!bulkRunning) bulkMessage = ''; });
  $('bulk-stop').addEventListener('click', () => { bulkStop = true; $('bulk-status').textContent = 'Stopping after this search…'; });
  $('saved-searches').addEventListener('change', (e) => { const s = savedSearches[Number(e.target.value)]; if (e.target.value !== '' && s) useSavedSearch(s); });
  renderDates();
}

// ---------- Google Flights links + "Send to Miles Maximiser" bookmarklet ----------

const addDaysIso = (d, n) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 864e5).toISOString().slice(0, 10);

// Same defaults as the server: ~60 days out, 7 nights.
function linkDates() {
  const out = $('out-date').value || addDaysIso(localToday(), 60);
  return { outbound: out, inbound: $('in-date').value || addDaysIso(out, 7) };
}

// Connecting rows limit stops to the route's connections, which (with the airline filter) pins the hub.
const gfLink = (r) => window.GFLink.linkFor({ dest: r.code, carriers: r.carriers, cabin: r.cabin, maxStops: r.via && r.via.length ? r.via.length : null, ...linkDates() });

$('rows').addEventListener('click', (e) => {
  const a = e.target.closest('a.gf');
  if (!a) return;
  a.href = gfLink(rows.find((r) => r.key === a.dataset.key) || {}); // dates may have changed since render
  const row = rows.find((r) => r.key === a.dataset.key);
  if (row) store.set(KEYS.gfPending, { routeId: row.routeId, dest: row.code, cabin: row.cabin, at: Date.now() }); // fallback if Google rewrites the URL
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
    routes: [...new Map(rows.map((r) => [r.routeId, { routeId: r.routeId, carriers: r.carriers, dest: r.code, via: r.defaultVia || r.via, flexible: r.flexible, hubs: r.hubs }])).values()],
    hubNames: Object.fromEntries(Object.values(meta.carriers).flatMap((c) => (c.hubs || []).map((h) => [h.code, h.match]))),
    pending: pending && Date.now() - pending.at < 6 * 3600e3 ? pending : null,
    window: $('out-date').value ? { outbound: $('out-date').value, inbound: $('in-date').value, flex: $('flex-days').value } : null,
  });
  if (res.error) { gfMessage(esc(res.error), 'err'); return; }

  const key = `${res.routeId}:${res.cabin}`;
  const row = rows.find((r) => r.key === key);
  if (!row) {
    gfMessage(`${esc(res.carriers.map((c) => meta.carriers[c].name).join(' + '))} ${CABIN_LABEL[res.cabin]} to ${esc(res.dest)} isn't a route in the table, so nothing was saved.`, 'err');
    return;
  }
  // Save everything the page priced to the price database (all date-grid cells), tagged with the
  // page's search range. Falls back to a price kept in this browser if the server can't save it.
  let savedToDb = false;
  try {
    const r2 = await fetch('/api/db/records', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ route: res.routeId, cabin: res.cabin, source: res.source, range: res.pageRange, prices: res.allCells }),
    });
    savedToDb = r2.ok;
  } catch { savedToDb = false; }
  if (savedToDb) {
    if (fareDates[key]) { delete overrides[key]; delete fareDates[key]; }
  } else {
    overrides[key] = res.lowest; // return fare, like the other sources
    fareDates[key] = { outbound: res.outbound, inbound: res.inbound, provider: 'google-flights' };
  }
  store.set(KEYS.prices, overrides);
  store.set(KEYS.fareDates, fareDates);
  // Show the import's range if your dates aren't set, so the saved prices are what you see.
  if (!$('out-date').value && res.pageRange) {
    $('out-date').value = res.pageRange.outbound; $('in-date').value = res.pageRange.inbound;
    renderDates();
  }
  await refresh();
  loadSavedSearches();
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
  }[st.provider] || '↻ off (add a SerpApi key or <code>pip install fast-flights</code>). Use <b>G</b> on a row for free Google Flights prices.';
  $('live-status').innerHTML = status;
  $('gf-help').open = !st.provider || $('gf-help').open; // Google Flights is the way to get prices without a provider
  $('key-toggle').hidden = st.serpApiKey === 'env';
  $('key-toggle').textContent = st.serpApiKey ? 'Remove SerpApi key' : 'Add SerpApi key';
  if (st.serpApiKey) $('key-form').hidden = true;
  if ($('flex-days')) renderDates(); // hint mentions SerpApi quota
  if ($('bulk-row') && rows.length) renderBulk(); // searching all regions needs a SerpApi key
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

// One live search for a row (↻). Throws with the reason on failure; returns the /api/live response.
async function searchRow(row, { batch = null } = {}) {
  const q = new URLSearchParams({ route: row.routeId, cabin: row.cabin, ...dateParams() });
  if (batch) q.set('batch', batch);
  const res = await (await fetch(`/api/live?${q}`)).json();
  const urls = res.urls || (res.byDate || []).map((d) => d.url).filter(Boolean);
  if (urls.length) console.log(`fast-flights URLs for ${row.carrierName} ${row.code} ${CABIN_LABEL[row.cabin]}:\n${urls.join('\n')}`);
  for (const d of res.byDate || []) {
    if (d.fromDb) console.log(`${d.outbound}–${d.inbound}: reused a price saved in the last 24 h (no search)`);
    else if (d.error) console.warn(`${d.outbound}–${d.inbound}: ${d.error}`);
  }
  if (res.error) throw new Error(res.error);
  // The server saved this search to the price database; drop an older browser-stored live price for the row.
  if (fareDates[row.key]) { delete overrides[row.key]; delete fareDates[row.key]; store.set(KEYS.prices, overrides); store.set(KEYS.fareDates, fareDates); }
  return res;
}

// "Google Flights only has: SWISS (SIN–ZRH–BOD) S$1,451 — that's the SWISS row." Explains a search that
// found itineraries, just not ones this row's miles apply to (other airlines or routing).
function othersNote(row, others) {
  if (!others || !others.length) return '';
  const lines = others.map((o) => {
    const names = (o.airlines || []).join(' + ') || 'other airlines';
    const path = (o.path || []).filter(Boolean).join('–');
    const match = rows.find((r) => r.cabin === row.cabin && r.key !== row.key &&
      ['SIN', ...r.via, r.code].join('–') === path &&
      r.carriers.map((c) => meta.carriers[c].name).sort().join('|') === [...o.airlines].sort().join('|'));
    return `  ${names}${path ? ` (${path})` : ''}: S$${fmt(o.price)}${match ? ` — that's the ${match.carrierName} row` : ''}`;
  });
  return `\n\nGoogle Flights only has itineraries this row's miles don't apply to:\n${lines.join('\n')}`;
}

// ---------- Search a whole region (every row shown) ----------

let bulkStop = false;
let bulkRunning = false;
let bulkMessage = ''; // last run's summary, kept until the region changes

function bulkTargets() {
  return visibleRows();
}

function renderBulk() {
  const live = meta.live.provider;
  const region = $('region').value;
  $('bulk-row').hidden = !live;
  if (!live || bulkRunning) return;
  const n = bulkTargets().length;
  const all = region === 'all';
  const blocked = all && live !== 'serpapi';
  $('bulk-go').disabled = blocked || !n;
  $('bulk-go').textContent = `↻ Search ${all ? 'all regions' : region} (${n} row${n === 1 ? '' : 's'})`;
  $('bulk-status').textContent = blocked
    ? 'Pick a region to search it with fast-flights; searching every region needs a SerpApi key.'
    : bulkMessage || (live === 'fast-flights' ? 'fast-flights searches one at a time, about 1 s apart.' : '');
}

// Estimate per fast-flights search: ~1 s pacing pause (mean of the random delay) + ~1.5 s to start the
// helper, download the Google Flights page (about 2 MB) and read the results from it.
const FF_SECONDS_PER_SEARCH = 2.5;

async function runBulk() {
  const targets = bulkTargets();
  const region = $('region').value;
  const all = region === 'all';
  const flex = Number($('flex-days').value) || 0;
  const per = $('out-date').value ? 2 * flex + 1 : 1;
  const max = targets.length * per;
  const provider = meta.live.provider;
  const cost = provider === 'serpapi'
    ? `up to ${max} SerpApi search${max === 1 ? '' : 'es'} (the free plan has 250 a month)`
    : `up to ${max} fast-flights search${max === 1 ? '' : 'es'}, taking roughly ${Math.ceil(max * FF_SECONDS_PER_SEARCH / 60)} min: ` +
      `about ${FF_SECONDS_PER_SEARCH} s per search, of which ~1 s is the deliberate pause between searches (pacing) and ` +
      `~${FF_SECONDS_PER_SEARCH - 1} s is fetching and reading each Google Flights page`;
  if (!confirm(`Search ${targets.length} row${targets.length === 1 ? '' : 's'} in ${all ? 'all regions' : region} for ${datesLabel()}?\n\nThat's ${cost}. Prices saved in the last 24 hours are reused instead of searched again.`)) return;

  bulkRunning = true; bulkStop = false;
  $('bulk-go').disabled = true; $('bulk-stop').hidden = false;
  let done = 0, priced = 0, reused = 0;
  const failed = [];
  for (const row of targets) {
    if (bulkStop) break;
    $('bulk-status').textContent = `Searching ${done + 1} of ${targets.length}: ${row.city} · ${row.carrierName} · ${CABIN_LABEL[row.cabin]}…`;
    try {
      const res = await searchRow(row, { batch: all ? 'all' : 'region' });
      if (res.lowest != null) priced++;
      reused += res.reused || 0;
    } catch (e) {
      failed.push(`${row.city} ${row.carrierName} ${CABIN_LABEL[row.cabin]}: ${e.message}`);
      if (/needs a SerpApi key/.test(e.message)) break;
    }
    done++;
    if (done % 5 === 0) refresh(); // show prices as they come in
  }
  bulkRunning = false;
  $('bulk-stop').hidden = true;
  await refresh();
  loadSavedSearches();
  bulkMessage = `${bulkStop ? 'Stopped' : 'Done'}: ${done} of ${targets.length} searched, ${priced} priced` +
    `${reused ? `, ${reused} date${reused === 1 ? '' : 's'} reused from saved prices` : ''}${failed.length ? `, ${failed.length} failed (see console)` : ''}.`;
  $('bulk-status').textContent = bulkMessage;
  if (failed.length) console.warn(`Region search: ${failed.length} failed\n${failed.join('\n')}`);
  renderBulk();
  $('bulk-go').disabled = false;
}

$('rows').addEventListener('click', async (e) => {
  const btn = e.target.closest('button.refresh');
  if (!btn) return;
  const row = rows.find((r) => r.key === btn.dataset.key);
  if (!row) return;
  const { code: dest, cabin } = row;
  const carrier = row.carriers.join(' + ');
  btn.disabled = true; btn.textContent = '…';
  try {
    if (Number($('flex-days').value)) btn.title = `Searching ${2 * $('flex-days').value + 1} date options…`;
    const res = await searchRow(row);
    if (res.lowest == null) {
      const where = row.flexible ? ` via ${row.hubs.join(', ')}` : row.via.length ? ` via ${row.via.join(', ')}` : ' (nonstop)';
      const unpriced = res.unpriced ? `\n\nGoogle listed ${res.unpriced} itinerar${res.unpriced === 1 ? 'y' : 'ies'} without a price ("Price unavailable"). Prices often appear on a later try; or use G on the row.` : '';
      throw new Error(`No ${carrier} fares${where} found for ${datesLabel()}.${unpriced}${othersNote(row, res.others)}`);
    }
    if (res.fallbackReason) console.warn(`SerpApi failed (${res.fallbackReason}); used fast-flights`);
    if (res.reused) console.info(`${res.reused} of ${res.searched} date options came from saved searches (no search spent)`);
    await refresh();
    loadSavedSearches();
  } catch (err) {
    btn.textContent = '!'; btn.title = err.message; btn.disabled = false;
    alert(`${dest} ${CABIN_LABEL[cabin]} (${carrier}): ${err.message}`);
  }
});

init().catch((e) => { document.body.insertAdjacentHTML('beforeend', `<p class="err">Failed to load: ${esc(e.message)}</p>`); });
