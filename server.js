'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const data = require('./data');
const { buildRows } = require('./lib/calc');
const live = require('./lib/live');
const settings = require('./lib/settings');
const db = require('./lib/db');
const communityRepo = require('./lib/community-repo');
const { version } = require('./package.json');

const PORT = Number(process.env.PORT) || 3000;
// Automatic anonymised sharing: saved prices at least AUTO_SHARE_DAYS old are written to
// data/community on startup and every 6 hours, ready to commit and send as a pull request.
const AUTO_SHARE = process.env.MILES_AUTO_SHARE !== '0';
const AUTO_SHARE_DAYS = 2;
let lastShare = null;
function autoShare() {
  if (!AUTO_SHARE) return null;
  try {
    const out = db.share({ minAgeDays: AUTO_SHARE_DAYS });
    lastShare = { at: new Date().toISOString(), ...out };
    if (out.count) console.log(`Shared ${out.count} anonymised price(s) to ${out.file} (commit it and open a pull request to share)`);
    return out;
  } catch (e) {
    lastShare = { at: new Date().toISOString(), error: e.message };
    return null;
  }
}

const PUBLIC_DIR = path.join(__dirname, 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json' };

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function parseJson(str) {
  try { const v = JSON.parse(str || '{}'); return v && typeof v === 'object' ? v : {}; } catch { return {}; }
}

async function handleApi(url, res) {
  const q = url.searchParams;
  switch (url.pathname) {
    case '/api/meta':
      return sendJson(res, 200, {
        version,
        origin: data.origin,
        airports: data.airports,
        carriers: data.carriers,
        accrualSource: data.accrualSource,
        sources: data.sources,
        salesCalendar: data.salesCalendar,
        liveEnabled: live.enabled(),
        live: live.status(),
      });
    case '/api/routes': {
      // Saved search prices for the date range (same defaults as live searches: ~60 days out, 7 nights).
      let range = null;
      // Past ranges are allowed here: old saved searches stay viewable as a price reference.
      try { range = live.datePairs({ outbound: q.get('outbound') || undefined, inbound: q.get('inbound') || undefined, flex: q.get('flex') || 0, today: q.get('outbound') ? '1970-01-01' : undefined }); } catch { range = null; }
      return sendJson(res, 200, {
        range: range && { outbound: range.outbound, inbound: range.inbound, flex: range.flex },
        rows: buildRows(data, {
          classOverrides: parseJson(q.get('classes')),
          priceOverrides: parseJson(q.get('overrides')),
          // "Max connection" (minutes): saved prices with a longer connection are left out.
          searchPrices: range ? db.pricesForRange({ ...range, maxLayover: q.get('maxLayover') }) : {},
          communityPrices: range ? db.communityForRange({ ...range, maxLayover: q.get('maxLayover') }) : {},
          roundTrip: q.get('roundTrip') !== 'false',
        }),
      });
    }
    case '/api/db/searches':
      return sendJson(res, 200, {
        searches: db.searches(), ...db.stats(), dir: undefined,
        autoShare: { enabled: AUTO_SHARE, minAgeDays: AUTO_SHARE_DAYS, last: lastShare, ...(await communityRepo.status()) },
      });
    case '/api/live':
      try {
        // A route is picked by id ("SQ+LX:BOD"), or by carrier + dest for single-airline routes.
        const dest = String(q.get('dest') || '').toUpperCase();
        const carrier = String(q.get('carrier') || 'SQ').toUpperCase();
        const routeId = q.get('route');
        const route = routeId
          ? data.fares.find((f) => f.routeId === routeId)
          : data.fares.find((f) => f.carrier === carrier && f.to === dest && !f.mixed);
        if (routeId && !route) throw new Error(`Unknown route ${routeId}`);
        if (!route && !data.carriers[carrier]) throw new Error(`Unsupported carrier ${carrier}`);
        // The route's connection and airlines come from the data, so searches match the row's miles.
        // Searching every region at once is only allowed with a SerpApi key (fast-flights scrapes Google).
        if (q.get('batch') === 'all' && live.status().provider !== 'serpapi') {
          return sendJson(res, 403, { error: 'Searching every region needs a SerpApi key. Pick one region to search with fast-flights.' });
        }
        const out = await live.lowestFareInWindow({
          route: route ? route.routeId : null, // saved to / reused from the price database
          carriers: route ? route.carriers : [carrier],
          dest: route ? route.to : dest,
          via: route ? route.via : [],
          // Flexible rows: any of the airline's hubs fits (miles follow the one priced).
          viaOptions: route && route.flexible ? route.hubs.map((h) => [h]) : undefined,
          segmentCarriers: route && route.mixed ? route.segments.map((s) => s.carrier) : null,
          airlineNames: route && route.mixed ? route.carriers.map((c) => data.carriers[c].name) : null,
          cabin: q.get('cabin'),
          // Dates are optional; flex (0-3) searches that many days either side, keeping trip length.
          outbound: q.get('outbound') || undefined,
          inbound: q.get('inbound') || undefined,
          flex: q.get('flex') || 0,
          // Longest connection allowed, in minutes (empty = any).
          maxLayover: q.get('maxLayover') || null,
        });
        return sendJson(res, 200, { ...out, route: route ? route.routeId : `${carrier}:${dest}` });
      } catch (e) {
        return sendJson(res, live.enabled() ? 502 : 503, { error: e.message, urls: e.urls || (e.url ? [e.url] : []) });
      }
    default:
      return sendJson(res, 404, { error: 'Not found' });
  }
}

// Only the machine running the server may change settings (the key is a secret on this computer).
const isLoopback = (req) => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);

function readBody(req, limit = 4096) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > limit) { reject(new Error('Body too large')); req.destroy(); } });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

async function handleSettings(req, res) {
  if (!isLoopback(req)) return sendJson(res, 403, { error: 'Settings can only be changed from this computer' });
  if (req.headers['content-type']?.split(';')[0] !== 'application/json' && req.method === 'POST') {
    return sendJson(res, 415, { error: 'Expected application/json' }); // blocks simple cross-site form posts
  }
  try {
    if (req.method === 'POST') {
      const { key } = parseJson(await readBody(req));
      settings.saveSerpApiKey(String(key || '').trim());
    } else if (req.method === 'DELETE') {
      settings.clearSerpApiKey();
    } else {
      return sendJson(res, 405, { error: 'Method not allowed' });
    }
    return sendJson(res, 200, { live: live.status() });
  } catch (e) {
    return sendJson(res, 400, { error: e.message });
  }
}

function serveStatic(url, res) {
  const rel = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(buf);
  });
}

// Google Flights imports (from the bookmarklet, via the page) are saved here: all cells of a date
// grid, or the cheapest result for the page's dates. Route details come from the data, not the client.
// "Share prices": write your saved prices, anonymised, to data/community (this computer only).
async function handleShare(req, res) {
  if (!isLoopback(req)) return sendJson(res, 403, { error: 'Sharing can only be started on this computer' });
  if (req.method !== 'POST') return sendJson(res, 405, { error: 'Method not allowed' });
  if (req.headers['content-type']?.split(';')[0] !== 'application/json') return sendJson(res, 415, { error: 'Expected application/json' });
  const { minAgeDays } = parseJson(await readBody(req));
  const days = Math.max(0, Math.min(30, Number(minAgeDays ?? 2) || 0));
  const out = db.share({ minAgeDays: days });
  return sendJson(res, 200, { ...out, minAgeDays: days });
}

async function handleDbRecords(req, res) {
  if (req.method !== 'POST') return sendJson(res, 405, { error: 'Method not allowed' });
  if (req.headers['content-type']?.split(';')[0] !== 'application/json') return sendJson(res, 415, { error: 'Expected application/json' });
  try {
    const body = parseJson(await readBody(req, 64 * 1024));
    const route = data.fares.find((f) => f.routeId === body.route);
    if (!route) throw new Error(`Unknown route ${body.route}`);
    if (!['economy', 'premium'].includes(body.cabin)) throw new Error('cabin must be economy or premium');
    const range = body.range || {};
    const at = new Date();
    const searchId = db.newSearchId(at);
    const list = (Array.isArray(body.prices) ? body.prices : []).slice(0, 200).map((p) => ({
      v: 1, searchId, searchedAt: at.toISOString(),
      route: route.routeId, carriers: route.carriers, dest: route.to, cabin: body.cabin,
      range: { outbound: range.outbound, inbound: range.inbound, flex: Math.max(0, Math.min(7, Number(range.flex) || 0)) },
      // The connection Google showed (flexible rows: one of the airline's hubs), else the row's own.
      via: route.flexible && Array.isArray(p.via) && p.via.length === 1 && route.hubs.includes(p.via[0]) ? p.via : route.via,
      outbound: p.outbound, inbound: p.inbound, price: Number(p.price), currency: 'SGD',
      provider: 'google-flights', offers: null, source: body.source === 'grid' ? 'date grid' : 'results',
      // Longest connection of the itinerary priced (results list only) and the page's limit, if any.
      ...(Number.isInteger(p.layoverMin) && p.layoverMin >= 0 ? { layoverMin: p.layoverMin } : {}),
      ...(db.limitOf(body.maxLayover) ? { maxLayover: db.limitOf(body.maxLayover) } : {}),
    }));
    const saved = db.save(list);
    if (!saved.length) throw new Error('No valid prices to save');
    return sendJson(res, 200, { saved: saved.length, searchId });
  } catch (e) {
    return sendJson(res, 400, { error: e.message });
  }
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (url.pathname === '/api/settings/serpapi') return handleSettings(req, res);
  if (url.pathname === '/api/db/records') return handleDbRecords(req, res);
  if (url.pathname === '/api/db/share') return handleShare(req, res);
  if (req.method !== 'GET') { res.writeHead(405); return res.end(); }
  if (url.pathname.startsWith('/api/')) return handleApi(url, res);
  serveStatic(url, res);
});

if (require.main === module) {
  // Get everyone's latest prices from the data repo first (fast-forward only; MILES_COMMUNITY_PULL=0 skips).
  const pulled = process.env.MILES_COMMUNITY_PULL === '0' ? Promise.resolve({ pulled: false, reason: 'off' }) : communityRepo.pull();
  pulled.then((p) => {
    if (!communityRepo.isClone()) console.log(`Community prices: data/community isn't a clone of ${communityRepo.DATA_REPO} (see README to join)`);
    else if (!p.pulled && p.reason !== 'off') console.log(`Community prices: couldn't update data/community (${p.reason})`);
  });
  let loadedDb = db.load(); // every *.jsonl in data/db
  pulled.then(() => { loadedDb = db.load(); autoShare(); }); // reload with pulled files, then share
  setInterval(autoShare, 6 * 3600e3).unref();
  Promise.all([live.checkFastFlights(), pulled]).then(() => {
    server.listen(PORT, process.env.HOST || '127.0.0.1', () => {
      const st = live.status();
      const how = st.provider === 'serpapi' ? 'SerpApi' : st.provider === 'fast-flights' ? 'fast-flights (no SerpApi key)' : 'off';
      console.log(`Miles Maximiser v${version} on http://localhost:${PORT} — live prices: ${how}`);
      console.log(`Price database: ${loadedDb.records} saved prices from ${loadedDb.files} file(s) in data/db${loadedDb.skipped ? ` (${loadedDb.skipped} unreadable lines skipped)` : ''}`);
      console.log(`Community prices: ${loadedDb.community.records} from ${loadedDb.community.files} shared file(s) in data/community${loadedDb.community.skipped ? ` (${loadedDb.community.skipped} lines rejected)` : ''}`);
    });
  });
}

module.exports = server;
