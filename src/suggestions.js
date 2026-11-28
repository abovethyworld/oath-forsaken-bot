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
const { ZAMORAK_RED } = require('./utils');
const COOLDOWN_MS = 5 * 60 * 1000;
const cooldowns = new Map();

function suggestionsChannelId() {
  return config.channels && config.channels.suggestions;
}

function isOnCooldown(userId) {
  if (cooldowns.size >= 1000) {
    const nowMs = Date.now();
    for (const [k, at] of cooldowns) {
      if (nowMs - at > COOLDOWN_MS) cooldowns.delete(k);
    }
  }
  return Date.now() - (cooldowns.get(`suggest:${userId}`) || 0) < COOLDOWN_MS;
}

async function handleSuggestButton(interaction) {
  // customId: 'suggest:open', 'suggest:open:anon', 'suggest:open:events'
  // or 'suggest:open:events:anon'
  const eventsAnon = interaction.customId === 'suggest:open:events:anon';
  const anon = interaction.customId === 'suggest:open:anon' || eventsAnon;
  const events = interaction.customId === 'suggest:open:events' || eventsAnon;

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
    .setCustomId(eventsAnon ? 'suggest:modal:events:anon' : events ? 'suggest:modal:events' : anon ? 'suggest:modal:anon' : 'suggest:modal')
    .setTitle(eventsAnon ? 'Suggest an event (anonymous)' : events ? 'Suggest an event' : anon ? 'Suggest an idea (anonymous)' : 'Suggest an idea');
  const titleInput = new TextInputBuilder()
    .setCustomId('suggest:title')
    .setLabel('Title')
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMaxLength(100);
  const detailsInput = new TextInputBuilder()
    .setCustomId('suggest:details')
    .setLabel('Details')
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(true)
    .setMaxLength(1000);
  if (events) {
    titleInput.setPlaceholder('e.g. Wintertodt mass');
    detailsInput.setPlaceholder('What is it, when should we run it, anything else?');
  }
  modal.addComponents(
    new ActionRowBuilder().addComponents(titleInput),
    new ActionRowBuilder().addComponents(detailsInput)
  );
  await interaction.showModal(modal);
}

async function handleSuggestModal(interaction) {
  // customId: 'suggest:modal', 'suggest:modal:anon', 'suggest:modal:events'
  // or 'suggest:modal:events:anon' (index.js only routes 'suggest' modals here).
  const eventsAnon = interaction.customId === 'suggest:modal:events:anon';
  const anon = interaction.customId === 'suggest:modal:anon' || eventsAnon;
  const events = interaction.customId === 'suggest:modal:events' || eventsAnon;

  const title = interaction.fields.getTextInputValue('suggest:title').trim();
  const details = interaction.fields.getTextInputValue('suggest:details').trim();
  if (!title || !details) {
    await interaction
      .reply({ content: 'Title and details cannot be blank.', ephemeral: true })
      .catch(() => {});
    return;
  }

  // Recheck the cooldown here: the check at the button can be bypassed by
  // opening several modals before the first one is submitted.
  if (isOnCooldown(interaction.user.id)) {
    await interaction
      .reply({ content: 'You suggested something recently. Try again in a few minutes.', ephemeral: true })
      .catch(() => {});
    return;
  }

  const channelId = events ? config.channels && config.channels.eventsChat : suggestionsChannelId();
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
          .setStyle(ButtonStyle.Danger)
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

function eventSuggestPanelPayload() {
  return {
    embeds: [
      new EmbedBuilder()
        .setColor(ZAMORAK_RED)
        .setTitle('⛧ Event Suggestions ⛧')
        .setDescription(
          '<:bluepartyhat:1559102058555113583> What events do you want to see us run?\n\n<:fishing:1574219634838732884> Skilling or <:tokjad:1574230189456760862> PvM. If you\'d show up to it, we want it in here.\n\nHit the button, put your idea up, and vote ✅ or ❌ on the ones you\'d come to.'
        ),
    ],
    components: [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId('suggest:open:events')
          .setLabel('Suggest an Event')
          .setStyle(ButtonStyle.Danger)
          .setEmoji('🎉'),
        new ButtonBuilder()
          .setCustomId('suggest:open:events:anon')
          .setLabel('Suggest an Event Anonymously')
          .setStyle(ButtonStyle.Secondary)
          .setEmoji('🕵️')
      ),
    ],
  };
}

module.exports = { handleSuggestButton, handleSuggestModal, suggestPanelPayload, eventSuggestPanelPayload };
