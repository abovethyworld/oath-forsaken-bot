// Staff-only channel wipe panel (posted in #bot-commands).
// The panel button asks for an ephemeral confirmation first;
// confirming bulk-deletes the channel's messages except pinned
// ones and the panel itself. Discord refuses bulk deletes for
// messages older than 14 days, so those are counted and left.
const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { isStaff } = require('./utils');

const FOURTEEN_DAYS = 14 * 24 * 60 * 60 * 1000;
const wiping = new Set();

async function handleWipeButton(interaction) {
  const parts = interaction.customId.split(':');
  const action = parts[1];

  if (action === 'ask') {
    if (!isStaff(interaction)) {
      return interaction.reply({ content: 'Staff only.', ephemeral: true });
    }
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`wipe:confirm:${interaction.message.id}`)
        .setLabel('Yes, wipe it')
        .setStyle(ButtonStyle.Danger),
      new ButtonBuilder()
        .setCustomId('wipe:cancel')
        .setLabel('Cancel')
        .setStyle(ButtonStyle.Secondary),
    );
    return interaction.reply({
      content: `Wipe <#${interaction.channelId}>? Every message goes `
        + 'except pinned ones and the wipe panel. Messages older than '
        + '14 days cannot be bulk deleted and stay.',
      ephemeral: true,
      components: [row],
    });
  }

  if (action === 'cancel') {
    return interaction.update({ content: 'Wipe cancelled.', components: [] });
  }

  if (action === 'confirm') {
    if (!isStaff(interaction)) {
      return interaction.reply({ content: 'Staff only.', ephemeral: true });
    }
    const panelId = parts[2];
    const channel = interaction.channel;
    if (!channel || wiping.has(channel.id)) {
      return interaction.update({
        content: 'A wipe is already running here.', components: [],
      });
    }
    wiping.add(channel.id);
    await interaction.update({ content: 'Wiping...', components: [] });
    let deleted = 0;
    let skippedOld = 0;
    try {
      const pinned = await channel.messages.fetchPinned().catch(() => null);
      const pinnedIds = new Set(pinned ? [...pinned.keys()] : []);
      let before;
      for (let i = 0; i < 50; i++) {
        const batch = await channel.messages.fetch(
          { limit: 100, ...(before ? { before } : {}) });
        if (!batch.size) break;
        before = batch.last().id;
        const now = Date.now();
        const keep = (m) => m.id !== panelId && !pinnedIds.has(m.id);
        const deletable = batch.filter(
          (m) => keep(m) && now - m.createdTimestamp < FOURTEEN_DAYS);
        skippedOld += batch.filter(
          (m) => keep(m) && now - m.createdTimestamp >= FOURTEEN_DAYS).size;
        if (deletable.size === 1) {
          await deletable.first().delete().catch(() => {});
          deleted += 1;
        } else if (deletable.size > 1) {
          const gone = await channel.bulkDelete(deletable, true)
            .catch(() => null);
          deleted += gone ? gone.size : 0;
        }
        if (batch.size < 100) break;
      }
    } finally {
      wiping.delete(channel.id);
    }
    return interaction.followUp({
      content: `Wiped ${deleted} message${deleted === 1 ? '' : 's'} `
        + `from <#${channel.id}>.`
        + (skippedOld
          ? ` ${skippedOld} older than 14 days were left `
            + '(Discord will not bulk delete those).'
          : ''),
      ephemeral: true,
    });
  }
}

module.exports = { handleWipeButton };
