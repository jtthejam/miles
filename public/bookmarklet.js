// "Send to Miles Maximiser" bookmarklet. The app turns this file into a javascript: link
// (replacing __APP__ with its own address); you drag that link to your bookmarks bar.
// On a Google Flights page it reads the prices you can see and opens the app with them.
// It sends nothing anywhere else, and reads only price labels and the page address.
(function () {
  var APP = '__APP__';
  if (!/\/travel\/flights/.test(location.pathname) || !/(^|\.)google\.[a-z.]+$/.test(location.hostname)) {
    alert('Open a Google Flights search first (use the "Google Flights" link on a row in Miles Maximiser).');
    return;
  }
  var visible = function (el) { return !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length); };
  var sp = function (t) { return t.replace(/\s+/g, ' '); };
  var grid = [], list = [], i, m, els;

  // Date grid cells, e.g. "SGD 1,470, low price, Nov 30 to Dec 6" (cells with "price unknown" are skipped).
  // The grid is drawn on a canvas; its labelled cells have no size, so check the open dialog instead.
  els = document.querySelectorAll('[role="dialog"] [aria-label]');
  for (i = 0; i < els.length; i++) {
    if (!visible(els[i].closest('[role="dialog"]'))) continue;
    // Google separates "SGD" and the amount with a non-breaking space, so match any whitespace.
    m = /^([A-Z]{3})\s([\d,]+),(?:\s[^,]+,)?\s([A-Z][a-z]{2}\s\d{1,2})\sto\s([A-Z][a-z]{2}\s\d{1,2})/.exec(els[i].getAttribute('aria-label'));
    if (m) grid.push([m[2], sp(m[3]), sp(m[4]), m[1]]);
  }

  // Result list, e.g. "From 1719 Singapore dollars round trip total. Nonstop flight with Singapore Airlines. ..."
  if (!grid.length) {
    els = document.querySelectorAll('[aria-label^="From "]');
    for (i = 0; i < els.length; i++) {
      m = /^From\s([\d,]+)\s(.+?)\sround\strip\stotal\..*?flights?\swith\s(.+?)\./.exec(els[i].getAttribute('aria-label'));
      if (m) list.push([m[1], sp(m[2]), sp(m[3])]);
    }
  }

  if (!grid.length && !list.length) {
    alert('No prices found yet. Wait for the results to load, or open "Date grid", then click the bookmark again.');
    return;
  }
  var payload = { v: 1, href: location.href, grid: grid, list: list.slice(0, 60) };
  window.open(APP + '/#gf=' + encodeURIComponent(JSON.stringify(payload)), 'miles-maximiser');
})();
