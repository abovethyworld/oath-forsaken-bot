// Website controls: a persistent staff panel in its own thread
// in #staff-chat that edits the recorded membership standing
// (data/membership.json). The record is what the website roster
// and the seniority sync read a member's standing from.
//
// Rules baked in:
// - Staff only. The gate is the isStaff helper (config.tickets.
//   staffRoleIds), checked on the panel command, the panel
//   button, the member picker, and the standing buttons, so a
//   forwarded component id gains a non-staff member nothing.
// - Approval writes the record on its own (see src/recruit.js).
//   This panel is the hand fix: set a member, set a guest, or
//   clear the record. Nothing here touches roles; standing and
//   roles are separate on purpose.
// - Every change posts one line to the mod-log and logs to the
//   journal. Failures log with the [website-controls] tag,
//   never swallowed.
const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  PermissionFlagsBits,
  SlashCommandBuilder,
  UserSelectMenuBuilder,
} = require('discord.js');
const fs = require('node:fs');
const path = require('node:path');
const config = require('./config');
const { ZAMORAK_RED, isStaff, safeFetch } = require('./utils');
const store = require('./store');

const TAG = '[website-controls]';
const STATE_FILE = path.join(__dirname, '..', 'data', 'website-controls-panel.json');

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) || {};
  } catch {
    return {};
  }
}

function saveState(state) {
  store.atomicWrite(STATE_FILE, state);
}

function panelPayload() {
  const embed = new EmbedBuilder()
    .setTitle('Website controls')
    .setDescription("Staff only. This record is what the website roster and the rank sync read a member's standing from. Approval writes the record on its own. Use this panel to fix the record by hand.")
    .setColor(ZAMORAK_RED);
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('webctl:open')
      .setLabel('Set standing')
      .setStyle(ButtonStyle.Danger),
  );
  return { embeds: [embed], components: [row] };
}

// Resolve the panel's home: its own thread in staff chat when
// config.websiteControls.threadId is set, else the staff chat
// channel itself. Exported for the smoke test.
function panelHome(guild, cfg = config) {
  const threadId = cfg.websiteControls?.threadId;
  if (threadId) return guild.channels.cache.get(threadId) || null;
  const chatId = cfg.ccChecklist?.staffChatId;
  return chatId ? guild.channels.cache.get(chatId) || null : null;
}

// Post the panel in its home, or edit the stored message back to
// the current payload when it still exists there. A stored
// message from the panel's old home is not edited: the panel
// posts fresh into the new home. Returns false when the panel
// home is gone.
async function refreshWebsiteControlsPanel(guild) {
  const channel = panelHome(guild);
  if (!channel) {
    console.error(`${TAG} panel home not found (config.websiteControls.threadId, config.ccChecklist.staffChatId)`);
    return false;
  }
  const payload = panelPayload();
  try {
    // Threads auto-archive; wake the panel's thread before
    // touching it. On a locked thread this throws into the catch
    // below and logs, like any other refresh failure.
    if (channel.isThread?.() && channel.archived) {
      await channel.setArchived(false);
    }
    const state = loadState();
    if (state.messageId && (!state.channelId || state.channelId === channel.id)) {
      const msg = await safeFetch(channel.messages.fetch(state.messageId), 'website-controls panel refresh');
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

// The recorded standing for one member: 'member', 'guest', or
// null when there is no record. Exported for the smoke test.
function currentStanding(guildId, targetId) {
  const rec = store.getMembership(guildId)[targetId];
  return rec && typeof rec.standing === 'string' ? rec.standing : null;
}

// The picker step's reply: the member's current standing, stated
// plainly for all three states, with the three write buttons.
// Exported for the smoke test.
function standingPayload(guildId, targetId) {
  const standing = currentStanding(guildId, targetId);
  const line = standing === 'member'
    ? `<@${targetId}> is recorded as a member.`
    : standing === 'guest'
      ? `<@${targetId}> is recorded as a guest.`
      : `<@${targetId}> has no standing record.`;
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`webctl:set:member:${targetId}`)
      .setLabel('Set as member')
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId(`webctl:set:guest:${targetId}`)
      .setLabel('Set as guest')
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId(`webctl:set:clear:${targetId}`)
      .setLabel('Clear record')
      .setStyle(ButtonStyle.Danger),
  );
  return { content: line, components: [row] };
}

async function postModLog(interaction, line) {
  const log = interaction.guild?.channels.cache.get(config.channels.modLog);
  if (log) {
    await log
      .send({ content: line })
      .catch((e) => console.error(`${TAG} mod-log post failed:`, e.message));
  } else {
    console.error(`${TAG} mod-log channel not found; the change still stands`);
  }
}

async function handleWebsiteControlsButton(interaction) {
  const [, action, choice, targetId] = interaction.customId.split(':');
  if (action === 'open') {
    if (!isStaff(interaction)) {
      await interaction.reply({ content: 'That button is for staff only.', ephemeral: true });
      return;
    }
    const row = new ActionRowBuilder().addComponents(
      new UserSelectMenuBuilder()
        .setCustomId('webctl:member')
        .setPlaceholder('Who are you setting?')
        .setMinValues(1)
        .setMaxValues(1),
    );
    await interaction.reply({ content: 'Whose record are you changing?', components: [row], ephemeral: true });
    return;
  }
  if (action !== 'set' || !targetId || !['member', 'guest', 'clear'].includes(choice)) return;
  if (!isStaff(interaction)) {
    await interaction.reply({ content: 'That button is for staff only.', ephemeral: true });
    return;
  }
  const guildId = interaction.guildId;
  if (choice === 'clear' && !currentStanding(guildId, targetId)) {
    await interaction.reply({ content: `There is no record for <@${targetId}>. Nothing changed.`, ephemeral: true });
    return;
  }
  try {
    if (choice === 'clear') {
      store.clearMembershipStanding(guildId, targetId);
    } else {
      store.setMembershipStanding(guildId, targetId, choice, 'panel');
    }
  } catch (err) {
    console.error(`${TAG} standing write failed:`, err.message);
    await interaction.reply({ content: 'The record could not be saved. Nothing changed.', ephemeral: true });
    return;
  }
  if (choice === 'clear') {
    console.log(`${TAG} ${interaction.user.tag} (${interaction.user.id}) cleared the standing record for ${targetId}`);
    await postModLog(interaction, `Website controls: <@${interaction.user.id}> cleared the standing record for <@${targetId}>.`);
    await interaction.reply({ content: `The record for <@${targetId}> was cleared.`, ephemeral: true });
    return;
  }
  console.log(`${TAG} ${interaction.user.tag} (${interaction.user.id}) set standing for ${targetId} to ${choice}`);
  await postModLog(interaction, `Website controls: <@${interaction.user.id}> set the standing for <@${targetId}> to ${choice}.`);
  await interaction.reply({ content: `Standing for <@${targetId}> is now ${choice}.`, ephemeral: true });
}

async function handleWebsiteControlsSelect(interaction) {
  if (!isStaff(interaction)) {
    await interaction.reply({ content: 'That picker is for staff only.', ephemeral: true });
    return;
  }
  const targetId = interaction.values && interaction.values[0];
  if (!targetId) return;
  await interaction.reply({ ...standingPayload(interaction.guildId, targetId), ephemeral: true });
}

async function postPanelCommand(interaction) {
  if (!isStaff(interaction)) {
    await interaction.reply({ content: 'That command is for staff only.', ephemeral: true });
    return;
  }
  await interaction.deferReply({ ephemeral: true });
  const posted = await refreshWebsiteControlsPanel(interaction.guild);
  await interaction.editReply(
    posted ? 'Panel is up in the Website controls thread.' : 'The panel thread was not found. The panel was not posted.',
  );
}

const commands = [
  {
    data: new SlashCommandBuilder()
      .setName('website-controls-panel')
      .setDescription('Post the staff Website controls panel in its thread (Staff only)')
      .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers),
    run: postPanelCommand,
  },
];

module.exports = {
  commands,
  panelPayload,
  panelHome,
  refreshWebsiteControlsPanel,
  currentStanding,
  standingPayload,
  handleWebsiteControlsButton,
  handleWebsiteControlsSelect,
};
