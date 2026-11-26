// WOM / Discord sync alerts, posted to the CC Rank Checklist thread.
//
// The Wise Old Man group (26687) is the list the comps and the website
// read, but nothing keeps it in step with Discord on its own: people
// leave, people get approved and are never added, accounts get
// renamed. This module watches for the drift and posts the issues
// to the checklist thread as one embed so staff can fix the group
// by hand (the bot has no WOM write access). It never edits the
// group, pings only the clan owner role (Lord of Chaos), and stays
// silent when the two lists agree.
//
// Two triggers:
//  - A member leaving (guildMemberRemove, wired in index.js): if any
//    of their linked RSNs are still in the group, one leave line.
//  - A daily sweep (14:00 UTC): members approved over 24h ago who are
//    not in the group yet, group names that match no member's links
//    (possible renames), and a backstop removal pass for members no
//    longer in the guild whose RSNs are still in the group.
//    A missing member whose display name carries an unknown group
//    name is reported once as a likely rename, not as two separate
//    problems. Cases staff have settled (src/sync-settled.js) are
//    not flagged at all; removals are never settled away.
// Removal issues read the departed registry (src/departed.js) as
// well as the live records: the registry snapshots a member's RSNs
// when they leave, so a later cleanup that marks the record left or
// parks the link cannot silence the removal alert or wipe its
// dedup memory. The sweep prunes the registry as cases resolve.
// The same 14:00 UTC pass also runs the role watch sweep
// (src/role-watch.js): one daily membership-sync pass, two checks,
// each module keeping its own alert state.
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
const { loadSettled } = require('./sync-settled');
const { loadDeparted, saveDeparted, recordDeparture, clearDeparture } = require('./departed');
const wom = require('./wom');
const roleWatch = require('./role-watch');

const STATE_FILE = path.join(__dirname, '..', 'data', 'wom-sync-alerts.json');
const SNAPSHOT_FILE = path.join(__dirname, '..', 'data', 'plugin-sync', 'roles-snapshot.json');
const APPROVAL_AGE_MS = 24 * 3600 * 1000;
const SWEEP_HOUR_UTC = 14;

// =====================================================================
// ALERT TEXT - DRAFT, NOT YET APPROVED.
// These strings were drafted for this feature and have NOT been ruled
// on yet. They live here, in this one block, so the approved wording
// can be swapped in with a single edit. TEXT is the canonical line
// for each issue; LINES is the same content in the shorter form the
// embed shows (the embed title carries the "WOM sync" lead). Posts
// go out as one embed that pings only the owner role below.
// =====================================================================
const TEXT = {
  leave: (name, rsns) => `WOM sync: ${name} left the server. Still in the Wise Old Man group: ${rsns}. Needs removing by hand.`,
  missing: (name, rsns) => `WOM sync: ${name} is a member but not in the Wise Old Man group yet: ${rsns}.`,
  rename: (name, rsns, newName) => `WOM sync: ${name} looks renamed - link says ${rsns}, the group says ${newName}. Update the link to settle it.`,
  unknown: (names) => `WOM sync: names in the Wise Old Man group that match no member: ${names}. Could be renames.`,
};

// The only role a WOM sync post may ping: Lord of Chaos, the clan
// owner. Sourced from config so a role re-make is a config edit.
const PING_ROLE_ID = (config.roles && config.roles.lordOfChaosId) || null;

const LINES = {
  leave: (name, rsns) => `${name} — left the server. Still in the group: ${rsns}. Needs removing by hand.`,
  missing: (name, rsns) => `${name} — a member, but not in the group yet: ${rsns}.`,
  rename: (name, rsns, newName) => `${name} — link says ${rsns}, the group says ${newName}. Update the link to settle it.`,
  unknown: (names) => `${names} — in the group but isn't a member here.`,
};

// Embed sections, in display order: [issue kind, heading].
const HEADINGS = [
  ['remove', 'Left, still in the group'],
  ['missing', 'Missing from the group'],
  ['rename', 'Looks renamed'],
  ['unknown', 'In the group, not a member'],
];

const EMBED_COLOR = 0xA31621;
const EMBED_FOOTER = 'Settled cases stay quiet. Nothing here changes on its own - adding people to the group is still by hand.';

// One message payload for a set of issues: an owner-role ping plus
// a single embed with the issues grouped under their headings. The
// description stays under Discord's cap by dropping trailing lines
// and saying how many were left out, never by failing the post.
function buildPayload(issues) {
  const byKind = new Map();
  for (const issue of issues || []) {
    if (!issue || !issue.line) continue;
    if (!byKind.has(issue.kind)) byKind.set(issue.kind, []);
    byKind.get(issue.kind).push(issue.line);
  }
  const parts = [];
  for (const [kind, heading] of HEADINGS) {
    const lines = byKind.get(kind);
    if (lines && lines.length) parts.push({ heading, lines: [...lines] });
  }
  let dropped = 0;
  const render = () => parts
    .filter((p) => p.lines.length)
    .map((p) => `**${p.heading}**\n${p.lines.join('\n')}`)
    .join('\n\n') + (dropped ? `\n\n+ ${dropped} more not shown.` : '');
  let description = render();
  while (description.length > 3900) {
    const last = [...parts].reverse().find((p) => p.lines.length);
    if (!last) break;
    last.lines.pop();
    dropped += 1;
    description = render();
  }
  const payload = {
    embeds: [{ title: '⛧ WOM Sync Check ⛧', color: EMBED_COLOR, description, footer: { text: EMBED_FOOTER } }],
  };
  if (PING_ROLE_ID) {
    payload.content = `<@&${PING_ROLE_ID}>`;
    payload.allowedMentions = { roles: [PING_ROLE_ID] };
  } else {
    payload.allowedMentions = { parse: [] };
  }
  return payload;
}

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
// group list, who is still in the guild, a name resolver, and the
// settled cases, work out every open issue. Returns the issues
// (with dedup keys and the exact lines to post) in a stable order:
// removals, renames, missing, unknown.
function computeSweep({ membership, links, groupNames, inGuild, nameOf, now, settled, departed }) {
  const gIndex = groupIndex(groupNames);
  const resolve = typeof nameOf === 'function' ? nameOf : (id) => `user ${id}`;
  const settledUsers = settled && settled.userIds ? settled.userIds : new Set();
  const settledRsns = settled && settled.rsns ? settled.rsns : new Set();
  const removals = [];
  const missingList = [];
  const records = membership && typeof membership === 'object' ? membership : {};
  const linkMap = links && typeof links === 'object' ? links : {};

  // Departed registry first: a departure snapshot outranks the live
  // record and link, which a cleanup may have marked left or parked.
  // Same issue key as the record path below, so the two never post
  // the same departure twice and the dedup memory carries over.
  const departedMap = departed && typeof departed === 'object' ? departed : {};
  const coveredDeparted = new Set();
  for (const [userId, dep] of Object.entries(departedMap)) {
    if (!dep || inGuild.has(userId)) continue;
    const snapshot = { rsns: Array.isArray(dep.rsns) ? dep.rsns : [] };
    const issue = removeIssue(userId, rsnsInGroup(snapshot, gIndex));
    if (!issue) continue;
    coveredDeparted.add(userId);
    const rsns = issue.rsns.join(', ');
    const who = dep.name || resolve(userId);
    removals.push({
      ...issue,
      kind: 'remove',
      line: LINES.leave(who, rsns),
      text: TEXT.leave(who, rsns),
    });
  }

  for (const [userId, rec] of Object.entries(records)) {
    if (!rec || (rec.standing !== 'member' && rec.standing !== 'guest')) continue;
    const entry = linkMap[userId];
    if (!entry) continue;
    if (!inGuild.has(userId)) {
      if (coveredDeparted.has(userId)) continue;
      const issue = removeIssue(userId, rsnsInGroup(entry, gIndex));
      if (issue) {
        const rsns = issue.rsns.join(', ');
        removals.push({
          ...issue,
          kind: 'remove',
          line: LINES.leave(resolve(userId), rsns),
          text: TEXT.leave(resolve(userId), rsns),
        });
      }
      continue;
    }
    if (rec.standing !== 'member') continue;
    if (settledUsers.has(userId)) continue;
    const at = typeof rec.at === 'number' ? rec.at : 0;
    if (now - at < APPROVAL_AGE_MS) continue;
    const missing = rsnsMissing(entry, gIndex)
      .filter((rsn) => !settledRsns.has(normName(rsn)));
    if (missing.length) {
      missingList.push({
        userId,
        rsns: missing,
        issue: {
          key: `missing:${userId}:${keyPart(missing)}`,
          kind: 'missing',
          line: LINES.missing(resolve(userId), missing.join(', ')),
          text: TEXT.missing(resolve(userId), missing.join(', ')),
        },
      });
    }
  }

  // Group names no link record explains. Any entry in the link store
  // counts, member or guest: a name somebody holds is not a rename
  // mystery even when its owner is not a recorded member. A settled
  // name is explained by the ruling, so it is not listed either.
  const known = new Set();
  for (const entry of Object.values(linkMap)) {
    for (const rsn of memberRsns(entry)) {
      for (const key of nameKeys(rsn)) known.add(key);
    }
  }
  // A departed snapshot explains its names too: they are a removal
  // case above, not an unknown-name mystery.
  for (const dep of Object.values(departedMap)) {
    if (!dep || !Array.isArray(dep.rsns)) continue;
    for (const rsn of dep.rsns) {
      for (const key of nameKeys(rsn)) known.add(key);
    }
  }
  const unknown = [];
  for (const [key, display] of gIndex) {
    if (!known.has(key) && !settledRsns.has(key)) unknown.push(display);
  }

  // Rename pairing: an unknown group name that appears in exactly
  // one missing member's display name is that member's new name.
  // One rename line replaces the member's missing line and the
  // name's place in the unknown list. When the name could belong
  // to more than one missing member, nothing pairs and the plain
  // lines stand - the sweep never guesses between people.
  const renames = [];
  const pairedUsers = new Set();
  const pairedNames = new Set();
  for (const display of unknown) {
    const key = normName(display);
    const candidates = missingList.filter(
      (m) => !pairedUsers.has(m.userId) && normName(resolve(m.userId)).includes(key),
    );
    if (candidates.length !== 1) continue;
    pairedUsers.add(candidates[0].userId);
    pairedNames.add(display);
    renames.push({
      key: `rename:${candidates[0].userId}:${key}`,
      kind: 'rename',
      line: LINES.rename(resolve(candidates[0].userId), candidates[0].rsns.join(', '), display),
      text: TEXT.rename(resolve(candidates[0].userId), candidates[0].rsns.join(', '), display),
    });
  }

  const issues = [...removals, ...renames];
  for (const m of missingList) {
    if (!pairedUsers.has(m.userId)) issues.push(m.issue);
  }
  const remainingUnknown = unknown.filter((d) => !pairedNames.has(d));
  if (remainingUnknown.length) {
    remainingUnknown.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
    issues.push({
      key: `unknown:${keyPart(remainingUnknown)}`,
      kind: 'unknown',
      line: LINES.unknown(remainingUnknown.join(', ')),
      text: TEXT.unknown(remainingUnknown.join(', ')),
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
async function postEmbedToChecklist(client, issues) {
  const threadId = config.ccChecklist && config.ccChecklist.threadId;
  if (!threadId || !client || !issues || !issues.length) return false;
  const channel = await safeFetch(client.channels.fetch(threadId), 'wom-sync checklist post');
  if (!channel || typeof channel.send !== 'function') return false;
  try {
    await channel.send(buildPayload(issues));
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

    // Snapshot the departure now, before anything else can change:
    // the sweep's removal check reads this registry, so a later
    // cleanup of the record or the link cannot silence it. Recorded
    // even when the WOM fetch below fails - a failed fetch is not
    // drift, but the departure still happened.
    const name = member.displayName || (member.user && member.user.username) || `user ${member.id}`;
    recordDeparture(member.id, name, memberRsns(entry));

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
    const posted = await postEmbedToChecklist(client, [
      { kind: 'remove', line: LINES.leave(name, issue.rsns.join(', ')) },
    ]);
    if (!posted) return false;
    state.sent[issue.key] = Date.now();
    saveState(state);
    return true;
  } catch (err) {
    console.error('[wom-sync] leave alert failed:', err.message);
    return false;
  }
}

// ---- Rejoin -----------------------------------------------------------
// Called from the guildMemberAdd handler in index.js: a rejoin ends
// the departed case, so the removal alert stands down. Never throws.
function onMemberRejoin(userId) {
  try {
    if (userId) clearDeparture(userId);
  } catch (err) {
    console.error('[wom-sync] rejoin clear failed:', err.message);
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
  // Prune the departed registry against this run's facts before
  // computing: an entry ends when the person is back in the guild
  // or none of their snapshot RSNs remain in the group.
  const departed = loadDeparted();
  const gIndex = groupIndex(groupNames);
  let departedChanged = false;
  for (const [userId, dep] of Object.entries(departed)) {
    const snapshot = { rsns: dep && Array.isArray(dep.rsns) ? dep.rsns : [] };
    if (presence.ids.has(userId) || !rsnsInGroup(snapshot, gIndex).length) {
      delete departed[userId];
      departedChanged = true;
    }
  }
  if (departedChanged) saveDeparted(departed);
  return computeSweep({
    membership: store.getMembership(config.guildId),
    links: loadLinks(),
    groupNames,
    inGuild: presence.ids,
    nameOf: presence.nameOf,
    now: Date.now(),
    settled: loadSettled(),
    departed,
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
      posted = await postEmbedToChecklist(client, fresh);
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
  // One daily pass for both membership-sync sweeps: the WOM drift
  // check above and the role watch in src/role-watch.js.
  const runDailyPass = () => {
    runSweep(client);
    roleWatch.runSweep(client);
  };
  const timer = setTimeout(() => {
    runDailyPass();
    const daily = setInterval(runDailyPass, 24 * 3600 * 1000);
    if (typeof daily.unref === 'function') daily.unref();
  }, msUntilNextSweep());
  if (typeof timer.unref === 'function') timer.unref();
}

module.exports = {
  TEXT,
  LINES,
  PING_ROLE_ID,
  buildPayload,
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
  postEmbedToChecklist,
  onMemberLeave,
  onMemberRejoin,
  runSweep,
  msUntilNextSweep,
  startWomSyncAlerts,
  APPROVAL_AGE_MS,
};
