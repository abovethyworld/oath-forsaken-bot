// Google Calendar → Discord event embed (bot idea #11).
// Reads the public "Oath Forsaken Event Calendar" via API key,
// posts a Zamorak-themed 2-week agenda embed in #event-calendar.
// Refreshes daily + on /calendar-sync.
const {
  EmbedBuilder,
  SlashCommandBuilder,
  PermissionFlagsBits,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require('discord.js');

const ZAMORAK_RED = 0x6b0e0e;
const EVENT_CALENDAR_CHANNEL_ID = '1558399108715118702'; // #event-calendar
const CALENDAR_ID = process.env.GCAL_CALENDAR_ID || '';
const API_KEY = process.env.GCAL_API_KEY || '';
// Optional: set these env vars to Discord CDN URLs after uploading to #bot-commands
const THUMBNAIL_URL = process.env.GCAL_THUMBNAIL_URL || '';
const BANNER_URL = process.env.GCAL_BANNER_URL || '';

function publicCalendarUrl() {
  if (!CALENDAR_ID) return 'https://calendar.google.com';
  return `https://calendar.google.com/calendar/embed?src=${encodeURIComponent(CALENDAR_ID)}`;
}

async function fetchEvents() {
  if (!CALENDAR_ID || !API_KEY) {
    console.error('Calendar: GCAL_CALENDAR_ID or GCAL_API_KEY not set');
    return [];
  }
  const now = new Date();
  const twoWeeks = new Date(now.getTime() + 14 * 24 * 3600 * 1000);
  const url =
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(CALENDAR_ID)}/events` +
    `?key=${API_KEY}` +
    `&timeMin=${now.toISOString()}&timeMax=${twoWeeks.toISOString()}` +
    `&singleEvents=true&orderBy=startTime&maxResults=25`;
  try {
    const res = await fetch(url);
    if (!res.ok) {
      console.error('Calendar fetch failed:', res.status);
      return [];
    }
    const data = await res.json();
    return data.items || [];
  } catch (err) {
    console.error('Calendar fetch error:', err.message);
    return [];
  }
}

// Discord timestamp: <t:UNIX:F> renders in each viewer's local timezone.
function discordTimestamp(dateStr) {
  if (!dateStr) return null;
  const d = new Date(dateStr);
  if (isNaN(d)) return null;
  return `<t:${Math.floor(d.getTime() / 1000)}:F>`;
}

function buildEmbed(events) {
  const embed = new EmbedBuilder()
    .setTitle('Oath Forsaken Event Calendar')
    .setColor(ZAMORAK_RED)
    .setDescription('*Upcoming Events over the next 2 weeks*')
    .setFooter({ text: 'Oath Forsaken Event Calendar' })
    .setTimestamp();

  if (THUMBNAIL_URL) embed.setThumbnail(THUMBNAIL_URL);
  if (BANNER_URL) embed.setImage(BANNER_URL);

  if (events.length === 0) {
    embed.addFields({ name: '\u200b', value: '*No events scheduled for the next two weeks.*' });
    return { embed, components: [viewCalendarButton()] };
  }

  for (const ev of events.slice(0, 10)) {
    const name = ev.summary || 'Untitled event';
    const startTs = discordTimestamp(ev.start?.dateTime || ev.start?.date);
    const endTs = discordTimestamp(ev.end?.dateTime || ev.end?.date);
    const isAllDay = ev.start?.date && !ev.start?.dateTime;

    let timeLine;
    if (isAllDay) {
      timeLine = startTs ? `**When:** ${startTs} (all day)` : '**When:** TBD';
    } else {
      timeLine = `**Starts:** ${startTs || 'TBD'}\n**Ends:** ${endTs || 'TBD'}`;
    }

    const desc = ev.description ? `\n\n${ev.description.slice(0, 300)}` : '';
    embed.addFields({
      name: `⛧ ${name}`,
      value: `${timeLine}${desc}`,
    });
  }

  return { embed, components: [viewCalendarButton()] };
}

function viewCalendarButton() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setLabel('View Calendar')
      .setStyle(ButtonStyle.Link)
      .setURL(publicCalendarUrl())
  );
}

async function syncCalendar(client, channelId = EVENT_CALENDAR_CHANNEL_ID) {
  const guild = client.guilds.cache.get(require('./config').guildId);
  if (!guild) return;
  const channel = guild.channels.cache.get(channelId);
  if (!channel) {
    console.error('Calendar: #event-calendar channel not found');
    return;
  }
  const events = await fetchEvents();
  const { embed, components } = buildEmbed(events);

  // Find existing calendar message to update, or post new one
  const messages = await channel.messages.fetch({ limit: 20 }).catch(() => null);
  let existing = null;
  if (messages) {
    existing = messages.find(
      (m) =>
        m.author.id === client.user.id &&
        m.embeds.some(
          (e) =>
            e.title === 'Oath Forsaken Event Calendar' ||
            e.title === '⛧ Upcoming Events ⛧'
        )
    );
  }
  const payload = { embeds: [embed], components };
  if (existing) {
    await existing.edit(payload).catch(() => {});
    console.log('Calendar: updated existing embed');
  } else {
    await channel.send(payload).catch(() => {});
    console.log('Calendar: posted new embed');
  }
}

async function syncCommand(interaction) {
  await interaction.deferReply({ ephemeral: true });
  await syncCalendar(interaction.client);
  await interaction.editReply('Calendar synced.');
}

const commands = [
  {
    data: new SlashCommandBuilder()
      .setName('calendar-sync')
      .setDescription('Refresh the event calendar embed now (Manage Roles only)')
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles),
    run: syncCommand,
  },
];

module.exports = { commands, syncCalendar, fetchEvents, buildEmbed };
