// Recruitment applications — three types: ironman, main, guest.
// On member join: opens a private application channel with three buttons.
// Iron applicants pick their total level bracket from a dropdown, then fill a modal.
// Main/guest applicants go straight to a modal (no total level asked).
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

// Total-level brackets mirror the clan's rank ladder, with server emoji.
const TOTAL_LEVEL_BRACKETS = [
  { value: 'maxed', label: 'Maxed [2376]', emoji: '1558454796611100743' },
  { value: 'zamorakian', label: 'Zamorakian [2300-2375]', emoji: '1558454806744666182' },
  { value: 'wrath', label: 'Wrath [2150-2299]', emoji: '1558454818396176394' },
  { value: 'destroyer', label: 'Destroyer [2000-2149]', emoji: '1558454830056476672' },
  { value: 'unholy', label: 'Unholy [1850-1999]', emoji: '1558454842094256208' },
  { value: 'skulled', label: 'Skulled [1650-1849]', emoji: '1558454852596531310' },
  { value: 'death', label: 'Death [1450-1649]', emoji: '1558454863149662208' },
  { value: 'imp', label: 'Imp [1250-1449]', emoji: '1558454873924833457' },
  { value: 'goblin', label: 'Goblin [1000-1249]', emoji: '1558454884880089121' },
  { value: 'necromancer', label: 'Necromancer [500-999]', emoji: '1558454896095797259' },
  { value: 'wizard', label: 'Wizard [0-499]', emoji: '1558454906803847308' },
];

function bracketLabel(value) {
  const b = TOTAL_LEVEL_BRACKETS.find((x) => x.value === value);
  return b ? b.label : value;
}

// Discord role IDs for each total-level rank (assigned on iron approval only).
const TOTAL_LEVEL_ROLE_IDS = {
  maxed: '1558440214739943505',
  zamorakian: '1558440222029651978',
  wrath: '1558450336665182228',
  destroyer: '1558450347251343481',
  unholy: '1558450357573521465',
  skulled: '1558440247140810772',
  death: '1558440218418221086',
  imp: '1558440250714492999',
  goblin: '1558450368927637504',
  necromancer: '1558440225401999380',
  wizard: '1558450379572781096',
};

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
        `**Ironman** — you play an ironman and want full clan membership (ranks, bingos, comps).\n` +
        `**Main** — you play a main; you can hang out, earn seniority, and join casual events.\n` +
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
        `**Ironman** — full clan membership (ranks, bingos, comps).\n` +
        `**Main** — hang out, earn seniority, join casual events.\n` +
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

// Iron applicants pick a total-level bracket first (modals can't hold dropdowns).
async function showTotalLevelSelect(interaction, ageAnswer) {
  const menu = new StringSelectMenuBuilder()
    .setCustomId(`apply:total:${ageAnswer || 'none'}`)
    .setPlaceholder('What is your total level?')
    .addOptions(TOTAL_LEVEL_BRACKETS.map((b) => ({ label: b.label, value: b.value, emoji: b.emoji ? { id: b.emoji } : undefined })));
  const row = new ActionRowBuilder().addComponents(menu);
  const replyOpts = {
    content: 'Pick your total level bracket, then answer a few questions.',
    components: [row],
    ephemeral: true,
  };
  // If this is a follow-up to the age dropdown, update instead of reply
  if (interaction.replied || interaction.deferred) {
    await interaction.editReply(replyOpts).catch(() => {});
  } else {
    await interaction.reply(replyOpts);
  }
}

// All applicants answer the Discord age question via Yes/No dropdown first.
async function showAgeSelect(interaction, type) {
  const menu = new StringSelectMenuBuilder()
    .setCustomId(`apply:age:${type}`)
    .setPlaceholder('Is your Discord account at least 1 month old?')
    .addOptions([
      { label: 'Yes', value: 'yes', emoji: '✅' },
      { label: 'No', value: 'no', emoji: '❌' },
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
  // customId: apply:modal:<type>:<bracket|none>:<age|none>
  const parts = interaction.customId.split(':');
  if (parts[0] !== 'apply' || parts[1] !== 'modal') return;

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
  if (type === 'iron' && bracket && bracket !== 'none') {
    lines.push(`**Total level:** ${bracketLabel(bracket)}`);
  }
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
    new ButtonBuilder().setCustomId(`apply:approve:${interaction.user.id}:${type}:${bracket || 'none'}`).setLabel('Approve').setStyle(ButtonStyle.Success).setEmoji('✅'),
    new ButtonBuilder().setCustomId(`apply:deny:${interaction.user.id}:${type}:${bracket || 'none'}`).setLabel('Deny').setStyle(ButtonStyle.Danger).setEmoji('❌')
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
    await interaction.editReply('Application submitted! Staff will review it soon.');
  } else {
    await interaction.editReply('Could not open your application thread — tell staff.');
  }

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
    // Irons also get their total-level rank role. Mains and guests do not.
    if (type === 'iron' && bracket && bracket !== 'none') {
      const rankRoleId = TOTAL_LEVEL_ROLE_IDS[bracket];
      if (rankRoleId) await target.roles.add(rankRoleId, 'Total level rank from application').catch(() => {});
    }
    // New members start at the bottom of the tenure ladder (not guests).
    if (type !== 'guest') {
      const entry = (config.seniorityRanks || []).find((r) => r.minMonths === 0);
      if (entry) await target.roles.add(entry.roleId, 'New member tenure rank').catch(() => {});
    }
    // Welcome DM tailored to application type
    const welcomeDMs = {
      iron: `🎉 Your **Ironman** application to **${guild.name}** was approved! Welcome to the clan.\n\nYou're full crew now: total-level ranks, bingos, WOM comps, all of it. Head to the roles channel to grab your ping roles and introduce yourself.`,
      main: `🎉 Your **Main** application to **${guild.name}** was approved! Welcome.\n\nAs a main you can hang out, earn seniority, and join casual events. Bingos and WOM comps are ironman-only, but there's plenty going on. Grab your ping roles in the roles channel and say hi.`,
      guest: `🎉 Your **Guest** application to **${guild.name}** was approved! Welcome.\n\nYou're free to hang out and check things out. If you ever want full membership, just reapply as an ironman or main.`,
    };
    await target.send(welcomeDMs[type] || welcomeDMs.guest).catch(() => {});

    // Public welcome in #general, pinging the new member (Sapphire-style)
    const welcomeTitles = {
      iron: 'Welcome, newest initiate.',
      main: 'Welcome, newest initiate.',
      guest: 'Welcome our newest Guest!',
    };
    const welcomeLines = {
      iron: 'You stand before the clan with empty hands. No Grand Exchange. No trading. No one to carry you. Kneel.',
      main: "Zamorak never cared about bloodlines — only strength. You're one of us now. That's all that matters.",
      guest: "The door's open. Come see what the forsaken built.",
    };
    const generalChan = guild.channels.cache.get('1558583385440395476');
    if (generalChan) {
      const { EmbedBuilder } = require('discord.js');
      const wEmbed = new EmbedBuilder()
        .setTitle(welcomeTitles[type] || welcomeTitles.guest)
        .setDescription(
          `<@${target.id}> — <@&1558452023790276659>\n\n` +
          `*${welcomeLines[type] || welcomeLines.guest}*\n\n` +
          `• Introduce yourself in <#1558428255940378715>\n` +
          `• Grab your roles in <#1558399101454786670>\n` +
          `• Ping <@&1558735997922054225> when you're ready for a clan chat invite`
        )
        .setColor(0x6B0E0E)
        .setThumbnail(target.user.displayAvatarURL());
      await generalChan.send({ embeds: [wEmbed] }).catch(() => {});
    }
  } else if (target) {
    await target.send(`Thanks for applying to **${guild.name}** — staff decided not to move forward this time. You're welcome to reapply later.`).catch(() => {});
  }

  // Rename the post like the other clan: "<Type> App from <user> - Approved"
  // and stamp "Approved/Denied by <staff>" on the original post.
  if (thread && thread.isThread()) {
    const base = thread.name.replace(/ - (Approved|Denied)$/, '');
    const verdict = decision === 'approve' ? 'Approved' : 'Denied';
    await thread.setName(`${base} - ${verdict}`.slice(0, 100)).catch(() => {});

    // Edit the starter message to show who decided, like the reference.
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
}

async function handleAgeSelect(interaction) {
  // customId: apply:age:<type>
  const parts = interaction.customId.split(':');
  if (parts[0] !== 'apply' || parts[1] !== 'age') return;
  const type = parts[2];
  const ageAnswer = interaction.values[0]; // 'yes' or 'no'
  if (type === 'iron') {
    await interaction.deferUpdate().catch(() => {});
    return showTotalLevelSelect(interaction, ageAnswer);
  }
  // For main/guest, show modal directly (can't defer before showModal)
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
