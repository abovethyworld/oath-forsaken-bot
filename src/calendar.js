// Clan calendar built on Discord's NATIVE scheduled events — members get the real
// Events tab UI with RSVP/Interested buttons, and Discord notifies them.
// /event-create makes the event + announces it; a background loop (started in
// index.js) sends reminder pings before each event starts.
const { DateTime } = require('luxon');
const {
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

function parseStart(dateStr, timeStr) {
  const tz = (config.calendar && config.calendar.timezone) || 'UTC';
  const dt = DateTime.fromFormat(`${dateStr} ${timeStr}`, 'yyyy-MM-dd HH:mm', { zone: tz });
  return dt.isValid ? dt : null;
}

async function createEvent(interaction) {
  const name = interaction.options.getString('name');
  const date = interaction.options.getString('date');
  const time = interaction.options.getString('time');
  const description = interaction.options.getString('description') || '';
  const voice = interaction.options.getChannel('voice');

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

  await interaction.deferReply({ ephemeral: true });

  const isVoice = voice && voice.type === ChannelType.GuildVoice;
  let event;
  try {
    event = await interaction.guild.scheduledEvents.create({
      name,
      scheduledStartTime: dt.toJSDate(),
      scheduledEndTime: dt.plus({ hours: 2 }).toJSDate(),
      privacyLevel: GuildScheduledEventPrivacyLevel.GuildOnly,
      entityType: isVoice ? GuildScheduledEventEntityType.Voice : GuildScheduledEventEntityType.External,
      ...(isVoice ? { channel: voice.id } : { entityMetadata: { location: 'In-game (Gielinor)' } }),
      description: description.slice(0, 1000),
      reason: `Event created by ${interaction.user.tag}`,
    });
  } catch (err) {
    await interaction.editReply('Could not create the event. Make sure I have the **Manage Events** permission.');
    return;
  }

  const unix = Math.floor(dt.toSeconds());
  const ch = interaction.guild.channels.cache.get(config.calendar.eventsChannelId);
  const ping = config.calendar.pingRoleId ? `<@&${config.calendar.pingRoleId}>` : '';
  if (ch) {
    const embed = new EmbedBuilder()
      .setTitle(`📅 ${name}`)
      .setDescription(`${description}\n\nStarts <t:${unix}:F> (<t:${unix}:R>)`)
      .setColor(0x5865f2);
    await ch.send({ content: `${ping} New clan event!`.trim() || null, embeds: [embed] }).catch(() => {});
  }

  await interaction.editReply(`Event created: **${name}** — <t:${unix}:F>\nMembers can RSVP from the server's Events tab.`);

  // Mirror to Google Calendar if linked (fire and forget)
  if (gcal.isConfigured()) {
    gcal
      .createEvent({
        summary: `[Oath Forsaken] ${name}`,
        description,
        start: dt.toJSDate(),
        end: dt.plus({ hours: 2 }).toJSDate(),
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
    embeds: [new EmbedBuilder().setTitle('📅 Upcoming events').setDescription(lines.join('\n\n')).setColor(0x5865f2)],
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
  const match = [...events.values()].find(
    (e) => e.id === query || e.name.toLowerCase().includes(query.toLowerCase())
  );
  if (!match) {
    await interaction.reply({ content: 'No matching event found.', ephemeral: true });
    return;
  }
  await match.delete().catch(() => {});
  store.clearReminders(match.id);
  await interaction.reply({ content: `Cancelled **${match.name}**.`, ephemeral: true });
}

// Runs on an interval from index.js. Sends each configured reminder once per event.
async function checkReminders(client) {
  try {
    const guild = client.guilds.cache.get(config.guildId);
    if (!guild) return;
    const events = await guild.scheduledEvents.fetch().catch(() => null);
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
          await ch.send(`${ping} ⏰ **${e.name}** starts in ~${r} minutes!`.trim()).catch(() => {});
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

module.exports = { commands, checkReminders };
