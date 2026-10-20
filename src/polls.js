// Polls: /poll creates an embed with a button per option; votes toggle live.
// Votes persist in data/polls.json so counts survive restarts.
const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  PermissionFlagsBits,
  SlashCommandBuilder,
} = require('discord.js');
const crypto = require('node:crypto');
const store = require('./store');
const config = require('./config');
const { isStaff } = require('./utils');

// Poll drafts wait here for a staff Post/Deny before they go live.
const STAFF_CHAT_ID = config.ccChecklist?.staffChatId;

const MAX_OPTIONS = 4;

function pollEmbed(poll) {
  const total = Object.keys(poll.votes).length;
  const counts = poll.options.map((_, i) => Object.values(poll.votes).filter((v) => v === i).length);
  const lines = poll.options.map((opt, i) => {
    const c = counts[i];
    const pct = total ? Math.round((c / total) * 100) : 0;
    return `${['1️⃣', '2️⃣', '3️⃣', '4️⃣'][i]} **${opt}** — ${c} vote${c === 1 ? '' : 's'} (${pct}%)`;
  });
  return new EmbedBuilder()
    .setTitle(`📊 ${poll.question}`)
    .setDescription(lines.join('\n') + `\n\n*${total} total vote${total === 1 ? '' : 's'} — click to vote, click again to change*`)
    .setColor(0x6b0e0e)
    .setFooter({ text: `Poll by ${poll.authorTag}` });
}

function pollRows(pollId, options) {
  const rows = [];
  const btns = options.map((opt, i) =>
    new ButtonBuilder()
      .setCustomId(`poll:${pollId}:${i}`)
      .setLabel(opt.slice(0, 80))
      .setStyle(ButtonStyle.Secondary)
      .setEmoji(['1️⃣', '2️⃣', '3️⃣', '4️⃣'][i])
  );
  for (let i = 0; i < btns.length; i += 5) {
    rows.push(new ActionRowBuilder().addComponents(btns.slice(i, i + 5)));
  }
  return rows;
}

async function createPoll(interaction) {
  const question = interaction.options.getString('question');
  // Discord embed title limit is 256 chars — fail friendly instead of API error
  if (question.length > 200) {
    await interaction.reply({ content: 'Keep the question under 200 characters.', ephemeral: true });
    return;
  }
  const options = [];
  for (let i = 1; i <= MAX_OPTIONS; i++) {
    const o = interaction.options.getString(`option${i}`);
    if (o) options.push(o.slice(0, 80));
  }
  if (options.length < 2) {
    await interaction.reply({ content: 'Give at least 2 options.', ephemeral: true });
    return;
  }

  await interaction.deferReply({ ephemeral: true });
  const pollId = crypto.randomBytes(8).toString('hex');
  const poll = {
    id: pollId,
    question,
    options,
    votes: {},
    authorTag: interaction.user.tag,
    authorId: interaction.user.id,
    channelId: interaction.channelId,
    messageId: null,
    createdAt: Date.now(),
    closed: false,
    pending: true,
  };
  const staffChat = STAFF_CHAT_ID ? interaction.guild.channels.cache.get(STAFF_CHAT_ID) : null;
  if (!staffChat) {
    await interaction.editReply({ content: 'Staff review channel is not set up. Tell staff to check the bot config.' });
    return;
  }
  store.savePoll(poll);
  const review = new EmbedBuilder()
    .setTitle(`📊 ${poll.question}`)
    .setDescription(
      poll.options.map((opt, i) => `${['1️⃣', '2️⃣', '3️⃣', '4️⃣'][i]} **${opt}**`).join('\n') +
        `\n\nPoll by ${poll.authorTag} for <#${poll.channelId}>`
    )
    .setColor(0x6b0e0e)
    .setFooter({ text: 'Staff: post it or deny it. It stays here until you do.' });
  await staffChat.send({
    embeds: [review],
    components: [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`poll:gate:${pollId}:post`).setLabel('Post poll').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(`poll:gate:${pollId}:deny`).setLabel('Deny').setStyle(ButtonStyle.Danger)
      ),
    ],
    allowedMentions: { parse: [] },
  });
  await interaction.editReply({
    content: 'Poll sent to staff for approval. It posts in this channel if they approve it.',
  });
}

async function handleGate(interaction, pollId, action) {
  if (!isStaff(interaction)) {
    await interaction.reply({ content: 'Only staff can approve polls.', ephemeral: true });
    return;
  }
  const poll = store.getPoll(pollId);
  if (!poll || !poll.pending) {
    await interaction.reply({ content: 'That poll draft is already handled.', ephemeral: true });
    return;
  }
  if (action === 'post') {
    if (poll.closed) {
      await interaction.update({ content: 'The author closed that poll, so it is not posting.', embeds: [], components: [] });
      return;
    }
    const channel = interaction.guild.channels.cache.get(poll.channelId);
    if (!channel) {
      await interaction.reply({ content: 'That channel is gone. The poll has nowhere to post.', ephemeral: true });
      return;
    }
    const msg = await channel.send({
      embeds: [pollEmbed(poll)],
      components: pollRows(pollId, poll.options),
      allowedMentions: { parse: [] },
    });
    poll.messageId = msg.id;
    poll.pending = false;
    store.savePoll(poll);
    await interaction.update({
      content: `Posted in <#${poll.channelId}> by ${interaction.user.tag}.`,
      embeds: [],
      components: [],
    });
  } else {
    poll.closed = true;
    poll.pending = false;
    poll.denied = true;
    store.savePoll(poll);
    await interaction.update({
      content: `Denied by ${interaction.user.tag}.`,
      embeds: [],
      components: [],
    });
  }
}

async function handlePollButton(interaction) {
  // customId: poll:<pollId>:<optionIdx> | poll:gate:<pollId>:<post|deny>
  const parts = interaction.customId.split(':');
  if (parts[1] === 'gate') return handleGate(interaction, parts[2], parts[3]);
  const [, pollId, idxStr] = parts;
  const poll = store.getPoll(pollId);
  if (!poll) {
    await interaction.reply({ content: 'This poll has expired.', ephemeral: true });
    return;
  }
  if (poll.pending) {
    await interaction.reply({ content: 'This poll is still waiting on staff approval.', ephemeral: true });
    return;
  }
  if (poll.closed) {
    await interaction.reply({ content: 'This poll is closed.', ephemeral: true });
    return;
  }
  const idx = parseInt(idxStr, 10);
  // Validate index is within bounds (prevents crafted customIds)
  if (isNaN(idx) || idx < 0 || idx >= poll.options.length) {
    await interaction.reply({ content: 'Invalid poll option.', ephemeral: true });
    return;
  }
  if (poll.votes[interaction.user.id] === idx) {
    delete poll.votes[interaction.user.id]; // toggle off
  } else {
    poll.votes[interaction.user.id] = idx;
  }
  store.savePoll(poll);
  await interaction.update({
    embeds: [pollEmbed(poll)],
    components: pollRows(pollId, poll.options),
    allowedMentions: { parse: [] },
  });
}

async function closePollCommand(interaction) {
  const mine = store.findOpenPolls(interaction.user.id, interaction.channelId);
  if (mine.length === 0) {
    await interaction.reply({ content: 'No open polls by you in this channel.', ephemeral: true });
    return;
  }
  // Close the most recent one
  mine.sort((a, b) => b.createdAt - a.createdAt);
  const poll = mine[0];
  store.closePoll(poll.id);
  // Update the message to show it's closed
  try {
    const channel = interaction.guild.channels.cache.get(poll.channelId);
    const msg = channel ? await channel.messages.fetch(poll.messageId).catch(() => null) : null;
    if (msg) {
      const embed = EmbedBuilder.from(msg.embeds[0]).setFooter({ text: `Poll by ${poll.authorTag} — closed` });
      await msg.edit({ embeds: [embed], components: [] }).catch(() => {});
    }
  } catch {}
  const total = Object.keys(poll.votes).length;
  await interaction.reply({ content: `Closed **${poll.question}** with ${total} vote${total === 1 ? '' : 's'}.`, ephemeral: true });
}

const commands = [
  {
    data: (() => {
      const b = new SlashCommandBuilder().setName('poll').setDescription('Create a poll with button voting (staff approve it first)');
      b.addStringOption((o) => o.setName('question').setDescription('The question').setRequired(true));
      for (let i = 1; i <= MAX_OPTIONS; i++) {
        b.addStringOption((o) => o.setName(`option${i}`).setDescription(`Option ${i}`).setRequired(i <= 2));
      }
      return b;
    })(),
    run: createPoll,
  },
  {
    data: new SlashCommandBuilder()
      .setName('poll-close')
      .setDescription('Close your most recent open poll in this channel'),
    run: closePollCommand,
  },
];

module.exports = { commands, handlePollButton };
