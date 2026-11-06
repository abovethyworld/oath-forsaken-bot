// Card Refresh: a member-funded forced update of one player's
// Wise Old Man snapshot. The charge rules live here so the card
// builders (which print the count on the button) and the button
// handler (which spends it) share one copy:
//   - 20 refreshes per person per UTC day, counted on the tapper.
//   - A refreshed name locks for 5 minutes, for everyone, so a
//     second pull cannot burn calls on numbers just fetched.
//   - One pull per name at a time; a tap during a pull is told
//     to wait and is never charged.
// State sits in data/refresh-state.json so counts and locks
// survive restarts. Every live pull still runs through the
// shared limiter inside wom.js; this module only decides who
// may spend and records the spend.
const fs = require('fs');
const path = require('path');

const DAILY_LIMIT = 20;
const LOCK_MS = 5 * 60 * 1000;
const STATE_PATH = path.join(__dirname, '..', 'data', 'refresh-state.json');

function dayKey(now) {
  return new Date(now).toISOString().slice(0, 10);
}

function loadState(file) {
  try {
    const s = JSON.parse(fs.readFileSync(file || STATE_PATH, 'utf8'));
    if (s && typeof s === 'object') {
      if (!s.users || typeof s.users !== 'object') s.users = {};
      if (!s.locks || typeof s.locks !== 'object') s.locks = {};
      return s;
    }
  } catch { /* no state yet: start empty */ }
  return { users: {}, locks: {} };
}

function saveState(state, file) {
  const target = file || STATE_PATH;
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const tmp = `${target}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state));
    fs.renameSync(tmp, target);
  } catch (err) {
    console.error('refresh state save failed:', err.message);
  }
}

// Yesterday's counts and expired locks carry no meaning; drop
// them whenever the state is touched so the file stays small.
function pruneState(state, now) {
  const today = dayKey(now);
  for (const [uid, e] of Object.entries(state.users)) {
    if (!e || e.day !== today) delete state.users[uid];
  }
  for (const [key, until] of Object.entries(state.locks)) {
    if (!(until > now)) delete state.locks[key];
  }
}

function remainingIn(state, userId, now) {
  if (!userId) return DAILY_LIMIT;
  const e = state.users[String(userId)];
  if (!e || e.day !== dayKey(now)) return DAILY_LIMIT;
  return Math.max(0, DAILY_LIMIT - (e.used || 0));
}

// How many refreshes this user has left today. Read-only; the
// card builders call it to print the count on the button.
function refreshRemaining(userId, now = Date.now()) {
  return remainingIn(loadState(), userId, now);
}

function lockLeftMs(state, key, now) {
  const until = state.locks[key];
  return typeof until === 'number' && until > now ? until - now : 0;
}

const inFlight = new Set();

// One refresh attempt, fully decided. Checks run busy, locked,
// allowance; only a pull Wise Old Man accepts is charged, and
// only a charged pull locks the name. updateFn is injected so
// tests drive the whole flow without the network. Outcomes:
// ok { remaining } / busy / locked { minutes } / empty / failed.
async function runRefresh({ userId, rsn, updateFn, now = Date.now(), file } = {}) {
  const key = String(rsn || '').toLowerCase().trim();
  if (!key || !userId || typeof updateFn !== 'function') return { outcome: 'failed' };
  if (inFlight.has(key)) return { outcome: 'busy' };
  const state = loadState(file);
  pruneState(state, now);
  const lockMs = lockLeftMs(state, key, now);
  if (lockMs > 0) return { outcome: 'locked', minutes: Math.max(1, Math.ceil(lockMs / 60000)) };
  if (remainingIn(state, userId, now) <= 0) return { outcome: 'empty' };
  inFlight.add(key);
  let accepted = false;
  try {
    accepted = !!(await updateFn(rsn));
  } catch { accepted = false; } finally {
    inFlight.delete(key);
  }
  if (!accepted) return { outcome: 'failed' };
  // Read the state again before writing: the pull took seconds
  // and another name's charge may have landed meanwhile.
  const fresh = loadState(file);
  pruneState(fresh, now);
  const uid = String(userId);
  const entry = fresh.users[uid] && fresh.users[uid].day === dayKey(now)
    ? fresh.users[uid] : { day: dayKey(now), used: 0 };
  entry.used = (entry.used || 0) + 1;
  fresh.users[uid] = entry;
  fresh.locks[key] = now + LOCK_MS;
  saveState(fresh, file);
  return { outcome: 'ok', remaining: Math.max(0, DAILY_LIMIT - entry.used) };
}

module.exports = {
  runRefresh, refreshRemaining, remainingIn, loadState, saveState,
  pruneState, lockLeftMs, dayKey, DAILY_LIMIT, LOCK_MS, STATE_PATH,
};
