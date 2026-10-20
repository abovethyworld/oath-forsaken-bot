// All slash commands: definitions + handlers.
// Setup commands need Administrator. Warn/strike commands need Manage Messages.
const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  PermissionFlagsBits,
  SlashCommandBuilder,
} = require('discord.js');
const config = require('./config');
const store = require('./store');
const tickets = require('./tickets');
const calendar = require('./calendar');
const polls = require('./polls');
const eventCalendar = require('./event-calendar');
const seniority = require('./seniority');
const ccChecklist = require('./cc-checklist');
const recruit = require('./recruit');
const permissions = require('./permissions');
const roster = require('./roster');
const lore = require('./lore');
const bounty = require('./bounty');
const teams = require('./teams');
const showoff = require('./showoff');

const STYLE_MAP = {
  Primary: ButtonStyle.Primary,
  Secondary: ButtonStyle.Secondary,
  Success: ButtonStyle.Success,
  Danger: ButtonStyle.Danger,
};

// Discord allows max 5 buttons per row, 5 rows per message (25 buttons/message).
function chunkButtons(buttons) {
  const rows = [];
  for (let i = 0; i < buttons.length; i += 5) {
    const row = new ActionRowBuilder();
    for (const b of buttons.slice(i, i + 5)) {
      const btn = new ButtonBuilder()
        .setCustomId(`role:${b.roleId}`)
        .setLabel(b.label)
        .setStyle(STYLE_MAP[b.style] || ButtonStyle.Secondary);
      if (b.emoji) btn.setEmoji(b.emoji);
      row.addComponents(btn);
    }
    rows.push(row);
  }
  return rows;
}

function panelToEmbed(panel) {
  const embed = new EmbedBuilder()
    .setTitle(panel.title)
    .setDescription(panel.description || '')
    .setColor(panel.color ?? 0xffd700);
  if (panel.banner) embed.setImage(panel.banner);
  return embed;
}

function sectionsToDescription(intro, sections, footer) {
  const DIV = '\u26E7 \u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501 \u26E7';
  let desc = intro ? `${intro}\n\n` : '';
  for (const s of sections || []) {
    if (s.divider_before) desc += `${DIV}\n`;
    desc += `**${s.heading}**\n${s.body}\n\n`;
  }
  if (footer) desc += `*${footer}*`;
  return desc.trim();
}

async function postRolePanels(interaction) {
  await interaction.deferReply({ ephemeral: true });
  const channel = interaction.guild.channels.cache.get(config.channels.roles);
  if (!channel) {
    await interaction.editReply('Roles channel not found. Check config.channels.roles.');
    return;
  }
  let posted = 0;
  for (const panel of config.rolePanels) {
    const rows = chunkButtons(panel.buttons || []);
    // Split into multiple messages if a panel somehow exceeds 25 buttons.
    for (let i = 0; i < rows.length; i += 5) {
      const msgRows = rows.slice(i, i + 5);
      const payload = { components: msgRows };
      if (i === 0) payload.embeds = [panelToEmbed(panel)];
      await channel.send(payload);
      posted++;
    }
  }
  await interaction.editReply(`Posted ${posted} role panel message(s) in ${channel}.`);
}

async function postRules(interaction) {
  await interaction.deferReply({ ephemeral: true });
  const channel = interaction.guild.channels.cache.get(config.channels.rules);
  if (!channel) {
    await interaction.editReply('Rules channel not found. Check config.channels.rules.');
    return;
  }
  const r = config.rules;
  const embed = new EmbedBuilder()
    .setTitle(r.title)
    .setDescription(sectionsToDescription(r.intro, r.sections, r.footer))
    .setColor(r.color ?? 0xffd700);
  if (r.banner) embed.setImage(r.banner);
  await channel.send({ embeds: [embed] });
  await interaction.editReply(`Rules posted in ${channel}.`);
}

async function postStrikes(interaction) {
  await interaction.deferReply({ ephemeral: true });
  const channel = interaction.guild.channels.cache.get(config.channels.rules);
  if (!channel) {
    await interaction.editReply('Rules channel not found. Check config.channels.rules.');
    return;
  }
  const s = config.strikeSystem;
  const embed = new EmbedBuilder()
    .setTitle(s.title)
    .setDescription(sectionsToDescription(s.intro, s.levels, s.footer))
    .setColor(s.color ?? 0xff0000);
  if (s.banner) embed.setImage(s.banner);
  await channel.send({ embeds: [embed] });
  await interaction.editReply(`Strike system posted in ${channel}.`);
}

async function postRanks(interaction) {
  await interaction.deferReply({ ephemeral: true });
  const channel = interaction.guild.channels.cache.get(config.channels.clanRanks || config.channels.rules);
  if (!channel) {
    await interaction.editReply('Rules channel not found. Check config.channels.rules.');
    return;
  }
  const r = config.rankInfo;
  const embed = new EmbedBuilder()
    .setTitle(r.title)
    .setDescription(sectionsToDescription(r.intro, r.sections, r.footer))
    .setColor(r.color ?? 0xffd700);
  if (r.banner) embed.setImage(r.banner);
  await channel.send({ embeds: [embed] });
  await interaction.editReply(`Ranks info posted in ${channel}.`);
}

async function warnUser(interaction) {
  const user = interaction.options.getUser('user');
  const reason = interaction.options.getString('reason');
  const count = store.addStrike(interaction.guildId, user.id, reason, interaction.user.id);

  await interaction.reply({
    content: `⚠️ ${user} has been warned (strike ${count}/3).\nReason: ${reason}`,
    ephemeral: true,
  });

  const log = interaction.guild.channels.cache.get(config.channels.modLog);
  if (log) {
    const embed = new EmbedBuilder()
      .setTitle(`Strike ${count}/3: ${user.tag}`)
      .setDescription(`**Reason:** ${reason}\n**Warned by:** ${interaction.user.tag}`)
      .setColor(count >= 3 ? 0xff0000 : 0xffa500)
      .setTimestamp();
    await log.send({ embeds: [embed] }).catch((e) => console.error("[commands.js] Silent failure:", e.message));
  }

  if (count >= 3) {
    await interaction.followUp({
      content: `🚨 ${user} has reached 3 strikes, review for a ban per the strike system.`,
      ephemeral: true,
    });
  }
}

async function showStrikes(interaction) {
  const user = interaction.options.getUser('user');
  const strikes = store.getStrikes(interaction.guildId, user.id);
  if (strikes.length === 0) {
    await interaction.reply({ content: `${user} has no strikes. Clean record.`, ephemeral: true });
    return;
  }
  const lines = strikes.map((s, i) => {
    const date = new Date(s.at).toLocaleDateString();
    return `**${i + 1}.** ${s.reason} — <@${s.modId}> (${date})`;
  });
  const embed = new EmbedBuilder()
    .setTitle(`Strikes for ${user.tag} (${strikes.length}/3)`)
    .setDescription(lines.join('\n'))
    .setColor(0xffa500);
  await interaction.reply({ embeds: [embed], ephemeral: true });
}

async function clearStrikesCmd(interaction) {
  const user = interaction.options.getUser('user');
  store.clearStrikes(interaction.guildId, user.id);
  await interaction.reply({ content: `Cleared all strikes for ${user}.`, ephemeral: true });
}

const commands = [
  {
    data: new SlashCommandBuilder()
      .setName('setup-roles')
      .setDescription('Post the button-role panels (Admin only)')
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
    run: postRolePanels,
  },
  {
    data: new SlashCommandBuilder()
      .setName('post-rules')
      .setDescription('Post the rules embed (Admin only)')
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
    run: postRules,
  },
    {
      data: new SlashCommandBuilder()
        .setName('post-ranks')
        .setDescription('Post the clan ranks info embed (Admin only)')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
      run: postRanks,
    },
  {
    data: new SlashCommandBuilder()
      .setName('post-strikes')
      .setDescription('Post the strike system embed (Admin only)')
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
    run: postStrikes,
  },
  {
    data: new SlashCommandBuilder()
      .setName('warn')
      .setDescription('Give a user a strike')
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
      .addUserOption((o) => o.setName('user').setDescription('Who to warn').setRequired(true))
      .addStringOption((o) => o.setName('reason').setDescription('Why').setRequired(true)),
    run: warnUser,
  },
  {
    data: new SlashCommandBuilder()
      .setName('strikes')
      .setDescription("Show a user's strikes")
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
      .addUserOption((o) => o.setName('user').setDescription('Who to check').setRequired(true)),
    run: showStrikes,
  },
  {
    data: new SlashCommandBuilder()
      .setName('clear-strikes')
      .setDescription("Clear a user's strikes")
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
      .addUserOption((o) => o.setName('user').setDescription('Who to clear').setRequired(true)),
    run: clearStrikesCmd,
  },
  ...tickets.commands,
  ...calendar.commands,
  ...polls.commands,
  ...eventCalendar.commands,
  ...seniority.commands,
  ...ccChecklist.commands,
  ...recruit.commands,
  ...permissions.commands,
  ...bounty.commands,
  ...teams.commands,
  ...showoff.commands,
  ...roster.commands,
  ...lore.commands,
];

async function handleCommand(interaction) {
  const cmd = commands.find((c) => c.data.name === interaction.commandName);
  if (!cmd) return;
  await cmd.run(interaction);
}

module.exports = { commands, handleCommand };
