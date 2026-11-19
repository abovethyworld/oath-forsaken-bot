// Remembers when each scheduled job last worked and last failed, so staff
// can see bot health without reading server logs.
// Data lives in data/job-status.json: { jobName: { lastOk, lastFail, lastError } }
const fs = require('node:fs');
const path = require('node:path');
const store = require('./store');

const FILE = path.join(__dirname, '..', 'data', 'job-status.json');

function readStatus() {
  try {
    const data = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    return data && typeof data === 'object' ? data : {};
  } catch {
    return {};
  }
}

function write(name, patch) {
  try {
    const all = readStatus();
    all[name] = { ...(all[name] || {}), ...patch };
    store.atomicWrite(FILE, all);
  } catch (e) {
    console.error('Job status write failed:', e.message);
  }
}

function recordOk(name) {
  write(name, { lastOk: new Date().toISOString() });
}

function recordFail(name, err) {
  const msg = String((err && err.message) || err || 'unknown error').slice(0, 200);
  write(name, { lastFail: new Date().toISOString(), lastError: msg });
  return msg;
}

function failed(name, err, opts) {
  const label = (opts && opts.label) || `Job ${name} failed`;
  console.error(`${label}:`, (err && err.message) || err);
  const msg = recordFail(name, err);
  if (opts && typeof opts.onFail === 'function') {
    try {
      const r = opts.onFail(msg);
      if (r && typeof r.catch === 'function') r.catch(() => {});
    } catch { /* alerting must never reach the job */ }
  }
}

// opts: { label } text for the console line, { onFail(msg) } called after a failure is recorded.
async function track(name, fn, opts) {
  try {
    await fn();
    recordOk(name);
  } catch (err) {
    failed(name, err, opts);
  }
}

function trackSync(name, fn, opts) {
  try {
    fn();
    recordOk(name);
  } catch (err) {
    failed(name, err, opts);
  }
}

module.exports = { track, trackSync, readStatus, recordOk, recordFail, FILE };
