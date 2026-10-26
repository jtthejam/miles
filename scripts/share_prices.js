#!/usr/bin/env node
'use strict';

// Share your saved prices with other users, anonymised, through the private data repo
// jtthejam/miles-prices (cloned into data/community).
//
//   node scripts/share_prices.js                 write any new anonymised prices to data/community
//   node scripts/share_prices.js --pr            ...then commit them on a branch, push and open a pull request
//   node scripts/share_prices.js --min-age-days 7
//
// The server already writes share files automatically (startup and every 6 hours), so usually
// only --pr is needed. --pr needs git and the GitHub CLI (gh), signed in with access to the repo.
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const db = require('../lib/db');
const repo = require('../lib/community-repo');

const arg = (name) => process.argv.includes(name);
const i = process.argv.indexOf('--min-age-days');
const minAgeDays = i > 0 ? Number(process.argv[i + 1]) : 2;
if (!(minAgeDays >= 0)) { console.error('--min-age-days must be 0 or more'); process.exit(1); }

const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { cwd: repo.DIR, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts }).trim();

db.load();
const { file, count } = db.share({ minAgeDays });
console.log(count
  ? `Wrote ${count} anonymised price(s) to ${file}`
  : `No new prices to share (they must be at least ${minAgeDays} day(s) old and not shared before).`);

if (!arg('--pr')) {
  if (count) console.log('Send them with: node scripts/share_prices.js --pr');
  process.exit(0);
}

if (!repo.isClone()) {
  console.error(`data/community isn't a clone of ${repo.DATA_REPO}. Set it up first:\n  git clone https://github.com/${repo.DATA_REPO}.git data/community`);
  process.exit(1);
}
const pending = run('git', ['status', '--porcelain', '--untracked-files=all', '--', '*.jsonl']).split('\n').filter(Boolean);
if (!pending.length) { console.log('Nothing waiting to be sent.'); process.exit(0); }

// Only new share files are sent: anything else changed in the clone is left alone.
const files = pending.map((l) => l.slice(3).trim()).filter((f) => /^prices-\d{4}-\d{2}-[0-9a-f]{6}\.jsonl$/.test(path.basename(f)));
for (const f of files) {
  for (const [n, line] of fs.readFileSync(path.join(repo.DIR, f), 'utf8').split('\n').filter(Boolean).entries()) {
    const problem = db.communityProblem(JSON.parse(line));
    if (problem) { console.error(`${f}:${n + 1}: ${problem}. Not sending.`); process.exit(1); }
  }
}
const base = run('git', ['rev-parse', '--abbrev-ref', 'HEAD']);
const branch = `share-${new Date().toISOString().slice(0, 10)}-${Math.random().toString(16).slice(2, 8)}`;
try {
  run('git', ['switch', '-c', branch]);
  run('git', ['add', '--', ...files]);
  const n = files.reduce((s, f) => s + fs.readFileSync(path.join(repo.DIR, f), 'utf8').split('\n').filter(Boolean).length, 0);
  run('git', ['commit', '-m', `Share ${n} anonymised price${n === 1 ? '' : 's'}`]);
  run('git', ['push', '-u', 'origin', branch], { timeout: 60000 });
  const url = run('gh', ['pr', 'create', '--fill', '--head', branch], { timeout: 60000 });
  console.log(`Pull request opened: ${url}`);
} catch (e) {
  console.error(`Couldn't open the pull request: ${String(e.stderr || e.message).trim()}`);
  console.error(`Your files are committed on branch ${branch} in data/community.`);
  process.exitCode = 1;
} finally {
  // Back to the main branch so the app keeps pulling everyone's prices. The ledger in data/db stops
  // these prices being shared again while the pull request is open.
  try { run('git', ['switch', base]); } catch { /* stay on the share branch */ }
}
