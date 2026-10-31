// Daily gains snapshots for !gains. Once a day the bot records
// every known player's per-skill XP and KC from the local
// cache/vault (no API calls), and !gains diffs current numbers
// against the snapshot nearest the start of the period. The
// vault means even players nobody has looked up lately keep a
// baseline, as long as their cached stats exist.

const fs = require('fs');
const path = require('path');
const { mergedPlayers } = require('./wom');
const { atomicWrite } = require('./store');

const FILE = path.join(__dirname, '..', 'data', 'gains-snapshots.json');
const KEEP_DAYS = 40;

function loadSnaps() {
  try {
    return JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch {
    return {};
  }
}

function todayKey(d = new Date()) {
  return d.toISOString().slice(0, 10);
}

// Record today's snapshot if it does not exist yet. Returns
// true when a snapshot was written.
function snapshotToday() {
  const snaps = loadSnaps();
  const key = todayKey();
  if (snaps[key]) return false;
  const day = {};
  for (const [name, entry] of Object.entries(mergedPlayers())) {
    const st = entry && entry.stats;
    if (!st || st.notFound) continue;
    const xp = {};
    for (const [skill, v] of Object.entries(st.skills || {})) {
      if (v && typeof v.xp === 'number') xp[skill] = v.xp;
    }
    day[name] = { xp, kc: st.kc || {} };
  }
  if (!Object.keys(day).length) return false;
  snaps[key] = day;
  const keys = Object.keys(snaps).sort();
  while (keys.length > KEEP_DAYS) delete snaps[keys.shift()];
  atomicWrite(FILE, JSON.stringify(snaps));
  return true;
}

// The baseline for a period: the snapshot on or before
// (today - days), or the earliest one available. spanDays is
// the real span the diff covers, so a young tracker reports
// what it actually measured.
function baselineFor(days) {
  const snaps = loadSnaps();
  const keys = Object.keys(snaps).sort();
  if (!keys.length) return null;
  const target = Date.now() - days * 86400000;
  let best = null;
  for (const k of keys) {
    if (new Date(`${k}T00:00:00Z`).getTime() <= target) best = k;
  }
  const key = best || keys[0];
  const spanDays = Math.round(
    (Date.now() - new Date(`${key}T00:00:00Z`).getTime()) / 86400000);
  return { key, snap: snaps[key], spanDays, isToday: key === todayKey() };
}

module.exports = { snapshotToday, baselineFor, loadSnaps, todayKey };
