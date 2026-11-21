// Clan events: /event-create was removed 2026-11-21 (events live on
// Google Calendar and Sesh handles RSVPs). What remains here reads any
// Discord scheduled events still on the server: /events lists them,
// /event-cancel cancels them, and a background loop (started in
// index.js) sends reminder pings before each one starts.
const crypto = require('node:crypto');
const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  PermissionFlagsBits,
  SlashCommandBuilder,
} = require('discord.js');
const config = require('./config');
const store = require('./store');

// Pending event confirmations: pendingId -> { data, expires }. Prevents
// timezone surprises — the creator sees the auto-converting time before it goes live.
const pendingEvents = new Map();
const PENDING_TTL = 5 * 60 * 1000;

function cleanupPending() {
  const now = Date.now();
  for (const [k, v] of pendingEvents) {
    if (now > v.expires) pendingEvents.delete(k);
  }
}

// Shared event cache (declared early — used by handleEventButton above getEvents)
let eventsCache = { data: null, at: 0 };

async function handleEventButton(interaction) {
  // customId: event:confirm:<pendingId>, event:confirmcancel:<pendingId>, or event:cancel:<pendingId>
  const parts = interaction.customId.split(':');
  const action = parts[1];
  const pendingId = parts[2];
  if (action === 'confirmcancel') {
    return handleCancelConfirm(interaction, pendingId);
  }
  const pending = pendingEvents.get(pendingId);
  if (!pending || Date.now() > pending.expires) {
    pendingEvents.delete(pendingId);
    await interaction.reply({ content: 'This confirmation expired.', ephemeral: true }).catch(() => {});
    return;
  }
  if (pending.creatorId !== interaction.user.id) {
    await interaction.reply({ content: 'Only the person who started this event can confirm it.', ephemeral: true }).catch(() => {});
    return;
  }
  pendingEvents.delete(pendingId);

  if (action === 'cancel') {
    // The cancel-event confirm's "Keep it" button.
    await interaction.update({ content: 'Event kept.', components: [] }).catch(() => {});
    return;
  }

  // Any other action was the removed creation confirm.
  await interaction.update({ content: 'This confirmation has expired.', components: [] }).catch(() => {});
}

async function listEvents(interaction) {
  const events = await interaction.guild.scheduledEvents.fetch().catch(() => null);
  if (!events) {
    await interaction.reply({ content: 'Could not read events.', ephemeral: true });
    return;
  }
  const upcoming = [...events.values()]
    .filter((e) => e.scheduledStartTimestamp > Date.now())
    .sort((a, b) => a.scheduledStartTimestamp - b.scheduledStartTimestamp)
    .slice(0, 10);
  if (upcoming.length === 0) {
    await interaction.reply({ content: 'No upcoming events.', ephemeral: true });
    return;
  }
  const lines = upcoming.map((e) => {
    const u = Math.floor(e.scheduledStartTimestamp / 1000);
    return `**${e.name}** — <t:${u}:F> (<t:${u}:R>)${e.description ? `\n${e.description}` : ''}`;
  });
  await interaction.reply({
    embeds: [new EmbedBuilder().setTitle('📅 Upcoming events').setDescription(lines.join('\n\n')).setColor(0x6b0e0e)],
    ephemeral: true,
  });
}

async function cancelEvent(interaction) {
  const query = interaction.options.getString('name');
  const events = await interaction.guild.scheduledEvents.fetch().catch(() => null);
  if (!events) {
    await interaction.reply({ content: 'Could not read events.', ephemeral: true });
    return;
  }
  const matches = [...events.values()].filter(
    (e) => e.id === query || e.name.toLowerCase().includes(query.toLowerCase())
  );
  if (matches.length === 0) {
    await interaction.reply({ content: 'No matching event found.', ephemeral: true });
    return;
  }
  if (matches.length > 1) {
    const list = matches.map((e) => `• **${e.name}** (ID: \`${e.id}\`)`).join('\n');
    await interaction.reply({
      content: `Multiple events match. Be more specific or use the ID:\n${list}`,
      ephemeral: true,
    });
    return;
  }
  const match = matches[0];
  // Confirmation — deletion is destructive and has no undo
  cleanupPending();
  const pendingId = crypto.randomBytes(6).toString('hex');
  pendingEvents.set(pendingId, {
    expires: Date.now() + PENDING_TTL,
    creatorId: interaction.user.id,
    data: { cancelEventId: match.id, cancelEventName: match.name },
  });
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`event:confirmcancel:${pendingId}`).setLabel(`Cancel "${match.name.slice(0, 40)}"`).setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`event:cancel:${pendingId}`).setLabel('Keep it').setStyle(ButtonStyle.Secondary)
  );
  await interaction.reply({
    content: `Cancel **${match.name}**? This cannot be undone.`,
    components: [row],
    ephemeral: true,
  });
}

async function handleCancelConfirm(interaction, pendingId) {
  const pending = pendingEvents.get(pendingId);
  if (!pending || Date.now() > pending.expires) {
    pendingEvents.delete(pendingId);
    await interaction.reply({ content: 'This confirmation expired.', ephemeral: true }).catch(() => {});
    return;
  }
  if (pending.creatorId !== interaction.user.id) {
    await interaction.reply({ content: 'Only the person who started this can confirm it.', ephemeral: true }).catch(() => {});
    return;
  }
  pendingEvents.delete(pendingId);
  const { cancelEventId, cancelEventName } = pending.data;
  const events = await interaction.guild.scheduledEvents.fetch().catch(() => null);
  const match = events ? [...events.values()].find((e) => e.id === cancelEventId) : null;
  if (!match) {
    await interaction.update({ content: 'Event no longer exists.', components: [] }).catch(() => {});
    return;
  }
  await match.delete().catch((e) => console.error("[calendar.js] Non-fatal error:", e.message));
  store.clearReminders(match.id);
  eventsCache = { data: null, at: 0 }; // invalidate — event deleted
  await interaction.update({ content: `Cancelled **${cancelEventName}**.`, components: [] }).catch(() => {});
}

// Runs on an interval from index.js. Sends each configured reminder once per event.
// Events cached for 2 min — no need to hit the API every 5 min when nothing changes.
const EVENTS_CACHE_TTL = 2 * 60 * 1000;

async function getEvents(guild) {
  const now = Date.now();
  if (eventsCache.data && now - eventsCache.at < EVENTS_CACHE_TTL) {
    return eventsCache.data;
  }
  const events = await guild.scheduledEvents.fetch().catch(() => null);
  if (events) {
    eventsCache = { data: events, at: now };
  }
  return eventsCache.data;
}

async function syncReminders(client) {
  try {
    const guild = client.guilds.cache.get(config.guildId);
    if (!guild) return;
    const events = await getEvents(guild);
    if (!events) return;

    store.pruneReminders([...events.keys()]);

    const now = Date.now();
    const ch = guild.channels.cache.get(config.calendar.eventsChannelId);
    if (!ch) return;
    const ping = config.calendar.pingRoleId ? `<@&${config.calendar.pingRoleId}>` : '';

    for (const e of events.values()) {
      const minsLeft = (e.scheduledStartTimestamp - now) / 60000;
      if (minsLeft <= 0) continue;
      for (const r of config.calendar.reminders || [60, 15]) {
        if (minsLeft <= r && !store.wasReminded(e.id, r)) {
          const where = e.channelId ? ` Meet in <#${e.channelId}>.`
            : (e.entityMetadata && e.entityMetadata.location ? ` Where: ${e.entityMetadata.location}.` : '');
          const sent = await ch.send(`${ping} ⏰ **${e.name}** starts in ~${r} minutes!${where}`.trim()).catch((e) => console.error("[calendar.js] Non-fatal error:", e.message));
          // Only mark as reminded once the ping actually went out — marking
          // first would permanently eat the reminder if the send failed.
          if (sent) store.markReminded(e.id, r);
        }
      }
    }
  } catch (err) {
    console.error('Reminder check failed:', err.message);
  }
}

const commands = [
  {
    data: new SlashCommandBuilder().setName('events').setDescription('List upcoming clan events'),
    run: listEvents,
  },
  {
    data: new SlashCommandBuilder()
      .setName('event-cancel')
      .setDescription('Cancel a clan event (Manage Events only)')
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageEvents)
      .addStringOption((o) => o.setName('name').setDescription('Event name or ID').setRequired(true)),
    run: cancelEvent,
  },
];

module.exports = { commands, syncReminders, handleEventButton };
