// Total level bracket roles: three Discord roles that say where a
// clan account sits - Under 1250, 1250-1850, 1850+ - assigned from
// the total level of the member's active linked RSN, read off the
// Jagex hiscores. Ruled Nov 27, 2026; the bottom bracket doubles as
// the ping list for early-game events.
//
// Who gets one: recorded clan members (membership.json standing
// "member") and Friend of the Clan role holders, each with a linked
// RSN. Guests get none. The bracket follows the active RSN only -
// alts never count. Anyone no longer eligible, or holding a bracket
// with no linked RSN, has the bracket roles taken back. A name the
// hiscores cannot find keeps whatever it already holds: a lookup
// failure never strips a bracket. Totals are cached for 12 hours so
// a restart does not re-read the hiscores for the whole clan. Runs
// on the startup sweep and daily, beside the friends publish whose
// inputs it shares.
const fs = require('node:fs');
const path = require('node:path');
const config = require('./config');
const { atomicWrite } = require('./store');
const { getMembers } = require('./guild-cache');
const { getRsnEntry } = require('./teams');

const CACHE_FILE = path.join(__dirname, '..', 'data', 'total-levels.json');
const MEMBERSHIP_FILE = path.join(__dirname, '..', 'data', 'membership.json');
const CACHE_TTL_MS = 12 * 3600 * 1000;
const BRACKETS = ['under', 'mid', 'high'];

function bracketFor(total) {
  if (!Number.isFinite(total)) return null;
  if (total < 1250) return 'under';
  if (total < 1850) return 'mid';
  return 'high';
}

function roleIds() {
  const tr = config.totalRoles || {};
  return { under: tr.under1250, mid: tr.mid, high: tr.high };
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

async function fetchTotalLevel(rsn) {
  const url = `https://secure.runescape.com/m=hiscore_oldschool/index_lite.json?player=${encodeURIComponent(rsn)}`;
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'OathForsaken-Bot/1.0 (https://oathforsaken.cc)' } });
    if (!res.ok) return null;
    const data = await res.json();
    const overall = data && data.skills && data.skills[0];
    return overall && Number.isFinite(overall.level) ? overall.level : null;
  } catch {
    return null;
  }
}

async function syncTotalRoles(client) {
  const ids = roleIds();
  if (!ids.under || !ids.mid || !ids.high) return 0;
  const guild = client.guilds.cache.get(config.guildId);
  if (!guild) return 0;
  const members = await getMembers(guild);
  if (!members) return 0;
  const standings = (readJson(MEMBERSHIP_FILE, {}) || {})[config.guildId] || {};
  const friendRoleId = (config.seniority || {}).friendOfClanRoleId;
  const cache = readJson(CACHE_FILE, {}) || {};
  let cacheDirty = false;
  let changed = 0;

  for (const member of members.values()) {
    if (member.user.bot) continue;
    const held = BRACKETS.filter((b) => ids[b] && member.roles.cache.has(ids[b]));
    const isMember = (standings[member.id] || {}).standing === 'member';
    const isFriend = friendRoleId && member.roles.cache.has(friendRoleId);
    const entry = getRsnEntry(member.id);
    if ((!isMember && !isFriend) || !entry.active) {
      for (const b of held) {
        await member.roles.remove(ids[b]).catch(() => {});
        changed += 1;
      }
      continue;
    }
    const key = entry.active.toLowerCase();
    const cached = cache[key];
    let total = cached && Date.now() - cached.at < CACHE_TTL_MS ? cached.total : null;
    if (total === null) {
      total = await fetchTotalLevel(entry.active);
      if (total === null) {
        // The hiscores intermittently 5xx a name on a burst; one
        // spaced retry before the name is left for the next run.
        await new Promise((r) => setTimeout(r, 2000));
        total = await fetchTotalLevel(entry.active);
      }
      if (total !== null) {
        cache[key] = { total, at: Date.now() };
        cacheDirty = true;
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    const bracket = bracketFor(total);
    if (!bracket) continue; // hiscores miss: keep whatever they hold
    const target = ids[bracket];
    if (!member.roles.cache.has(target)) {
      await member.roles.add(target).catch(() => {});
      changed += 1;
    }
    for (const b of held) {
      if (ids[b] !== target) {
        await member.roles.remove(ids[b]).catch(() => {});
        changed += 1;
      }
    }
  }
  if (cacheDirty) atomicWrite(CACHE_FILE, cache);
  if (changed) console.log(`Total roles: ${changed} bracket change(s) applied.`);
  return changed;
}

module.exports = { syncTotalRoles, bracketFor };
