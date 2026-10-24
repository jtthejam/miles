'use strict';

// Local settings (SerpApi key) stored in .local/config.json — gitignored, file mode 600.
// The SERPAPI_KEY environment variable takes precedence over the saved key.
const fs = require('node:fs');
const path = require('node:path');

const DIR = process.env.MILES_CONFIG_DIR || path.join(__dirname, '..', '.local');
const FILE = path.join(DIR, 'config.json');

function read() {
  try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return {}; }
}

function write(cfg) {
  fs.mkdirSync(DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(FILE, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 });
  fs.chmodSync(FILE, 0o600);
}

const isValidKey = (k) => typeof k === 'string' && /^[A-Za-z0-9_-]{20,128}$/.test(k);

function serpApiKey() {
  return process.env.SERPAPI_KEY || read().serpApiKey || null;
}

function keySource() {
  if (process.env.SERPAPI_KEY) return 'env';
  return read().serpApiKey ? 'saved' : null;
}

function saveSerpApiKey(key) {
  if (!isValidKey(key)) throw new Error('That does not look like a SerpApi key');
  write({ ...read(), serpApiKey: key });
}

function clearSerpApiKey() {
  const cfg = read();
  delete cfg.serpApiKey;
  write(cfg);
}

module.exports = { serpApiKey, keySource, saveSerpApiKey, clearSerpApiKey, isValidKey, FILE };
