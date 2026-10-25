'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const data = require('./data');
const { buildRows } = require('./lib/calc');
const live = require('./lib/live');
const settings = require('./lib/settings');
const { version } = require('./package.json');

const PORT = Number(process.env.PORT) || 3000;
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
    case '/api/routes':
      return sendJson(res, 200, {
        rows: buildRows(data, {
          classOverrides: parseJson(q.get('classes')),
          priceOverrides: parseJson(q.get('overrides')),
          roundTrip: q.get('roundTrip') !== 'false',
        }),
      });
    case '/api/live':
      try {
        const carrier = String(q.get('carrier') || 'SQ').toUpperCase();
        if (!data.carriers[carrier]) throw new Error(`Unsupported carrier ${carrier}`);
        // Dates are optional; flex (0-3) searches that many days either side, keeping trip length.
        const out = await live.lowestFareInWindow({
          carrier,
          dest: String(q.get('dest') || '').toUpperCase(),
          cabin: q.get('cabin'),
          outbound: q.get('outbound') || undefined,
          inbound: q.get('inbound') || undefined,
          flex: q.get('flex') || 0,
        });
        return sendJson(res, 200, out);
      } catch (e) {
        return sendJson(res, live.enabled() ? 502 : 503, { error: e.message });
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

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (url.pathname === '/api/settings/serpapi') return handleSettings(req, res);
  if (req.method !== 'GET') { res.writeHead(405); return res.end(); }
  if (url.pathname.startsWith('/api/')) return handleApi(url, res);
  serveStatic(url, res);
});

if (require.main === module) {
  live.checkFastFlights().then(() => {
    server.listen(PORT, process.env.HOST || '127.0.0.1', () => {
      const st = live.status();
      const how = st.provider === 'serpapi' ? 'SerpApi' : st.provider === 'fast-flights' ? 'fast-flights (no SerpApi key)' : 'off';
      console.log(`Miles Maximiser v${version} on http://localhost:${PORT} — live prices: ${how}`);
    });
  });
}

module.exports = server;
