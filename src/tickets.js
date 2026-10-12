// Ticket system: /setup-tickets posts an "Open a Ticket" panel.
// Clicking it creates a private channel (user + staff only) with a Close button.
// Closing posts a transcript to the log channel and deletes the ticket channel.
const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  EmbedBuilder,
  PermissionFlagsBits,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
} = require('discord.js');
const config = require('./config');
const store = require('./store');

async function setupTickets(interaction) {
  await interaction.deferReply({ ephemeral: true });
  const t = config.tickets;
  const channel = interaction.guild.channels.cache.get(t.panelChannelId);
  if (!channel) {
    await interaction.editReply('Ticket panel channel not found. Check config.tickets.panelChannelId.');
    return;
  }
  const embed = new EmbedBuilder()
    .setTitle(t.title)
    .setDescription(t.description)
    .setColor(t.color ?? 0x5865f2);
  if (t.banner) embed.setImage(t.banner);
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('ticket:create')
      .setLabel(t.buttonLabel || 'Open a Ticket')
      .setStyle(ButtonStyle.Primary)
      .setEmoji('🎫')
  );
  await channel.send({ embeds: [embed], components: [row] });
  await interaction.editReply(`Ticket panel posted in ${channel}.`);
}

async function createTicket(interaction) {
  const t = config.tickets;

  const existingId = store.getTicket(interaction.guildId, interaction.user.id);
  if (existingId) {
    // Check if it's a thread that still exists
    const existing = interaction.guild.channels.cache.get(existingId);
    if (existing) {
      await interaction.reply({ content: `You already have an open ticket: ${existing}`, ephemeral: true });
      return;
    }
    // Also check threads
    try {
      const thread = await interaction.guild.channels.fetch(existingId).catch(() => null);
      if (thread) {
        await interaction.reply({ content: `You already have an open ticket: ${thread}`, ephemeral: true });
        return;
      }
    } catch {}
    store.removeTicket(interaction.guildId, interaction.user.id); // stale record
  }

  await interaction.deferReply({ ephemeral: true });

  // Get the tickets channel (where threads will be created)
  const ticketsChannel = interaction.guild.channels.cache.get(t.panelChannelId);
  if (!ticketsChannel) {
    await interaction.editReply('Tickets channel not found. Tell staff.');
    return;
  }

  const safeName = interaction.user.username.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 20) || 'user';
  let thread;
  try {
    // Create a private thread (like Raven's Watch)
    thread = await ticketsChannel.threads.create({
      name: `Ticket with ${safeName}`,
      type: ChannelType.PrivateThread,
      reason: `Ticket opened by ${interaction.user.tag}`,
    });
    // Add the user and staff to the thread
    await thread.members.add(interaction.user.id).catch(() => {});
    for (const roleId of t.staffRoleIds || []) {
      const role = interaction.guild.roles.cache.get(roleId);
      if (role) {
        for (const [, member] of role.members) {
          await thread.members.add(member.id).catch(() => {});
        }
      }
    }
  } catch (err) {
    await interaction.editReply('Could not create the ticket thread. Make sure I have the **Create Private Threads** permission.');
    return;
  }

  store.setTicket(interaction.guildId, interaction.user.id, thread.id);

  const staffPings = (t.staffRoleIds || []).map((r) => `<@&${r}>`).join(' ');
  const embed = new EmbedBuilder()
    .setTitle('Ticket opened')
    .setDescription((t.introMessage || 'Staff will be with you shortly.') + '\n\nPick a category below so staff knows what this is about.')
    .setColor(t.color ?? 0x5865f2);

  const categoryRow = new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId('ticket:category')
      .setPlaceholder('What is this about?')
      .addOptions([
        { label: 'General Query', value: 'general', emoji: '💬' },
        { label: 'Report a Member', value: 'report', emoji: '🚨' },
        { label: 'Bot/Plugin Help', value: 'bothelp', emoji: '🔧' },
      ])
  );

  const closeRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('ticket:close')
      .setLabel('Close Ticket')
      .setStyle(ButtonStyle.Danger)
      .setEmoji('🔒')
  );
  await thread.send({
    content: `${interaction.user} ${staffPings}`.trim(),
    embeds: [embed],
    components: [categoryRow, closeRow],
  });

  await interaction.editReply(`Ticket created: ${thread}`);
}

function isStaff(interaction) {
  const staffIds = config.tickets.staffRoleIds || [];
  return (
    interaction.member.roles.cache.some((r) => staffIds.includes(r.id)) ||
    interaction.memberPermissions.has(PermissionFlagsBits.Administrator)
  );
}

async function closeTicket(interaction) {
  const thread = interaction.channel;
  const ownerId = store.getTicketOwner(interaction.guildId, thread.id);

  if (!ownerId) {
    await interaction.reply({ content: 'This only works inside a ticket thread.', ephemeral: true });
    return;
  }
  if (interaction.user.id !== ownerId && !isStaff(interaction)) {
    await interaction.reply({ content: 'Only staff or the ticket owner can close this.', ephemeral: true });
    return;
  }

  await interaction.reply({ content: 'Closing ticket…', ephemeral: true });

  store.removeTicket(interaction.guildId, ownerId);
  // Archive and lock the thread instead of deleting (like RW)
  setTimeout(() => {
    thread.setArchived(true).catch(() => {});
    thread.setLocked(true).catch(() => {});
  }, 3000);
}

async function handleTicketButton(interaction) {
  const [, action] = interaction.customId.split(':');
  if (action === 'create') return createTicket(interaction);
  if (action === 'close') return closeTicket(interaction);
}

async function handleTicketSelect(interaction) {
  if (interaction.customId !== 'ticket:category') return;
  const category = interaction.values[0];
  const labels = {
    general: 'General Query',
    report: 'Report a Member',
    bothelp: 'Bot/Plugin Help',
  };
  const label = labels[category] || category;

  // Rename the thread to include the category
  const thread = interaction.channel;
  if (thread && thread.isThread()) {
    const base = thread.name.replace(/ \[(General Query|Report a Member|Bot\/Plugin Help)\]$/, '');
    await thread.setName(`${base} [${label}]`.slice(0, 100)).catch(() => {});
  }

  await interaction.reply({ content: `Category set to **${label}**. Staff will be with you shortly.`, ephemeral: true }).catch(() => {});
}

const commands = [
  {
    data: new SlashCommandBuilder()
      .setName('setup-tickets')
      .setDescription('Post the ticket panel (Admin only)')
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
    run: setupTickets,
  },
  {
    data: new SlashCommandBuilder()
      .setName('close')
      .setDescription('Close this ticket (staff or ticket owner)'),
    run: closeTicket,
  },
];

module.exports = { commands, handleTicketButton, handleTicketSelect };
