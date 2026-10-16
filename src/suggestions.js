// Suggestions panel: button -> modal -> public post with vote reactions.
// Each suggestion gets ✅/❌ votes and an auto-created discussion thread.
// The panel also offers anonymous submissions (footer shows "Submitted
// anonymously" instead of the author's name).
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

function isOnCooldown(userId) {
  return Date.now() - (cooldowns.get(`suggest:${userId}`) || 0) < COOLDOWN_MS;
}

async function handleSuggestButton(interaction) {
  // customId: 'suggest:open' or 'suggest:open:anon'
  const anon = interaction.customId === 'suggest:open:anon';

  // Check the cooldown here, before the modal opens. A reply to the button
  // press renders reliably on mobile; a reply to the modal submit often
  // does not. The cooldown is only *set* after a successful post.
  if (isOnCooldown(interaction.user.id)) {
    await interaction
      .reply({ content: 'Slow down. One suggestion every few minutes.', ephemeral: true })
      .catch(() => {});
    return;
  }

  const modal = new ModalBuilder()
    .setCustomId(anon ? 'suggest:modal:anon' : 'suggest:modal')
    .setTitle(anon ? 'Suggest an idea (anonymous)' : 'Suggest an idea');
  modal.addComponents(
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('suggest:title')
        .setLabel('Title')
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setMaxLength(100)
    ),
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('suggest:details')
        .setLabel('Details')
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(true)
        .setMaxLength(1000)
    )
  );
  await interaction.showModal(modal);
}

async function handleSuggestModal(interaction) {
  // customId: 'suggest:modal' or 'suggest:modal:anon'
  // (index.js only routes 'suggest' modals here).
  const anon = interaction.customId === 'suggest:modal:anon';

  const title = interaction.fields.getTextInputValue('suggest:title').trim();
  const details = interaction.fields.getTextInputValue('suggest:details').trim();
  if (!title || !details) {
    await interaction
      .reply({ content: 'Title and details cannot be blank.', ephemeral: true })
      .catch(() => {});
    return;
  }

  const channelId = suggestionsChannelId();
  if (!channelId) {
    await interaction
      .reply({ content: 'Suggestions are not set up yet. Tell staff.', ephemeral: true })
      .catch(() => {});
    return;
  }
  const channel = await interaction.client.channels.fetch(channelId).catch(() => null);
  if (!channel) {
    await interaction
      .reply({ content: 'Could not find the suggestions channel. Tell staff.', ephemeral: true })
      .catch(() => {});
    return;
  }

  const embed = new EmbedBuilder()
    .setColor(ZAMORAK_RED)
    .setTitle(title)
    .setDescription(details)
    .setFooter({
      text: anon ? 'Submitted anonymously' : `Suggested by ${interaction.user.displayName}`,
    })
    .setTimestamp();

  let msg;
  try {
    msg = await channel.send({ embeds: [embed] });
  } catch (err) {
    console.error('Suggest post failed:', err.message);
    await interaction
      .reply({ content: 'Could not post that. Tell staff.', ephemeral: true })
      .catch(() => {});
    return;
  }

  await msg.react('✅').catch((err) => console.warn('Suggest react failed:', err.message));
  await msg.react('❌').catch((err) => console.warn('Suggest react failed:', err.message));

  // Discussion thread per suggestion
  const thread = await msg
    .startThread({
      name: `💬 ${title}`.slice(0, 100),
      autoArchiveDuration: 4320,
      reason: 'Suggestion discussion',
    })
    .catch((err) => {
      console.warn('Suggest thread failed:', err.message);
      return null;
    });
  if (thread) {
    await thread
      .send('Discuss this suggestion here. Vote with ✅ or ❌ on the post above.')
      .catch((err) => console.warn('Suggest thread message failed:', err.message));
  }

  // Only burn the cooldown once the post actually landed.
  cooldowns.set(`suggest:${interaction.user.id}`, Date.now());

  await interaction
    .reply({ content: 'Posted. Members can vote with reactions.', ephemeral: true })
    .catch(() => {});
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
