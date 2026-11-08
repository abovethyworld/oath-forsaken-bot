// /help: one index menu, answered privately. The teaching lives in
// the website Bot Guide (one short page per topic); this menu lists
// the commands with their guide one-liners and opens the setup card.
// Content comes from guide-content.json (pages shape, the same file
// the website guide is built from, so the words can never drift
// apart): the live copy sits in the data dir; the bundled src copy
// is the first-boot fallback.
const fs = require('fs');
const path = require('path');
const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  SlashCommandBuilder,
} = require('discord.js');
const { ZAMORAK_RED } = require('./utils');
const { scheduleEphemeralDelete } = require('./auto-delete');

const CONTENT_FILE = path.join(__dirname, '..', 'data', 'guide-content.json');

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

// First content line (short, then fullExtra) starting with the given
// text: the menu lines are the guide pages' own lines, pulled live.
function pageLine(page, startsWith) {
  if (!page) return null;
  const lines = [...(page.short || []), ...(page.fullExtra || [])];
  return lines.find((l) => l.startsWith(startsWith)) || null;
}

function guideUrl(slug) {
  const base = loadContent().siteUrl || 'https://oathforsaken.cc/guide';
  return slug ? `${base}/${slug}/` : `${base}/`;
}

function menuEmbed() {
  const gains = pageBySlug('gains-profile-pbs');
  const cards = [
    pageLine(pageBySlug('boss-cards'), '`/kc'),
    pageLine(pageBySlug('collection-log-cards'), '`/clog`'),
    pageLine(pageBySlug('dry-and-luck'), '`/dry'),
    pageLine(gains, '`/skills`'),
    pageLine(gains, '`/gains`'),
    pageLine(gains, 'Also:'),
    pageLine(pageBySlug('compare'), '`/compare'),
  ].filter(Boolean);
  const clan = [
    pageLine(pageBySlug('events-competitions'), '`/events`'),
    '`/help` - This menu.',
  ].filter(Boolean);
  const text = pageBySlug('text-commands');
  const parts = [
    `Guides for everything are in the [Bot Guide](${guideUrl()}).`,
    '',
    '**Cards**',
    ...cards,
    '',
    '**Clan**',
    ...clan,
  ];
  if (text && (text.short || []).length) parts.push('', text.short[0]);
  return new EmbedBuilder()
    .setTitle('⛧ Bot Guide ⛧')
    .setColor(ZAMORAK_RED)
    .setDescription(parts.join('\n'));
}

function menuButtons() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setStyle(ButtonStyle.Link)
      .setLabel('Bot Guide')
      .setURL(guideUrl()),
    new ButtonBuilder()
      .setStyle(ButtonStyle.Danger)
      .setCustomId('help:setup')
      .setLabel('View Setup Guide')
  );
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
    components: [menuButtons()],
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
];

module.exports = { commands, handleHelpButton };
