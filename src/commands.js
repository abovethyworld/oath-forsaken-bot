// All slash commands: definitions + handlers.
// Setup commands need Administrator. Warn/strike commands need Moderate Members.
const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  ModalBuilder,
  PermissionFlagsBits,
  TextInputBuilder,
  TextInputStyle,
  SlashCommandBuilder,
} = require('discord.js');
const config = require('./config');
const store = require('./store');
const { ZAMORAK_RED, isStaff } = require('./utils');
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
const pluginConnect = require('./plugin-connect');
const guide = require('./guide');
const staffLink = require('./staff-link');
const websiteControls = require('./website-controls');
const { postOrEdit, postOrEditMany } = require('./panel-store');

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
    .setColor(panel.color ?? ZAMORAK_RED);
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
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
    await interaction.reply({ content: 'You do not have permission to use this command.', ephemeral: true });
    return;
  }
  await interaction.deferReply({ ephemeral: true });
  const channel = interaction.guild.channels.cache.get(config.channels.roles);
  if (!channel) {
    await interaction.editReply('Roles channel not found. Tell staff.');
    return;
  }
  const payloads = [];
  for (const panel of config.rolePanels) {
    const rows = chunkButtons(panel.buttons || []);
    // Split into multiple messages if a panel somehow exceeds 25 buttons.
    for (let i = 0; i < rows.length; i += 5) {
      const msgRows = rows.slice(i, i + 5);
      const payload = { components: msgRows };
      if (i === 0) payload.embeds = [panelToEmbed(panel)];
      payloads.push(payload);
    }
  }
  const posted = await postOrEditMany(channel, 'roles', payloads);
  await interaction.editReply(`Posted/refreshed ${posted} role panel message(s) in ${channel}.`);
}

async function postRules(interaction) {
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
    await interaction.reply({ content: 'You do not have permission to use this command.', ephemeral: true });
    return;
  }
  await interaction.deferReply({ ephemeral: true });
  const channel = interaction.guild.channels.cache.get(config.channels.rules);
  if (!channel) {
    await interaction.editReply('Rules channel not found. Tell staff.');
    return;
  }
  const r = config.rules;
  const embed = new EmbedBuilder()
    .setTitle(r.title)
    .setDescription(sectionsToDescription(r.intro, r.sections, r.footer))
    .setColor(r.color ?? ZAMORAK_RED);
  if (r.banner) embed.setImage(r.banner);
  await postOrEdit(channel, 'rules', { embeds: [embed] });
  await interaction.editReply(`Rules posted/refreshed in ${channel}.`);
}

async function postStrikes(interaction) {
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
    await interaction.reply({ content: 'You do not have permission to use this command.', ephemeral: true });
    return;
  }
  await interaction.deferReply({ ephemeral: true });
  const channel = interaction.guild.channels.cache.get(config.channels.rules);
  if (!channel) {
    await interaction.editReply('Rules channel not found. Tell staff.');
    return;
  }
  const s = config.strikeSystem;
  const embed = new EmbedBuilder()
    .setTitle(s.title)
    .setDescription(sectionsToDescription(s.intro, s.levels, s.footer))
    .setColor(s.color ?? ZAMORAK_RED);
  if (s.banner) embed.setImage(s.banner);
  await postOrEdit(channel, 'strikes', { embeds: [embed] });
  await interaction.editReply(`Strike system posted/refreshed in ${channel}.`);
}

async function postRanks(interaction) {
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
    await interaction.reply({ content: 'You do not have permission to use this command.', ephemeral: true });
    return;
  }
  await interaction.deferReply({ ephemeral: true });
  const channel = interaction.guild.channels.cache.get(config.channels.clanRanks || config.channels.rules);
  if (!channel) {
    await interaction.editReply('Rules channel not found. Tell staff.');
    return;
  }
  const r = config.rankInfo;
  const embed = new EmbedBuilder()
    .setTitle(r.title)
    .setDescription(sectionsToDescription(r.intro, r.sections, r.footer))
    .setColor(r.color ?? ZAMORAK_RED);
  if (r.banner) embed.setImage(r.banner);
  await postOrEdit(channel, 'ranks', { embeds: [embed] });
  await interaction.editReply(`Ranks info posted/refreshed in ${channel}.`);
}

async function warnUser(interaction) {
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.ModerateMembers)) {
    await interaction.reply({ content: 'You do not have permission to use this command.', ephemeral: true });
    return;
  }
  const user = interaction.options.getUser('user');
  const reason = interaction.options.getString('reason');
  const count = store.addStrike(interaction.guildId, user.id, reason, interaction.user.id);

  await interaction.reply({
    content: `⚠️ ${user} has been warned (strike ${count}/3).\nReason: ${reason}`,
    ephemeral: true,
    allowedMentions: { users: [user.id] },
  });

  const log = interaction.guild.channels.cache.get(config.channels.modLog);
  if (log) {
    const embed = new EmbedBuilder()
      .setTitle(`Strike ${count}/3: ${user.tag}`)
      .setDescription(`**Reason:** ${reason}\n**Warned by:** ${interaction.user.tag}`)
      .setColor(count >= 3 ? ZAMORAK_RED : 0xffa500)
      .setTimestamp();
    await log.send({ embeds: [embed] }).catch((e) => console.error("[commands.js] Non-fatal error:", e.message));
  }

  if (count >= 3) {
    await interaction.followUp({
      content: `🚨 ${user} has reached 3 strikes. Review them for a ban under the strike system.`,
      ephemeral: true,
    });
  }
}

async function showStrikes(interaction) {
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.ModerateMembers)) {
    await interaction.reply({ content: 'You do not have permission to use this command.', ephemeral: true });
    return;
  }
  const user = interaction.options.getUser('user');
  const strikes = store.getStrikes(interaction.guildId, user.id);
  if (strikes.length === 0) {
    await interaction.reply({ content: `${user} has no strikes.`, ephemeral: true });
    return;
  }
  const lines = strikes.map((s, i) => {
    const date = new Date(s.at).toLocaleDateString();
    return `**${i + 1}.** ${s.reason}, by <@${s.modId}> (${date})`;
  });
  const embed = new EmbedBuilder()
    .setTitle(`Strikes for ${user.tag} (${strikes.length}/3)`)
    .setDescription(lines.join('\n'))
    .setColor(strikes.length >= 3 ? ZAMORAK_RED : 0xffa500);
  await interaction.reply({ embeds: [embed], ephemeral: true });
}

async function clearStrikesCmd(interaction) {
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.ModerateMembers)) {
    await interaction.reply({ content: 'You do not have permission to use this command.', ephemeral: true });
    return;
  }
  const user = interaction.options.getUser('user');
  store.clearStrikes(interaction.guildId, user.id);
  await interaction.reply({ content: `Cleared all strikes for ${user}.`, ephemeral: true });
}

// ─── /panel-text (staff) ────────────────────────────────────────────
const panelText = require('./panel-text').createPanelText();

async function panelTextCommand(interaction) {
  if (!isStaff(interaction)) {
    await interaction.reply({ content: 'This command is for staff.', ephemeral: true });
    return;
  }
  const sub = interaction.options.getSubcommand();
  if (sub === 'list') {
    const r = panelText.registry();
    const text = `**Panels**\n${r.panels.map((k) => `\`${k}\``).join(', ')}\n\n**Guide**\n${r.guide.map((k) => `\`${k}\``).join(', ')}`;
    await interaction.reply({ content: text.slice(0, 1990), ephemeral: true });
    return;
  }
  const key = interaction.options.getString('key', true).trim();
  const known = panelText.registry();
  if (!known.panels.includes(key) && !known.guide.includes(key)) {
    await interaction.reply({ content: panelText.validate(key, 'x'), ephemeral: true });
    return;
  }
  if (sub === 'get') {
    const cur = panelText.get(key, config);
    const tag = panelText.isOverridden(key) ? 'Changed text' : 'Original text';
    await interaction.reply({ content: `**${key}** (${tag})\n${cur}`.slice(0, 1990), ephemeral: true });
    return;
  }
  if (sub === 'clear') {
    const res = panelText.clear(key, config);
    await interaction.reply({ content: res.ok ? `Cleared. ${key} is back to the original text.` : res.message, ephemeral: true });
    return;
  }
  if (sub === 'set') {
    const modalId = `paneltext:${interaction.id}`;
    const input = new TextInputBuilder()
      .setCustomId('text')
      .setLabel('New text')
      .setStyle(TextInputStyle.Paragraph)
      .setRequired(true)
      .setMaxLength(panelText.MAX_LEN)
      .setValue(panelText.get(key, config).slice(0, panelText.MAX_LEN));
    const modal = new ModalBuilder()
      .setCustomId(modalId)
      .setTitle('Change text')
      .addComponents(new ActionRowBuilder().addComponents(input));
    await interaction.showModal(modal);
    const sub2 = await interaction
      .awaitModalSubmit({ time: 10 * 60 * 1000, filter: (i) => i.customId === modalId && i.user.id === interaction.user.id })
      .catch(() => null);
    if (!sub2) return;
    const res = panelText.set(key, sub2.fields.getTextInputValue('text'), config);
    const msg = res.ok
      ? (key.startsWith('guide.')
        ? 'Saved. The new wording shows on the next /help.'
        : 'Saved. Panels pick it up on their next post or re-post with the /setup commands.')
      : res.message;
    await sub2.reply({ content: msg, ephemeral: true });
  }
}

// ─── /bot-status (staff) ────────────────────────────────────────────
function ago(ms) {
  const m = Math.max(0, Math.floor(ms / 60000));
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function span(ms) {
  const m = Math.floor(ms / 60000);
  const d = Math.floor(m / 1440);
  const h = Math.floor((m % 1440) / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m % 60}m` : `${m}m`;
}

async function reachable(url) {
  try {
    await fetch(url, { signal: AbortSignal.timeout(3000) });
    return true;
  } catch {
    return false;
  }
}

async function botStatus(interaction) {
  if (!isStaff(interaction)) {
    await interaction.reply({ content: 'That command is for staff only.', ephemeral: true });
    return;
  }
  await interaction.deferReply({ ephemeral: true });
  const fs = require('node:fs');
  const path = require('node:path');
  const now = Date.now();
  const version = require('../package.json').version;

  const jobs = require('./job-status').readStatus();
  const jobLines = Object.entries(jobs).map(([name, j]) => {
    const ok = j.lastOk ? new Date(j.lastOk).getTime() : 0;
    const fail = j.lastFail ? new Date(j.lastFail).getTime() : 0;
    if (fail > ok) return `${name}: FAILED ${ago(now - fail)}: ${j.lastError || 'unknown error'}`;
    return `${name}: ok ${ago(now - ok)}`;
  });

  const checks = await Promise.all([
    ['Card API', 'https://oathforsaken.cc/api/cards'],
    ['Wise Old Man', 'https://api.wiseoldman.net/v2'],
    ['RuneProfile', 'https://api.runeprofile.com/v1'],
  ].map(async ([label, url]) => `${label}: ${(await reachable(url)) ? 'reachable' : 'NOT reachable'}`));

  const dataLines = ['membership.json', 'bounties.json', 'job-status.json'].map((f) => {
    try {
      const st = fs.statSync(path.join(__dirname, '..', 'data', f));
      return `${f}: updated ${ago(now - st.mtimeMs)}`;
    } catch {
      return `${f}: no file yet`;
    }
  });

  const jobText = jobLines.length ? jobLines.join('\n') : 'Jobs have not run yet since boot.';
  const embed = new EmbedBuilder()
    .setColor(ZAMORAK_RED)
    .setTitle('Bot status')
    .addFields(
      { name: 'Running', value: `Up for ${span(process.uptime() * 1000)}\nVersion ${version}` },
      { name: 'Jobs', value: jobText.length > 1000 ? `${jobText.slice(0, 997)}...` : jobText },
      { name: 'Services', value: checks.join('\n') },
      { name: 'Data files', value: dataLines.join('\n') },
    );
  await interaction.editReply({ embeds: [embed] });
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
      .setName('setup-rules')
      .setDescription('Post the rules embed (Admin only)')
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
    run: postRules,
  },
    {
      data: new SlashCommandBuilder()
        .setName('setup-ranks')
        .setDescription('Post the clan ranks info embed (Admin only)')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
      run: postRanks,
    },
  {
    data: new SlashCommandBuilder()
      .setName('setup-strikes')
      .setDescription('Post the strike system embed (Admin only)')
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
    run: postStrikes,
  },
  {
    data: new SlashCommandBuilder()
      .setName('warn')
      .setDescription('Give a user a strike (Timeout Members only)')
      .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
      .addUserOption((o) => o.setName('user').setDescription('Who to warn').setRequired(true))
      .addStringOption((o) => o.setName('reason').setDescription('Why').setRequired(true).setMaxLength(1000)),
    run: warnUser,
  },
  {
    data: new SlashCommandBuilder()
      .setName('strikes')
      .setDescription("Show a user's strikes (Timeout Members only)")
      .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
      .addUserOption((o) => o.setName('user').setDescription('Who to check').setRequired(true)),
    run: showStrikes,
  },
  {
    data: new SlashCommandBuilder()
      .setName('clear-strikes')
      .setDescription("Clear a user's strikes (Timeout Members only)")
      .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
      .addUserOption((o) => o.setName('user').setDescription('Who to clear').setRequired(true)),
    run: clearStrikesCmd,
  },
  {
    data: new SlashCommandBuilder()
      .setName('bot-status')
      .setDescription('Show how the bot is doing (Staff only)')
      .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers),
    run: botStatus,
  },
  {
    data: new SlashCommandBuilder()
      .setName('panel-text')
      .setDescription('Change panel and guide wording (Staff only)')
      .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers)
      .addSubcommand((c) => c.setName('list').setDescription('Show the texts you can change'))
      .addSubcommand((c) => c.setName('get').setDescription('Show the current text')
        .addStringOption((o) => o.setName('key').setDescription('Which text').setRequired(true)))
      .addSubcommand((c) => c.setName('set').setDescription('Change a text')
        .addStringOption((o) => o.setName('key').setDescription('Which text').setRequired(true)))
      .addSubcommand((c) => c.setName('clear').setDescription('Go back to the original text')
        .addStringOption((o) => o.setName('key').setDescription('Which text').setRequired(true))),
    run: panelTextCommand,
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
  ...pluginConnect.commands,
  ...guide.commands,
  ...staffLink.commands,
  ...websiteControls.commands,
];

async function handleCommand(interaction) {
  const cmd = commands.find((c) => c.data.name === interaction.commandName);
  if (!cmd) return;
  await cmd.run(interaction);
}

module.exports = { commands, handleCommand };
