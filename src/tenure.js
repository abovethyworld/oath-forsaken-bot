// Tenure ledger: seniority counts time actually spent in the clan
// chat (rule set Nov 5, 2026). Per Discord user: banked time from
// finished stretches, the start of the stretch they are in now, and
// the finished stretches themselves, so every leave date is on record.
// Time away banks nothing: leaving freezes the total where it was and
// rejoining resumes from there, however long the gap.
// Stretches move at the WOM group refresh (src/friends.js): a name
// appearing on the group list starts the linked account's stretch, a
// name disappearing ends it. Recorded dates are the refresh dates.
const fs = require('fs');
const path = require('path');
const { atomicWrite } = require('./store');
const membership = require('./membership');

const FILE = path.join(__dirname, '..', 'data', 'tenure.json');

let cache = null;

function emptyStore() {
  return { users: {}, seededAt: null };
}

function load() {
  if (cache) return cache;
  try {
    if (fs.existsSync(FILE)) {
      const parsed = JSON.parse(fs.readFileSync(FILE, 'utf8'));
      cache = parsed && typeof parsed === 'object' && parsed.users && typeof parsed.users === 'object'
        ? { users: parsed.users, seededAt: parsed.seededAt || null }
        : emptyStore();
    } else {
      cache = emptyStore();
    }
  } catch (err) {
    console.error(`Tenure: failed to parse ${FILE} (${err.message}); moving it aside and starting empty`);
    try {
      fs.renameSync(FILE, `${FILE}.corrupt-${Date.now()}`);
    } catch {}
    cache = emptyStore();
  }
  return cache;
}

function save() {
  try {
    atomicWrite(FILE, cache);
  } catch (err) {
    console.error('Tenure save failed:', err.message);
  }
}

function getRecord(userId) {
  return load().users[userId] || null;
}

// Accrued time for a record: banked stretches plus the open one.
// Pure, and never negative. Exported for the sims in tools/.
function accruedMs(rec, nowMs) {
  if (!rec) return 0;
  let ms = typeof rec.bankedMs === 'number' && rec.bankedMs > 0 ? rec.bankedMs : 0;
  if (rec.stretchStart) {
    const start = Date.parse(rec.stretchStart);
    if (Number.isFinite(start)) ms += Math.max(0, nowMs - start);
  }
  return ms;
}

// Record-level stretch moves, pure so the sims can drive them.
function applyStart(rec, atMs) {
  if (rec.stretchStart) return false;
  rec.stretchStart = new Date(atMs).toISOString();
  return true;
}

function applyEnd(rec, atMs) {
  if (!rec.stretchStart) return false;
  const start = Date.parse(rec.stretchStart);
  if (Number.isFinite(start) && atMs > start) {
    rec.bankedMs = (typeof rec.bankedMs === 'number' ? rec.bankedMs : 0) + (atMs - start);
  }
  if (!Array.isArray(rec.stretches)) rec.stretches = [];
  rec.stretches.push({ start: rec.stretchStart, end: new Date(atMs).toISOString() });
  rec.stretchStart = null;
  return true;
}

function blankRecord() {
  return { bankedMs: 0, stretchStart: null, stretches: [] };
}

function startStretch(userId, atMs) {
  const data = load();
  if (!data.users[userId]) data.users[userId] = blankRecord();
  if (!applyStart(data.users[userId], atMs)) return false;
  save();
  return true;
}

function endStretch(userId, atMs) {
  const data = load();
  const rec = data.users[userId];
  if (!rec || !applyEnd(rec, atMs)) return false;
  save();
  return true;
}

// Move one user's stretch state to match their membership at atMs.
function reconcile(userId, member, atMs) {
  return member ? startStretch(userId, atMs) : endStretch(userId, atMs);
}

// Reconcile every known user (linked accounts, plus anyone already in
// the ledger) against a fresh WOM group name list. Runs at each group
// refresh, so a join or leave lands in the ledger within one refresh
// of the list itself changing.
function reconcileAll(groupNames, atMs) {
  const links = membership.loadLinks();
  const ids = membership.computeMemberIds(links, groupNames);
  const all = new Set([...Object.keys(links), ...Object.keys(load().users)]);
  let changed = 0;
  for (const userId of all) {
    if (reconcile(userId, ids.has(userId), atMs)) changed++;
  }
  return changed;
}

// One-time seed for members who predate the ledger: the stretch start
// is the best date Wise Old Man holds for the person's in-group RSNs
// (the synced in-game join date when present, else the WOM group
// membership date), earliest across their accounts. Banked starts at
// zero: no leaves were recorded before the ledger existed.
function seedFromMemberships(membershipsList) {
  const data = load();
  if (data.seededAt) return 0;
  const owners = membership.computeOwnerMap(membership.loadLinks());
  const earliest = new Map();
  for (const m of membershipsList || []) {
    if (!m || typeof m.name !== 'string') continue;
    const owner = owners.get(membership.normName(m.name));
    if (!owner) continue;
    const t = Date.parse(m.clientSyncJoinedAt || m.createdAt || '');
    if (!Number.isFinite(t)) continue;
    if (!earliest.has(owner) || t < earliest.get(owner)) earliest.set(owner, t);
  }
  let seeded = 0;
  for (const [userId, t] of earliest) {
    const rec = data.users[userId];
    if (rec && (rec.stretchStart || rec.bankedMs > 0 || (Array.isArray(rec.stretches) && rec.stretches.length))) continue;
    data.users[userId] = { ...blankRecord(), stretchStart: new Date(t).toISOString(), seeded: true };
    seeded++;
  }
  data.seededAt = new Date().toISOString();
  save();
  return seeded;
}

function isSeeded() {
  return !!load().seededAt;
}

module.exports = {
  getRecord,
  accruedMs,
  applyStart,
  applyEnd,
  startStretch,
  endStretch,
  reconcile,
  reconcileAll,
  seedFromMemberships,
  isSeeded,
};
