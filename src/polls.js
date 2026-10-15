// Polls: /poll creates an embed with a button per option; votes toggle live.
// Votes persist in data/polls.json so counts survive restarts.
const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  SlashCommandBuilder,
} = require('discord.js');
const store = require('./store');

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
    .setColor(0x5865f2)
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
  const options = [];
  for (let i = 1; i <= MAX_OPTIONS; i++) {
    const o = interaction.options.getString(`option${i}`);
    if (o) options.push(o);
  }
  if (options.length < 2) {
    await interaction.reply({ content: 'Give at least 2 options.', ephemeral: true });
    return;
  }

  await interaction.deferReply();
  const crypto = require('node:crypto');
  const pollId = crypto.randomBytes(8).toString('hex');
  const poll = {
    id: pollId,
    question,
    options,
    votes: {},
    authorTag: interaction.user.tag,
    channelId: interaction.channelId,
    messageId: null,
  };
  const msg = await interaction.editReply({
    embeds: [pollEmbed(poll)],
    components: pollRows(pollId, options),
    allowedMentions: { parse: [] }, // block @everyone/@here in poll text
  });
  poll.messageId = msg.id;
  store.savePoll(poll);
}

async function handlePollButton(interaction) {
  // customId: poll:<pollId>:<optionIdx>
  const [, pollId, idxStr] = interaction.customId.split(':');
  const poll = store.getPoll(pollId);
  if (!poll) {
    await interaction.reply({ content: 'This poll has expired.', ephemeral: true });
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

const commands = [
  {
    data: (() => {
      const b = new SlashCommandBuilder().setName('poll').setDescription('Create a poll with button voting');
      b.addStringOption((o) => o.setName('question').setDescription('The question').setRequired(true));
      for (let i = 1; i <= MAX_OPTIONS; i++) {
        b.addStringOption((o) => o.setName(`option${i}`).setDescription(`Option ${i}`).setRequired(i <= 2));
      }
      return b;
    })(),
    run: createPoll,
  },
];

module.exports = { commands, handlePollButton };
