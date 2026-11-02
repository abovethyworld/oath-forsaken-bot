// Bounty proof checker. There is no sign-up: a hunter gets the drop
// while a contract is live, screenshots it, and opens a proof thread.
// The anchor is the contract's post date, not a claim. The Done button
// checks two timestamped feeds for the drop after that date: the
// plugin drops log (server-timestamped) and the clan chat feed
// (TrackScape relay of the in-game broadcasts). The collection log
// shows the item is owned but cannot date it, so it is supporting
// evidence only. The result advises staff; a human still grants.
const fs = require('fs');
const path = require('path');
const { getClogPages } = require('./runeprofile');
const { getRsn } = require('./teams');

const LUCK = (() => {
  try {
    return require('./luck-data.json');
  } catch {
    return { items: {} };
  }
})();

// Item name -> item ids, from the luck table (scored items). Items
// outside the table cannot be matched in the drops log by id; the
// feed and collection log checks match those by name instead.
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

// First drop of any target item strictly after the given time. Entries
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

// A clan chat feed line proves the drop when it names both the player
// and the item after the post date. Feed lines are { text, at } with
// the relay message's content and embeds flattened into text.
function findFeedHit(lines, rsn, targetName, sinceMs) {
  const who = String(rsn || '').trim().toLowerCase();
  const what = String(targetName || '').trim().toLowerCase();
  if (!who || !what) return null;
  for (const line of lines || []) {
    if (!line || !(line.at > sinceMs)) continue;
    const text = String(line.text || '').toLowerCase();
    if (text.includes(who) && text.includes(what)) return { at: line.at, text: String(line.text) };
  }
  return null;
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

const fmtDate = (ms) => new Date(ms).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';

// Run the checks for one proof thread. postedAt is the contract's
// post time: the drop has to land after it. Returns { status, lines }
// where status is 'proven', 'not', or 'unknown'.
async function verifyProof({ rsn, proof, postedAt, feedLines }) {
  const lines = [];
  if (!proof || !proof.type) return { status: 'unknown', lines: ['This contract has no proof target. Staff judge the screenshot.'] };
  if (!rsn) {
    return {
      status: 'unknown',
      lines: ['No RSN is linked to this Discord account, so the feeds cannot be matched by name. Press **Link RSN** under the guide post in #bot-guide. Staff can still judge the screenshot.'],
    };
  }

  if (proof.type === 'kc' || proof.type === 'xp') {
    return {
      status: 'unknown',
      lines: [`${proof.type === 'kc' ? 'KC' : 'XP'} contracts are judged on the screenshot and the clan feeds. The checker only auto-checks drops.`],
    };
  }

  if (proof.type === 'drop' || proof.type === 'clog') {
    const ids = itemIdsForName(proof.target);
    // 1. Plugin drops log.
    const entries = readDropEntries(rsn);
    const hit = findDropSince(entries, ids, postedAt);
    if (hit) {
      lines.push(`Plugin drop log: ${proof.target} dropped from ${hit.source} at ${fmtDate(hit.at)}, after the contract was posted.`);
      return { status: 'proven', lines };
    }
    // 2. Clan chat feed.
    const feedHit = findFeedHit(feedLines, rsn, proof.target, postedAt);
    if (feedHit) {
      lines.push(`Clan chat feed: "${feedHit.text.slice(0, 180)}" at ${fmtDate(feedHit.at)}, after the contract was posted.`);
      return { status: 'proven', lines };
    }
    if (ids.length && !entries.length) lines.push('Drops log: no plugin drops recorded for this player yet.');
    else if (ids.length) lines.push(`Drops log: no ${proof.target} since the contract was posted.`);
    else lines.push(`Drops log: ${proof.target} is not in the scored item table, so the log cannot be matched by item.`);
    lines.push('Clan chat feed: no broadcast naming this player and item since the post date.');
    // 3. Collection log appearance (supporting only, cannot date it).
    const hasNow = await clogHasNow(rsn, proof.target, ids).catch(() => null);
    if (hasNow === true) {
      lines.push(`Collection log: ${proof.target} is in the log now, but the log cannot show when it landed. Judge the screenshot against the post date.`);
      return { status: 'unknown', lines };
    }
    if (hasNow === false) lines.push(`Collection log: ${proof.target} is not in the log yet.`);
    else lines.push('Collection log: unavailable right now.');
    return { status: hasNow === false ? 'not' : 'unknown', lines };
  }

  return { status: 'unknown', lines: [`Unknown proof type: ${proof.type}.`] };
}

module.exports = {
  verifyProof,
  resolveRsn: (userId) => getRsn(userId),
  _internals: { itemIdsForName, slugFor, findDropSince, findFeedHit, clogHasInPages },
};
