// Suggestions panel: button -> modal -> public post with vote reactions.
// Members see suggestions; posting goes through the panel so every entry
// has the same shape. Staff react to accept/deny.
const {
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
} = require('discord.js');
const config = require('./config');

const ZAMORAK_RED = 0x6b0e0e;
const COOLDOWN_MS = 5 * 60 * 1000;
const cooldowns = new Map();

function suggestionsChannelId() {
  return config.channels && config.channels.suggestions;
}

async function handleSuggestButton(interaction) {
  // customId: 'suggest:open' or 'suggest:open:anon'
  const anon = interaction.customId === 'suggest:open:anon';
  const modal = new ModalBuilder()
    .setCustomId(anon ? 'suggest:modal:anon' : 'suggest:modal')
    .setTitle(anon ? 'Suggest an idea (anonymous)' : 'Suggest an idea');
  modal.addComponents(
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('title')
        .setLabel('Title')
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setMaxLength(100)
    ),
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('details')
        .setLabel('Details')
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(true)
        .setMaxLength(1000)
    )
  );
  await interaction.showModal(modal);
}

async function handleSuggestModal(interaction) {
  // customId: 'suggest:modal' or 'suggest:modal:anon'. Returns true if handled.
  if (!interaction.customId.startsWith('suggest:')) return false;
  const anon = interaction.customId === 'suggest:modal:anon';

  const now = Date.now();
  const key = `suggest:${interaction.user.id}`;
  if (now - (cooldowns.get(key) || 0) < COOLDOWN_MS) {
    await interaction
      .reply({ content: 'Slow down. One suggestion every few minutes.', ephemeral: true })
      .catch(() => {});
    return true;
  }
  cooldowns.set(key, now);

  const title = interaction.fields.getTextInputValue('title').trim();
  const details = interaction.fields.getTextInputValue('details').trim();
  const channelId = suggestionsChannelId();
  if (!channelId) {
    await interaction
      .reply({ content: 'Suggestions are not set up yet. Tell staff.', ephemeral: true })
      .catch(() => {});
    return true;
  }
  const channel = await interaction.client.channels.fetch(channelId).catch(() => null);
  if (!channel) {
    await interaction
      .reply({ content: 'Could not find the suggestions channel. Tell staff.', ephemeral: true })
      .catch(() => {});
    return true;
  }
  const embed = new EmbedBuilder()
    .setColor(ZAMORAK_RED)
    .setTitle(title)
    .setDescription(details)
    .setFooter({ text: anon ? 'Submitted anonymously' : `Suggested by ${interaction.user.tag}` })
    .setTimestamp();
  const msg = await channel.send({ embeds: [embed] });
  await msg.react('✅').catch(() => {});
  await msg.react('❌').catch(() => {});
  // Discussion thread per suggestion
  const thread = await msg
    .startThread({
      name: `💬 ${title}`.slice(0, 100),
      autoArchiveDuration: 4320,
      reason: 'Suggestion discussion',
    })
    .catch(() => null);
  if (thread) {
    await thread
      .send('Discuss this suggestion here. Vote with ✅ or ❌ on the post above.')
      .catch(() => {});
  }
  await interaction
    .reply({ content: 'Posted. Members can vote with reactions.', ephemeral: true })
    .catch(() => {});
  return true;
}

function suggestPanelPayload() {
  return {
    embeds: [
      new EmbedBuilder()
        .setColor(ZAMORAK_RED)
        .setTitle('⛧ Suggestions ⛧')
        .setDescription(
          'Got an idea for the clan? Events, channels, bots, anything.\n\nClick the button and have the clan vote on it!'
        ),
    ],
    components: [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId('suggest:open')
          .setLabel('Submit Suggestion')
          .setStyle(ButtonStyle.Primary)
          .setEmoji('💡'),
        new ButtonBuilder()
          .setCustomId('suggest:open:anon')
          .setLabel('Submit Anonymously')
          .setStyle(ButtonStyle.Secondary)
          .setEmoji('🕵️')
      ),
    ],
  };
}

module.exports = { handleSuggestButton, handleSuggestModal, suggestPanelPayload };
