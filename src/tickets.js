// Ticket system: /setup-tickets posts an "Open a Ticket" panel.
// Clicking it creates a private channel (user + staff only) with a Close button.
// Closing archives and locks the thread (staff-only).
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
const { isStaff, buildInitiateWelcome, safeFetch, ZAMORAK_RED } = require('./utils');
const { postOrEdit } = require('./panel-store');

// Per-button ticket themes (every ticket themed to the button clicked)
const TICKET_TYPES = {
  report: { label: 'Report', emoji: '⚠️', intro: 'Tell staff what happened. Include names, dates, and any proof.' },
  inquiry: { label: 'Inquiry', emoji: '💬', intro: 'Ask your question below.' },
  claim: { label: 'Reward Claim', emoji: '🏆', intro: 'Tell staff what you won and which event it was from.' },
};

async function setupTickets(interaction) {
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
    await interaction.reply({ content: 'You do not have permission to use this command.', ephemeral: true }).catch((e) => console.error("[tickets.js] Non-fatal error:", e.message));
    return;
  }
  await interaction.deferReply({ ephemeral: true });
  const t = config.tickets;
  const channel = interaction.guild.channels.cache.get(t.panelChannelId);
  if (!channel) {
    await interaction.editReply('Ticket panel channel not found. Tell staff.');
    return;
  }
  const embed = new EmbedBuilder()
    .setTitle('⛧ Contact Staff ⛧')
    .setDescription(
      `**⚠️ Report**\n` +
      `⛧ See something wrong in the server? Tell staff here.\n\n` +
      `**💬 Inquiry**\n` +
      `⛧ Got a question? Ask it here.\n\n` +
      `**🏆 Claim Reward**\n` +
      `⛧ Won an event? Claim your reward here.\n\n` +
      `**⬆️ Become a Member**\n` +
      `⛧ Currently a guest? Press the button and pick your account type to become a member.\n\n` +
      `Press a button below to get started.`
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
  await postOrEdit(channel, 'tickets', { embeds: [embed], components: [row] });
  await interaction.editReply(`Ticket panel posted/refreshed in ${channel}.`);
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
      const thread = await safeFetch(interaction.guild.channels.fetch(existingId), 'ticket channel fetch');
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
    // Create a private thread — named for the ticket type.
    // Append user ID suffix to avoid collisions (two "johndoe"s).
    const threadName = `${theme.label} - ${safeName}-${interaction.user.id.slice(-4)}`.slice(0, 100);
    thread = await ticketsChannel.threads.create({
      name: threadName,
      type: ChannelType.PrivateThread,
      reason: `${theme.label} ticket opened by ${interaction.user.tag}`,
    });
    // Add the ticket creator to the thread (staff see it via the role ping)
    await thread.members.add(interaction.user.id).catch((e) => console.error("[tickets.js] Non-fatal error:", e.message));
  } catch (err) {
    await interaction.editReply('Could not create the ticket thread. Make sure I have the **Create Private Threads** permission.');
    return;
  }

  store.setTicket(interaction.guildId, interaction.user.id, thread.id);

  const embed = new EmbedBuilder()
    .setTitle(`${theme.emoji} ${theme.label}`)
    .setDescription(theme.intro + (theme.noCloser ? '' : '\n\nStaff will be with you shortly.'))
    .setColor(t.color ?? ZAMORAK_RED);

  const closeRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('ticket:close')
      .setLabel('Close Ticket')
      .setStyle(ButtonStyle.Danger)
      .setEmoji('🔒')
  );
  await thread.send({
    // Staff are tagged on new tickets and the role ping notifies for real (live since launch).
    content: `${interaction.user} <@&${config.tickets.staffRoleIds[0]}>`.trim(),
    embeds: [embed],
    components: [closeRow],
    allowedMentions: { users: [interaction.user.id], roles: [config.tickets.staffRoleIds[0]] },
  });

  await interaction.editReply(`Ticket created: ${thread}`);
}

// isStaff imported from utils.js

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
  // Archive and lock the thread instead of deleting
  try {
    await thread.send('Staff has closed this ticket.').catch((e) => console.error("[tickets.js] Non-fatal error:", e.message));
    await thread.setLocked(true);
    await thread.setArchived(true);
    await interaction.followUp({ content: 'Ticket closed.', ephemeral: true }).catch((e) => console.error("[tickets.js] Non-fatal error:", e.message));
  } catch (err) {
    await interaction.followUp({ content: 'Could not archive the thread: ' + (err.message || err), ephemeral: true }).catch((e) => console.error("[tickets.js] Non-fatal error:", e.message));
  }
}

async function handleTicketButton(interaction) {
  const parts = interaction.customId.split(':');
  const action = parts[1];
  if (action === 'create') {
    const ticketType = parts[2] || 'inquiry';
    // Become a Member is direct promotion, not a ticket
    if (ticketType === 'member') return showMemberSelect(interaction);
    return createTicket(interaction, ticketType);
  }
  if (action === 'close') return closeTicket(interaction);
}

// Become a Member: guest picks iron/main, bot promotes instantly
async function showMemberSelect(interaction) {
  const types = config.recruit?.types || {};
  const member = interaction.member;
  if (!types.guest?.roleId) {
    await interaction.reply({ content: 'The guest role is not set up. Tell staff.', ephemeral: true }).catch((e) => console.error("[tickets.js] Non-fatal error:", e.message));
    return;
  }
  const memberRoleIds = [types.iron?.roleId, types.main?.roleId].filter(Boolean);
  if (member.roles.cache.some((r) => memberRoleIds.includes(r.id))) {
    await interaction.reply({ content: 'You are already a member of the clan.', ephemeral: true }).catch((e) => console.error("[tickets.js] Non-fatal error:", e.message));
    return;
  }
  if (types.guest?.roleId && !member.roles.cache.has(types.guest.roleId)) {
    await interaction.reply({ content: 'This is for guests looking to join. Apply first if you have not.', ephemeral: true }).catch((e) => console.error("[tickets.js] Non-fatal error:", e.message));
    return;
  }
  const menu = new StringSelectMenuBuilder()
    .setCustomId('member:select')
    .setPlaceholder('Pick your account type')
    .addOptions([
      { label: 'Ironman', value: 'iron', emoji: config.recruit?.ironEmojiId },
      { label: 'Main', value: 'main', emoji: config.recruit?.mainEmojiId },
    ]);
  await interaction.reply({
    content: 'Pick your account type.',
    components: [new ActionRowBuilder().addComponents(menu)],
    ephemeral: true,
  }).catch((e) => console.error("[tickets.js] Non-fatal error:", e.message));
}

async function handleMemberSelect(interaction) {
  if (interaction.customId !== 'member:select') return;
  const choice = interaction.values[0]; // 'iron' or 'main'
  const types = config.recruit?.types || {};
  const t = types[choice];
  if (!t || !t.roleId) {
    await interaction.reply({ content: 'Something went wrong. Try again.', ephemeral: true }).catch((e) => console.error("[tickets.js] Non-fatal error:", e.message));
    return;
  }
  const member = interaction.member;
  if (!types.guest?.roleId) {
    await interaction.reply({ content: 'The guest role is not set up. Tell staff.', ephemeral: true }).catch((e) => console.error("[tickets.js] Non-fatal error:", e.message));
    return;
  }
  // Re-verify guest status: they may have been approved via normal application
  // between opening the menu and picking. Prevents double promotion.
  const memberRoleIds = [types.iron?.roleId, types.main?.roleId].filter(Boolean);
  if (member.roles.cache.some((r) => memberRoleIds.includes(r.id))) {
    await interaction.reply({ content: 'You are already a member of the clan.', ephemeral: true }).catch((e) => console.error("[tickets.js] Non-fatal error:", e.message));
    return;
  }
  if (types.guest?.roleId && !member.roles.cache.has(types.guest.roleId)) {
    await interaction.reply({ content: 'This is for guests looking to join. Apply first if you have not.', ephemeral: true }).catch((e) => console.error("[tickets.js] Non-fatal error:", e.message));
    return;
  }
  // Verify the role still exists (config could have changed since the menu was shown)
  const role = interaction.guild.roles.cache.get(t.roleId);
  if (!role) {
    await interaction.reply({ content: 'That member role no longer exists. Tell staff.', ephemeral: true }).catch((e) => console.error("[tickets.js] Non-fatal error:", e.message));
    return;
  }
  const guild = interaction.guild;

  // RSN confirm (ruling Nov 20, 2026): the guest application already
  // collected their RSN and staff approved it, so show the name on
  // file and let them confirm it is still theirs before anything
  // changes. No name on file (staff handed them the Guest role
  // directly) skips the step and promotes the way it always has.
  const answers = store.getApplicationAnswers(guild.id, member.id);
  const rsnOnFile = answers && answers.rsn ? String(answers.rsn).trim() : '';
  if (rsnOnFile) {
    pendingMemberPicks.set(member.id, { choice, at: Date.now() });
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('member:confirm').setLabel('Yes, that is my name').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId('member:wrongname').setLabel('Not my name').setStyle(ButtonStyle.Secondary),
    );
    await interaction.update({
      content: `Joining as ${t.label}. Your RSN on file is **${rsnOnFile}**. Is that still your name?`,
      components: [row],
    }).catch((e) => console.error("[tickets.js] Non-fatal error:", e.message));
    return;
  }

  await interaction.deferReply({ ephemeral: true });
  await executePromotion(interaction, choice);
}

// Staged Become a Member picks waiting on the RSN confirm tap.
// userId -> { choice, at }
const pendingMemberPicks = new Map();
const MEMBER_PICK_TTL_MS = 10 * 60 * 1000;

async function handleMemberConfirm(interaction) {
  const action = interaction.customId.split(':')[1];
  const userId = interaction.user.id;
  if (action === 'wrongname') {
    pendingMemberPicks.delete(userId);
    await interaction.update({
      content: `No problem, nothing changed. Update your name with the Link RSN steps in <#${config.channels?.botGuide || '1561976856780210186'}>, or ask staff to fix it, then tap Become a Member again.`,
      components: [],
    }).catch((e) => console.error("[tickets.js] Non-fatal error:", e.message));
    return;
  }
  if (action !== 'confirm') return;
  const staged = pendingMemberPicks.get(userId);
  if (!staged || Date.now() - staged.at > MEMBER_PICK_TTL_MS) {
    pendingMemberPicks.delete(userId);
    await interaction.update({ content: 'That pick timed out. Press Become a Member and pick again.', components: [] }).catch((e) => console.error("[tickets.js] Non-fatal error:", e.message));
    return;
  }
  pendingMemberPicks.delete(userId);
  // Re-verify before executing: roles may have changed since the pick.
  const types = config.recruit?.types || {};
  const member = interaction.member;
  const memberRoleIds = [types.iron?.roleId, types.main?.roleId].filter(Boolean);
  if (member.roles.cache.some((r) => memberRoleIds.includes(r.id))) {
    await interaction.update({ content: 'You are already a member of the clan.', components: [] }).catch((e) => console.error("[tickets.js] Non-fatal error:", e.message));
    return;
  }
  if (types.guest?.roleId && !member.roles.cache.has(types.guest.roleId)) {
    await interaction.update({ content: 'This is for guests looking to join. Apply first if you have not.', components: [] }).catch((e) => console.error("[tickets.js] Non-fatal error:", e.message));
    return;
  }
  const t = types[staged.choice];
  if (!t || !t.roleId || !interaction.guild.roles.cache.get(t.roleId)) {
    await interaction.update({ content: 'Something went wrong. Try again.', components: [] }).catch((e) => console.error("[tickets.js] Non-fatal error:", e.message));
    return;
  }
  await interaction.deferUpdate();
  await executePromotion(interaction, staged.choice);
}

// The promotion itself. The interaction is already deferred (reply or
// update) by whichever path got here.
async function executePromotion(interaction, choice) {
  const types = config.recruit?.types || {};
  const t = types[choice];
  const member = interaction.member;
  const guild = interaction.guild;

  // Swap Guest for the member role + Initiate
  if (types.guest?.roleId && member.roles.cache.has(types.guest.roleId)) {
    await member.roles.remove(types.guest.roleId, 'Guest to member promotion').catch((e) => console.error("[tickets.js] Non-fatal error:", e.message));
  }
  await member.roles.add(t.roleId, 'Guest to member promotion').catch((e) => console.error("[tickets.js] Non-fatal error:", e.message));
  const entry = (config.seniorityRanks || []).find((r) => r.minMonths === 0);
  if (entry) await member.roles.add(entry.roleId, 'New member tenure rank').catch((e) => console.error("[tickets.js] Non-fatal error:", e.message));

  // Record the promotion as membership (ruling Nov 20, 2026): an
  // approval writes this record, and the seniority sync, the website
  // roster, and the staff reports read it. Without it a promoted
  // member still read as a guest everywhere outside Discord. No
  // badge is recorded from the pick - the comp roster keeps typing
  // them from Wise Old Man, same as before.
  try {
    store.setMembershipStanding(guild.id, member.id, 'member', 'promotion');
  } catch (e) {
    console.error('[tickets.js] Membership record failed:', e.message);
  }
  try {
    require('./comp-roster').scheduleRefresh(guild);
  } catch (e) {
    console.error('[tickets.js] Comp roster refresh failed:', e.message);
  }

  // Initiate welcome in #general, same as an approval
  const generalChan = guild.channels.cache.get(config.recruit?.generalChannelId || config.channels?.general);
  if (generalChan) {
    const welcomeMsg = buildInitiateWelcome(member.id);
    await generalChan.send({ content: welcomeMsg, allowedMentions: { parse: ['users'] } }).catch((e) => console.error("[tickets.js] Non-fatal error:", e.message));
  }

  await interaction.editReply({ content: `Welcome aboard! You joined as ${t.label}. Staff will meet you in-game to add you to the clan chat.`, components: [] }).catch((e) => console.error("[tickets.js] Non-fatal error:", e.message));
}

const commands = [
  {
    data: new SlashCommandBuilder()
      .setName('setup-tickets')
      .setDescription('Post the ticket panel (Admin only)')
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
    run: setupTickets,
  },
];

module.exports = { commands, handleTicketButton, handleMemberSelect, handleMemberConfirm };
