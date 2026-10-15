// Event roster: button-based signup for clan events.
// When /event-create posts its announcement, it includes a "Join Roster" button.
// Members click to join/leave; the roster updates live on the message.
// Data persists in data/rosters.json so it survives restarts.
const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  PermissionFlagsBits,
  SlashCommandBuilder,
} = require('discord.js');
const crypto = require('node:crypto');
const store = require('./store');
const { ZAMORAK_RED } = require('./utils');

// Roster roles members can sign up for (OSRS group content)
const ROSTER_ROLES = ['Tank', 'DPS', 'Learner'];

function rosterEmbed(eventName, roster) {
  const total = Object.keys(roster).length;
  const lines = ROSTER_ROLES.map((role) => {
    const members = Object.entries(roster)
      .filter(([, r]) => r === role)
      .map(([uid]) => `<@${uid}>`);
    return `**${role}** (${members.length}): ${members.join(', ') || '—'}`;
  });
  const unassigned = Object.entries(roster)
    .filter(([, r]) => !r)
    .map(([uid]) => `<@${uid}>`);
  if (unassigned.length) {
    lines.push(`**Unassigned** (${unassigned.length}): ${unassigned.join(', ')}`);
  }
  return new EmbedBuilder()
    .setTitle(`⛧ ${eventName} — Roster`)
    .setDescription(lines.join('\n') + `\n\n*${total} signed up — click to join, pick your role*`)
    .setColor(ZAMORAK_RED);
}

function rosterButtons(rosterId) {
  const row = new ActionRowBuilder();
  row.addComponents(
    new ButtonBuilder()
      .setCustomId(`roster:join:${rosterId}`)
      .setLabel('Join')
      .setStyle(ButtonStyle.Success)
      .setEmoji('✅')
  );
  for (const role of ROSTER_ROLES) {
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(`roster:role:${rosterId}:${role.toLowerCase()}`)
        .setLabel(role)
        .setStyle(ButtonStyle.Secondary)
    );
  }
  row.addComponents(
    new ButtonBuilder()
      .setCustomId(`roster:leave:${rosterId}`)
      .setLabel('Leave')
      .setStyle(ButtonStyle.Danger)
      .setEmoji('❌')
  );
  return [row];
}

async function postRoster(channel, eventName, eventId) {
  const rosterId = eventId || crypto.randomBytes(8).toString('hex');
  const roster = {};
  store.saveRoster(rosterId, { eventName, roster, channelId: channel.id, messageId: null });
  const msg = await channel.send({
    embeds: [rosterEmbed(eventName, roster)],
    components: rosterButtons(rosterId),
  });
  const data = store.getRoster(rosterId);
  data.messageId = msg.id;
  store.saveRoster(rosterId, data);
  return msg;
}

async function handleRosterButton(interaction) {
  // customId: roster:<action>:<rosterId>[:<role>]
  const parts = interaction.customId.split(':');
  const action = parts[1];
  const rosterId = parts[2];
  const role = parts[3];

  const data = store.getRoster(rosterId);
  if (!data) {
    await interaction.reply({ content: 'This roster has expired.', ephemeral: true });
    return;
  }

  const userId = interaction.user.id;
  if (action === 'join') {
    if (!data.roster[userId]) {
      data.roster[userId] = null;
      store.saveRoster(rosterId, data);
    }
  } else if (action === 'leave') {
    delete data.roster[userId];
    store.saveRoster(rosterId, data);
  } else if (action === 'role' && role) {
    const roleName = ROSTER_ROLES.find((r) => r.toLowerCase() === role);
    if (!roleName) {
      await interaction.reply({ content: 'Invalid role.', ephemeral: true });
      return;
    }
    if (!data.roster.hasOwnProperty(userId)) {
      data.roster[userId] = roleName;
    } else {
      data.roster[userId] = data.roster[userId] === roleName ? null : roleName;
    }
    store.saveRoster(rosterId, data);
  }

  await interaction.update({
    embeds: [rosterEmbed(data.eventName, data.roster)],
    components: rosterButtons(rosterId),
  });
}

async function rosterCommand(interaction) {
  const eventName = interaction.options.getString('event');
  // Embed title limit is 256 chars — "⛧ {name} — Roster" prefix takes ~12
  if (eventName.length > 200) {
    await interaction.reply({ content: 'Keep the event name under 200 characters.', ephemeral: true });
    return;
  }
  const channel = interaction.channel;
  await interaction.deferReply({ ephemeral: true });
  await postRoster(channel, eventName);
  await interaction.editReply(`Roster posted for **${eventName}**.`);
}

const commands = [
  {
    data: new SlashCommandBuilder()
      .setName('roster')
      .setDescription('Post an event signup roster (Manage Events only)')
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageEvents)
      .addStringOption((o) => o.setName('event').setDescription('Event name').setRequired(true)),
    run: rosterCommand,
  },
];

module.exports = { commands, handleRosterButton, postRoster };
