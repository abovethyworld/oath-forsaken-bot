// CC rank-up checklist: persistent embed in #staff-chat tracking in-game
// clan chat rank updates. When the bot promotes a Discord seniority role,
// it adds an entry here. Staff updates the in-game CC manually (no API),
// then hits Done to clear. Hold button for exceptions.
// Built 2026-10-13 (bot idea #12).
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
const { safeFetch } = require('./utils');
const { atomicWrite } = require('./store');

const ZAMORAK_RED = 0x6b0e0e;
// All IDs from config.json — no hardcoded IDs in this file.
const CC = config.ccChecklist || {};
const STAFF_CHAT_ID = CC.staffChatId;
const CC_THREAD_ID = CC.threadId;
const CC_UPDATER_ROLE_ID = CC.ccUpdaterRoleId;

const RANK_ROLE_IDS = CC.rankRoleIds || {};
const RANK_EMOJIS = CC.rankEmojis || {};

function rankEmoji(rankName) {
  return RANK_EMOJIS[rankName] || '';
}

function rankDisplay(rankName) {
  return `${rankEmoji(rankName)} ${rankName}`;
}
const DATA_FILE = path.join(__dirname, '..', 'data', 'cc-checklist.json');

function load() {
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch {
    return { entries: [], messageId: null, page: 0 };
  }
}

function save(data) {
  atomicWrite(DATA_FILE, data);
}

const PER_PAGE = 5;

function buildEmbed(entries, page) {
  const embed = new EmbedBuilder()
    .setTitle('\u26e7 CC Rank Checklist \u26e7')
    .setColor(ZAMORAK_RED);

  if (entries.length === 0) {
    embed.setDescription('\u26e7 All caught up. No pending in-game rank updates.');
    return embed;
  }

  const totalPages = Math.ceil(entries.length / PER_PAGE);
  const start = page * PER_PAGE;
  const pageEntries = entries.slice(start, start + PER_PAGE);

  const lines = pageEntries.map((e, i) => {
    const num = start + i + 1;
    const holdTag = e.held ? ' \u23f8\ufe0f **HELD**' : '';
    return `**${num}.** <@${e.userId}> \u2014 ${rankDisplay(e.oldRank)} \u2192 **${rankDisplay(e.newRank)}**${holdTag}\n\u26e7 <t:${e.at}:R>`;
  });

  let desc = lines.join('\n\n');
  embed.setDescription(desc);

  let footer = 'Update their in-game clan chat rank, then hit \u2705.';
  if (totalPages > 1) {
    footer += ` Page ${page + 1} of ${totalPages} (${entries.length} total).`;
  }
  embed.setFooter({ text: footer });
  return embed;
}

function buildButtons(entries, page) {
  if (entries.length === 0) return [];
  const totalPages = Math.ceil(entries.length / PER_PAGE);
  const start = page * PER_PAGE;
  const pageEntries = entries.slice(start, start + PER_PAGE);

  const doneRow = new ActionRowBuilder();
  const holdRow = new ActionRowBuilder();
  for (let i = 0; i < pageEntries.length; i++) {
    const globalIdx = start + i;
    const num = globalIdx + 1;
    doneRow.addComponents(
      new ButtonBuilder()
        .setCustomId(`cc:done:${globalIdx}`)
        .setLabel(`${num}`)
        .setStyle(ButtonStyle.Success)
        .setEmoji('\u2705')
    );
    holdRow.addComponents(
      new ButtonBuilder()
        .setCustomId(`cc:hold:${globalIdx}`)
        .setLabel(`${num}`)
        .setStyle(ButtonStyle.Secondary)
        .setEmoji('\u23f8\ufe0f')
    );
  }

  const rows = [doneRow, holdRow];

  // Navigation + clear row
  const navRow = new ActionRowBuilder();
  if (totalPages > 1) {
    navRow.addComponents(
      new ButtonBuilder()
        .setCustomId('cc:prev')
        .setLabel('Prev')
        .setStyle(ButtonStyle.Secondary)
        .setEmoji('\u25c0\ufe0f')
        .setDisabled(page === 0),
      new ButtonBuilder()
        .setCustomId('cc:next')
        .setLabel('Next')
        .setStyle(ButtonStyle.Secondary)
        .setEmoji('\u25b6\ufe0f')
        .setDisabled(page >= totalPages - 1)
    );
  }
  navRow.addComponents(
    new ButtonBuilder()
      .setCustomId('cc:clearall')
      .setLabel('Clear All')
      .setStyle(ButtonStyle.Danger)
      .setEmoji('🗑️')
  );
  rows.push(navRow);

  return rows;
}

async function refreshChecklist(guild) {
  const data = load();
  const channel = guild.channels.cache.get(CC_THREAD_ID);
  if (!channel) return;

  const page = data.page || 0;
  const embed = buildEmbed(data.entries, page);
  const components = buildButtons(data.entries, page);

  try {
    if (data.messageId) {
      const msg = await safeFetch(channel.messages.fetch(data.messageId), 'cc-checklist refresh');
      if (msg) {
        await msg.edit({ embeds: [embed], components }).catch((e) => console.error("[cc-checklist.js] Silent failure:", e.message));
        return;
      }
    }
    // No existing message, post a new one
    const msg = await channel.send({ embeds: [embed], components });
    data.messageId = msg.id;
    save(data);
  } catch (err) {
    console.error('CC checklist refresh failed:', err.message);
  }
}

async function addEntry(guild, userId, oldRank, newRank) {
  const data = load();
  // Don't add duplicates
  if (data.entries.some(e => e.userId === userId && e.newRank === newRank)) return;
  data.entries.push({
    userId,
    oldRank: oldRank || 'None',
    newRank,
    at: Math.floor(Date.now() / 1000),
    held: false,
  });
  save(data);
  await refreshChecklist(guild);
  // Ping CC Updaters about the new entry
  try {
    const channel = guild.channels.cache.get(CC_THREAD_ID);
    if (channel) {
      const pingMsg = await channel.send({
        content: `<@&${CC_UPDATER_ROLE_ID}> New CC update needed: <@${userId}> — ${rankDisplay(oldRank)} → **${rankDisplay(newRank)}**`,
        allowedMentions: { parse: ['roles'] },
      }).catch((e) => { console.error('[cc-checklist] Ping send failed:', e.message); return null; });
      if (pingMsg) {
        // Store ping message ID on the entry for cleanup
        const d2 = load();
        const entry = d2.entries.find(e => e.userId === userId && e.oldRank === oldRank && e.newRank === newRank && !e.pingMsgId);
        if (entry) {
          entry.pingMsgId = pingMsg.id;
          save(d2);
        }
      }
    }
  } catch {}
}

async function handleCcButton(interaction) {
  const parts = interaction.customId.split(':');
  if (parts[0] !== 'cc') return false;
  const action = parts[1];

  const data = load();
  data.page = data.page || 0;

  if (action === 'clearall') {
    const count = data.entries.length;
    if (count === 0) {
      await interaction.reply({ content: 'Nothing to clear.', ephemeral: true });
      return true;
    }
    const confirmRow = new ActionRowBuilder();
    confirmRow.addComponents(
      new ButtonBuilder()
        .setCustomId('cc:confirmclear')
        .setLabel(`Yes, clear all ${count}`)
        .setStyle(ButtonStyle.Danger),
      new ButtonBuilder()
        .setCustomId('cc:cancelclear')
        .setLabel('Cancel')
        .setStyle(ButtonStyle.Secondary)
    );
    await interaction.reply({
      content: `Clear all ${count} entries? This cannot be undone.`,
      components: [confirmRow],
      ephemeral: true,
    });
    return true;
  }

  if (action === 'confirmclear') {
    const count = data.entries.length;
    const pingIds = data.entries.map(e => e.pingMsgId).filter(Boolean);
    data.entries = [];
    data.page = 0;
    save(data);
    await refreshChecklist(interaction.guild);
    // Delete all ping messages
    try {
      const thread = interaction.guild.channels.cache.get(CC_THREAD_ID);
      if (thread) {
        for (const pid of pingIds) {
          const pingMsg = await safeFetch(thread.messages.fetch(pid), 'cc-checklist ping cleanup');
          if (pingMsg) await pingMsg.delete().catch((e) => console.error("[cc-checklist.js] Silent failure:", e.message));
        }
      }
    } catch {}
    await interaction.update({ content: `Cleared ${count} entries.`, components: [] });
    return true;
  }

  if (action === 'cancelclear') {
    await interaction.update({ content: 'Cancelled.', components: [] });
    return true;
  }

  if (action === 'prev' || action === 'next') {
    const totalPages = Math.ceil(data.entries.length / PER_PAGE);
    if (action === 'prev' && data.page > 0) data.page--;
    if (action === 'next' && data.page < totalPages - 1) data.page++;
    save(data);
    await refreshChecklist(interaction.guild);
    await interaction.deferUpdate().catch((e) => console.error("[cc-checklist.js] Silent failure:", e.message));
    return true;
  }

  const idx = parseInt(parts[2], 10);
  if (isNaN(idx) || idx < 0 || idx >= data.entries.length) {
    await interaction.reply({ content: 'Entry not found.', ephemeral: true });
    return true;
  }

  if (action === 'done') {
    const removed = data.entries.splice(idx, 1)[0];
    // Adjust page if we removed the last entry on the last page
    const totalPages = Math.ceil(data.entries.length / PER_PAGE);
    if (data.page >= totalPages && data.page > 0) data.page = totalPages - 1;
    save(data);
    await refreshChecklist(interaction.guild);
    // Delete the ping message for this entry
    if (removed.pingMsgId) {
      try {
        const thread = interaction.guild.channels.cache.get(CC_THREAD_ID);
        if (thread) {
          const pingMsg = await safeFetch(thread.messages.fetch(removed.pingMsgId), 'cc-checklist ping cleanup');
          if (pingMsg) await pingMsg.delete().catch((e) => console.error("[cc-checklist.js] Silent failure:", e.message));
        }
      } catch {}
    }
    await interaction.reply({ content: `Cleared <@${removed.userId}>.`, ephemeral: true });
  } else if (action === 'hold') {
    data.entries[idx].held = !data.entries[idx].held;
    save(data);
    await refreshChecklist(interaction.guild);
    const state = data.entries[idx].held ? 'held' : 'unheld';
    await interaction.reply({ content: `Entry #${idx + 1} ${state}.`, ephemeral: true });
  }
  return true;
}

async function setupCommand(interaction) {
  await interaction.deferReply({ ephemeral: true });
  await refreshChecklist(interaction.guild);
  await interaction.editReply('CC checklist posted/refreshed in #staff-chat.');
}

const commands = [
  {
    data: new SlashCommandBuilder()
      .setName('setup-cc-checklist')
      .setDescription('Post the CC rank checklist in #staff-chat (Admin only)')
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
    run: setupCommand,
  },
];

module.exports = { commands, handleCcButton, addEntry, refreshChecklist };
