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

// Per-button ticket themes (Alex 2026-10-14 — every ticket themed to the button clicked)
const TICKET_TYPES = {
  report: { label: 'Report', emoji: '⚠️', intro: 'Tell staff what happened. Include names, dates, and any proof.' },
  inquiry: { label: 'Inquiry', emoji: '💬', intro: 'Ask your question below and staff will get back to you.' },
  claim: { label: 'Reward Claim', emoji: '🏆', intro: 'Tell staff what you won and which event it was from.' },
};

async function setupTickets(interaction) {
  await interaction.deferReply({ ephemeral: true });
  const t = config.tickets;
  const channel = interaction.guild.channels.cache.get(t.panelChannelId);
  if (!channel) {
    await interaction.editReply('Ticket panel channel not found. Check config.tickets.panelChannelId.');
    return;
  }
  const embed = new EmbedBuilder()
    .setTitle('⛧ Contact Staff ⛧')
    .setDescription(
      `**⚠️ Report**\n` +
      `⛧ Got something for staff to look into.\n\n` +
      `**💬 Inquiry**\n` +
      `⛧ Got a question.\n\n` +
      `**🏆 Claim Reward**\n` +
      `⛧ Won an event? Claim your reward here.\n\n` +
      `**⬆️ Become a Member**\n` +
      `⛧ Click the button and pick your account type to become an official member.\n\n` +
      `Click a button below to get started.`
    )
    .setColor(ZAMORAK_RED);

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('ticket:create:report')
      .setLabel('Report')
      .setStyle(ButtonStyle.Danger)
      .setEmoji('⚠️'),
    new ButtonBuilder()
      .setCustomId('ticket:create:inquiry')
      .setLabel('Inquiry')
      .setStyle(ButtonStyle.Danger)
      .setEmoji('💬'),
    new ButtonBuilder()
      .setCustomId('ticket:create:claim')
      .setLabel('Claim Reward')
      .setStyle(ButtonStyle.Danger)
      .setEmoji('🏆'),
    new ButtonBuilder()
      .setCustomId('ticket:create:member')
      .setLabel('Become a Member')
      .setStyle(ButtonStyle.Danger)
      .setEmoji('⬆️')
  );
  await channel.send({ embeds: [embed], components: [row] });
  await interaction.editReply(`Ticket panel posted in ${channel}.`);
}

async function createTicket(interaction, ticketType) {
  const t = config.tickets;
  const theme = TICKET_TYPES[ticketType] || TICKET_TYPES.inquiry;

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
    // Create a private thread (like the other clan) — named for the ticket type
    thread = await ticketsChannel.threads.create({
      name: `${theme.label} — ${safeName}`.slice(0, 100),
      type: ChannelType.PrivateThread,
      reason: `${theme.label} ticket opened by ${interaction.user.tag}`,
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

  const embed = new EmbedBuilder()
    .setTitle(`${theme.emoji} ${theme.label}`)
    .setDescription(theme.intro + (theme.noCloser ? '' : '\n\nStaff will be with you shortly.'))
    .setColor(t.color ?? 0x5865f2);

  const closeRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('ticket:close')
      .setLabel('Close Ticket')
      .setStyle(ButtonStyle.Danger)
      .setEmoji('🔒')
  );
  await thread.send({
    // Only tag Staff on tickets (Alex 2026-10-14) — quiet until launch (no notify, just the visible mention).
    // Flip allowedMentions to include roles for legit pings at launch.
    content: `${interaction.user} <@&1558735997922054225>`.trim(),
    embeds: [embed],
    components: [closeRow],
    allowedMentions: { users: [interaction.user.id] },
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
  if (!isStaff(interaction)) {
    await interaction.reply({ content: 'Only staff can close tickets.', ephemeral: true });
    return;
  }

  await interaction.reply({ content: 'Closing ticket…', ephemeral: true });

  store.removeTicket(interaction.guildId, ownerId);
  // Archive and lock the thread instead of deleting (like the reference)
  try {
    await thread.send('Staff has closed this ticket. Don\'t be afraid to reach out if you need anything else.').catch(() => {});
    await thread.setLocked(true);
    await thread.setArchived(true);
    await interaction.followUp({ content: 'Ticket closed.', ephemeral: true }).catch(() => {});
  } catch (err) {
    await interaction.followUp({ content: 'Could not archive the thread: ' + (err.message || err), ephemeral: true }).catch(() => {});
  }
}

async function handleTicketButton(interaction) {
  const parts = interaction.customId.split(':');
  const action = parts[1];
  if (action === 'create') {
    const ticketType = parts[2] || 'inquiry';
    // Become a Member is direct promotion, not a ticket (Alex 2026-10-14)
    if (ticketType === 'member') return showMemberSelect(interaction);
    return createTicket(interaction, ticketType);
  }
  if (action === 'close') return closeTicket(interaction);
}

// Become a Member: guest picks iron/main, bot promotes instantly (Alex 2026-10-14)
async function showMemberSelect(interaction) {
  const types = config.recruit?.types || {};
  const member = interaction.member;
  const memberRoleIds = [types.iron?.roleId, types.main?.roleId].filter(Boolean);
  if (member.roles.cache.some((r) => memberRoleIds.includes(r.id))) {
    await interaction.reply({ content: 'You are already a member of the clan.', ephemeral: true }).catch(() => {});
    return;
  }
  if (types.guest?.roleId && !member.roles.cache.has(types.guest.roleId)) {
    await interaction.reply({ content: 'This is for guests looking to join. Apply first if you have not.', ephemeral: true }).catch(() => {});
    return;
  }
  const menu = new StringSelectMenuBuilder()
    .setCustomId('member:select')
    .setPlaceholder('I play an…')
    .addOptions([
      { label: 'Ironman', value: 'iron', emoji: '1558623401302564996' },
      { label: 'Main', value: 'main', emoji: '1558623453438025828' },
    ]);
  await interaction.reply({
    content: 'Pick your account type.',
    components: [new ActionRowBuilder().addComponents(menu)],
    ephemeral: true,
  }).catch(() => {});
}

async function handleMemberSelect(interaction) {
  if (interaction.customId !== 'member:select') return;
  const choice = interaction.values[0]; // 'iron' or 'main'
  const types = config.recruit?.types || {};
  const t = types[choice];
  if (!t || !t.roleId) {
    await interaction.reply({ content: 'Something went wrong.', ephemeral: true }).catch(() => {});
    return;
  }
  const member = interaction.member;
  const guild = interaction.guild;
  await interaction.deferReply({ ephemeral: true });

  // Swap Guest for the member role + Initiate
  if (types.guest?.roleId && member.roles.cache.has(types.guest.roleId)) {
    await member.roles.remove(types.guest.roleId, 'Guest to member promotion').catch(() => {});
  }
  await member.roles.add(t.roleId, 'Guest to member promotion').catch(() => {});
  const entry = (config.seniorityRanks || []).find((r) => r.minMonths === 0);
  if (entry) await member.roles.add(entry.roleId, 'New member tenure rank').catch(() => {});

  // Initiate welcome in #general, same as an approval
  const generalChan = guild.channels.cache.get('1558583385440395476');
  if (generalChan) {
    const welcomeMsg =
      `⛧ <@&1558452023790276659> ⛧\n` +
      `⛧ ━━━━━━━━━━━━━━━━━━━━━━━━ ⛧\n` +
      `<@${member.id}> has joined Oath Forsaken.\n\n` +
      `Welcome to Oath Forsaken! Glad you're here. Take a look around and make yourself at home.\n\n` +
      `• Drop an intro in <#1558428255940378715> so we can get to meet you\n` +
      `• Grab your roles in <#1558399101454786670>\n` +
      `• Ping <@&1558735997922054225> when you're ready for a clan chat invite`;
    await generalChan.send({ content: welcomeMsg, allowedMentions: { parse: ['users'] } }).catch(() => {});
  }

  await interaction.editReply({ content: `Welcome aboard! You joined as ${t.label}. Staff will meet you in-game to add you to the clan chat.` }).catch(() => {});
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
      .setDescription('Close this ticket (staff only)'),
    run: closeTicket,
  },
];

module.exports = { commands, handleTicketButton, handleMemberSelect };
