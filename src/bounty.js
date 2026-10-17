// Bounty board: staff posts contracts, members claim with proof in a
// private thread, staff grants or rejects. The winner holds the champion
// title until dethroned — granting to a new winner strips the old holder.
const {
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  PermissionFlagsBits,
} = require('discord.js');
const fs = require('fs');
const path = require('path');
const config = require('./config');
const { isStaff, ZAMORAK_RED, getRoleById } = require('./utils');

const STATE_FILE = path.join(__dirname, '..', 'data', 'bounties.json');
const CLAIM_ARCHIVE_MIN = 4320; // 3 days
// Clan member roles allowed to claim: Iron Sworn, Unbound, Friend of the Clan.
const GUILD_MEMBER_ROLES = (config.bounty && config.bounty.memberRoleIds) || [];

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return { bounties: {}, claims: {} };
  }
}

function saveState(state) {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function bountyConfig() {
  return config.bounty || {};
}

function championRole(guild) {
  const cfg = bountyConfig();
  return getRoleById(guild, cfg.roleId, cfg.roleName || 'Champion of Chaos');
}

function isMember(member) {
  return member.roles.cache.some((r) => GUILD_MEMBER_ROLES.includes(r.id));
}

function bountyEmbed({ target, location, threat, days, wiki, rewardMention }) {
  return new EmbedBuilder()
    .setColor(ZAMORAK_RED)
    .setTitle('📜 Bounty Contract Available')
    .setDescription(
      `Chaos demands tribute. A new contract is nailed to the board.\n\n` +
        `**Target:** ${target}\n` +
        `**Location:** ${location}\n` +
        `**Threat Level:** ${threat}\n` +
        `**Time Limit:** ${days} day${days === 1 ? '' : 's'}\n` +
        `**Reward:** ${rewardMention}\n\n` +
        `First to return with proof claims the title. The kill must be fresh.`
    )
    .setTimestamp();
}

function reviewButtons(threadId) {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`bounty:grant:${threadId}`)
        .setLabel('Grant Winnings')
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`bounty:reject:${threadId}`)
        .setLabel('Reject')
        .setStyle(ButtonStyle.Danger),
      new ButtonBuilder()
        .setCustomId(`bounty:lock:${threadId}`)
        .setLabel('Lock & Archive Thread')
        .setStyle(ButtonStyle.Primary)
    ),
  ];
}

async function postCommand(interaction) {
  if (!isStaff(interaction)) {
    await interaction.reply({ content: 'Staff only.', ephemeral: true }).catch(() => {});
    return;
  }
  const target = interaction.options.getString('target', true).trim();
  const location = interaction.options.getString('location', true).trim();
  const threat = interaction.options.getString('threat', true);
  const days = interaction.options.getInteger('days', true);
  const wiki = interaction.options.getString('wiki')?.trim();
  const channelId = bountyConfig().channelId;
  if (!channelId) {
    await interaction.reply({ content: 'Bounty board is not set up yet. Tell staff.', ephemeral: true }).catch(() => {});
    return;
  }
  const channel = await interaction.client.channels.fetch(channelId).catch(() => null);
  if (!channel) {
    await interaction.reply({ content: 'Could not find the bounty board channel.', ephemeral: true }).catch(() => {});
    return;
  }
  const role = championRole(interaction.guild);
  if (!role) {
    await interaction.reply({ content: 'Champion role is not set up yet. Tell staff.', ephemeral: true }).catch(() => {});
    return;
  }

  await interaction.deferReply({ ephemeral: true });

  const state = loadState();
  // Retire any currently active bounty.
  for (const [id, b] of Object.entries(state.bounties)) {
    if (b.active) {
      b.active = false;
      try {
        const oldMsg = await channel.messages.fetch(id);
        const oldEmbed = EmbedBuilder.from(oldMsg.embeds[0]).setFooter({ text: 'Contract closed.' });
        await oldMsg.edit({ embeds: [oldEmbed], components: [] });
      } catch (err) {
        console.warn('Bounty retire edit failed:', err.message);
      }
    }
  }

  const wikiUrl = wiki || `https://runescape.wiki/w/${encodeURIComponent(target.replace(/ /g, '_'))}`;
  const embed = bountyEmbed({
    target,
    location,
    threat,
    days,
    wiki: wikiUrl,
    rewardMention: `<@&${role.id}>`,
  });
  // Stash wiki for the link button (per-bounty).
  const msg = await channel.send({
    embeds: [embed],
    components: [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId('bounty:claim:pending')
          .setLabel('Claim Bounty')
          .setStyle(ButtonStyle.Success)
          .setEmoji('⚔️'),
        new ButtonBuilder().setLabel('Wiki Link').setStyle(ButtonStyle.Link).setURL(wikiUrl).setEmoji('📖')
      ),
    ],
  });
  // Patch the claim button with the real bounty id now that we have it.
  await msg
    .edit({
      components: [
        new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId(`bounty:claim:${msg.id}`)
            .setLabel('Claim Bounty')
            .setStyle(ButtonStyle.Success)
            .setEmoji('⚔️'),
          new ButtonBuilder().setLabel('Wiki Link').setStyle(ButtonStyle.Link).setURL(wikiUrl).setEmoji('📖')
        ),
      ],
    })
    .catch((err) => console.warn('Bounty button patch failed:', err.message));

  state.bounties[msg.id] = {
    channelId: channel.id,
    target,
    location,
    threat,
    days,
    wiki: wikiUrl,
    active: true,
    winnerId: null,
    createdAt: Date.now(),
    createdBy: interaction.user.id,
  };
  saveState(state);
  await interaction.editReply({ content: `Bounty posted: ${target}` }).catch(() => {});
}

async function handleClaim(interaction, bountyId) {
  const state = loadState();
  const bounty = state.bounties[bountyId];
  if (!bounty || !bounty.active) {
    await interaction.reply({ content: 'This bounty is no longer active.', ephemeral: true }).catch(() => {});
    return;
  }
  if (!isMember(interaction.member)) {
    await interaction.reply({ content: 'Clan members only. Join the clan first.', ephemeral: true }).catch(() => {});
    return;
  }
  // One pending claim per member per bounty.
  const existing = Object.entries(state.claims).find(
    ([, c]) => c.bountyId === bountyId && c.claimerId === interaction.user.id && c.status === 'pending'
  );
  if (existing) {
    await interaction
      .reply({ content: 'You already have an open claim. Post your proof in your thread.', ephemeral: true })
      .catch(() => {});
    return;
  }

  await interaction.deferReply({ ephemeral: true });
  const parentMsg = await interaction.channel.messages.fetch(bountyId).catch(() => null);
  if (!parentMsg) {
    await interaction.editReply({ content: 'Could not find the bounty post.' }).catch(() => {});
    return;
  }
  const name = `Bounty Claim - ${interaction.user.displayName}`.slice(0, 100);
  let thread;
  try {
    thread = await parentMsg.startThread({ name, autoArchiveDuration: CLAIM_ARCHIVE_MIN, type: ChannelType.PrivateThread });
  } catch {
    thread = await parentMsg
      .startThread({ name, autoArchiveDuration: CLAIM_ARCHIVE_MIN })
      .catch(() => null);
  }
  if (!thread) {
    await interaction.editReply({ content: 'Could not open a claim thread. Tell staff.' }).catch(() => {});
    return;
  }
  await thread.members.add(interaction.user.id).catch(() => {});
  await thread.send({
    content:
      `<@${interaction.user.id}> would like to claim the bounty!\n` +
      `Post your proof here. TrackScape screenshot or in-game capture. Fresh kills only.`,
    components: reviewButtons(thread.id),
  });

  state.claims[thread.id] = { bountyId, claimerId: interaction.user.id, status: 'pending', createdAt: Date.now() };
  saveState(state);
  await interaction.editReply({ content: `Claim opened: ${thread.url}` }).catch(() => {});
}

async function handleGrant(interaction, threadId) {
  if (!isStaff(interaction)) {
    await interaction.reply({ content: 'Staff only.', ephemeral: true }).catch(() => {});
    return;
  }
  const state = loadState();
  const claim = state.claims[threadId];
  if (!claim || claim.status !== 'pending') {
    await interaction.reply({ content: 'Nothing to grant here.', ephemeral: true }).catch(() => {});
    return;
  }
  const guild = interaction.guild;
  const role = championRole(guild);
  if (!role) {
    await interaction.reply({ content: 'Champion role is not set up.', ephemeral: true }).catch(() => {});
    return;
  }
  await interaction.deferReply({ ephemeral: true });

  // Strip the previous holder(s). The title belongs to one champion.
  const prevHolders = [...role.members.values()].filter((m) => m.id !== claim.claimerId);
  for (const m of prevHolders) {
    await m.roles.remove(role).catch((err) => console.warn('Bounty strip failed:', err.message));
  }
  const winner = await guild.members.fetch(claim.claimerId).catch(() => null);
  if (!winner) {
    await interaction.editReply({ content: 'Winner is no longer in the server.' }).catch(() => {});
    return;
  }
  const retained = winner.roles.cache.has(role.id);
  if (!retained) {
    try {
      await winner.roles.add(role);
    } catch (err) {
      console.error('Bounty grant failed:', err.message);
      await interaction.editReply({ content: 'Could not grant the role. Check my permissions.' }).catch(() => {});
      return;
    }
  }

  claim.status = 'granted';
  const bounty = state.bounties[claim.bountyId];
  if (bounty) {
    bounty.active = false;
    bounty.winnerId = claim.claimerId;
    try {
      const chan = await guild.channels.fetch(bounty.channelId).catch(() => null);
      const msg = chan ? await chan.messages.fetch(claim.bountyId).catch(() => null) : null;
      if (msg && msg.embeds[0]) {
        const done = EmbedBuilder.from(msg.embeds[0]).setFooter({
          text: `Claimed by ${winner.displayName}`,
        });
        await msg.edit({ embeds: [done], components: [] });
      }
    } catch (err) {
      console.warn('Bounty close edit failed:', err.message);
    }
  }
  saveState(state);

  const thread = await guild.channels.fetch(threadId).catch(() => null);
  if (thread && thread.isThread()) {
    await thread
      .send(
        retained
          ? `👑 Bounty Confirmed! <@${winner.id}> retains the title ${role.name}.`
          : `👑 Bounty Confirmed! <@${winner.id}> has been granted the title ${role.name}.`
      )
      .catch(() => {});
    await thread.setLocked(true).catch(() => {});
    await thread.setArchived(true).catch(() => {});
  }
  await interaction.editReply({ content: `Granted to ${winner.displayName}.` }).catch(() => {});
}

async function handleReject(interaction, threadId) {
  if (!isStaff(interaction)) {
    await interaction.reply({ content: 'Staff only.', ephemeral: true }).catch(() => {});
    return;
  }
  const state = loadState();
  const claim = state.claims[threadId];
  if (!claim || claim.status !== 'pending') {
    await interaction.reply({ content: 'Nothing to reject here.', ephemeral: true }).catch(() => {});
    return;
  }
  claim.status = 'rejected';
  saveState(state);
  const thread = await interaction.guild.channels.fetch(threadId).catch(() => null);
  if (thread && thread.isThread()) {
    await thread.send('Claim rejected. Post better proof if you have it.').catch(() => {});
  }
  await interaction.reply({ content: 'Claim rejected.', ephemeral: true }).catch(() => {});
}

async function handleLock(interaction, threadId) {
  if (!isStaff(interaction)) {
    await interaction.reply({ content: 'Staff only.', ephemeral: true }).catch(() => {});
    return;
  }
  const thread = await interaction.guild.channels.fetch(threadId).catch(() => null);
  if (thread && thread.isThread()) {
    await thread.setLocked(true).catch(() => {});
    await thread.setArchived(true).catch(() => {});
  }
  await interaction.reply({ content: 'Thread locked and archived.', ephemeral: true }).catch(() => {});
}

async function handleBountyButton(interaction) {
  // customId: 'bounty:claim:<msgId>' | 'bounty:grant:<threadId>' | 'bounty:reject:<threadId>' | 'bounty:lock:<threadId>'
  const [, action, id] = interaction.customId.split(':');
  if (action === 'claim') return handleClaim(interaction, id);
  if (action === 'grant') return handleGrant(interaction, id);
  if (action === 'reject') return handleReject(interaction, id);
  if (action === 'lock') return handleLock(interaction, id);
}

const commands = [
  {
    data: new SlashCommandBuilder()
      .setName('bounty')
      .setDescription('Manage bounty contracts')
      .addSubcommand((s) =>
        s
          .setName('post')
          .setDescription('Post a new bounty contract (staff)')
          .addStringOption((o) => o.setName('target').setDescription('What to hunt').setRequired(true).setMaxLength(100))
          .addStringOption((o) => o.setName('location').setDescription('Where').setRequired(true).setMaxLength(100))
          .addStringOption((o) =>
            o
              .setName('threat')
              .setDescription('Threat level')
              .setRequired(true)
              .addChoices(
                { name: 'Easy', value: 'Easy' },
                { name: 'Medium', value: 'Medium' },
                { name: 'Hard', value: 'Hard' },
                { name: 'Extreme', value: 'Extreme' }
              )
          )
          .addIntegerOption((o) => o.setName('days').setDescription('Time limit in days').setRequired(true).setMinValue(1).setMaxValue(90))
          .addStringOption((o) => o.setName('wiki').setDescription('Wiki URL (defaults to OSRS wiki)').setRequired(false))
      ),
    run: async (interaction) => {
      if (interaction.options.getSubcommand() === 'post') return postCommand(interaction);
    },
  },
];

module.exports = { commands, handleBountyButton };
