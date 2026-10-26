'use strict';

// data/community is a clone of the private data repo (jtthejam/miles-prices). These helpers run git
// inside that clone: pull everyone's prices, count files waiting to be sent, open a pull request.
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const db = require('./db');

const DIR = db.COMMUNITY_DIR;
const DATA_REPO = 'jtthejam/miles-prices';

const git = (args, timeout = 20000) => new Promise((resolve, reject) => {
  execFile('git', ['-C', DIR, ...args], { timeout }, (err, stdout, stderr) => {
    if (err) return reject(new Error(String(stderr || err.message).trim().split('\n').pop()));
    resolve(String(stdout).trim());
  });
});

const isClone = () => fs.existsSync(path.join(DIR, '.git'));

// Fast-forward only: never merges or rewrites your local work.
async function pull() {
  if (!isClone()) return { pulled: false, reason: 'not cloned' };
  try {
    await git(['pull', '--ff-only', '--quiet']);
    return { pulled: true };
  } catch (e) {
    return { pulled: false, reason: e.message };
  }
}

// Share files written here but not yet committed in the data repo.
async function status() {
  if (!isClone()) {
    let files = 0;
    try { files = fs.readdirSync(DIR).filter((f) => f.endsWith('.jsonl')).length; } catch { /* none */ }
    return { cloned: false, repo: DATA_REPO, uncommitted: null, files };
  }
  try {
    const out = await git(['status', '--porcelain', '--untracked-files=all', '--', '*.jsonl'], 5000);
    return { cloned: true, repo: DATA_REPO, uncommitted: out ? out.split('\n').length : 0 };
  } catch {
    return { cloned: true, repo: DATA_REPO, uncommitted: null };
  }
}

module.exports = { DIR, DATA_REPO, isClone, pull, status, git };
