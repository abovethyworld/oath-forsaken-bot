// Clan calendar built on Discord's NATIVE scheduled events — members get the real
// Events tab UI with RSVP/Interested buttons, and Discord notifies them.
// /event-create makes the event + announces it; a background loop (started in
// index.js) sends reminder pings before each event starts.
const { DateTime } = require('luxon');
const crypto = require('node:crypto');
const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  EmbedBuilder,
  GuildScheduledEventEntityType,
  GuildScheduledEventPrivacyLevel,
  PermissionFlagsBits,
  SlashCommandBuilder,
} = require('discord.js');
const config = require('./config');
const store = require('./store');
const gcal = require('./gcal');

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

function parseStart(dateStr, timeStr) {
  const tz = (config.calendar && config.calendar.timezone) || 'UTC';
  const dt = DateTime.fromFormat(`${dateStr} ${timeStr}`, 'yyyy-MM-dd HH:mm', { zone: tz });
  return dt.isValid ? dt : null;
}

async function createEvent(interaction) {
  const name = interaction.options.getString('name');
  // Discord scheduled event name limit is 100 chars — fail friendly
  if (name.length > 100) {
    await interaction.reply({ content: 'Keep the event name under 100 characters.', ephemeral: true });
    return;
  }
  const date = interaction.options.getString('date');
  const time = interaction.options.getString('time');
  const description = interaction.options.getString('description') || '';
  const voice = interaction.options.getChannel('voice');
  const durationHours = interaction.options.getInteger('duration') || 2;
  const withRoster = interaction.options.getBoolean('roster') || false;

  const dt = parseStart(date, time);
  if (!dt) {
    await interaction.reply({
      content: `Couldn't read that date/time. Use **YYYY-MM-DD** and **HH:MM** (24-hour) in ${(config.calendar && config.calendar.timezone) || 'UTC'} — e.g. \`2026-10-17\` \`19:00\`.`,
      ephemeral: true,
    });
    return;
  }
  if (dt <= DateTime.now()) {
    await interaction.reply({ content: 'That time is in the past.', ephemeral: true });
    return;
  }

  // Confirmation step: show the parsed time as a Discord timestamp (auto-converts
  // to each viewer's timezone) plus the explicit timezone it was read in, so the
  // creator can catch a timezone mistake before the event goes live.
  cleanupPending();
  const pendingId = crypto.randomBytes(6).toString('hex');
  pendingEvents.set(pendingId, {
    expires: Date.now() + PENDING_TTL,
    creatorId: interaction.user.id,
    data: { name, date, time, description, voiceId: voice ? voice.id : null, durationHours, withRoster },
  });
  const unix = Math.floor(dt.toSeconds());
  const tz = (config.calendar && config.calendar.timezone) || 'UTC';
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`event:confirm:${pendingId}`).setLabel('Create Event').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`event:cancel:${pendingId}`).setLabel('Cancel').setStyle(ButtonStyle.Secondary)
  );
  await interaction.reply({
    content:
      `About to create **${name}**\n\n` +
      `I read \`${date} ${time}\` as **${dt.toFormat('cccc, MMM d')} at ${dt.toFormat('h:mm a')}** (${tz}).\n` +
      `In your timezone that shows as <t:${unix}:F>.\n\n` +
      `If that looks wrong, hit Cancel and try again with the ${tz} time.`,
    components: [row],
    ephemeral: true,
  });
  return;
}

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
    await interaction.reply({ content: 'This confirmation expired. Run `/event-create` again.', ephemeral: true }).catch(() => {});
    return;
  }
  if (pending.creatorId !== interaction.user.id) {
    await interaction.reply({ content: 'Only the person who started this event can confirm it.', ephemeral: true }).catch(() => {});
    return;
  }
  pendingEvents.delete(pendingId);

  if (action === 'cancel') {
    await interaction.update({ content: 'Event creation cancelled.', components: [] }).catch(() => {});
    return;
  }

  // Confirmed — create the event
  const { name, description, voiceId, durationHours, withRoster } = pending.data;
  const dt = parseStart(pending.data.date, pending.data.time);
  if (!dt || dt <= DateTime.now()) {
    await interaction.update({ content: 'That time has passed while you were confirming. Run `/event-create` again.', components: [] }).catch(() => {});
    return;
  }

  await interaction.update({ content: 'Creating event...', components: [] }).catch(() => {});

  const voice = voiceId ? interaction.guild.channels.cache.get(voiceId) : null;
  const isVoice = voice && voice.type === ChannelType.GuildVoice;
  let event;
  try {
    event = await interaction.guild.scheduledEvents.create({
      name,
      scheduledStartTime: dt.toJSDate(),
      scheduledEndTime: dt.plus({ hours: durationHours }).toJSDate(),
      privacyLevel: GuildScheduledEventPrivacyLevel.GuildOnly,
      entityType: isVoice ? GuildScheduledEventEntityType.Voice : GuildScheduledEventEntityType.External,
      ...(isVoice ? { channel: voice.id } : { entityMetadata: { location: 'In-game (Gielinor)' } }),
      description: description.slice(0, 1000),
      reason: `Event created by ${interaction.user.tag}`,
    });
  } catch (err) {
    await interaction.followUp({ content: 'Could not create the event. Make sure I have the **Manage Events** permission.', ephemeral: true }).catch(() => {});
    return;
  }

  const unix2 = Math.floor(dt.toSeconds());
  const ch = interaction.guild.channels.cache.get(config.calendar.eventsChannelId);
  const ping = config.calendar.pingRoleId ? `<@&${config.calendar.pingRoleId}>` : '';
  if (ch) {
    const embed = new EmbedBuilder()
      .setTitle(`📅 ${name}`)
      .setDescription(`${description}\n\nStarts <t:${unix2}:F> (<t:${unix2}:R>)`)
      .setColor(0x6b0e0e);
    await ch.send({ content: `${ping} New clan event!`.trim() || null, embeds: [embed], allowedMentions: { roles: config.calendar.pingRoleId ? [config.calendar.pingRoleId] : [] } }).catch((e) => console.error("[calendar.js] Non-fatal error:", e.message));
  }

  await interaction.followUp({ content: `Event created: **${name}** — <t:${unix2}:F>\nMembers can RSVP from the server's Events tab.`, ephemeral: true }).catch(() => {});
  eventsCache = { data: null, at: 0 }; // invalidate — new event exists

  // Optional signup roster in the events channel
  if (withRoster && ch) {
    const { postRoster } = require('./roster');
    await postRoster(ch, name, event.id).catch((e) => console.error('[calendar.js] Roster post failed:', e.message));
  }

  // Mirror to Google Calendar if linked (fire and forget)
  if (gcal.isConfigured()) {
    gcal
      .createEvent({
        summary: `[Oath Forsaken] ${name}`,
        description,
        start: dt.toJSDate(),
        end: dt.plus({ hours: durationHours }).toJSDate(),
        timeZone: config.calendar.timezone,
        calendarId: (config.gcal && config.gcal.calendarId) || 'primary',
      })
      .then(() => console.log(`Mirrored "${name}" to Google Calendar`))
      .catch((err) => console.error('Google Calendar mirror failed:', err.message));
  }
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
    await interaction.reply({ content: 'No upcoming events. Create one with `/event-create`.', ephemeral: true });
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
          store.markReminded(e.id, r);
          await ch.send(`${ping} ⏰ **${e.name}** starts in ~${r} minutes!`.trim()).catch((e) => console.error("[calendar.js] Non-fatal error:", e.message));
        }
      }
    }
  } catch (err) {
    console.error('Reminder check failed:', err.message);
  }
}

const commands = [
  {
    data: new SlashCommandBuilder()
      .setName('event-create')
      .setDescription('Create a clan event (Manage Events only)')
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageEvents)
      .addStringOption((o) => o.setName('name').setDescription('Event name, e.g. "Friday ToA learner raid"').setRequired(true))
      .addStringOption((o) => o.setName('date').setDescription('YYYY-MM-DD').setRequired(true))
      .addStringOption((o) => o.setName('time').setDescription('HH:MM, 24-hour').setRequired(true))
      .addStringOption((o) => o.setName('description').setDescription('What to bring, requirements, etc.'))
      .addChannelOption((o) =>
        o.setName('voice').setDescription('Voice channel to attach (optional)').addChannelTypes(ChannelType.GuildVoice)
      )
      .addIntegerOption((o) =>
        o.setName('duration').setDescription('Duration in hours (default 2)').setMinValue(1).setMaxValue(12)
      )
      .addBooleanOption((o) =>
        o.setName('roster').setDescription('Also post a signup roster (default false)')
      ),
    run: createEvent,
  },
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
