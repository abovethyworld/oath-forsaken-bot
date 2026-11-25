// WOM / Discord sync alerts, posted to the CC Rank Checklist thread.
//
// The Wise Old Man group (26687) is the list the comps and the website
// read, but nothing keeps it in step with Discord on its own: people
// leave, people get approved and are never added, accounts get
// renamed. This module watches for the drift and posts one plain line
// per issue to the checklist thread so staff can fix the group by
// hand (the bot has no WOM write access). It never edits the group,
// never pings, and stays silent when the two lists agree.
//
// Two triggers:
//  - A member leaving (guildMemberRemove, wired in index.js): if any
//    of their linked RSNs are still in the group, one leave line.
//  - A daily sweep (14:00 UTC): members approved over 24h ago who are
//    not in the group yet, group names that match no member's links
//    (possible renames), and a backstop removal pass for members no
//    longer in the guild whose RSNs are still in the group.
// Sent alerts are remembered in data/wom-sync-alerts.json so the same
// unresolved issue is never posted twice; a key clears when the sweep
// sees the issue is gone.
const fs = require('fs');
const path = require('path');
const config = require('./config');
const store = require('./store');
const { atomicWrite } = require('./store');
const { safeFetch } = require('./utils');
const { normName, entryRsns, loadLinks } = require('./membership');
const wom = require('./wom');

const STATE_FILE = path.join(__dirname, '..', 'data', 'wom-sync-alerts.json');
const SNAPSHOT_FILE = path.join(__dirname, '..', 'data', 'plugin-sync', 'roles-snapshot.json');
const APPROVAL_AGE_MS = 24 * 3600 * 1000;
const SWEEP_HOUR_UTC = 14;

// =====================================================================
// ALERT TEXT - DRAFT, NOT YET APPROVED.
// These strings were drafted for this feature and have NOT been ruled
// on yet. They live here, in this one block, so the approved wording
// can be swapped in with a single edit. Plain text, no pings: posts
// go out with allowedMentions parsing disabled.
// =====================================================================
const TEXT = {
  leave: (name, rsns) => `WOM sync: ${name} left the server. Still in the Wise Old Man group: ${rsns}. Needs removing by hand.`,
  missing: (name, rsns) => `WOM sync: ${name} is a member but not in the Wise Old Man group yet: ${rsns}.`,
  unknown: (names) => `WOM sync: names in the Wise Old Man group that match no member: ${names}. Could be renames.`,
};

// ---- Name matching --------------------------------------------------
// Same loose comparison as src/membership.js (case, underscores and
// spacing folded), plus the alt-notation lesson from the roster sync:
// a recorded name like "Main | Alt" or "Main / Alt" matches the group
// when any one part does, so every part becomes a candidate key.
function nameKeys(rsn) {
  const raw = String(rsn || '');
  const keys = new Set();
  const full = normName(raw);
  if (full) keys.add(full);
  for (const part of raw.split(/[|/]/)) {
    const key = normName(part);
    if (key) keys.add(key);
  }
  return [...keys];
}

// Every RSN one link record claims for a member: the linked list plus
// the plugin-verified list, deduped by normalized full name.
function memberRsns(entry) {
  const out = [];
  const seen = new Set();
  const verified = entry && Array.isArray(entry.verified) ? entry.verified : [];
  for (const rsn of [...entryRsns(entry), ...verified]) {
    if (typeof rsn !== 'string' || !rsn.trim()) continue;
    const key = normName(rsn);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(rsn.trim());
  }
  return out;
}

// Normalized name -> the group's own spelling of it, first wins.
function groupIndex(groupNames) {
  const map = new Map();
  for (const name of groupNames || []) {
    const key = normName(name);
    if (key && !map.has(key)) map.set(key, String(name).trim());
  }
  return map;
}

// The member's RSNs that are in the group, in the group's spelling
// (that is the spelling staff have to find to remove them).
function rsnsInGroup(entry, gIndex) {
  const out = [];
  const seen = new Set();
  for (const rsn of memberRsns(entry)) {
    for (const key of nameKeys(rsn)) {
      const display = gIndex.get(key);
      if (display && !seen.has(key)) {
        seen.add(key);
        out.push(display);
      }
    }
  }
  return out;
}

function rsnsMissing(entry, gIndex) {
  return memberRsns(entry).filter((rsn) => !nameKeys(rsn).some((key) => gIndex.has(key)));
}

function keyPart(rsns) {
  return rsns.map(normName).filter(Boolean).sort().join(',');
}

// The removal issue for one user, shared by the leave handler and the
// sweep backstop so the same departure only ever alerts once.
function removeIssue(userId, inGroupRsns) {
  if (!inGroupRsns.length) return null;
  return { key: `remove:${userId}:${keyPart(inGroupRsns)}`, rsns: inGroupRsns };
}

// Pure sweep: given the recorded standings, the link store, the live
// group list, who is still in the guild, and a name resolver, work
// out every open issue. Returns the issues (with dedup keys and the
// exact lines to post) in a stable order: removals, missing, unknown.
function computeSweep({ membership, links, groupNames, inGuild, nameOf, now }) {
  const gIndex = groupIndex(groupNames);
  const resolve = typeof nameOf === 'function' ? nameOf : (id) => `user ${id}`;
  const issues = [];
  const records = membership && typeof membership === 'object' ? membership : {};
  const linkMap = links && typeof links === 'object' ? links : {};

  for (const [userId, rec] of Object.entries(records)) {
    if (!rec || (rec.standing !== 'member' && rec.standing !== 'guest')) continue;
    const entry = linkMap[userId];
    if (!entry) continue;
    if (!inGuild.has(userId)) {
      const issue = removeIssue(userId, rsnsInGroup(entry, gIndex));
      if (issue) {
        issues.push({ ...issue, text: TEXT.leave(resolve(userId), issue.rsns.join(', ')) });
      }
      continue;
    }
    if (rec.standing !== 'member') continue;
    const at = typeof rec.at === 'number' ? rec.at : 0;
    if (now - at < APPROVAL_AGE_MS) continue;
    const missing = rsnsMissing(entry, gIndex);
    if (missing.length) {
      issues.push({
        key: `missing:${userId}:${keyPart(missing)}`,
        text: TEXT.missing(resolve(userId), missing.join(', ')),
      });
    }
  }

  // Group names no link record explains. Any entry in the link store
  // counts, member or guest: a name somebody holds is not a rename
  // mystery even when its owner is not a recorded member.
  const known = new Set();
  for (const entry of Object.values(linkMap)) {
    for (const rsn of memberRsns(entry)) {
      for (const key of nameKeys(rsn)) known.add(key);
    }
  }
  const unknown = [];
  for (const [key, display] of gIndex) {
    if (!known.has(key)) unknown.push(display);
  }
  if (unknown.length) {
    unknown.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
    issues.push({
      key: `unknown:${keyPart(unknown)}`,
      text: TEXT.unknown(unknown.join(', ')),
    });
  }
  return issues;
}

// ---- Alert state ----------------------------------------------------
// Only this feature's own file is ever written. A corrupt or missing
// file reads as "nothing sent yet" rather than throwing.
function loadState() {
  try {
    const raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    if (raw && typeof raw === 'object' && raw.sent && typeof raw.sent === 'object') {
      return { sent: { ...raw.sent } };
    }
  } catch { /* first run or unreadable: start empty */ }
  return { sent: {} };
}

function saveState(state) {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  atomicWrite(STATE_FILE, { sent: state.sent });
}

// Drop keys whose issue is no longer in the current set (the member
// was removed from the group, added to it, or the name matched again).
// Returns true when anything changed.
function pruneState(state, currentKeys) {
  let changed = false;
  for (const key of Object.keys(state.sent)) {
    if (!currentKeys.has(key)) {
      delete state.sent[key];
      changed = true;
    }
  }
  return changed;
}

// ---- Posting ----------------------------------------------------------
async function postToChecklist(client, text) {
  const threadId = config.ccChecklist && config.ccChecklist.threadId;
  if (!threadId || !client) return false;
  const channel = await safeFetch(client.channels.fetch(threadId), 'wom-sync checklist post');
  if (!channel || typeof channel.send !== 'function') return false;
  try {
    await channel.send({ content: text, allowedMentions: { parse: [] } });
    return true;
  } catch (err) {
    console.error('[wom-sync] checklist post failed:', err.message);
    return false;
  }
}

// ---- Leave handler ----------------------------------------------------
// Called from the guildMemberRemove handler in index.js, alongside
// the connect-code revoke (which it does not touch). Never throws.
async function onMemberLeave(client, member) {
  try {
    if (!member || !member.id) return false;
    const guildId = (member.guild && member.guild.id) || config.guildId;
    const rec = store.getMembership(guildId)[member.id];
    if (!rec || (rec.standing !== 'member' && rec.standing !== 'guest')) return false;
    const entry = loadLinks()[member.id];
    if (!entry || !memberRsns(entry).length) return false;

    const groupNames = await wom.getGroupMembers(config.womGroupId);
    if (!groupNames) {
      // WOM is unreachable: a failed fetch is not drift. Log and skip.
      console.warn('[wom-sync] leave check skipped: WOM group fetch failed.');
      return false;
    }
    const issue = removeIssue(member.id, rsnsInGroup(entry, groupIndex(groupNames)));
    if (!issue) return false;

    const state = loadState();
    if (state.sent[issue.key]) return false;
    const name = member.displayName || (member.user && member.user.username) || `user ${member.id}`;
    const posted = await postToChecklist(client, TEXT.leave(name, issue.rsns.join(', ')));
    if (!posted) return false;
    state.sent[issue.key] = Date.now();
    saveState(state);
    return true;
  } catch (err) {
    console.error('[wom-sync] leave alert failed:', err.message);
    return false;
  }
}

// ---- Daily sweep ------------------------------------------------------
// Who is still in the guild: the shared member cache first, the roles
// snapshot file second. Null when neither can answer, so the sweep
// fails closed instead of guessing at drift.
async function guildPresence(guild) {
  try {
    const { getMembers } = require('./guild-cache');
    const members = await getMembers(guild);
    if (members) {
      return {
        ids: new Set(members.keys()),
        nameOf: (id) => {
          const m = members.get(id);
          return m ? m.displayName || (m.user && m.user.username) || `user ${id}` : `user ${id}`;
        },
      };
    }
  } catch { /* fall through to the snapshot */ }
  try {
    const snap = JSON.parse(fs.readFileSync(SNAPSHOT_FILE, 'utf8'));
    if (snap && snap.members && typeof snap.members === 'object') {
      return { ids: new Set(Object.keys(snap.members)), nameOf: (id) => `user ${id}` };
    }
  } catch { /* no snapshot yet */ }
  return null;
}

// The current issue list, or null when a source the sweep depends
// on is unavailable (no guild, WOM down, guild presence unknown):
// a gap in the inputs is not drift, so the sweep stays silent.
async function collectIssues(client) {
  const guild = client.guilds.cache.get(config.guildId);
  if (!guild) return null;
  const groupNames = await wom.getGroupMembers(config.womGroupId);
  if (!groupNames) {
    console.warn('[wom-sync] sweep skipped: WOM group fetch failed.');
    return null;
  }
  const presence = await guildPresence(guild);
  if (!presence) {
    console.warn('[wom-sync] sweep skipped: guild membership unavailable.');
    return null;
  }
  return computeSweep({
    membership: store.getMembership(config.guildId),
    links: loadLinks(),
    groupNames,
    inGuild: presence.ids,
    nameOf: presence.nameOf,
    now: Date.now(),
  });
}

async function runSweep(client) {
  try {
    if (!client) return false;
    const issues = await collectIssues(client);
    if (!issues) return false;

    const state = loadState();
    const changed = pruneState(state, new Set(issues.map((i) => i.key)));
    const fresh = issues.filter((i) => !state.sent[i.key]);
    let posted = false;
    if (fresh.length) {
      posted = await postToChecklist(client, fresh.map((i) => i.text).join('\n'));
      if (posted) {
        for (const issue of fresh) state.sent[issue.key] = Date.now();
      }
    }
    if (changed || posted) saveState(state);
    if (fresh.length && posted) {
      console.log(`WOM sync sweep: posted ${fresh.length} alert line(s) to the CC checklist thread.`);
    }
    return posted;
  } catch (err) {
    console.error('[wom-sync] sweep failed:', err.message);
    return false;
  }
}

// One run a day at 14:00 UTC (a quiet hour for the clan): a timeout
// to the first run, then a plain 24h interval like the other daily
// loops in index.js.
function msUntilNextSweep(now = new Date()) {
  const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), SWEEP_HOUR_UTC, 0, 0, 0);
  let delay = next - now.getTime();
  if (delay <= 0) delay += 24 * 3600 * 1000;
  return delay;
}

function startWomSyncAlerts(client) {
  const timer = setTimeout(() => {
    runSweep(client);
    const daily = setInterval(() => runSweep(client), 24 * 3600 * 1000);
    if (typeof daily.unref === 'function') daily.unref();
  }, msUntilNextSweep());
  if (typeof timer.unref === 'function') timer.unref();
}

module.exports = {
  TEXT,
  nameKeys,
  memberRsns,
  groupIndex,
  rsnsInGroup,
  rsnsMissing,
  removeIssue,
  computeSweep,
  loadState,
  saveState,
  pruneState,
  postToChecklist,
  onMemberLeave,
  runSweep,
  msUntilNextSweep,
  startWomSyncAlerts,
  APPROVAL_AGE_MS,
};
