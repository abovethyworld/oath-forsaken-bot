// Daily Wise Old Man stats warm-up for linked members outside the group.
//
// The stats cache (data/wom-cache-v3.json) otherwise only fills for
// Wise Old Man group members (the daily gains sync walks the group
// list) and for names someone runs a card command on. A member
// approved through the application flow who is not in the WOM group
// falls through both, and the website exporter builds roster rows
// from this cache, so their row publishes with no total level or XP.
// On the startup sweep and daily, this pass walks the link store for
// RSNs whose owner holds member standing (a recorded membership, or
// a published seniority rank) but who are not on the WOM group list,
// and refreshes the missing or stale ones through the normal paced
// getStats path, a few per run.
const fs = require('fs');
const path = require('path');
const config = require('./config');
const store = require('./store');
const { getStats, getCachedStats } = require('./wom');
const { loadLinks, entryRsns, loadGroupNames, normName } = require('./membership');

const RANKS_FILE = path.join(__dirname, '..', 'data', 'rank-holders.json');
const MAX_PER_RUN = 10;

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

// Discord ids holding member standing: a recorded membership for
// this guild, or a place in the published rank holders list.
function memberStandingIds() {
  const ids = new Set();
  const records = store.getMembership(config.guildId);
  for (const [userId, rec] of Object.entries(records || {})) {
    if (rec && rec.standing === 'member') ids.add(String(userId));
  }
  const ranks = readJson(RANKS_FILE);
  if (Array.isArray(ranks)) {
    for (const r of ranks) {
      if (r && r.discordId) ids.add(String(r.discordId));
    }
  }
  return ids;
}

// Linked RSNs of standing members that the WOM group list does not
// cover. Fails closed with an empty list when the group list cannot
// be read: without it we cannot tell who is actually uncovered.
function uncoveredMemberRsns() {
  const groupNames = loadGroupNames();
  if (groupNames === null) return [];
  const standing = memberStandingIds();
  if (!standing.size) return [];
  const group = new Set(groupNames.map(normName).filter(Boolean));
  const names = new Map(); // normalized -> display RSN, first writer wins
  for (const [userId, entry] of Object.entries(loadLinks())) {
    if (!standing.has(String(userId))) continue;
    for (const rsn of entryRsns(entry)) {
      const display = String(rsn || '').trim();
      const key = normName(display);
      if (display && key && !group.has(key) && !names.has(key)) {
        names.set(key, display);
      }
    }
  }
  return [...names.values()];
}

async function warmMemberStats() {
  const stale = uncoveredMemberRsns().filter((rsn) => {
    const hit = getCachedStats(rsn);
    return !hit || !hit.fresh;
  });
  const batch = stale.slice(0, MAX_PER_RUN);
  let warmed = 0;
  let unknown = 0;
  for (const rsn of batch) {
    try {
      const stats = await getStats(rsn);
      if (stats && !stats.notFound) warmed += 1;
      else if (stats && stats.notFound) unknown += 1;
      else console.error(`WOM member warm failed for ${rsn}: lookup returned no stats.`);
    } catch (err) {
      console.error(`WOM member warm failed for ${rsn}: ${err.message}`);
    }
  }
  if (batch.length) {
    console.log(`WOM member warm: refreshed ${warmed}/${batch.length} linked member RSN(s) outside the WOM group`
      + `${unknown ? `, ${unknown} not tracked by WOM` : ''}`
      + `${stale.length > batch.length ? `, ${stale.length - batch.length} left for the next run` : ''}.`);
  }
  return warmed;
}

module.exports = { warmMemberStats, uncoveredMemberRsns, memberStandingIds };
