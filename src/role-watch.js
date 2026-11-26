// Role watch: staff promote guests to members by editing Discord
// roles by hand, so the bot watches the access roles (Iron Sworn,
// Unbound, Guest) and lines the records up behind a hand move.
//
// A hand promotion used to strand people: the roles said member
// while the membership record still said guest, so the website,
// the comp roster and the CC checklist all kept treating them as
// a guest, and if the access role itself was missed they could
// not see the server at all. This module closes that gap:
//
//  - Live (guildMemberUpdate, wired in index.js): a guest who
//    gains a member access role is promoted on the record too -
//    standing flipped to member, Initiate added, CC checklist
//    entry queued, comp roster refreshed, welcome posted, one
//    staff line in the CC checklist thread.
//  - A daily sweep (the same 14:00 UTC pass as the WOM sync
//    sweep) repairs anyone the live watch missed and flags the
//    two cases a person has to decide: a recorded member holding
//    no member role, and a member role held with no record at
//    all. Those two are staff lines only - the watcher never
//    demotes, never creates standing from roles alone, and never
//    removes a role.
//  - Friend of the Clan holders are a separate track and are
//    always exempt, as are bots.
//  - People on the settled list (src/sync-settled.js) are exempt
//    from the two staff-call flags: staff have already ruled on
//    their case. Settling never blocks a promotion repair.
//
// Live changes settle for a few seconds before anything is read:
// the application approval flow adds the role first and writes
// the standing a moment later, and a watcher reading in between
// would flag every normal approval. After the settle the record
// is re-read, so approvals pass through untouched and only hand
// moves (which never write a record) are acted on.
//
// Staff lines go to the CC checklist thread with mentions parsing
// disabled - no pings, ever. Sent lines are remembered in
// data/role-watch.json so an unresolved issue is never posted
// twice; a key clears when a sweep sees the issue is gone.
const fs = require('fs');
const path = require('path');
const config = require('./config');
const store = require('./store');
const { atomicWrite } = require('./store');
const { safeFetch, buildInitiateWelcome } = require('./utils');
const { addEntry: addCcEntry } = require('./cc-checklist');
const { getRsnEntry } = require('./teams');
const { loadSettled, isUserSettled } = require('./sync-settled');

const STATE_FILE = path.join(__dirname, '..', 'data', 'role-watch.json');
const SNAPSHOT_FILE = path.join(__dirname, '..', 'data', 'plugin-sync', 'roles-snapshot.json');
const SETTLE_MS = 5000;

// Access roles, all read from config - never hardcoded. Iron Sworn
// and Unbound are the member roles; Guest is the visitor role.
// Holding Friend of the Clan exempts a person from every check.
const IRON_SWORN_ID = config.teams && config.teams.ironSwornRoleId;
const UNBOUND_ID = config.recruit && config.recruit.types && config.recruit.types.main
  ? config.recruit.types.main.roleId : null;
const GUEST_ID = config.recruit && config.recruit.types && config.recruit.types.guest
  ? config.recruit.types.guest.roleId : null;
const FRIEND_ID = (config.seniority || {}).friendOfClanRoleId;
const MEMBER_ROLE_IDS = [IRON_SWORN_ID, UNBOUND_ID].filter(Boolean);
const ACCESS_ROLE_IDS = [...MEMBER_ROLE_IDS, GUEST_ID].filter(Boolean);

// =====================================================================
// STAFF LINE TEXT - DRAFT, NOT YET APPROVED.
// These strings were drafted for this feature and have NOT been
// ruled on yet. They live here, in this one block, so the approved
// wording can be swapped in with a single edit. Plain text, no
// pings: posts go out with allowedMentions parsing disabled.
// =====================================================================
const TEXT = {
  promotion: (name, rsns) => `Role sync: ${name} was given a member role in Discord. Record updated to member, checklist entry added.${rsns && rsns.length ? ` RSNs: ${rsns.join(', ')}.` : ''}`,
  repair: (name, rsns) => `Role sync: ${name} holds a member role but their record said guest. Record fixed to member, checklist entry added.${rsns && rsns.length ? ` RSNs: ${rsns.join(', ')}.` : ''}`,
  demotion: (name) => `Role sync: ${name} is a member on record but holds no member role in Discord. Nothing changed - staff call.`,
  norecord: (name) => `Role sync: ${name} holds a member role in Discord but has no membership record. Nothing changed - staff call.`,
};

// ---- Role sets --------------------------------------------------------
// A member's role ids as a Set, from a discord.js member (roles
// cache), a plain Map-backed fake, or a raw array (the roles
// snapshot stores plain arrays).
function roleIdsOf(member) {
  if (!member) return new Set();
  const cache = member.roles && member.roles.cache;
  if (cache && typeof cache.keys === 'function') return new Set([...cache.keys()]);
  if (Array.isArray(member.roles)) return new Set(member.roles);
  return new Set();
}

function displayNameOf(member) {
  if (!member) return 'user unknown';
  return member.displayName || (member.user && member.user.username) || `user ${member.id}`;
}

// True when the set of access roles differs between two role sets.
// Anything else changing (seniority ranks, account types, cosmetic
// roles) is not this module's business.
function accessChanged(oldIds, newIds) {
  for (const id of ACCESS_ROLE_IDS) {
    if (oldIds.has(id) !== newIds.has(id)) return true;
  }
  return false;
}

// ---- The classifier ---------------------------------------------------
// Pure decision: given a person's recorded standing ('member',
// 'guest', or null for no record), the role ids they hold, and
// whether they are a bot, what should happen?
//   'promote'  - recorded guest holding a member access role
//   'demotion' - recorded member holding no member access role
//   'norecord' - no record, holding a member access role
//   null       - nothing to do (includes bots, Friend holders,
//                records with an unrecognised standing, and every
//                consistent state)
function classify({ standing, roleIds, isBot }) {
  if (isBot) return null;
  if (standing !== null && standing !== 'member' && standing !== 'guest') return null;
  const roles = roleIds instanceof Set ? roleIds : new Set(roleIds || []);
  if (FRIEND_ID && roles.has(FRIEND_ID)) return null;
  const hasMemberRole = MEMBER_ROLE_IDS.some((id) => roles.has(id));
  if (standing === 'guest' && hasMemberRole) return 'promote';
  if (standing === 'member' && !hasMemberRole) return 'demotion';
  if (standing === null && hasMemberRole) return 'norecord';
  return null;
}

// The member's linked RSNs: the link list plus the plugin-verified
// list, deduped, in recorded order.
function linkedRsns(userId) {
  const entry = getRsnEntry(userId);
  const out = [];
  const seen = new Set();
  const lists = [...(entry.rsns || []), ...(entry.verified || [])];
  for (const rsn of lists) {
    if (typeof rsn !== 'string' || !rsn.trim()) continue;
    const key = rsn.trim().toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(rsn.trim());
  }
  return out;
}

// ---- Alert state ------------------------------------------------------
// Only this feature's own file is ever written. A corrupt or
// missing file reads as "nothing sent yet" rather than throwing.
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

// Drop keys whose issue is no longer in the current set. Returns
// true when anything changed.
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

// ---- Posting ------------------------------------------------------------
async function postToChecklist(client, text) {
  const threadId = config.ccChecklist && config.ccChecklist.threadId;
  if (!threadId || !client) return false;
  const channel = await safeFetch(client.channels.fetch(threadId), 'role-watch checklist post');
  if (!channel || typeof channel.send !== 'function') return false;
  try {
    await channel.send({ content: text, allowedMentions: { parse: [] } });
    return true;
  } catch (err) {
    console.error('[role-watch] checklist post failed:', err.message);
    return false;
  }
}

// The Initiate welcome, posted in General on a live promotion -
// the same message the application approval flow posts.
async function postWelcome(client, guild, userId) {
  const generalId = (config.recruit && config.recruit.generalChannelId)
    || (config.channels && config.channels.general);
  if (!generalId) return false;
  let channel = guild && guild.channels && guild.channels.cache
    ? guild.channels.cache.get(generalId) : null;
  if (!channel && client) {
    channel = await safeFetch(client.channels.fetch(generalId), 'role-watch welcome post');
  }
  if (!channel || typeof channel.send !== 'function') return false;
  const rsns = linkedRsns(userId);
  try {
    await channel.send({
      content: buildInitiateWelcome(userId, rsns.length ? rsns : null),
      allowedMentions: { parse: ['users'] },
    });
    return true;
  } catch (err) {
    console.error('[role-watch] welcome post failed:', err.message);
    return false;
  }
}

// ---- The promotion ------------------------------------------------------
// Everything a guest-to-member approval would have done, run
// because the roles already moved: flip the record, add Initiate
// when a live member object is at hand, queue the CC checklist
// entry, refresh the comp roster. Never removes a role. The
// welcome is live-path only; the sweep repairs quietly.
async function applyPromotion(client, guild, userId, member, { welcome }) {
  store.setMembershipStanding(guild.id, userId, 'member', 'role-watch');
  if (member && member.roles && typeof member.roles.add === 'function') {
    const entry = (config.seniorityRanks || []).find((r) => r.minMonths === 0);
    if (entry && entry.roleId && !roleIdsOf(member).has(entry.roleId)) {
      await member.roles.add(entry.roleId, 'Role sync: member promotion')
        .catch((e) => console.error('[role-watch] Initiate add failed:', e.message));
    }
  }
  await addCcEntry(guild, userId, 'None', 'Initiate')
    .catch((e) => console.error('[role-watch] CC checklist entry failed:', e.message));
  try {
    require('./comp-roster').scheduleRefresh(guild);
  } catch (e) {
    console.error('[role-watch] Comp roster refresh failed:', e.message);
  }
  if (welcome) await postWelcome(client, guild, userId);
  return true;
}

// A deduped staff line for the two flag-only issues, shared by the
// live handler and the sweep so an issue posts once from either.
async function postFlag(client, state, action, userId, name) {
  const key = `${action}:${userId}`;
  if (state.sent[key]) return false;
  const text = action === 'demotion' ? TEXT.demotion(name) : TEXT.norecord(name);
  const posted = await postToChecklist(client, text);
  if (!posted) return false;
  state.sent[key] = Date.now();
  saveState(state);
  return true;
}

// ---- Live handler ---------------------------------------------------------
// Called from the guildMemberUpdate handler in index.js whenever
// roles changed. Only access-role changes are acted on. Never
// throws.
const pending = new Set();

async function onMemberUpdate(client, oldMember, newMember, opts = {}) {
  try {
    if (!client || !newMember || !newMember.id) return false;
    if (newMember.user && newMember.user.bot) return false;
    const oldIds = roleIdsOf(oldMember);
    const newIds = roleIdsOf(newMember);
    if (!accessChanged(oldIds, newIds)) return false;
    const guild = newMember.guild;
    if (!guild) return false;
    if (pending.has(newMember.id)) return false;
    pending.add(newMember.id);
    try {
      // Let an in-flight approval finish writing its standing
      // before reading anything (see the header note).
      const settleMs = typeof opts.settleMs === 'number' ? opts.settleMs : SETTLE_MS;
      if (settleMs > 0) await new Promise((resolve) => setTimeout(resolve, settleMs));

      const fresh = (guild.members && guild.members.cache && guild.members.cache.get(newMember.id))
        || newMember;
      if (fresh.user && fresh.user.bot) return false;
      const rec = store.getMembership(guild.id)[newMember.id];
      const standing = rec ? rec.standing : null;
      const action = classify({ standing, roleIds: roleIdsOf(fresh), isBot: false });
      if (!action) return false;
      if (action !== 'promote' && isUserSettled(loadSettled(), newMember.id)) return false;
      const name = displayNameOf(fresh);

      if (action === 'promote') {
        await applyPromotion(client, guild, newMember.id, fresh, { welcome: true });
        return postToChecklist(client, TEXT.promotion(name, linkedRsns(newMember.id)));
      }
      return postFlag(client, loadState(), action, newMember.id, name);
    } finally {
      pending.delete(newMember.id);
    }
  } catch (err) {
    console.error('[role-watch] update failed:', err.message);
    return false;
  }
}

// ---- Daily sweep ----------------------------------------------------------
// Everyone in the guild with their roles: the shared member cache
// first (live member objects, so repairs can add Initiate), the
// roles snapshot file second (ids and role lists only - repairs
// there skip the role add, and bot flags are unknown so entries
// read as non-bots). Null when neither can answer, so the sweep
// fails closed instead of guessing at drift.
async function guildRoster(guild) {
  try {
    const { getMembers } = require('./guild-cache');
    const members = await getMembers(guild);
    if (members) {
      const list = [];
      for (const m of members.values()) {
        list.push({
          id: m.id,
          roleIds: roleIdsOf(m),
          name: displayNameOf(m),
          isBot: !!(m.user && m.user.bot),
          member: m,
        });
      }
      return list;
    }
  } catch { /* fall through to the snapshot */ }
  try {
    const snap = JSON.parse(fs.readFileSync(SNAPSHOT_FILE, 'utf8'));
    if (snap && snap.members && typeof snap.members === 'object') {
      return Object.entries(snap.members).map(([id, roleIds]) => ({
        id,
        roleIds: new Set(Array.isArray(roleIds) ? roleIds : []),
        name: `user ${id}`,
        isBot: false,
        member: null,
      }));
    }
  } catch { /* no snapshot yet */ }
  return null;
}

async function runSweep(client) {
  try {
    if (!client) return false;
    const guild = client.guilds.cache.get(config.guildId);
    if (!guild) return false;
    const roster = await guildRoster(guild);
    if (!roster) {
      console.warn('[role-watch] sweep skipped: guild membership unavailable.');
      return false;
    }
    // One read of the records up front: repairs below write through
    // the store, and the sweep judges everyone against the same
    // starting picture.
    const membership = store.getMembership(config.guildId);
    const settled = loadSettled();
    const state = loadState();
    const currentKeys = new Set();
    const lines = [];
    const freshKeys = [];

    for (const person of roster) {
      const rec = membership[person.id];
      const standing = rec ? rec.standing : null;
      const action = classify({ standing, roleIds: person.roleIds, isBot: person.isBot });
      if (!action) continue;
      if (action !== 'promote' && isUserSettled(settled, person.id)) continue;
      if (action === 'promote') {
        await applyPromotion(client, guild, person.id, person.member, { welcome: false });
        lines.push(TEXT.repair(person.name, linkedRsns(person.id)));
        continue;
      }
      const key = `${action}:${person.id}`;
      currentKeys.add(key);
      if (!state.sent[key]) {
        freshKeys.push(key);
        lines.push(action === 'demotion' ? TEXT.demotion(person.name) : TEXT.norecord(person.name));
      }
    }

    const pruned = pruneState(state, currentKeys);
    let posted = false;
    if (lines.length) {
      posted = await postToChecklist(client, lines.join('\n'));
      if (posted) {
        for (const key of freshKeys) state.sent[key] = Date.now();
      }
    }
    if (pruned || (posted && freshKeys.length)) saveState(state);
    if (lines.length && posted) {
      console.log(`Role watch sweep: posted ${lines.length} line(s) to the CC checklist thread.`);
    }
    return posted;
  } catch (err) {
    console.error('[role-watch] sweep failed:', err.message);
    return false;
  }
}

module.exports = {
  TEXT,
  MEMBER_ROLE_IDS,
  ACCESS_ROLE_IDS,
  SETTLE_MS,
  roleIdsOf,
  displayNameOf,
  accessChanged,
  classify,
  linkedRsns,
  loadState,
  saveState,
  pruneState,
  postToChecklist,
  onMemberUpdate,
  runSweep,
};
