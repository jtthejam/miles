'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const data = require('./data');
const { buildRows } = require('./lib/calc');
const live = require('./lib/live');
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
        const out = await live.lowestReturnFare({
          carrier,
          dest: String(q.get('dest') || '').toUpperCase(),
          cabin: q.get('cabin'),
          outbound: q.get('outbound'),
          inbound: q.get('inbound'),
        });
        return sendJson(res, 200, out);
      } catch (e) {
        return sendJson(res, live.enabled() ? 502 : 503, { error: e.message });
      }
    default:
      return sendJson(res, 404, { error: 'Not found' });
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
  if (req.method !== 'GET') { res.writeHead(405); return res.end(); }
  if (url.pathname.startsWith('/api/')) return handleApi(url, res);
  serveStatic(url, res);
});

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`Miles Maximiser v${version} on http://localhost:${PORT}` + (live.enabled() ? ' (live pricing on)' : ''));
  });
}

module.exports = server;
