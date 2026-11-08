// /help: one index menu, answered privately. The teaching lives in
// the website Bot Guide (one short page per topic); this menu lists
// every member command as a slash mention plus one plain sentence,
// and opens the setup card. /staff-help is the same shape for staff
// commands, gated on Moderate Members. Setup card content comes from
// guide-content.json (the same file the website guide is built
// from, so the words can never drift apart): the live copy sits in
// the data dir; the bundled src copy is the first-boot fallback.
const fs = require('fs');
const path = require('path');
const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  PermissionFlagsBits,
  SlashCommandBuilder,
} = require('discord.js');
const { ZAMORAK_RED } = require('./utils');
const { scheduleEphemeralDelete } = require('./auto-delete');

const CONTENT_FILE = path.join(__dirname, '..', 'data', 'guide-content.json');
const LOGO_URL = 'https://oathforsaken.cc/assets/server-icon-helm.gif';

let CONTENT = null;
let contentMtime = 0;

function loadContent() {
  try {
    const st = fs.statSync(CONTENT_FILE);
    if (st.mtimeMs !== contentMtime) {
      CONTENT = JSON.parse(fs.readFileSync(CONTENT_FILE, 'utf8'));
      contentMtime = st.mtimeMs;
      console.log(`Guide content loaded from data dir: ${(CONTENT.pages || []).length} pages`);
    }
  } catch {
    if (!CONTENT) {
      try {
        CONTENT = require('./guide-content.json');
      } catch {
        CONTENT = { intro: '', siteUrl: 'https://oathforsaken.cc/guide', pages: [] };
      }
    }
  }
  return CONTENT;
}
loadContent();

function pageBySlug(slug) {
  return (loadContent().pages || []).find((p) => p.slug === slug) || null;
}

function guideUrl(slug) {
  const base = loadContent().siteUrl || 'https://oathforsaken.cc/guide';
  return slug ? `${base}/${slug}/` : `${base}/`;
}

// Slash mention pills (</name:id>) need the registered command ids.
// index.js hands them over after registration; until then (and in
// tests) a name renders as plain code text instead of a pill.
let commandIds = new Map();

function setCommandIds(map) {
  if (map && typeof map.get === 'function') commandIds = map;
}

function mention(name) {
  const id = commandIds.get(name);
  return id ? `</${name}:${id}>` : `\`/${name}\``;
}

// One plain sentence per command. These lines are member-facing
// copy: short, direct, no flavor, and they end with periods.
const MEMBER_GROUPS = [
  ['Your account', [
    ['connect', 'Get a code that links the clan plugin to your Discord.'],
    ['unlink', 'Remove an RSN from your linked names.'],
  ]],
  ['Cards', [
    ['kc', 'Posts the kill count and collection log card for a boss.'],
    ['clog', 'Posts your collection log card, or one page of it.'],
    ['dry', 'Posts what you are dry on at a boss, and your luck.'],
    ['skills', 'Posts the skill levels card for you or another player.'],
    ['gains', 'Posts the XP and KC gained over the last day, week, month, or year.'],
    ['profile', 'Posts the profile card for you or another player.'],
    ['pb', 'Posts the personal best card for you or another player.'],
    ['leaderboard', 'Posts the clan leaderboards.'],
    ['compare', 'Compares two players on one card.'],
  ]],
  ['Clan', [
    ['events', 'Lists the events coming up in the server.'],
    ['poll', 'Creates a poll with button voting that staff approve first.'],
    ['poll-close', 'Closes your most recent open poll in this channel.'],
    ['lore', 'Posts a random piece of Zamorak lore.'],
    ['help', 'Opens this help menu.'],
  ]],
];

const STAFF_GROUPS = [
  ['Strikes', [
    ['warn', 'Gives a member a strike and logs the reason.'],
    ['strikes', 'Shows the strikes recorded for a member.'],
    ['clear-strikes', 'Clears every strike recorded for a member.'],
  ]],
  ['Members', [
    ['seniority-hold', "Puts a hold on a member's seniority rank, or releases it."],
    ['sync-seniority', 'Runs the seniority rank check now.'],
    ['apply-stats', 'Shows the application funnel counts.'],
    ['reset-application', "Clears a member's application so they can apply again."],
    ['force-unlink', 'Clears an RSN link for a member.'],
    ['link-rsn-panel', 'Posts the staff Link an RSN panel in its thread.'],
  ]],
  ['Events', [
    ['event-create', 'Creates a clan event.'],
    ['event-cancel', 'Cancels a clan event.'],
    ['roster', 'Posts a signup roster for an event.'],
    ['calendar-sync', 'Refreshes the event calendar post now.'],
  ]],
  ['Bounties', [
    ['bounty', 'Posts a bounty contract from the pool.'],
  ]],
  ['Server setup', [
    ['setup-roles', 'Posts the button role panels.'],
    ['setup-rules', 'Posts the rules post.'],
    ['setup-ranks', 'Posts the clan ranks post.'],
    ['setup-strikes', 'Posts the strike system post.'],
    ['setup-tickets', 'Posts the ticket panel.'],
    ['setup-cc-checklist', 'Posts the CC rank checklist in the staff chat.'],
    ['setup-applications', 'Posts the application panel in this channel.'],
    ['setup-team-panel', 'Posts the team finder panel.'],
    ['website-controls-panel', 'Posts the staff website controls panel in its thread.'],
    ['check-permissions', 'Checks the server for permission drift.'],
  ]],
];

function commandListParts(groups) {
  const parts = [];
  for (const [heading, lines] of groups) {
    parts.push(`**${heading}**`);
    for (const [name, sentence] of lines) parts.push(`${mention(name)} - ${sentence}`);
    parts.push('');
  }
  parts.pop();
  return parts;
}

function menuEmbed() {
  const parts = [
    `Guides for everything are in the [Bot Guide](${guideUrl()}).`,
    '',
    ...commandListParts(MEMBER_GROUPS),
  ];
  return new EmbedBuilder()
    .setTitle('Help Menu')
    .setColor(ZAMORAK_RED)
    .setThumbnail(LOGO_URL)
    .setDescription(parts.join('\n'));
}

function menuButtons() {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setStyle(ButtonStyle.Link)
        .setLabel('Bot Guide ↗')
        .setURL(guideUrl())
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setStyle(ButtonStyle.Danger)
        .setCustomId('help:setup')
        .setLabel('View Setup Guide')
    ),
  ];
}

function staffHelpEmbed() {
  return new EmbedBuilder()
    .setTitle('Staff Help')
    .setColor(ZAMORAK_RED)
    .setThumbnail(LOGO_URL)
    .setDescription(commandListParts(STAFF_GROUPS).join('\n'));
}

function setupEmbed() {
  const start = pageBySlug('getting-started');
  const safety = pageBySlug('safety');
  const parts = start ? [...(start.short || [])] : [];
  const scamLine = safety
    ? (safety.short || []).find((l) => l.includes('Jagex login'))
    : null;
  if (scamLine) parts.push(scamLine);
  return new EmbedBuilder()
    .setTitle('⛧ Getting started with Oath Forsaken ⛧')
    .setColor(ZAMORAK_RED)
    .setDescription(parts.join('\n\n'));
}

function setupButtons() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setStyle(ButtonStyle.Danger)
      .setCustomId('team:rsn')
      .setLabel('Link your RSN'),
    new ButtonBuilder()
      .setStyle(ButtonStyle.Link)
      .setLabel('Bot Guide')
      .setURL(guideUrl()),
    new ButtonBuilder()
      .setStyle(ButtonStyle.Link)
      .setLabel('Safety')
      .setURL(guideUrl('safety'))
  );
}

async function helpCommand(interaction) {
  await interaction.reply({
    embeds: [menuEmbed()],
    components: menuButtons(),
    ephemeral: true,
  });
  scheduleEphemeralDelete(interaction);
}

async function staffHelpCommand(interaction) {
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.ModerateMembers)) {
    await interaction.reply({ content: 'You do not have permission to use this command.', ephemeral: true });
    return;
  }
  await interaction.reply({
    embeds: [staffHelpEmbed()],
    ephemeral: true,
  });
  scheduleEphemeralDelete(interaction);
}

async function handleHelpButton(interaction) {
  if (interaction.customId !== 'help:setup') return;
  await interaction.reply({
    embeds: [setupEmbed()],
    components: [setupButtons()],
    ephemeral: true,
  });
  scheduleEphemeralDelete(interaction);
}

const commands = [
  {
    data: new SlashCommandBuilder()
      .setName('help')
      .setDescription('Bot guide, answered privately'),
    run: helpCommand,
  },
  {
    data: new SlashCommandBuilder()
      .setName('staff-help')
      .setDescription('Staff commands, answered privately')
      .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers),
    run: staffHelpCommand,
  },
];

module.exports = { commands, handleHelpButton, setCommandIds };
