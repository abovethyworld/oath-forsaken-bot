// Role sync panel: one standing embed, edited in place, that is the
// only reporting surface for the role watcher (src/role-watch.js).
//
// Two parts:
//  - Open flags: the two cases a person has to decide (a recorded
//    member holding no member role, and a member role held with no
//    record). A flag clears on its own once roles and record agree
//    again, the person is settled, or they leave the server.
//  - Done by the bot: the last 10 things the watcher did itself
//    (promotions, record repairs, moves to guest), dropped after
//    7 days.
//
// Each flag carries a Fix button that replies with the Website
// controls standing reply for that person, so the panel adds no
// write path of its own. Every write still goes through the
// existing Website controls handlers.
//
// State lives in data/role-watch.json (version 2): the panel
// message ids, the open flags and the recent actions. A version 1
// file ({ sent: {...} }) migrates on first load.
const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  PermissionFlagsBits,
  SlashCommandBuilder,
} = require('discord.js');
const fs = require('node:fs');
const path = require('node:path');
const config = require('./config');
const store = require('./store');
const { atomicWrite } = require('./store');
const { ZAMORAK_RED, isStaff, safeFetch } = require('./utils');
const { loadSettled, isUserSettled } = require('./sync-settled');

const TAG = '[role-sync-panel]';
const STATE_FILE = path.join(__dirname, '..', 'data', 'role-watch.json');
const PER_PAGE = 5;
const MAX_RECENT = 10;
const RECENT_MAX_AGE_S = 7 * 24 * 60 * 60;
const FLAG_ACTIONS = ['demotion', 'norecord'];

// =====================================================================
// PANEL TEXT. Approved by Gavin on Nov 26, 2026. Every string the
// panel shows lives in this one block, so the wording can be swapped
// in a single edit. Mentions render inside the embed and never ping;
// every send and edit also disables mention parsing.
// =====================================================================
const TEXT = {
  title: '⛧ Role Sync ⛧',
  flagsHeading: 'Needs a staff call',
  flag: {
    demotion: (n, id, since) => `**${n}.** <@${id}>: member on record, no member role. <t:${since}:R>`,
    norecord: (n, id, since) => `**${n}.** <@${id}>: member role, no record. <t:${since}:R>`,
  },
  flagsEmpty: 'Nothing needs a staff call.',
  recentHeading: 'Done by the bot',
  recent: {
    promote: (id, at) => `<@${id}> set to member. Checklist entry added. <t:${at}:R>`,
    repair: (id, at) => `<@${id}> record fixed to member. Checklist entry added. <t:${at}:R>`,
    demote: (id, at, rankRemoved) => `<@${id}> set to guest.${rankRemoved ? ' Rank role removed.' : ''} <t:${at}:R>`,
  },
  recentEmpty: 'Nothing in the last 7 days.',
  allClear: 'All caught up. Roles and records match.',
  footer: 'Fix opens their record. A row clears once roles and record agree.',
  fixButton: (n) => `Fix ${n}`,
  fixGone: 'That one is already sorted.',
  staffOnly: 'That button is for staff only.',
};

const nowS = () => Math.floor(Date.now() / 1000);

// ---- State ------------------------------------------------------------
function emptyState() {
  return { version: 2, messageId: null, channelId: null, page: 0, open: {}, recent: [] };
}

// Trim recent: drop anything older than 7 days, keep the newest 10.
function trimRecent(recent, now = nowS()) {
  return recent
    .filter((r) => r && typeof r.at === 'number' && now - r.at <= RECENT_MAX_AGE_S)
    .slice(0, MAX_RECENT);
}

// A missing or corrupt file reads as an empty panel rather than
// throwing. A v1 file ({ sent }) converts: demotion and norecord
// keys become open flags (timestamps to seconds), demote keys drop,
// messageId stays null so the first refresh posts the panel.
function loadState() {
  try {
    const raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    if (raw && typeof raw === 'object') {
      if (raw.version === 2) {
        return {
          version: 2,
          messageId: raw.messageId || null,
          channelId: raw.channelId || null,
          page: Number.isInteger(raw.page) && raw.page > 0 ? raw.page : 0,
          open: raw.open && typeof raw.open === 'object' ? { ...raw.open } : {},
          recent: Array.isArray(raw.recent) ? raw.recent.slice() : [],
        };
      }
      if (raw.sent && typeof raw.sent === 'object') {
        const state = emptyState();
        for (const [key, stamp] of Object.entries(raw.sent)) {
          const idx = key.indexOf(':');
          const action = key.slice(0, idx);
          const userId = key.slice(idx + 1);
          if (!FLAG_ACTIONS.includes(action) || !userId) continue;
          const n = Number(stamp);
          const since = Number.isFinite(n) && n > 0
            ? (n > 1e11 ? Math.floor(n / 1000) : Math.floor(n))
            : nowS();
          state.open[key] = { action, userId, since };
        }
        return state;
      }
    }
  } catch { /* first run or unreadable: start empty */ }
  return emptyState();
}

function saveState(state) {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  atomicWrite(STATE_FILE, {
    version: 2,
    messageId: state.messageId || null,
    channelId: state.channelId || null,
    page: state.page || 0,
    open: state.open,
    recent: trimRecent(state.recent),
  });
}

// Record something the bot did. Newest first, trimmed on write.
function recordAction(action, userId, { rankRemoved = false, at = nowS() } = {}) {
  const state = loadState();
  state.recent.unshift({ action, userId, at, rankRemoved: !!rankRemoved });
  saveState(state);
  return true;
}

// Open a flag. Returns false when that flag is already open.
function openFlag(action, userId, since = nowS()) {
  if (!FLAG_ACTIONS.includes(action)) return false;
  const key = `${action}:${userId}`;
  const state = loadState();
  if (state.open[key]) return false;
  state.open[key] = { action, userId, since };
  saveState(state);
  return true;
}

// Remove one flag (either kind) for a person. Returns true when
// anything was removed.
function clearFlagsFor(userId) {
  const state = loadState();
  let changed = false;
  for (const action of FLAG_ACTIONS) {
    const key = `${action}:${userId}`;
    if (state.open[key]) { delete state.open[key]; changed = true; }
  }
  if (changed) saveState(state);
  return changed;
}

// Drop flags whose key is not in the current set (the sweep's
// view). Returns true when anything changed.
function pruneOpen(currentKeys) {
  const state = loadState();
  let changed = false;
  for (const key of Object.keys(state.open)) {
    if (!currentKeys.has(key)) { delete state.open[key]; changed = true; }
  }
  if (changed) saveState(state);
  return changed;
}

function sortedFlags(state) {
  return Object.values(state.open).sort((a, b) => (a.since - b.since) || String(a.userId).localeCompare(String(b.userId)));
}

function clampPage(page, count) {
  const totalPages = Math.max(1, Math.ceil(count / PER_PAGE));
  return Math.min(Math.max(0, page || 0), totalPages - 1);
}

// ---- Rendering ----------------------------------------------------------
function buildEmbed(state, now = nowS()) {
  const flags = sortedFlags(state);
  const recent = trimRecent(state.recent, now);
  const embed = new EmbedBuilder().setTitle(TEXT.title).setColor(ZAMORAK_RED);

  if (!flags.length && !recent.length) {
    embed.setDescription(TEXT.allClear);
    embed.setFooter({ text: TEXT.footer });
    return embed;
  }

  const page = clampPage(state.page, flags.length);
  const start = page * PER_PAGE;
  const flagLines = flags.slice(start, start + PER_PAGE)
    .map((f, i) => TEXT.flag[f.action](start + i + 1, f.userId, f.since));
  const recentLines = recent.map((r) => (TEXT.recent[r.action]
    ? TEXT.recent[r.action](r.userId, r.at, r.rankRemoved) : null)).filter(Boolean);

  const desc = [
    `**${TEXT.flagsHeading}**`,
    flagLines.length ? flagLines.join('\n') : TEXT.flagsEmpty,
    '',
    `**${TEXT.recentHeading}**`,
    recentLines.length ? recentLines.join('\n') : TEXT.recentEmpty,
  ].join('\n');
  embed.setDescription(desc);
  embed.setFooter({ text: TEXT.footer });
  return embed;
}

function buildButtons(state) {
  const flags = sortedFlags(state);
  if (!flags.length) return [];
  const totalPages = Math.ceil(flags.length / PER_PAGE);
  const page = clampPage(state.page, flags.length);
  const start = page * PER_PAGE;
  const fixRow = new ActionRowBuilder();
  flags.slice(start, start + PER_PAGE).forEach((f, i) => {
    fixRow.addComponents(
      new ButtonBuilder()
        .setCustomId(`rsync:fix:${f.userId}`)
        .setLabel(TEXT.fixButton(start + i + 1))
        .setStyle(ButtonStyle.Danger)
        .setEmoji('🔧'),
    );
  });
  const rows = [fixRow];
  if (totalPages > 1) {
    rows.push(new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('rsync:prev')
        .setLabel('Prev')
        .setEmoji('◀')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(page === 0),
      new ButtonBuilder()
        .setCustomId('rsync:next')
        .setLabel('Next')
        .setEmoji('▶')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(page >= totalPages - 1),
    ));
  }
  return rows;
}

// ---- Home ---------------------------------------------------------------
let warnedFallback = false;
function panelHome(guild, cfg = config) {
  const own = cfg.roleSync && cfg.roleSync.threadId;
  if (own) return guild.channels.cache.get(own) || null;
  const fallback = cfg.ccChecklist && cfg.ccChecklist.threadId;
  if (!fallback) return null;
  if (!warnedFallback) {
    warnedFallback = true;
    console.warn(`${TAG} config.roleSync.threadId is not set; using the CC checklist thread.`);
  }
  return guild.channels.cache.get(fallback) || null;
}

// ---- Flag re-check ----------------------------------------------------------
// Which open flags no longer hold? Resolved (roles and record agree),
// settled, or the person left the server. A fetch error other than
// Unknown Member keeps the flag (fails closed, like the sweep).
async function staleFlagKeys(guild, state) {
  const { classify, roleIdsOf } = require('./role-watch');
  const keys = Object.keys(state.open);
  if (!keys.length) return [];
  const membership = store.getMembership(guild.id) || {};
  const settled = loadSettled();
  const stale = [];
  for (const key of keys) {
    const flag = state.open[key];
    if (isUserSettled(settled, flag.userId)) { stale.push(key); continue; }
    let member = guild.members && guild.members.cache && guild.members.cache.get(flag.userId);
    if (!member) {
      try {
        member = await guild.members.fetch(flag.userId);
      } catch (err) {
        if (err && (err.code === 10007 || err.code === 10013)) stale.push(key);
        else console.error(`${TAG} member fetch failed for a flag, keeping it:`, err && err.message);
        continue;
      }
    }
    if (!member) { stale.push(key); continue; }
    const rec = membership[flag.userId];
    const action = classify({
      standing: rec ? rec.standing : null,
      roleIds: roleIdsOf(member),
      isBot: !!(member.user && member.user.bot),
    });
    if (action !== flag.action) stale.push(key);
  }
  return stale;
}

// ---- Refresh ----------------------------------------------------------------
// Re-check flags against now, then apply the drops to a fresh read
// so changes made during the fetches are not clobbered. Also trims
// recent, resets the message id when the home moved, and clamps the
// page. Returns the saved state.
async function settleState(guild, channel) {
  const stale = await staleFlagKeys(guild, loadState());
  const state = loadState();
  let changed = false;
  for (const key of stale) {
    if (state.open[key]) { delete state.open[key]; changed = true; }
  }
  const trimmed = trimRecent(state.recent);
  if (trimmed.length !== state.recent.length) { state.recent = trimmed; changed = true; }
  if (state.channelId && state.channelId !== channel.id) { state.messageId = null; changed = true; }
  state.page = clampPage(state.page, Object.keys(state.open).length);
  if (changed) saveState(state);
  return state;
}

// Edit the stored panel message, or post a new one when it is gone.
async function editOrPost(channel, state, payload) {
  if (state.messageId) {
    const msg = await safeFetch(channel.messages.fetch(state.messageId), 'role-sync-panel refresh');
    if (msg) {
      await msg.edit(payload);
      return;
    }
  }
  const msg = await channel.send(payload);
  // Reload before saving so flag changes made during the send are not clobbered.
  const fresh = loadState();
  fresh.messageId = msg.id;
  fresh.channelId = channel.id;
  saveState(fresh);
}

async function doRefresh(guild) {
  const channel = panelHome(guild);
  if (!channel) {
    console.error(`${TAG} panel home not found (config.roleSync.threadId, config.ccChecklist.threadId)`);
    return false;
  }
  try {
    const state = await settleState(guild, channel);
    const payload = {
      embeds: [buildEmbed(state)],
      components: buildButtons(state),
      allowedMentions: { parse: [] },
    };
    if (channel.isThread && channel.isThread() && channel.archived) {
      await channel.setArchived(false);
    }
    await editOrPost(channel, state, payload);
    return true;
  } catch (err) {
    console.error(`${TAG} refresh failed:`, err.message);
    return false;
  }
}

// Refreshes run one at a time on a module-level chain, so a live
// event and the sweep cannot both find no message and post twice.
let chain = Promise.resolve();
function refresh(guild) {
  const run = chain.then(() => doRefresh(guild));
  chain = run.catch(() => false);
  return run.catch(() => false);
}

// ---- Buttons ----------------------------------------------------------------
async function handleRoleSyncButton(interaction) {
  const [, action, userId] = interaction.customId.split(':');
  if (!isStaff(interaction)) {
    await interaction.reply({ content: TEXT.staffOnly, ephemeral: true });
    return;
  }
  if (action === 'fix') {
    if (!userId) return;
    const state = loadState();
    const live = FLAG_ACTIONS.some((a) => state.open[`${a}:${userId}`]);
    if (!live) {
      await interaction.reply({ content: TEXT.fixGone, ephemeral: true });
      return;
    }
    const { standingPayload } = require('./website-controls');
    await interaction.reply({ ...standingPayload(interaction.guildId, userId), ephemeral: true });
    return;
  }
  if (action === 'prev' || action === 'next') {
    const state = loadState();
    const count = Object.keys(state.open).length;
    state.page = clampPage(clampPage(state.page, count) + (action === 'next' ? 1 : -1), count);
    saveState(state);
    await interaction.deferUpdate();
    await refresh(interaction.guild);
  }
}

// ---- Command ----------------------------------------------------------------
async function setupCommand(interaction) {
  if (!isStaff(interaction)) {
    await interaction.reply({ content: 'That command is for staff only.', ephemeral: true });
    return;
  }
  await interaction.deferReply({ ephemeral: true });
  const posted = await refresh(interaction.guild);
  await interaction.editReply(
    posted ? 'Role sync panel posted/refreshed.' : 'The panel thread was not found. The panel was not posted.',
  );
}

const commands = [
  {
    data: new SlashCommandBuilder()
      .setName('setup-role-sync')
      .setDescription('Post the role sync panel in its thread (Admin only)')
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
    run: setupCommand,
  },
];

module.exports = {
  commands,
  TEXT,
  PER_PAGE,
  MAX_RECENT,
  loadState,
  saveState,
  trimRecent,
  recordAction,
  openFlag,
  clearFlagsFor,
  pruneOpen,
  buildEmbed,
  buildButtons,
  panelHome,
  refresh,
  handleRoleSyncButton,
};
