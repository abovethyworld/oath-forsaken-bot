// /help: the bot guide, one topic at a time, answered privately.
// Content comes from guide-content.json: the live copy sits in the data
// dir (same file the website guide page is built from, so the words can
// never drift apart); the bundled src copy is the first-boot fallback.
const fs = require('fs');
const path = require('path');
const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
} = require('discord.js');
const { ZAMORAK_RED } = require('./utils');

const CONTENT_FILE = path.join(__dirname, '..', 'data', 'guide-content.json');
const MEMBERS_DIR = path.join(__dirname, '..', 'data', 'plugin-sync', 'members');

let CONTENT = null;
let contentMtime = 0;

function loadContent() {
  try {
    const st = fs.statSync(CONTENT_FILE);
    if (st.mtimeMs !== contentMtime) {
      CONTENT = JSON.parse(fs.readFileSync(CONTENT_FILE, 'utf8'));
      contentMtime = st.mtimeMs;
      console.log(`Guide content loaded from data dir: ${(CONTENT.topics || []).length} topics`);
    }
  } catch {
    if (!CONTENT) {
      try {
        CONTENT = require('./guide-content.json');
      } catch {
        CONTENT = { intro: '', siteUrl: 'https://oathforsaken.cc/guide', topics: [] };
      }
    }
  }
  return CONTENT;
}
loadContent();

function topicById(id) {
  return (loadContent().topics || []).find((t) => t.id === id) || null;
}

function linkedRsns(discordId) {
  let files = [];
  try {
    files = fs.readdirSync(MEMBERS_DIR).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }
  const rsns = [];
  for (const file of files) {
    try {
      const record = JSON.parse(fs.readFileSync(path.join(MEMBERS_DIR, file), 'utf8'));
      if (record && record.discordId === discordId && record.rsn) rsns.push(record.rsn);
    } catch { /* skip unreadable records */ }
  }
  return rsns;
}

function topicMenu() {
  const topics = loadContent().topics || [];
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId('help:topic')
      .setPlaceholder('Pick a topic')
      .addOptions(topics.map((t) => ({ label: t.title, value: t.id })))
  );
}

function guideButton(topicId) {
  const base = loadContent().siteUrl || 'https://oathforsaken.cc/guide';
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setStyle(ButtonStyle.Link)
      .setLabel('Full guide on the website')
      .setURL(topicId ? `${base}#${topicId}` : base)
  );
}

function homeEmbed(user) {
  const content = loadContent();
  const rsns = linkedRsns(user.id);
  const status = rsns.length
    ? `Your linked accounts: ${rsns.join(', ')}`
    : 'No RSN linked yet. The Link RSN button is under the guide post in #bot-guide.';
  const topicList = (content.topics || []).map((t) => `**${t.title}**`).join(' · ');
  return new EmbedBuilder()
    .setTitle('⛧ Bot Guide ⛧')
    .setColor(ZAMORAK_RED)
    .setDescription(
      `${content.intro}\n\n${status}\n\nPick a topic below and the bot answers here, privately. Topics: ${topicList}`
    );
}

function topicEmbed(topic) {
  return new EmbedBuilder()
    .setTitle(`⛧ ${topic.title} ⛧`)
    .setColor(ZAMORAK_RED)
    .setDescription([...(topic.short || []), ...(topic.fullExtra || [])].join('\n\n'));
}

async function helpCommand(interaction) {
  const topicId = interaction.options.getString('topic');
  const topic = topicId ? topicById(topicId) : null;
  if (topic) {
    await interaction.reply({
      embeds: [topicEmbed(topic)],
      components: [topicMenu(), guideButton(topic.id)],
      ephemeral: true,
    });
    return;
  }
  await interaction.reply({
    embeds: [homeEmbed(interaction.user)],
    components: [topicMenu(), guideButton(null)],
    ephemeral: true,
  });
}

async function handleHelpSelect(interaction) {
  const topic = topicById(interaction.values[0]);
  if (!topic) return;
  await interaction.update({
    embeds: [topicEmbed(topic)],
    components: [topicMenu(), guideButton(topic.id)],
  });
}

const commands = [
  {
    data: new SlashCommandBuilder()
      .setName('help')
      .setDescription('Bot guide: pick a topic, get the full version privately')
      .addStringOption((o) =>
        o
          .setName('topic')
          .setDescription('Jump straight to a topic')
          .setRequired(false)
          .addChoices(
            { name: 'RSN Sync', value: 'sync' },
            { name: 'Cards', value: 'cards' },
            { name: 'Text commands', value: 'text-commands' },
            { name: 'Compare', value: 'compare' },
            { name: 'Bounties', value: 'bounties' },
            { name: 'Fixes', value: 'fixes' }
          )
      ),
    run: helpCommand,
  },
];

module.exports = { commands, handleHelpSelect };
