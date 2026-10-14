// Recruitment applications — three types: ironman, main, guest.
// On member join: opens a private application channel with three buttons.
// All applicants answer the Discord age question, then fill a modal.
// Submit -> the bot opens a forum post in the applications forum titled
// "<Type> App from <username>" with the answers, so staff can discuss in the
// thread. Approve / Deny buttons live on the post's starter message.
// Approve assigns the right member role (Iron Sworn/Unbound/Guest) + Initiate
// seniority, renames the post to "... - Approved", and locks it.
const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  EmbedBuilder,
  ModalBuilder,
  PermissionFlagsBits,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
} = require('discord.js');
const config = require('./config');
const store = require('./store');

const DAY_MS = 24 * 3600 * 1000;
const ZAMORAK_RED = 0x6b0e0e;

function accountAgeDays(user) {
  return Math.floor((Date.now() - user.createdAt.getTime()) / DAY_MS);
}

function appTypes() {
  return config.recruit?.types || {};
}

async function onMemberJoin(member) {
  // No longer creates a private channel (2026-10-11).
  // Users apply via the #apply-here channel or /apply command.
  return;
}

// Posts the 3-button application panel to a channel.
// Used by /setup-applications and for the #apply-here channel.
async function postApplicationPanel(channel) {
  const types = appTypes();
  const guild = channel.guild;

  const embed = new EmbedBuilder()
    .setTitle('📝 Clan Application')
    .setDescription(
      `To join **${guild.name}**, pick the application that fits you.\n\n` +
        `**Ironman** — you play an ironman.\n` +
        `**Main** — you play a main.\n` +
        `**Guest** — you're just visiting or here for a friend.\n\n` +
        `Staff review every application.`
    )
    .setColor(ZAMORAK_RED);

  const row = new ActionRowBuilder();
  for (const [key, t] of Object.entries(types)) {
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(`apply:type:${key}`)
        .setLabel(t.buttonLabel || t.label)
        .setStyle(ButtonStyle.Primary)
        .setEmoji(t.emoji || '📝')
    );
  }
  await channel.send({ embeds: [embed], components: [row] }).catch(() => {});
}

async function setupApplications(interaction) {
  await interaction.deferReply({ ephemeral: true });
  const channel = interaction.channel;
  await postApplicationPanel(channel);
  await interaction.editReply(`Application panel posted in ${channel}.`);
}

async function applyCommand(interaction) {
  const types = appTypes();
  const embed = new EmbedBuilder()
    .setTitle('📝 Clan Application')
    .setDescription(
      `Pick the application that fits you.\n\n` +
        `**Ironman** — you play an ironman.\n` +
        `**Main** — you play a main.\n` +
        `**Guest** — just visiting or here for a friend.`
    )
    .setColor(ZAMORAK_RED);

  const row = new ActionRowBuilder();
  for (const [key, t] of Object.entries(types)) {
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(`apply:type:${key}`)
        .setLabel(t.buttonLabel || t.label)
        .setStyle(ButtonStyle.Primary)
        .setEmoji(t.emoji || '📝')
    );
  }
  await interaction.reply({ embeds: [embed], components: [row], ephemeral: true });
}

// All applicants answer the Discord age question via Yes/No dropdown first.
async function showAgeSelect(interaction, type) {
  const menu = new StringSelectMenuBuilder()
    .setCustomId(`apply:age:${type}`)
    .setPlaceholder('Is your Discord account at least 1 month old?')
    .addOptions([
      { label: 'Yes', value: 'yes', emoji: '✅' },
      { label: 'No', value: 'no', emoji: '✖️' },
    ]);
  const row = new ActionRowBuilder().addComponents(menu);
  await interaction.reply({
    content: 'One quick question first.',
    components: [row],
    ephemeral: true,
  });
}

async function showApplicationModal(interaction, type, totalBracket, ageAnswer) {
  const types = appTypes();
  const t = types[type];
  if (!t) return;
  // customId: apply:modal:<type>:<bracket|none>:<age|none>  (keep under 100 chars)
  const modal = new ModalBuilder()
    .setCustomId(`apply:modal:${type}:${totalBracket || 'none'}:${ageAnswer || 'none'}`)
    .setTitle(`${t.label} Application`);
  for (const q of t.questions || []) {
    // Skip the age question — answered via dropdown
    if (q.id === 'age') continue;
    modal.addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId(q.id)
          .setLabel(q.label)
          .setStyle(q.style === 'paragraph' ? TextInputStyle.Paragraph : TextInputStyle.Short)
          .setRequired(!!q.required)
          .setMaxLength(q.style === 'paragraph' ? 500 : 100)
      )
    );
  }
  await interaction.showModal(modal);
}

async function handleModalSubmit(interaction) {
  // customId: apply:modal:<type>:<bracket|none>:<age|none> OR apply:denyreasonmodal:<userId>:<type>:<bracket>
  const parts = interaction.customId.split(':');
  if (parts[0] !== 'apply') return;

  // Deny-with-reason modal from staff
  if (parts[1] === 'denyreasonmodal') {
    return handleDenyReasonSubmit(interaction);
  }

  if (parts[1] !== 'modal') return;

  // Prevent multiple submissions
  if (store.isApplicationSubmitted(interaction.guildId, interaction.user.id)) {
    await interaction.reply({ content: 'You already have an application submitted. Staff will review it soon.', ephemeral: true }).catch(() => {});
    return;
  }

  const [, , type, bracket, ageVal] = parts;
  const types = appTypes();
  const t = types[type];
  if (!t) return;

  const answers = {};
  for (const q of t.questions || []) {
    if (q.id === 'age') continue; // answered via dropdown
    answers[q.id] = interaction.fields.getTextInputValue(q.id);
  }
  // Add the age dropdown answer
  if (ageVal && ageVal !== 'none') {
    answers['age'] = ageVal === 'yes' ? 'Yes' : 'No';
  }

  await interaction.deferReply({ ephemeral: true });

  const rc = config.recruit;
  const ageDays = accountAgeDays(interaction.user);
  const ageOk = ageDays >= (rc.minAccountAgeDays || 30);
  const forum = interaction.guild.channels.cache.get(rc.applicationsChannelId);
  if (!forum || forum.type !== ChannelType.GuildForum) {
    await interaction.editReply('Applications forum is not set up — tell staff.');
    return;
  }

  const lines = [`**Application type:** ${t.label}`];
  for (const q of t.questions || []) {
    lines.push(`**${q.label}:** ${answers[q.id]}`);
  }
  const embed = new EmbedBuilder()
    .setTitle(`Application — ${interaction.user.tag}`)
    .setDescription(lines.join('\n'))
    .addFields(
      {
        name: 'User',
        value: `<@${interaction.user.id}> (${interaction.user.tag})`,
      },
      {
        name: 'Account age',
        value: ageOk ? `✅ ${ageDays} days (meets ${rc.minAccountAgeDays}-day minimum)` : `⚠️ **${ageDays} days** — under the ${rc.minAccountAgeDays}-day minimum`,
      }
    )
    .setColor(ageOk ? ZAMORAK_RED : 0xffa500)
    .setTimestamp();

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`apply:approve:${interaction.user.id}:${type}:${bracket || 'none'}`).setLabel('Accept').setStyle(ButtonStyle.Success).setEmoji('✅'),
    new ButtonBuilder().setCustomId(`apply:denyreason:${interaction.user.id}:${type}:${bracket || 'none'}`).setLabel('Deny with Reason').setStyle(ButtonStyle.Secondary).setEmoji('📝'),
    new ButtonBuilder().setCustomId(`apply:deny:${interaction.user.id}:${type}:${bracket || 'none'}`).setLabel('Deny').setStyle(ButtonStyle.Danger).setEmoji('✖️')
  );

  const postName = `${t.label} App from ${interaction.user.username}`;
  const thread = await forum.threads
    .create({
      name: postName.slice(0, 100),
      message: { embeds: [embed], components: [row] },
      reason: `Application from ${interaction.user.tag}`,
    })
    .catch(() => null);

  if (thread) {
    // Staff ping on new applications — quiet until launch (Gavin 2026-10-14).
    // The mention renders but doesn't notify; flip allowedMentions to ping for real at launch.
    await thread.send({
      content: `<@&1558735997922054225> New ${t.label} application from ${interaction.user}.`,
      allowedMentions: { users: [interaction.user.id] },
    }).catch(() => {});
    await interaction.editReply('Application submitted! Staff will review it soon.');
  } else {
    await interaction.editReply('Could not open your application thread — tell staff.');
  }

  // Save answers so approval can auto-set the nickname ("Nickname [RSN]")
  store.setApplicationAnswers(interaction.guildId, interaction.user.id, answers);
  // Mark this channel as submitted so it isn't reused
  store.setApplicationSubmitted(interaction.guildId, interaction.user.id);
}

function isStaff(interaction) {
  const staffIds = config.tickets.staffRoleIds || [];
  return (
    interaction.member.roles.cache.some((r) => staffIds.includes(r.id)) ||
    interaction.memberPermissions.has(PermissionFlagsBits.Administrator)
  );
}

async function handleDenyReasonPrompt(interaction) {
  // customId: apply:denyreason:<userId>:<type>:<bracket>
  const [, , userId, type, bracket] = interaction.customId.split(':');
  if (!isStaff(interaction)) {
    await interaction.reply({ content: 'Staff only.', ephemeral: true });
    return;
  }
  const modal = new ModalBuilder()
    .setCustomId(`apply:denyreasonmodal:${userId}:${type}:${bracket || 'none'}`)
    .setTitle('Deny with Reason');
  modal.addComponents(
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('reason')
        .setLabel('Reason for denial')
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(true)
        .setMaxLength(500)
    )
  );
  await interaction.showModal(modal);
}

async function handleDenyReasonSubmit(interaction) {
  // customId: apply:denyreasonmodal:<userId>:<type>:<bracket>
  const [, , userId, type, bracket] = interaction.customId.split(':');
  if (!isStaff(interaction)) {
    await interaction.reply({ content: 'Staff only.', ephemeral: true });
    return;
  }
  const reason = interaction.fields.getTextInputValue('reason');
  // Reuse handleDecision by faking a deny interaction customId, then add reason
  await interaction.deferReply({ ephemeral: true });
  const guild = interaction.guild;
  const target = await guild.members.fetch(userId).catch(() => null);
  const thread = interaction.channel;
  const types = appTypes();
  const t = types[type] || {};

  if (thread && thread.isThread()) {
    const base = thread.name.replace(/ - (Approved|Denied)$/, '');
    await thread.setName(`${base} - Denied`.slice(0, 100)).catch(() => {});
    try {
      const starter = await thread.fetchStarterMessage().catch(() => null);
      if (starter && starter.embeds.length > 0) {
        const orig = starter.embeds[0];
        const updated = EmbedBuilder.from(orig).addFields(
          { name: 'Denied', value: `by ${interaction.user.tag}` },
          { name: 'Reason', value: reason }
        );
        await starter.edit({ embeds: [updated], components: [] }).catch(() => {});
      }
    } catch {}
    await thread.setLocked(true).catch(() => {});
    await thread.setArchived(true).catch(() => {});
  }

  // DM the applicant with the reason
  if (target) {
    await target.send(`Your **${t.label || type}** application to **${guild.name}** was denied.\n\nReason: ${reason}`).catch(() => {});
  }

  await interaction.editReply(`Denied <@${userId}> with reason.`);
}

async function handleDecision(interaction) {
  // customId: apply:approve:<userId>:<type>:<bracket> or apply:deny:<userId>:<type>:<bracket>
  const [, decision, userId, type, bracket] = interaction.customId.split(':');
  if (!isStaff(interaction)) {
    await interaction.reply({ content: 'Staff only.', ephemeral: true });
    return;
  }
  const types = appTypes();
  const t = types[type] || {};
  const guild = interaction.guild;
  const target = await guild.members.fetch(userId).catch(() => null);
  const thread = interaction.channel;

  await interaction.deferReply({ ephemeral: true });

  if (decision === 'approve' && target) {
    if (t.roleId) await target.roles.add(t.roleId).catch(() => {});
    // Everyone-ping role: added on every approval regardless of application type
    try {
      const pingRole = guild.roles.cache.find((r) => r.name === 'Oath Forsakers');
      if (pingRole && !target.roles.cache.has(pingRole.id)) {
        await target.roles.add(pingRole, 'Everyone-ping role on approval');
      }
    } catch {}
    // Total-level ranks removed 2026-10-13 (age-ranks-only overhaul).
    // New members start at the bottom of the tenure ladder (not guests).
    if (type !== 'guest') {
      const entry = (config.seniorityRanks || []).find((r) => r.minMonths === 0);
      if (entry) await target.roles.add(entry.roleId, 'New member tenure rank').catch(() => {});
    }
    // Auto-nickname: "Nickname [RSN]" (Gavin's idea 2026-10-14, all 3 app types)
    const appAnswers = store.getApplicationAnswers(guild.id, userId);
    if (appAnswers && appAnswers.nickname && appAnswers.rsn) {
      const nick = String(appAnswers.nickname).trim();
      const firstRsn = String(appAnswers.rsn).split(/[,/]/)[0].trim();
      if (nick && firstRsn) {
        const rsnPart = ` [${firstRsn}]`;
        const newNick = nick.length + rsnPart.length > 32
          ? nick.slice(0, 32 - rsnPart.length).trimEnd() + rsnPart
          : nick + rsnPart;
        await target.setNickname(newNick, 'Auto-nickname on approval').catch(() => {});
      }
    }
    // Welcome DM tailored to application type
    const welcomeDMs = {
      iron: `⛧ Welcome to Oath Forsaken ⛧\n\nYour application was approved.`,
      main: `⛧ Welcome to Oath Forsaken ⛧\n\nYour application was approved.`,
      guest: `⛧ Welcome to Oath Forsaken ⛧\n\nYour application was approved.`,
    };
    await target.send(welcomeDMs[type] || welcomeDMs.guest).catch(() => {});

    // Public welcome in #general - plain text (finalized 2026-10-13)
    // Guest gets the guest welcome; iron/main get the Initiate announcement.
    // This also handles guest-to-member promotions (they get the Initiate post).
    const generalChan = guild.channels.cache.get('1558583385440395476');
    if (generalChan) {
      let welcomeMsg;
      if (type === 'guest') {
        welcomeMsg =
          `Welcome, <@&1558540445611728997>\n` +
          `⛧ ━━━━━━━━━━━━━━━━ ⛧\n` +
          `<@${target.id}>\n\n` +
          `The door's open. Come see what the forsaken built.\n\n` +
          `• Introduce yourself in <#1558428255940378715>\n` +
          `• Grab your roles in <#1558399101454786670>\n` +
          `• Ping <@&1558735997922054225> when you're ready for a clan chat invite\n` +
          `• Like what you see? To become an official member, hit Become a Member in <#1558399103757717518>`;
      } else {
        welcomeMsg =
          `⛧ <@&1558452023790276659> ⛧\n` +
          `⛧ ━━━━━━━━━━━━━━━━━━━━━━━━ ⛧\n` +
          `<@${target.id}> has joined Oath Forsaken.\n\n` +
          `Welcome to Oath Forsaken! Glad you're here. Take a look around and make yourself at home.\n\n` +
          `• Drop an intro in <#1558428255940378715> so we can get to meet you\n` +
          `• Grab your roles in <#1558399101454786670>\n` +
          `• Ping <@&1558735997922054225> when you're ready for a clan chat invite`;
      }
      await generalChan.send({ content: welcomeMsg, allowedMentions: { parse: ['users'] } }).catch(() => {});
    }
  } else if (target) {
    // Simple deny: no DM sent (2026-10-13)
  }

  // Rename the post like Raven's Watch: "<Type> App from <user> - Approved"
  // and stamp "Approved/Denied by <staff>" on the original post.
  if (thread && thread.isThread()) {
    const base = thread.name.replace(/ - (Approved|Denied)$/, '');
    const verdict = decision === 'approve' ? 'Approved' : 'Denied';
    await thread.setName(`${base} - ${verdict}`.slice(0, 100)).catch(() => {});

    // Edit the starter message to show who decided, like RW.
    try {
      const starter = await thread.fetchStarterMessage().catch(() => null);
      if (starter && starter.embeds.length > 0) {
        const orig = starter.embeds[0];
        const updated = EmbedBuilder.from(orig).addFields({
          name: verdict,
          value: `by ${interaction.user.tag}`,
        });
        // Remove the approve/deny buttons so it can't be decided twice.
        await starter.edit({ embeds: [updated], components: [] }).catch(() => {});
      }
    } catch {}

    await thread.setLocked(true).catch(() => {});
    await thread.setArchived(true).catch(() => {});
  }

  await interaction.editReply(decision === 'approve' ? `Approved <@${userId}> as ${t.label || type}.` : `Denied <@${userId}>.`);

  // Close their private application channel
  const appChannelId = store.getApplication(guild.id, userId);
  if (appChannelId) {
    const ch = guild.channels.cache.get(appChannelId);
    store.removeApplication(guild.id, userId);
    if (ch) setTimeout(() => ch.delete('Application decided').catch(() => {}), 5000);
  }

  const log = guild.channels.cache.get(config.tickets.logChannelId);
  if (log) {
    await log.send(`Application **${decision}d** (${t.label || type}): <@${userId}> by ${interaction.user.tag}`).catch(() => {});
  }
}

async function handleApplyButton(interaction) {
  // customId: apply:type:<type> | apply:approve:... | apply:deny:...
  const parts = interaction.customId.split(':');
  const action = parts[1];
  if (action === 'type') {
    // Prevent members and staff from applying
    const member = interaction.member;
    const blockedRoleNames = ['Iron Sworn', 'Unbound', 'Guest', 'Friend of the Clan', 'Lord of Chaos', 'Warmonger', 'Ritualist', 'Inquisitor', 'Staff'];
    const hasBlockedRole = member.roles.cache.some(r => blockedRoleNames.includes(r.name));
    if (hasBlockedRole) {
      await interaction.reply({ content: 'You are already a member of the clan.', ephemeral: true }).catch(() => {});
      return;
    }
    // Prevent starting a second application
    if (store.isApplicationSubmitted(interaction.guildId, interaction.user.id)) {
      await interaction.reply({ content: 'You already have an application submitted. Staff will review it soon.', ephemeral: true }).catch(() => {});
      return;
    }
    const type = parts[2];
    return showAgeSelect(interaction, type);
  }
  if (action === 'approve' || action === 'deny') return handleDecision(interaction);
  if (action === 'denyreason') return handleDenyReasonPrompt(interaction);
}

async function handleAgeSelect(interaction) {
  // customId: apply:age:<type>
  const parts = interaction.customId.split(':');
  if (parts[0] !== 'apply' || parts[1] !== 'age') return;
  const type = parts[2];
  const ageAnswer = interaction.values[0]; // 'yes' or 'no'
  // All types go straight to modal (total-level bracket removed 2026-10-13)
  return showApplicationModal(interaction, type, null, ageAnswer);
}

async function handleTotalSelect(interaction) {
  // customId: apply:total:<ageAnswer>
  const parts = interaction.customId.split(':');
  if (parts[0] !== 'apply' || parts[1] !== 'total') return;
  const ageAnswer = parts[2] === 'none' ? null : parts[2];
  const bracket = interaction.values[0];
  // Don't defer — showModal must be the initial response
  await showApplicationModal(interaction, 'iron', bracket, ageAnswer);
}

const { SlashCommandBuilder } = require('discord.js');
const { PermissionFlagsBits: PFB } = require('discord.js');

const commands = [
  {
    data: new SlashCommandBuilder()
      .setName('apply')
      .setDescription('Start a clan application'),
    run: applyCommand,
  },
  {
    data: new SlashCommandBuilder()
      .setName('setup-applications')
      .setDescription('Post the application panel here (Admin only)')
      .setDefaultMemberPermissions(PFB.Administrator),
    run: setupApplications,
  },
  {
    data: new SlashCommandBuilder()
      .setName('reset-application')
      .setDescription('Clear someone\'s application so they can reapply (Admin only)')
      .setDefaultMemberPermissions(PFB.Administrator)
      .addUserOption((o) => o.setName('user').setDescription('Who to reset').setRequired(true)),
    run: async (interaction) => {
      const target = interaction.options.getUser('user');
      store.removeApplication(interaction.guildId, target.id);
      await interaction.reply({ content: `Cleared application for ${target.tag}. They can apply again.`, ephemeral: true });
    },
  },
];

module.exports = { onMemberJoin, handleApplyButton, handleModalSubmit, handleTotalSelect, handleAgeSelect, commands };
