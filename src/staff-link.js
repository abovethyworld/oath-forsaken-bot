// Staff RSN link: a persistent panel in its own thread in
// #staff-chat that lets staff link a RuneScape name to a member's
// Discord for them. It is the repair path for a member who cannot
// or will not use Link RSN themselves (ruled Nov 6, 2026).
//
// Rules baked in:
// - Staff only. The gate is the isStaff helper (config.tickets.
//   staffRoleIds), checked on the panel command, the button, the
//   member picker, and the modal, so a forwarded component id
//   gains a non-staff member nothing.
// - The write is always linkRsnQuiet: the name is appended and the
//   member's active name never moves. addRsn is never used here.
// - Wise Old Man must confirm the name exists before anything is
//   written. A name WOM cannot reach is refused, never linked
//   unchecked (the application flow's unchecked path is for
//   applications, not for a staff write).
// - A successful link posts one line to the mod-log and logs to
//   the journal. Refusals and failures log with the [staff-link]
//   tag, never swallowed.
const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  ModalBuilder,
  PermissionFlagsBits,
  SlashCommandBuilder,
  TextInputBuilder,
  TextInputStyle,
  UserSelectMenuBuilder,
} = require('discord.js');
const fs = require('node:fs');
const path = require('node:path');
const config = require('./config');
const { ZAMORAK_RED, isStaff, safeFetch } = require('./utils');
const { atomicWrite } = require('./store');
const { linkRsnQuiet, verifiedOwnerOf } = require('./teams');
const { computeOwnerMap, entryRsns, loadLinks, normName } = require('./membership');
const { getStats } = require('./wom');

const TAG = '[staff-link]';
const STATE_FILE = path.join(__dirname, '..', 'data', 'staff-link-panel.json');
const RSN_SHAPE = /^[A-Za-z0-9 ]{1,12}$/;

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) || {};
  } catch {
    return {};
  }
}

function saveState(state) {
  atomicWrite(STATE_FILE, state);
}

function panelPayload() {
  const embed = new EmbedBuilder()
    .setTitle('Link an RSN')
    .setDescription("Staff only. Link a RuneScape name to a member's Discord for them. Their active name stays as it is.")
    .setColor(ZAMORAK_RED);
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('stafflink:open')
      .setLabel('Link an RSN')
      .setStyle(ButtonStyle.Danger),
  );
  return { embeds: [embed], components: [row] };
}

// Resolve the panel's home: its own thread in staff chat when
// config.staffLink.threadId is set (resolved the way the CC
// checklist resolves its thread), else the staff chat channel
// itself, which is where the panel lived before it got a thread.
// Exported for the smoke test.
function panelHome(guild, cfg = config) {
  const threadId = cfg.staffLink?.threadId;
  if (threadId) return guild.channels.cache.get(threadId) || null;
  const chatId = cfg.ccChecklist?.staffChatId;
  return chatId ? guild.channels.cache.get(chatId) || null : null;
}

// Post the panel in its home, or edit the stored message back to
// the current payload when it still exists there (the CC checklist
// panel's refresh shape). A stored message from the panel's old
// home is not edited: the panel posts fresh into the new home.
// Returns false when the panel home is gone.
async function refreshStaffLinkPanel(guild) {
  const channel = panelHome(guild);
  if (!channel) {
    console.error(`${TAG} panel home not found (config.staffLink.threadId, config.ccChecklist.staffChatId)`);
    return false;
  }
  const payload = panelPayload();
  try {
    // Threads auto-archive; wake the panel's thread before touching
    // it. On a locked thread this throws into the catch below and
    // logs, like any other refresh failure.
    if (channel.isThread?.() && channel.archived) {
      await channel.setArchived(false);
    }
    const state = loadState();
    if (state.messageId && (!state.channelId || state.channelId === channel.id)) {
      const msg = await safeFetch(channel.messages.fetch(state.messageId), 'staff-link panel refresh');
      if (msg) {
        await msg.edit(payload);
        return true;
      }
    }
    const msg = await channel.send(payload);
    saveState({ ...loadState(), messageId: msg.id, channelId: channel.id });
    return true;
  } catch (err) {
    console.error(`${TAG} panel refresh failed:`, err.message);
    return false;
  }
}

// The checks, in the ruled order. Pure apart from the two injected
// lookups, so the smoke test can drive it with fixtures. statsFn
// mirrors the application flow's lookup (getStats: a stats object,
// { notFound: true }, or null when Wise Old Man cannot be reached).
async function checkStaffLink({ targetId, rawRsn, links, statsFn = getStats, verifiedOwnerFn = verifiedOwnerOf }) {
  const rsn = String(rawRsn || '').replace(/\s+/g, ' ').trim();
  if (!RSN_SHAPE.test(rsn)) {
    return { ok: false, code: 'shape', message: 'That name does not fit the shape of a RuneScape name. Check it and try again.' };
  }
  const verifiedOwner = verifiedOwnerFn(rsn);
  if (verifiedOwner && verifiedOwner !== targetId) {
    return { ok: false, code: 'verified', message: 'That name is verified to another member. It cannot be linked here.' };
  }
  const owner = computeOwnerMap(links || {}).get(normName(rsn));
  if (owner && owner !== targetId) {
    return { ok: false, code: 'owned', message: 'That name is already linked to another member.' };
  }
  const alreadyMine = entryRsns((links || {})[targetId]).some((r) => normName(r) === normName(rsn));
  if (alreadyMine) {
    return { ok: false, code: 'already', message: 'That name is already linked to them. Nothing changed.' };
  }
  let stats = null;
  try {
    stats = await statsFn(rsn);
  } catch {
    stats = null;
  }
  if (stats && stats.notFound) {
    return { ok: false, code: 'missing', message: 'Wise Old Man has no record of that name. Check the spelling and try again.' };
  }
  if (!stats) {
    return { ok: false, code: 'unreachable', message: 'Wise Old Man did not answer, so nothing was linked. Try again in a bit.' };
  }
  return { ok: true, rsn: stats.displayName || stats.username || rsn };
}

async function handleStaffLinkButton(interaction) {
  const [, action] = interaction.customId.split(':');
  if (action !== 'open') return;
  if (!isStaff(interaction)) {
    await interaction.reply({ content: 'That button is for staff only.', ephemeral: true });
    return;
  }
  const row = new ActionRowBuilder().addComponents(
    new UserSelectMenuBuilder()
      .setCustomId('stafflink:member')
      .setPlaceholder('Pick the member')
      .setMinValues(1)
      .setMaxValues(1),
  );
  await interaction.reply({ content: 'Who is the name for?', components: [row], ephemeral: true });
}

async function handleStaffLinkSelect(interaction) {
  if (!isStaff(interaction)) {
    await interaction.reply({ content: 'That picker is for staff only.', ephemeral: true });
    return;
  }
  const targetId = interaction.values && interaction.values[0];
  if (!targetId) return;
  const input = new TextInputBuilder()
    .setCustomId('rsn')
    .setLabel('RuneScape name')
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMaxLength(12);
  const modal = new ModalBuilder()
    .setCustomId(`stafflink:rsn:${targetId}`)
    .setTitle('Link an RSN')
    .addComponents(new ActionRowBuilder().addComponents(input));
  await interaction.showModal(modal);
}

async function handleStaffLinkModal(interaction) {
  const targetId = interaction.customId.split(':')[2];
  if (!isStaff(interaction)) {
    await interaction.reply({ content: 'That form is for staff only.', ephemeral: true });
    return;
  }
  if (!targetId) {
    console.error(`${TAG} modal submit carried no target id`);
    await interaction.reply({ content: 'Something went wrong.', ephemeral: true });
    return;
  }
  // The Wise Old Man lookup can take a moment; defer before it so
  // the submit does not die on Discord's 3-second window.
  await interaction.deferReply({ ephemeral: true });
  const rawRsn = interaction.fields.getTextInputValue('rsn');
  const check = await checkStaffLink({ targetId, rawRsn, links: loadLinks() });
  if (!check.ok) {
    if (check.code !== 'already') {
      console.error(`${TAG} refused (${check.code}): staff ${interaction.user.id}, target ${targetId}, name "${rawRsn}"`);
    }
    await interaction.editReply(check.message);
    return;
  }
  let added;
  try {
    added = linkRsnQuiet(targetId, check.rsn);
  } catch (err) {
    console.error(`${TAG} link write failed:`, err.message);
    await interaction.editReply('The link could not be saved. Nothing changed.');
    return;
  }
  if (!added) {
    // The name landed between the check and the write (a duplicate
    // submit, or the member linked it themselves in between).
    await interaction.editReply('That name is already linked to them. Nothing changed.');
    return;
  }
  console.log(`${TAG} ${interaction.user.tag} (${interaction.user.id}) linked ${check.rsn} to ${targetId}`);
  const log = interaction.guild.channels.cache.get(config.channels.modLog);
  if (log) {
    await log
      .send({ content: `Staff link: <@${interaction.user.id}> linked **${check.rsn}** to <@${targetId}>.` })
      .catch((e) => console.error(`${TAG} mod-log post failed:`, e.message));
  } else {
    console.error(`${TAG} mod-log channel not found; the link still stands`);
  }
  await interaction.editReply(`Linked **${check.rsn}** to <@${targetId}>. Their active name was not changed.`);
}

async function postPanelCommand(interaction) {
  if (!isStaff(interaction)) {
    await interaction.reply({ content: 'That command is for staff only.', ephemeral: true });
    return;
  }
  await interaction.deferReply({ ephemeral: true });
  const posted = await refreshStaffLinkPanel(interaction.guild);
  await interaction.editReply(
    posted ? 'Panel is up in the Link an RSN thread.' : 'The panel thread was not found. The panel was not posted.',
  );
}

const commands = [
  {
    data: new SlashCommandBuilder()
      .setName('link-rsn-panel')
      .setDescription('Post the staff Link an RSN panel in its thread (Staff only)')
      .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers),
    run: postPanelCommand,
  },
];

module.exports = {
  commands,
  panelPayload,
  panelHome,
  refreshStaffLinkPanel,
  checkStaffLink,
  handleStaffLinkButton,
  handleStaffLinkSelect,
  handleStaffLinkModal,
};
