// Google Calendar → Discord event embed (bot idea #11).
// Reads the public "Oath Forsaken Event Calendar" via API key,
// posts a Zamorak-themed 2-week agenda embed in #event-calendar.
// Refreshes daily + on /calendar-sync.
const { EmbedBuilder, SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');

const ZAMORAK_RED = 0x6b0e0e;
const EVENT_CALENDAR_CHANNEL_ID = '1558399108715118702'; // #event-calendar
const CALENDAR_ID = process.env.GCAL_CALENDAR_ID || '';
const API_KEY = process.env.GCAL_API_KEY || '';

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

function formatEventDate(ev) {
  const start = ev.start?.dateTime || ev.start?.date;
  const end = ev.end?.dateTime || ev.end?.date;
  if (!start) return 'TBD';
  const s = new Date(start);
  const opts = { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' };
  const dateStr = s.toLocaleDateString('en-US', { month: 'short', day: 'numeric', weekday: 'short' });
  if (ev.start?.date && !ev.start?.dateTime) return `${dateStr} (all day)`;
  const timeStr = s.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  return `${dateStr} at ${timeStr}`;
}

function buildEmbed(events) {
  const embed = new EmbedBuilder()
    .setTitle('⛧ Upcoming Events ⛧')
    .setColor(ZAMORAK_RED)
    .setFooter({ text: 'Oath Forsaken Event Calendar' })
    .setTimestamp();

  if (events.length === 0) {
    embed.setDescription('*No events scheduled for the next two weeks.*');
    return embed;
  }

  const lines = events.slice(0, 10).map((ev) => {
    const name = ev.summary || 'Untitled event';
    const when = formatEventDate(ev);
    const desc = ev.description ? `\n${ev.description.slice(0, 100)}` : '';
    return `**${name}**\n${when}${desc}`;
  });

  embed.setDescription(lines.join('\n\n⛧ ━━━━━━━━━━━━━━━━ ⛧\n\n'));
  return embed;
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
  const embed = buildEmbed(events);

  // Find existing calendar message to update, or post new one
  const messages = await channel.messages.fetch({ limit: 20 }).catch(() => null);
  let existing = null;
  if (messages) {
    existing = messages.find(
      (m) => m.author.id === client.user.id && m.embeds.some((e) => e.title === '⛧ Upcoming Events ⛧')
    );
  }
  if (existing) {
    await existing.edit({ embeds: [embed] }).catch(() => {});
    console.log('Calendar: updated existing embed');
  } else {
    await channel.send({ embeds: [embed] }).catch(() => {});
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
