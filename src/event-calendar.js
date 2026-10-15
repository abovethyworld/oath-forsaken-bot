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
const config = require('./config');

const { ZAMORAK_RED, safeFetch } = require('./utils');
const EVENT_CALENDAR_CHANNEL_ID = config.eventCalendar?.channelId; // #event-calendar
const BOT_COMMANDS_CHANNEL_ID = config.eventCalendar?.botCommandsChannelId; // #bot-commands
const CALENDAR_ID = process.env.GCAL_CALENDAR_ID || '';
const API_KEY = process.env.GCAL_API_KEY || '';
// Source messages in #bot-commands holding the embed images (per EMBED_IMAGE_SOURCES.md rule).
// The bot resolves fresh signed CDN URLs from these on each sync so they never expire.
const THUMBNAIL_MSG_ID = process.env.GCAL_THUMBNAIL_MSG_ID || config.eventCalendar?.thumbnailMsgId || '';
const BANNER_MSG_ID = process.env.GCAL_BANNER_MSG_ID || config.eventCalendar?.bannerMsgId || '';
// Fallback static URLs (will expire if they're signed links — prefer message IDs above)
const THUMBNAIL_URL = process.env.GCAL_THUMBNAIL_URL || '';
const BANNER_URL = process.env.GCAL_BANNER_URL || '';

// Cache resolved image URLs for 12h — signed CDN URLs last ~24h,
// so no need to re-fetch the source message on every daily sync.
let imageUrlCache = { thumbnail: null, banner: null, at: 0 };
const IMAGE_CACHE_TTL = 12 * 3600 * 1000;

// Fetch a fresh signed attachment URL from a #bot-commands source message.
async function resolveImageUrl(client, channelId, messageId, fallbackUrl, cacheKey) {
  if (!messageId) return fallbackUrl;
  const now = Date.now();
  if (cacheKey && imageUrlCache[cacheKey] && now - imageUrlCache.at < IMAGE_CACHE_TTL) {
    return imageUrlCache[cacheKey];
  }
  try {
    const guild = client.guilds.cache.get(config.guildId);
    const channel = guild?.channels.cache.get(channelId);
    if (!channel) return fallbackUrl;
    const msg = await safeFetch(channel.messages.fetch(messageId), 'event-calendar fetch');
    const url = msg?.attachments.first()?.url;
    const resolved = url || fallbackUrl;
    if (cacheKey && resolved) {
      imageUrlCache[cacheKey] = resolved;
      imageUrlCache.at = now;
    }
    return resolved;
  } catch {
    return fallbackUrl;
  }
}

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

function buildEmbed(events, thumbnailUrl = THUMBNAIL_URL, bannerUrl = BANNER_URL) {
  const embed = new EmbedBuilder()
    .setTitle('Oath Forsaken Event Calendar')
    .setColor(ZAMORAK_RED)
    .setDescription('*Upcoming Events over the next 2 weeks*')
    .setFooter({ text: 'Oath Forsaken Event Calendar' })
    .setTimestamp();

  if (thumbnailUrl) embed.setThumbnail(thumbnailUrl);
  if (bannerUrl) embed.setImage(bannerUrl);

  if (events.length === 0) {
    embed.addFields({ name: '\u200b', value: '*No events scheduled for the next two weeks.*' });
    return { embed, components: [viewCalendarButton()] };
  }

  const sections = events.slice(0, 10).map((ev, idx) => {
    const name = ev.summary || 'Untitled event';
    const startTs = discordTimestamp(ev.start?.dateTime || ev.start?.date);
    const endTs = discordTimestamp(ev.end?.dateTime || ev.end?.date);
    const isAllDay = ev.start?.date && !ev.start?.dateTime;

    let timeLine;
    if (isAllDay) {
      timeLine = startTs ? `**Starts:** ${startTs} (all day)` : '**Starts:** TBD';
    } else {
      timeLine = `**Starts:** ${startTs || 'TBD'}\n**Ends:** ${endTs || 'TBD'}`;
    }

    const desc = ev.description ? `\n\n${ev.description.slice(0, 300)}` : '';
    return `## ⛧ *${name}*\n\n${timeLine}${desc}`;
  });

  embed.setDescription(
    '*Upcoming Events over the next 2 weeks*\n\n' +
      sections.join('\n\n⛧ ━━━━━━━━━━━━━━━━ ⛧\n\n')
  );

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
  const guild = client.guilds.cache.get(config.guildId);
  if (!guild) return;
  const channel = guild.channels.cache.get(channelId);
  if (!channel) {
    console.error('Calendar: #event-calendar channel not found');
    return;
  }
  const events = await fetchEvents();
  // Resolve fresh signed image URLs so embeds never break on expiry.
  const thumbnailUrl = await resolveImageUrl(client, BOT_COMMANDS_CHANNEL_ID, THUMBNAIL_MSG_ID, THUMBNAIL_URL, 'thumbnail');
  const bannerUrl = await resolveImageUrl(client, BOT_COMMANDS_CHANNEL_ID, BANNER_MSG_ID, BANNER_URL, 'banner');
  const { embed, components } = buildEmbed(events, thumbnailUrl, bannerUrl);

  // Find existing calendar message to update, or post new one
  const messages = await safeFetch(channel.messages.fetch({ limit: 20 }), 'event-calendar scan');
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
    await existing.edit(payload).catch((e) => console.error("[event-calendar.js] Silent failure:", e.message));
    console.log('Calendar: updated existing embed');
  } else {
    await channel.send(payload).catch((e) => console.error("[event-calendar.js] Silent failure:", e.message));
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
