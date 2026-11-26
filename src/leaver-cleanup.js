// Leaver cleanup: when a member leaves the clan, a case opens and
// the reversible steps run at once, so nobody has to chase the
// pieces by hand and nothing lingers on the website or the rosters.
//
// Two triggers open a case:
//  - The member leaves the server (guildMemberRemove, wired in
//    index.js after the WOM sync snapshot, which reads the link
//    before this module parks it).
//  - Staff tap "Remove from clan" on the Website controls panel.
//
// Opening a case snapshots everything needed to undo it (standing,
// the raw RSN link, held access/rank roles, the CC rank name) into
// data/cleanup-cases.json, then:
//  - marks the membership record 'left' (every consumer already
//    reads that as no record: the website roster, the comp roster,
//    the seniority sync, the role watch),
//  - parks the RSN link inside the case (out of rsn-links.json),
//  - revokes the plugin connect code,
//  - snapshots the departure for the WOM removal alert
//    (src/departed.js),
//  - closes the member's open CC checklist entries and adds one
//    "Remove CC rank" entry for the CC Updater,
//  - refreshes the comp roster.
// The profile comes off the website at the next export on its own,
// because the roster follows the record.
//
// Undo: if the member rejoins while the case is open, a restore
// offer with a button posts in the CC checklist thread (the case
// post itself carries the same button). A staff tap puts back the
// standing, the link, the roles, and the seniority eligibility
// (the assigned marker is cleared, so the sync can rank them
// again), closes the removal entry, and closes the case.
//
// This is part 1: cases stay open until restored or until staff
// close them by hand in the file. The day-7 automatic close
// (deleting the parked link, archiving plugin data) is part 2 and
// ships only after real leavers have passed through part 1.
const fs = require('fs');
const path = require('path');
const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const config = require('./config');
const store = require('./store');
const { atomicWrite } = require('./store');
const { safeFetch, isStaff } = require('./utils');
const { loadLinks } = require('./membership');
const { getRsnEntry, mutateRsnLinks } = require('./teams');
const { addEntry: addCcEntry, removeEntriesForUser } = require('./cc-checklist');
const { recordDeparture, clearDeparture } = require('./departed');
const { ACCESS_ROLE_IDS, roleIdsOf } = require('./role-watch');

const CASES_FILE = path.join(__dirname, '..', 'data', 'cleanup-cases.json');
const RANKS_FILE = path.join(__dirname, '..', 'data', 'rank-holders.json');
const TAG = '[leaver-cleanup]';

// =====================================================================
// STAFF TEXT - DRAFT, NOT YET APPROVED.
// These strings were drafted for this feature and have NOT been
// ruled on yet. They live here, in this one block, so the approved
// wording can be swapped in with a single edit. Posts go to the CC
// checklist thread with mentions parsing disabled - no pings.
// =====================================================================
const TEXT = {
  openedLeave: (name, rsns) => `Cleanup: ${name} left the server. Case opened - record marked left, link parked, comp roster rebuilding, and a Remove CC rank entry is on the checklist.${rsns.length ? ` RSNs: ${rsns.join(', ')}.` : ''} If they rejoin, the Restore button below puts it all back.`,
  openedPanel: (name, rsns) => `Cleanup: ${name} was removed from the clan by staff. Case opened - record marked left, link parked, comp roster rebuilding, and a Remove CC rank entry is on the checklist.${rsns.length ? ` RSNs: ${rsns.join(', ')}.` : ''} The Restore button below puts it all back.`,
  rejoin: (name) => `Cleanup: ${name} is back in the server and their cleanup case is still open. Restore puts back their record, link, roles and rank.`,
  restored: (name) => `Cleanup: ${name} was restored - record, link, roles and rank eligibility are back. The case is closed.`,
};

// ---- Case store -------------------------------------------------------
// Only this feature's own file is ever written. A corrupt or
// missing file reads as "no open cases" rather than throwing.
function loadCases() {
  try {
    const raw = JSON.parse(fs.readFileSync(CASES_FILE, 'utf8'));
    if (raw && typeof raw === 'object') return raw;
  } catch { /* first run or unreadable: no open cases */ }
  return {};
}

function saveCases(cases) {
  fs.mkdirSync(path.dirname(CASES_FILE), { recursive: true });
  atomicWrite(CASES_FILE, cases && typeof cases === 'object' ? cases : {});
}

function getCase(userId) {
  const cases = loadCases();
  return cases[String(userId)] || null;
}

// ---- Snapshots ----------------------------------------------------------
// The member's RSNs: the link list plus the plugin-verified list,
// deduped, in recorded order (same merge as the role watch).
function rsnsOf(userId) {
  const entry = getRsnEntry(userId);
  const out = [];
  const seen = new Set();
  for (const rsn of [...(entry.rsns || []), ...(entry.verified || [])]) {
    if (typeof rsn !== 'string' || !rsn.trim()) continue;
    const key = rsn.trim().toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(rsn.trim());
  }
  return out;
}

// Rank role ids from config, highest first.
function rankRoleIds() {
  return [...(config.seniorityRanks || [])]
    .sort((a, b) => b.minMonths - a.minMonths)
    .map((r) => r.roleId)
    .filter(Boolean);
}

// The CC rank name a member holds: their roles when a member object
// is at hand, else the last published rank-holders list. Null when
// they hold no rank either way.
function heldRankName(userId, member) {
  const held = member ? roleIdsOf(member) : new Set();
  const ranks = [...(config.seniorityRanks || [])].sort((a, b) => b.minMonths - a.minMonths);
  for (const r of ranks) {
    if (r.roleId && held.has(r.roleId)) return r.name.split(' ')[0];
  }
  if (member) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(RANKS_FILE, 'utf8'));
    if (Array.isArray(raw)) {
      const row = raw.find((x) => x && x.discordId === String(userId));
      if (row && typeof row.rank === 'string' && row.rank) return row.rank;
    }
  } catch { /* no published list yet */ }
  return null;
}

// The roles worth restoring: access roles (Iron Sworn / Unbound /
// Guest) plus seniority rank roles. Everything else a member wore
// is theirs to re-earn or staff's to re-grant by hand.
function restorableRoleIds(member) {
  if (!member) return [];
  const held = roleIdsOf(member);
  const wanted = new Set([...(ACCESS_ROLE_IDS || []), ...rankRoleIds()]);
  return [...held].filter((id) => wanted.has(id));
}

function displayNameOf(member, userId) {
  if (member) return member.displayName || (member.user && member.user.username) || `user ${userId}`;
  return `user ${userId}`;
}

// ---- Posting --------------------------------------------------------------
function restoreRow(userId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`cleanup:restore:${userId}`)
      .setLabel('Restore')
      .setStyle(ButtonStyle.Danger),
  );
}

async function postToChecklist(client, payload) {
  const threadId = config.ccChecklist && config.ccChecklist.threadId;
  if (!threadId || !client) return false;
  const channel = await safeFetch(client.channels.fetch(threadId), 'leaver-cleanup checklist post');
  if (!channel || typeof channel.send !== 'function') return false;
  try {
    await channel.send({ allowedMentions: { parse: [] }, ...payload });
    return true;
  } catch (err) {
    console.error(`${TAG} checklist post failed:`, err.message);
    return false;
  }
}

function refreshCompRoster(guild) {
  try {
    require('./comp-roster').scheduleRefresh(guild);
  } catch (e) {
    console.error(`${TAG} comp roster refresh failed:`, e.message);
  }
}

// ---- Open a case ------------------------------------------------------------
// Runs the reversible steps for one departure. Returns the case, or
// null when there is nothing to clean (no member/guest record, or a
// case is already open). Never throws to its callers' detriment:
// each outside step is guarded and logged, and the snapshot is
// saved first so a half-finished open can still be restored.
async function openCase(client, guild, { userId, via, byId = null, member = null }) {
  try {
    if (!guild || !userId) return null;
    const guildId = guild.id || config.guildId;
    const rec = store.getMembership(guildId)[userId];
    if (!rec || (rec.standing !== 'member' && rec.standing !== 'guest')) return null;
    if (getCase(userId)) return null;

    const name = displayNameOf(member, userId);
    const rsns = rsnsOf(userId);
    const theCase = {
      openedAt: Date.now(),
      openedBy: via,
      by: byId,
      name,
      rsns,
      priorStanding: rec.standing,
      priorLink: loadLinks()[userId] || null,
      priorRank: heldRankName(userId, member),
      priorRoleIds: restorableRoleIds(member),
    };
    const cases = loadCases();
    cases[String(userId)] = theCase;
    saveCases(cases);

    store.setMembershipStanding(guildId, userId, 'left', 'cleanup');
    if (theCase.priorLink) {
      mutateRsnLinks((links) => { delete links[userId]; });
    }
    try {
      require('./plugin-connect').revokeCodeFor(userId);
    } catch (e) {
      console.error(`${TAG} connect code revoke failed:`, e.message);
    }
    if (rsns.length) recordDeparture(userId, name, rsns);
    await removeEntriesForUser(guild, userId)
      .catch((e) => console.error(`${TAG} checklist close failed:`, e.message));
    await addCcEntry(guild, userId, theCase.priorRank || 'None', 'Remove')
      .catch((e) => console.error(`${TAG} checklist entry failed:`, e.message));
    refreshCompRoster(guild);

    const line = via === 'panel' ? TEXT.openedPanel(name, rsns) : TEXT.openedLeave(name, rsns);
    await postToChecklist(client, { content: line, components: [restoreRow(userId)] });
    console.log(`${TAG} case opened for ${userId} (${via})`);
    return theCase;
  } catch (err) {
    console.error(`${TAG} case open failed:`, err.message);
    return null;
  }
}

// Server leave (index.js guildMemberRemove, after the WOM sync
// snapshot). The departing member object still carries their roles.
async function onMemberLeave(client, member) {
  if (!member || !member.id) return false;
  const guild = member.guild || (client && client.guilds.cache.get(config.guildId));
  const opened = await openCase(client, guild, { userId: member.id, via: 'leave', member });
  return !!opened;
}

// Staff Remove on the Website controls panel. Fetches the member
// for the name/role snapshot when they are still in the server.
async function onPanelRemove(client, guild, targetId, staffId) {
  if (!guild || !targetId) return null;
  let member = null;
  try {
    member = await safeFetch(guild.members.fetch(targetId), 'leaver-cleanup member fetch');
  } catch { /* not in the server anymore: snapshot from records */ }
  return openCase(client, guild, { userId: targetId, via: 'panel', byId: staffId, member });
}

// Rejoin (index.js guildMemberAdd): with a case still open, post
// the restore offer. The case post's own button works too; this
// puts the offer in front of staff at the moment it matters.
async function onMemberRejoin(client, member) {
  try {
    if (!member || !member.id) return false;
    const theCase = getCase(member.id);
    if (!theCase) return false;
    return postToChecklist(client, {
      content: TEXT.rejoin(theCase.name || displayNameOf(member, member.id)),
      components: [restoreRow(member.id)],
    });
  } catch (err) {
    console.error(`${TAG} rejoin offer failed:`, err.message);
    return false;
  }
}

// ---- Restore ------------------------------------------------------------------
// The undo, run by the Restore button. Puts back the standing, the
// parked link, the snapshot roles, and the seniority eligibility;
// closes the removal checklist entry; closes the case. Returns
// true when a case was restored. Never throws.
async function restoreCase(client, guild, userId, member) {
  try {
    if (!guild || !userId) return false;
    const guildId = guild.id || config.guildId;
    const theCase = getCase(userId);
    if (!theCase) return false;

    store.setMembershipStanding(guildId, userId, theCase.priorStanding || 'member', 'cleanup-restore');
    if (theCase.priorLink) {
      const parked = theCase.priorLink;
      mutateRsnLinks((links) => { links[userId] = parked; });
    }
    store.clearSeniorityAssigned(guildId, userId);
    clearDeparture(userId);
    if (member && member.roles && typeof member.roles.add === 'function') {
      const held = roleIdsOf(member);
      for (const roleId of theCase.priorRoleIds || []) {
        if (held.has(roleId)) continue;
        const role = guild.roles && guild.roles.cache ? guild.roles.cache.get(roleId) : null;
        if (!role) continue;
        await member.roles.add(roleId, 'Leaver cleanup restore')
          .catch((e) => console.error(`${TAG} role restore failed:`, e.message));
      }
    }
    await removeEntriesForUser(guild, userId)
      .catch((e) => console.error(`${TAG} checklist close failed:`, e.message));
    refreshCompRoster(guild);

    const cases = loadCases();
    delete cases[String(userId)];
    saveCases(cases);

    await postToChecklist(client, { content: TEXT.restored(theCase.name || `user ${userId}`) });
    console.log(`${TAG} case restored for ${userId}`);
    return true;
  } catch (err) {
    console.error(`${TAG} restore failed:`, err.message);
    return false;
  }
}

// The Restore button (buttons.js routes kind 'cleanup'). Staff
// only, like the panel it undoes.
async function handleCleanupButton(interaction) {
  const [, action, targetId] = interaction.customId.split(':');
  if (action !== 'restore' || !targetId) return;
  if (!isStaff(interaction)) {
    await interaction.reply({ content: 'That button is for staff only.', ephemeral: true });
    return;
  }
  if (!getCase(targetId)) {
    await interaction.reply({ content: 'That cleanup case is already closed.', ephemeral: true });
    return;
  }
  let member = null;
  try {
    member = await safeFetch(interaction.guild.members.fetch(targetId), 'leaver-cleanup restore fetch');
  } catch { /* handled below */ }
  if (!member) {
    await interaction.reply({
      content: `<@${targetId}> is not in the server right now, so their roles cannot be put back. The case stays open.`,
      ephemeral: true,
    });
    return;
  }
  const restored = await restoreCase(interaction.client, interaction.guild, targetId, member);
  await interaction.reply({
    content: restored
      ? `<@${targetId}> is restored - record, link, roles and rank eligibility are back.`
      : 'The restore did not finish. The case is still open; check the log.',
    ephemeral: true,
  });
}

module.exports = {
  TEXT,
  CASES_FILE,
  loadCases,
  saveCases,
  getCase,
  rsnsOf,
  heldRankName,
  restorableRoleIds,
  openCase,
  onMemberLeave,
  onPanelRemove,
  onMemberRejoin,
  restoreCase,
  handleCleanupButton,
};
