// Launch countdown channel: one pinned message carrying a banner with
// the whole days left until launch, plus Discord timestamps that render
// live in the app. The banner images are pre-rendered under
// assets/countdown/ (the bot image ships zero native dependencies, so
// rasterising the Blood Moon composite happens ahead of time, one file
// per day count); this module picks the file for today's count and
// swaps the attachment once a day, shortly after midnight New York
// time. After launch day the job stops and the message stays as is.
const fs = require('node:fs');
const path = require('node:path');
const { ChannelType, PermissionFlagsBits } = require('discord.js');
const { DateTime } = require('luxon');
const config = require('./config');
const { atomicWrite } = require('./store');

const ZONE = 'America/New_York';
const LAUNCH_DATE = '2026-11-23'; // Monday, November 23, 2026
const LAUNCH_TIME = '12:00'; // noon, America/New_York
const CHANNEL_NAME = '⏳-launch-countdown';
const STATE_FILE = path.join(__dirname, '..', 'data', 'launch-countdown.json');
const ASSET_DIR = path.join(__dirname, '..', 'assets', 'countdown');
const MAX_RENDERED_DAYS = 18; // renders exist for day-01 .. day-18 and today

// The member-view overwrite set mirrors #general as of Nov 5, 2026:
// these four roles can view #general, everyone else is denied at
// @everyone. Staff send access mirrors the read-only panel channels.
const VIEW_ROLE_IDS = [
  '1558621489283211316', // Friend of the Clan
  '1558540434652008569', // Unbound
  '1558540424048803860', // Iron Sworn
  '1558540445611728997', // Guest
];
const STAFF_SEND_ROLE_IDS = [
  '1558578603359207555', // Lord of Chaos
  '1558578608233119765', // Warmonger
];

function launchInstant() {
  return DateTime.fromISO(`${LAUNCH_DATE}T${LAUNCH_TIME}`, { zone: ZONE });
}

function todayInZone(now = DateTime.now().setZone(ZONE)) {
  return now.startOf('day');
}

// Whole calendar days from today (New York) to launch day. Launch day
// itself is 0; days after launch go negative.
function daysRemaining(now = DateTime.now().setZone(ZONE)) {
  const launch = DateTime.fromISO(LAUNCH_DATE, { zone: ZONE }).startOf('day');
  return Math.round(launch.diff(todayInZone(now), 'days').days);
}

function bannerFileFor(days) {
  if (days <= 0) return 'today.jpg';
  const n = Math.min(days, MAX_RENDERED_DAYS);
  return `day-${String(n).padStart(2, '0')}.jpg`;
}

function messageContent() {
  const unix = Math.floor(launchInstant().toSeconds());
  return `**Oath Forsaken launches** <t:${unix}:F>\n<t:${unix}:R>`;
}

function buildOverwrites(client) {
  const { ViewChannel, SendMessages, AttachFiles, ReadMessageHistory, ManageMessages } = PermissionFlagsBits;
  const overwrites = [
    // @everyone: no view, no send (the guild id doubles as the role id).
    { id: config.guildId, type: 0, deny: [ViewChannel, SendMessages] },
  ];
  for (const id of VIEW_ROLE_IDS) {
    overwrites.push({ id, type: 0, allow: [ViewChannel], deny: [SendMessages] });
  }
  for (const id of STAFF_SEND_ROLE_IDS) {
    overwrites.push({ id, type: 0, allow: [ViewChannel, SendMessages] });
  }
  // The bot itself: post, edit, and pin its countdown message.
  overwrites.push({
    id: client.user.id,
    type: 1,
    allow: [ViewChannel, SendMessages, AttachFiles, ReadMessageHistory, ManageMessages],
  });
  return overwrites;
}

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function saveState(state) {
  atomicWrite(STATE_FILE, state);
}

function todayKey(now = DateTime.now().setZone(ZONE)) {
  return now.toISODate();
}

async function fetchStoredMessage(guild, state) {
  const channel = state.channelId ? guild.channels.cache.get(state.channelId) : null;
  if (!channel) return { channel: null, message: null };
  if (!state.messageId) return { channel, message: null };
  try {
    const message = await channel.messages.fetch(state.messageId);
    return { channel, message };
  } catch {
    return { channel, message: null };
  }
}

// Creates the channel and posts the pinned countdown on first run.
// Later runs only top up a missed daily refresh. Every failure is
// logged; nothing here throws into the startup sweep.
async function ensureLaunchCountdown(client) {
  try {
    const guild = client.guilds.cache.get(config.guildId);
    if (!guild) {
      console.error('[launch-countdown] guild not in cache; skipping');
      return;
    }
    const state = loadState();
    let { channel, message } = await fetchStoredMessage(guild, state);

    if (state.channelId && !channel) {
      console.error('[launch-countdown] stored channel is gone; not recreating it');
      return;
    }
    if (state.messageId && channel && !message) {
      console.error('[launch-countdown] stored message is gone; not reposting it');
      return;
    }

    if (!channel) {
      channel = await guild.channels.create({
        name: CHANNEL_NAME,
        type: ChannelType.GuildText,
        position: 0, // no parent category: renders at the very top
        permissionOverwrites: buildOverwrites(client),
      });
      state.channelId = channel.id;
      saveState(state);
      console.log(`[launch-countdown] created channel ${channel.id}`);
    }

    if (!message) {
      const days = daysRemaining();
      if (days < 0) {
        console.error('[launch-countdown] launch day has passed; not posting');
        return;
      }
      message = await channel.send({
        content: messageContent(),
        files: [path.join(ASSET_DIR, bannerFileFor(days))],
      });
      await message.pin();
      state.messageId = message.id;
      state.renderedDate = todayKey();
      saveState(state);
      console.log(`[launch-countdown] posted and pinned message ${message.id} (${days} day(s) left)`);
      return;
    }

    await refreshLaunchCountdown(client);
  } catch (err) {
    console.error('[launch-countdown] ensure failed:', err.message);
  }
}

// Daily refresh: when the New York date has rolled over and launch day
// has not passed, swap the banner for today's day count. The message
// text never changes; its timestamps render live in the app.
async function refreshLaunchCountdown(client, { force = false } = {}) {
  try {
    const days = daysRemaining();
    if (days < 0) return false; // after launch: the job stops
    const state = loadState();
    if (!state.channelId || !state.messageId) return false;
    if (!force && state.renderedDate === todayKey()) return false;

    const guild = client.guilds.cache.get(config.guildId);
    if (!guild) {
      console.error('[launch-countdown] guild not in cache; refresh skipped');
      return false;
    }
    const { channel, message } = await fetchStoredMessage(guild, state);
    if (!channel || !message) {
      console.error('[launch-countdown] stored channel or message missing; refresh skipped');
      return false;
    }
    await message.edit({
      content: messageContent(),
      files: [path.join(ASSET_DIR, bannerFileFor(days))],
    });
    state.renderedDate = todayKey();
    saveState(state);
    console.log(`[launch-countdown] banner refreshed (${days} day(s) left)`);
    return true;
  } catch (err) {
    console.error('[launch-countdown] refresh failed:', err.message);
    return false;
  }
}

module.exports = {
  ensureLaunchCountdown,
  refreshLaunchCountdown,
  daysRemaining,
  bannerFileFor,
  messageContent,
  launchInstant,
  CHANNEL_NAME,
};
