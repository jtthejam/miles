'use strict';

// Sales calendar overlay: a year planner with one row per airline.
// Bars use the airline's brand colour at 10% (Small Sale), 25% (Large Sale) or 40% (Main Sale) opacity.
// Overlapping sales on one airline stack into lanes; sales run outside Singapore get a dashed outline.
window.SalesCalendar = (() => {
  const ALPHA = { small: 0.10, large: 0.25, main: 0.40 };
  const TIER_LABEL = { small: 'Small Sale', large: 'Large Sale', main: 'Main Sale' };
  const LANE_H = 30, PAD = 5; // px per lane, top/bottom padding
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  let backdrop, lastFocus, meta;
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const isLeap = (y) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  const daysIn = (y, m) => new Date(Date.UTC(y, m + 1, 0)).getUTCDate();

  function dayOfYear(y, mmdd) {
    let [m, d] = mmdd.split('-').map(Number);
    if (m === 2 && d === 29 && !isLeap(y)) d = 28;
    return (Date.UTC(y, m - 1, d) - Date.UTC(y, 0, 1)) / 86400000; // 0-based
  }

  // [start, endExclusive] day ranges within the year; a window ending before it starts wraps New Year.
  function segments(y, start, end) {
    const total = isLeap(y) ? 366 : 365;
    const a = dayOfYear(y, start), b = dayOfYear(y, end) + 1;
    return b > a ? [[a, b]] : [[a, total], [0, b]];
  }

  function fmtRange(start, end) {
    const f = (mmdd) => { const [m, d] = mmdd.split('-').map(Number); return `${d} ${MONTHS[m - 1]}`; };
    return `${f(start)} – ${f(end)}`;
  }

  function rgba(hex, a) {
    const n = parseInt(hex.slice(1), 16);
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
  }

  function brand(code) {
    const dark = window.matchMedia?.('(prefers-color-scheme: dark)').matches;
    const b = meta.salesCalendar.brand[code];
    return dark ? b.dark : b.light;
  }

  // Greedy lane packing: each segment goes in the first lane where it doesn't overlap.
  function layout(y, items) {
    const segs = items.flatMap((s) => segments(y, s.start, s.end).map(([a, b]) => ({ s, a, b })))
      .sort((p, q) => p.a - q.a || q.b - p.b);
    const laneEnds = [];
    for (const g of segs) {
      let lane = laneEnds.findIndex((end) => end <= g.a);
      if (lane === -1) { lane = laneEnds.length; laneEnds.push(0); }
      laneEnds[lane] = g.b;
      g.lane = lane;
    }
    return { segs, lanes: Math.max(1, laneEnds.length) };
  }

  const rowHeight = (lanes) => lanes * LANE_H + PAD * 2;

  function bars(total, segs, colourFor, kind) {
    return segs.map(({ s, a, b, lane }) => {
      const left = (a / total) * 100, width = ((b - a) / total) * 100;
      const top = PAD + lane * LANE_H + 1;
      const pos = `left:${left}%;width:${width}%;top:${top}px;height:${LANE_H - 2}px`;
      const c = colourFor(s);
      const style = kind === 'fair' ? pos : `${pos};background:${rgba(c, ALPHA[s.tier])};border-color:${rgba(c, 0.65)}`;
      const away = kind === 'sale' && s.market !== 'Singapore';
      const tip = `${s.name} · ${fmtRange(s.start, s.end)}${s.tier ? ` · ${TIER_LABEL[s.tier]}` : ''}${away ? ` · ${s.market} market` : ''}`;
      return `<button type="button" class="cal-bar ${kind}${away ? ' away' : ''}" style="${style}" data-target="${esc(s.id || '')}" title="${esc(tip)}" aria-label="${esc(tip)}"><span>${esc(s.name)}</span></button>`;
    }).join('');
  }

  function build() {
    const y = new Date().getFullYear();
    const total = isLeap(y) ? 366 : 365;
    const cal = meta.salesCalendar;
    const codes = Object.keys(meta.carriers);
    const sales = cal.sales.map((s, i) => ({ ...s, id: `sale-${i}` }));
    const fairs = cal.fairs.map((s, i) => ({ ...s, id: `fair-${i}` }));
    const todayPct = ((Date.UTC(y, new Date().getMonth(), new Date().getDate()) - Date.UTC(y, 0, 1)) / 86400000 / total) * 100;
    const monthCols = MONTHS.map((_, m) => `${daysIn(y, m)}fr`).join(' ');

    const rowsData = codes.map((c) => ({ c, ...layout(y, sales.filter((s) => s.carrier === c)) }));
    const fairLayout = layout(y, fairs);
    const labels = rowsData.map(({ c, lanes }) =>
      `<div class="cal-label" style="height:${rowHeight(lanes)}px"><i class="cal-dot" style="background:${brand(c)}"></i>${esc(meta.carriers[c].name)}</div>`).join('');
    const tracks = rowsData.map(({ c, segs, lanes }) => {
      const body = segs.length
        ? bars(total, segs, () => brand(c), 'sale')
        : `<span class="cal-none">${esc(cal.none?.[c] || 'No recurring sale found')}</span>`;
      return `<div class="cal-track" style="height:${rowHeight(lanes)}px">${body}</div>`;
    }).join('');

    const legendSw = (t) => `<span class="lg"><i class="cal-sw" style="background:${rgba(brand('SQ'), ALPHA[t])};border-color:${rgba(brand('SQ'), 0.65)}"></i>${TIER_LABEL[t]}</span>`;

    const listHtml = codes.map((c) => {
      const list = sales.filter((s) => s.carrier === c);
      if (!list.length) return '';
      return `<section><h3><i class="cal-dot" style="background:${brand(c)}"></i>${esc(meta.carriers[c].name)}</h3><ul>` +
        list.map((s) => `<li id="${s.id}"><b>${esc(s.name)}</b> · ${fmtRange(s.start, s.end)}
          <span class="cal-tier ${s.tier}">${TIER_LABEL[s.tier]}</span>
          ${s.market !== 'Singapore' ? `<span class="cal-market">${esc(s.market)}</span>` : ''}<br>
          <span class="cal-basis">Based on: ${esc(s.basis)} — <a href="${esc(s.url)}" target="_blank" rel="noopener">source</a></span></li>`).join('') +
        '</ul></section>';
    }).join('');

    backdrop.innerHTML = `
      <div class="cal-panel" role="dialog" aria-modal="true" aria-labelledby="cal-title">
        <div class="cal-head">
          <div>
            <h2 id="cal-title">Sales calendar · ${y}</h2>
            <p class="hint">Typical yearly booking windows, from 2023–2026 patterns. Exact dates shift each year. Dashed outline = sale run in another market (fares may not apply from Singapore).</p>
          </div>
          <button type="button" class="cal-close" aria-label="Close sales calendar">×</button>
        </div>
        <div class="cal-legend">${['small', 'large', 'main'].map(legendSw).join('')}
          <span class="lg"><i class="cal-sw away-sw"></i>Other market</span>
          <span class="lg"><i class="cal-sw fair"></i>Travel fair</span>
          <span class="lg"><i class="cal-today-sw"></i>Today</span></div>
        <div class="cal-wrap">
          <div class="cal-labels">
            <div class="cal-label cal-corner"></div>
            <div class="cal-label muted" style="height:${rowHeight(fairLayout.lanes)}px">Travel fairs</div>
            ${labels}
          </div>
          <div class="cal-scroll">
            <div class="cal-timeline">
              <div class="cal-months" style="grid-template-columns:${monthCols}">${MONTHS.map((m) => `<span>${m}</span>`).join('')}</div>
              <div class="cal-track fairs" style="height:${rowHeight(fairLayout.lanes)}px">${bars(total, fairLayout.segs, () => null, 'fair')}</div>
              ${tracks}
              <div class="cal-overlay" style="grid-template-columns:${monthCols}" aria-hidden="true">
                ${MONTHS.map(() => '<span></span>').join('')}
                <i class="cal-today" style="left:${todayPct}%"></i>
              </div>
            </div>
          </div>
        </div>
        <div class="cal-list">${listHtml}
          <p class="hint">Also monthly: KrisFlyer Spontaneous Escapes (about 30% off award seats about a month out) and bank promo codes (HSBC last Tuesday, DBS second Tuesday).</p>
        </div>
      </div>`;

    backdrop.querySelector('.cal-close').addEventListener('click', close);
    backdrop.querySelectorAll('.cal-bar').forEach((b) => b.addEventListener('click', () => {
      const li = backdrop.querySelector(`#${b.dataset.target}`);
      if (!li) return;
      backdrop.querySelectorAll('.cal-list li.hl').forEach((n) => n.classList.remove('hl'));
      li.classList.add('hl');
      li.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }));

    // Start scrolled to the current month on narrow screens.
    const scroller = backdrop.querySelector('.cal-scroll');
    requestAnimationFrame(() => {
      const track = backdrop.querySelector('.cal-months');
      if (scroller.scrollWidth > scroller.clientWidth) {
        scroller.scrollLeft = (todayPct / 100) * track.offsetWidth - scroller.clientWidth / 2;
      }
    });
  }

  function onKey(e) {
    if (e.key === 'Escape') close();
    if (e.key === 'Tab') { // keep focus inside the dialog
      const f = [...backdrop.querySelectorAll('button, a[href]')].filter((n) => n.offsetParent !== null);
      if (!f.length) return;
      if (e.shiftKey && document.activeElement === f[0]) { e.preventDefault(); f[f.length - 1].focus(); }
      else if (!e.shiftKey && document.activeElement === f[f.length - 1]) { e.preventDefault(); f[0].focus(); }
    }
  }

  function open(m) {
    meta = m;
    lastFocus = document.activeElement;
    if (!backdrop) {
      backdrop = document.createElement('div');
      backdrop.className = 'cal-backdrop';
      backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });
      document.body.append(backdrop);
    }
    build(); // rebuild so colours follow light/dark and "today" stays current
    backdrop.hidden = false;
    document.body.classList.add('modal-open');
    document.addEventListener('keydown', onKey);
    backdrop.querySelector('.cal-close').focus();
  }

  function close() {
    if (!backdrop) return;
    backdrop.hidden = true;
    document.body.classList.remove('modal-open');
    document.removeEventListener('keydown', onKey);
    lastFocus?.focus?.();
  }

  return { open, close };
})();
