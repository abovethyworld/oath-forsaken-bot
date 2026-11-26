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
//   This panel is the hand fix: set a member or a guest, move a
//   member to Friend of the Clan (clears the record; the Friend
//   role itself is still staff's to move), or remove them from
//   the clan, which opens a cleanup case (src/leaver-cleanup.js).
//   Standing buttons never touch roles; standing and roles are
//   separate on purpose.
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
  } catch (err) {
    if (err && err.code === 'ENOENT') return {};
    throw err;
  }
}

function saveState(state) {
  store.atomicWrite(STATE_FILE, state);
}

function panelPayload() {
  const embed = new EmbedBuilder()
    .setTitle('Website controls')
    .setDescription("Staff only. The website roster and rank sync read a member's standing from this record. Approving an application writes it. Use this panel only to fix it by hand.")
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
      : standing === 'left'
        ? `<@${targetId}> left the clan. A cleanup case holds their record.`
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
  );
  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`webctl:remove:${targetId}`)
      .setLabel('Remove from clan')
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId(`webctl:friend:${targetId}`)
      .setLabel('Move to Friend')
      .setStyle(ButtonStyle.Danger),
  );
  return { content: line, components: [row, row2] };
}

// A standing change can resolve a role sync panel row; refresh it
// so the row clears now. Never throws.
async function refreshRoleSyncRow(guild) {
  try {
    await require('./role-sync-panel').refresh(guild);
  } catch (e) {
    console.error(`${TAG} role sync panel refresh failed:`, e.message);
  }
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
  // Remove from clan / Move to Friend carry the target in the
  // third segment instead of a standing choice.
  if (action === 'remove' || action === 'friend') {
    const target = choice;
    if (!target) return;
    if (!isStaff(interaction)) {
      await interaction.reply({ content: 'That button is for staff only.', ephemeral: true });
      return;
    }
    if (action === 'friend') return handleFriendMove(interaction, target);
    return handleRemove(interaction, target);
  }
  if (action !== 'set' || !targetId || !['member', 'guest'].includes(choice)) return;
  if (!isStaff(interaction)) {
    await interaction.reply({ content: 'That button is for staff only.', ephemeral: true });
    return;
  }
  const guildId = interaction.guildId;
  try {
    store.setMembershipStanding(guildId, targetId, choice, 'panel');
  } catch (err) {
    console.error(`${TAG} standing write failed:`, err.message);
    await interaction.reply({ content: 'The record could not be saved. Nothing changed.', ephemeral: true });
    return;
  }
  // Standing changed: the comp roster follows membership.
  try {
    require('./comp-roster').scheduleRefresh(interaction.guild);
  } catch (e) {
    console.error(`${TAG} comp roster refresh failed:`, e.message);
  }
  console.log(`${TAG} ${interaction.user.tag} (${interaction.user.id}) set standing for ${targetId} to ${choice}`);
  await postModLog(interaction, `Website controls: <@${interaction.user.id}> set the standing for <@${targetId}> to ${choice}.`);
  await refreshRoleSyncRow(interaction.guild);
  await interaction.reply({ content: `Standing for <@${targetId}> is now ${choice}.`, ephemeral: true });
}

// Move to Friend: the record clears, exactly as the old Clear
// record button did - the website then shows them as a Friend of
// the Clan while they hold the Friend role (published from roles
// by src/friends.js). Deliberately NOT the cleanup case: a Friend
// keeps their link, their checklist state, and their plugin code.
async function handleFriendMove(interaction, targetId) {
  const guildId = interaction.guildId;
  if (!currentStanding(guildId, targetId)) {
    await interaction.reply({ content: `There is no record for <@${targetId}>. Nothing changed.`, ephemeral: true });
    return;
  }
  if (require('./leaver-cleanup').getCase(targetId)) {
    await interaction.reply({
      content: `<@${targetId}> has an open cleanup case. Restore it from the case post first, then move them.`,
      ephemeral: true,
    });
    return;
  }
  try {
    store.clearMembershipStanding(guildId, targetId);
  } catch (err) {
    console.error(`${TAG} standing write failed:`, err.message);
    await interaction.reply({ content: 'The record could not be saved. Nothing changed.', ephemeral: true });
    return;
  }
  try {
    require('./comp-roster').scheduleRefresh(interaction.guild);
  } catch (e) {
    console.error(`${TAG} comp roster refresh failed:`, e.message);
  }
  console.log(`${TAG} ${interaction.user.tag} (${interaction.user.id}) moved ${targetId} to Friend of the Clan (record cleared)`);
  await postModLog(interaction, `Website controls: <@${interaction.user.id}> moved <@${targetId}> to Friend of the Clan (record cleared).`);
  await refreshRoleSyncRow(interaction.guild);
  await interaction.reply({
    content: `The record for <@${targetId}> was cleared. They show as a Friend of the Clan while they hold the Friend role.`,
    ephemeral: true,
  });
}

// Remove from clan: opens a cleanup case (src/leaver-cleanup.js),
// which runs the reversible removal steps and holds the undo.
async function handleRemove(interaction, targetId) {
  const cleanup = require('./leaver-cleanup');
  if (cleanup.getCase(targetId)) {
    await interaction.reply({ content: `A cleanup case is already open for <@${targetId}>.`, ephemeral: true });
    return;
  }
  if (!currentStanding(interaction.guildId, targetId)) {
    await interaction.reply({ content: `There is no record for <@${targetId}>. Nothing to remove.`, ephemeral: true });
    return;
  }
  const opened = await cleanup.onPanelRemove(interaction.client, interaction.guild, targetId, interaction.user.id);
  if (!opened) {
    await interaction.reply({ content: `The cleanup case for <@${targetId}> could not be opened. Nothing changed.`, ephemeral: true });
    return;
  }
  console.log(`${TAG} ${interaction.user.tag} (${interaction.user.id}) removed ${targetId} from the clan (cleanup case)`);
  await postModLog(interaction, `Website controls: <@${interaction.user.id}> removed <@${targetId}> from the clan (cleanup case opened).`);
  await refreshRoleSyncRow(interaction.guild);
  await interaction.reply({
    content: `Cleanup case opened for <@${targetId}>. Record marked left, link parked, and a Remove CC rank entry is on the checklist.`,
    ephemeral: true,
  });
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
