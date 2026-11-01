// Bounty proof checker. A claim stores a snapshot of the claimant's
// numbers at claim time; the Done button in the proof thread re-reads
// the same sources and measures from the claim forward, so an item or
// KC gained before claiming never counts. Checks run in a fixed order:
// the plugin drops log (strongest, server-timestamped), then collection
// log appearance, then Wise Old Man KC/XP deltas. The result is
// evidence for staff; a human still presses Grant.
const fs = require('fs');
const path = require('path');
const { getStats } = require('./wom');
const { getClogPages } = require('./runeprofile');
const { getRsn } = require('./teams');

const LUCK = (() => {
  try {
    return require('./luck-data.json');
  } catch {
    return { items: {} };
  }
})();

// Item name -> item ids, from the luck table (814 scored items). Items
// outside the table cannot be matched in the drops log by id; the
// collection log check matches those by name instead.
const NAME_TO_IDS = new Map();
for (const [id, entry] of Object.entries(LUCK.items || {})) {
  if (!entry || typeof entry.name !== 'string') continue;
  const key = entry.name.toLowerCase();
  if (!NAME_TO_IDS.has(key)) NAME_TO_IDS.set(key, []);
  NAME_TO_IDS.get(key).push(Number(id));
}

function itemIdsForName(name) {
  const q = String(name || '').trim().toLowerCase();
  if (!q) return [];
  if (NAME_TO_IDS.has(q)) return NAME_TO_IDS.get(q);
  for (const [n, ids] of NAME_TO_IDS) {
    if (n.startsWith(q) || n.includes(q)) return ids;
  }
  return [];
}

function slugFor(rsn) {
  return String(rsn || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

const normKey = (s) => String(s || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');

// WOM metric keys a proof target refers to: the exact key plus its
// mode variants (tombs_of_amascut covers tombs_of_amascut_expert), or,
// with no exact key, any key containing the target (or contained by
// it).
function kcKeysFor(stats, target) {
  const kc = (stats && stats.kc) || {};
  const keys = Object.keys(kc);
  const t = normKey(target);
  if (!t) return [];
  if (keys.includes(t)) return keys.filter((k) => k === t || k.startsWith(`${t}_`));
  return keys.filter((k) => k.includes(t) || t.includes(k));
}

function kcTotal(stats, keys) {
  const kc = (stats && stats.kc) || {};
  return keys.reduce((sum, k) => sum + (typeof kc[k] === 'number' ? kc[k] : 0), 0);
}

// XP for a proof target: a skill name, or overall (sum of all skills).
function xpFor(stats, target) {
  const skills = (stats && stats.skills) || {};
  const t = normKey(target);
  if (!t) return null;
  if (t === 'overall' || t === 'total') {
    let sum = 0;
    let any = false;
    for (const [k, v] of Object.entries(skills)) {
      if (k === 'overall') continue;
      if (v && typeof v.xp === 'number') {
        sum += v.xp;
        any = true;
      }
    }
    const overall = skills.overall && typeof skills.overall.xp === 'number' ? skills.overall.xp : null;
    return any || overall != null ? { label: 'Overall', xp: overall != null ? overall : sum } : null;
  }
  const entry = skills[t];
  if (entry && typeof entry.xp === 'number') return { label: target, xp: entry.xp };
  return null;
}

// First drop of any target item strictly after the claim time. Entries
// are plugin drop log lines: {source, kind, items:[{id, qty}], at}.
function findDropSince(entries, ids, sinceMs) {
  if (!ids.length) return null;
  const want = new Set(ids);
  for (const e of entries || []) {
    const at = Date.parse(e && e.at);
    if (!Number.isFinite(at) || at <= sinceMs) continue;
    for (const it of e.items || []) {
      if (want.has(it.id)) return { at, source: e.source || 'unknown', id: it.id };
    }
  }
  return null;
}

function readDropEntries(rsn) {
  try {
    const file = path.join(__dirname, '..', 'data', 'plugin-sync', 'drops', `${slugFor(rsn)}.jsonl`);
    return fs
      .readFileSync(file, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

// Does the obtained-items set (RuneProfile full log parse) contain the
// target, by id when known, else by name?
function clogHasInPages(pages, targetName, ids) {
  const q = String(targetName || '').trim().toLowerCase();
  const want = new Set(ids || []);
  for (const page of Object.values(pages || {})) {
    for (const it of page.items || []) {
      if (want.has(it.id)) return true;
      if (q && String(it.name || '').toLowerCase() === q) return true;
    }
  }
  return false;
}

async function clogHasNow(rsn, targetName, ids) {
  const res = await getClogPages(rsn).catch(() => null);
  if (!res || res.notFound || !res.pages) return null;
  return clogHasInPages(res.pages, targetName, ids);
}

// Snapshot the claimant's numbers for this proof target. Never throws:
// a failed source records a note and the claim proceeds regardless.
async function takeSnapshot(rsn, proof) {
  const snap = { at: Date.now(), rsn: rsn || null };
  if (!proof || !proof.type) return snap;
  if (!rsn) {
    snap.note = 'no linked RSN';
    return snap;
  }
  try {
    if (proof.type === 'kc') {
      const stats = await getStats(rsn);
      const keys = stats ? kcKeysFor(stats, proof.target) : [];
      if (stats && keys.length) snap.kc = { keys, total: kcTotal(stats, keys) };
      else snap.note = 'no Wise Old Man KC found for that target';
    } else if (proof.type === 'xp') {
      const stats = await getStats(rsn);
      const entry = stats ? xpFor(stats, proof.target) : null;
      if (entry) snap.xp = entry;
      else snap.note = 'no Wise Old Man XP found for that target';
    } else if (proof.type === 'drop' || proof.type === 'clog') {
      const ids = itemIdsForName(proof.target);
      snap.clogHas = await clogHasNow(rsn, proof.target, ids);
      if (snap.clogHas === null) snap.note = 'collection log unavailable at claim time';
    }
  } catch (err) {
    snap.note = `snapshot failed: ${err.message}`;
  }
  return snap;
}

function snapshotLine(snapshot, proof) {
  if (!proof || !proof.type) return null;
  if (!snapshot) return 'Snapshot failed. Staff can still judge a screenshot.';
  if (!snapshot.rsn) {
    return 'No RSN is linked to your Discord, so the proof checker has nothing to measure. /connect links it. Screenshots still work.';
  }
  if (snapshot.kc) return `Snapshot at claim: ${proof.target} KC ${snapshot.kc.total}. Gains count from here.`;
  if (snapshot.xp) return `Snapshot at claim: ${snapshot.xp.label} XP ${snapshot.xp.xp.toLocaleString()}. Gains count from here.`;
  if (snapshot.clogHas === true) {
    return `Heads up: the collection log already shows ${proof.target} from before this claim. A fresh one has to land after the claim.`;
  }
  if (snapshot.clogHas === false) return `Snapshot at claim: ${proof.target} is not in the collection log yet.`;
  if (snapshot.note) return `Snapshot: ${snapshot.note}. The checker will compare what it can.`;
  return null;
}

const fmtDate = (ms) => new Date(ms).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';

// Run the checks for one claim. Returns { status, lines } where status
// is 'proven', 'not', or 'unknown' (a source could not settle it).
async function verifyProof({ rsn, proof, snapshot, claimedAt }) {
  const lines = [];
  if (!proof || !proof.type) return { status: 'unknown', lines: ['This contract has no proof target.'] };
  if (!rsn) {
    return {
      status: 'unknown',
      lines: ['No RSN is linked to the claimant\u2019s Discord, so nothing can be checked automatically. /connect links it.'],
    };
  }
  const need = proof.amount && proof.amount > 0 ? proof.amount : 1;

  if (proof.type === 'drop' || proof.type === 'clog') {
    const ids = itemIdsForName(proof.target);
    // 1. Plugin drops log.
    const entries = readDropEntries(rsn);
    const hit = findDropSince(entries, ids, claimedAt);
    if (hit) {
      lines.push(`Plugin drop log: item ${hit.id} dropped from ${hit.source} at ${fmtDate(hit.at)}, after the claim.`);
      return { status: 'proven', lines };
    }
    if (!ids.length) {
      lines.push(`Drops log: ${proof.target} is not in the scored item table, so the log cannot be matched by item.`);
    } else if (!entries.length) {
      lines.push('Drops log: no plugin drops recorded for this player yet.');
    } else {
      lines.push(`Drops log: no ${proof.target} since the claim.`);
    }
    // 2. Collection log appearance.
    const hasNow = await clogHasNow(rsn, proof.target, ids).catch(() => null);
    if (hasNow === true && snapshot && snapshot.clogHas === false) {
      lines.push(`Collection log: ${proof.target} was missing at claim time and is in the log now.`);
      return { status: 'proven', lines };
    }
    if (hasNow === true && snapshot && snapshot.clogHas === true) {
      lines.push(`Collection log: ${proof.target} is in the log, but it was already there at claim time. It does not prove this claim.`);
      return { status: 'not', lines };
    }
    if (hasNow === true) {
      lines.push(`Collection log: ${proof.target} is in the log now, but there is no claim-time snapshot to prove it landed after the claim.`);
      return { status: 'unknown', lines };
    }
    if (hasNow === false) lines.push(`Collection log: ${proof.target} is not in the log yet.`);
    else lines.push('Collection log: unavailable right now.');
    return { status: hasNow === false ? 'not' : 'unknown', lines };
  }

  if (proof.type === 'kc') {
    const stats = await getStats(rsn).catch(() => null);
    if (!stats) return { status: 'unknown', lines: ['Wise Old Man lookup failed. Try again in a bit.'] };
    const keys = snapshot && snapshot.kc ? snapshot.kc.keys : kcKeysFor(stats, proof.target);
    if (!keys.length) return { status: 'unknown', lines: [`No Wise Old Man KC matches "${proof.target}".`] };
    const nowTotal = kcTotal(stats, keys);
    if (!snapshot || !snapshot.kc) {
      lines.push(`${proof.target} KC is ${nowTotal} now, but this claim has no snapshot to measure from.`);
      return { status: 'unknown', lines };
    }
    const delta = nowTotal - snapshot.kc.total;
    lines.push(`${proof.target} KC: ${snapshot.kc.total} at claim, ${nowTotal} now (+${delta}). Needs +${need}.`);
    return { status: delta >= need ? 'proven' : 'not', lines };
  }

  if (proof.type === 'xp') {
    const stats = await getStats(rsn).catch(() => null);
    if (!stats) return { status: 'unknown', lines: ['Wise Old Man lookup failed. Try again in a bit.'] };
    const entry = xpFor(stats, proof.target);
    if (!entry) return { status: 'unknown', lines: [`No Wise Old Man XP matches "${proof.target}".`] };
    if (!snapshot || !snapshot.xp) {
      lines.push(`${entry.label} XP is ${entry.xp.toLocaleString()} now, but this claim has no snapshot to measure from.`);
      return { status: 'unknown', lines };
    }
    const delta = entry.xp - snapshot.xp.xp;
    lines.push(
      `${entry.label} XP: ${snapshot.xp.xp.toLocaleString()} at claim, ${entry.xp.toLocaleString()} now (+${delta.toLocaleString()}). Needs +${need.toLocaleString()}.`
    );
    return { status: delta >= need ? 'proven' : 'not', lines };
  }

  return { status: 'unknown', lines: [`Unknown proof type: ${proof.type}.`] };
}

module.exports = {
  takeSnapshot,
  snapshotLine,
  verifyProof,
  resolveRsn: (userId) => getRsn(userId),
  _internals: { itemIdsForName, slugFor, kcKeysFor, kcTotal, xpFor, findDropSince, clogHasInPages },
};
