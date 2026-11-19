// Staff-only health channel: bot start-up notes and job failure alerts.
const fs = require('node:fs');
const path = require('node:path');
const { ChannelType } = require('discord.js');
const config = require('./config');
const store = require('./store');

const FILE = path.join(__dirname, '..', 'data', 'bot-health.json');
const CHANNEL_NAME = '𝐁𝐨𝐭 𝐇𝐞𝐚𝐥𝐭𝐡';
const THROTTLE_MS = 60 * 60 * 1000;

const lastSent = new Map();
let pending = null;

function readSaved() {
  try {
    return JSON.parse(fs.readFileSync(FILE, 'utf8')).channelId || null;
  } catch {
    return null;
  }
}

async function resolveChannel(client) {
  const guild = client.guilds.cache.get(config.guildId);
  if (!guild) return null;

  const savedId = readSaved();
  if (savedId) {
    const saved = guild.channels.cache.get(savedId) || await guild.channels.fetch(savedId).catch(() => null);
    if (saved) return saved;
  }

  const staffId = config.ccChecklist?.staffChatId;
  const staff = staffId ? (guild.channels.cache.get(staffId) || await guild.channels.fetch(staffId).catch(() => null)) : null;
  if (!staff) return null;

  let channel = guild.channels.cache.find((c) => c.name === CHANNEL_NAME && c.parentId === staff.parentId);
  if (!channel) {
    const overwrites = [...(staff.permissionOverwrites?.cache?.values() || [])].map((o) => ({
      id: o.id,
      type: o.type,
      allow: o.allow,
      deny: o.deny,
    }));
    channel = await guild.channels.create({
      name: CHANNEL_NAME,
      type: ChannelType.GuildText,
      parent: staff.parentId || undefined,
      permissionOverwrites: overwrites,
    });
  }
  store.atomicWrite(FILE, { channelId: channel.id });
  return channel;
}

// Finds or creates the health channel. Concurrent calls share one run,
// so a second channel is never created.
function ensureHealthChannel(client) {
  if (!pending) {
    pending = resolveChannel(client)
      .catch((e) => { console.error('Health channel setup failed:', e.message); return null; })
      .finally(() => { pending = null; });
  }
  return pending;
}

// Same key at most once an hour. Never throws.
async function alertHealth(client, key, text) {
  try {
    const now = Date.now();
    const last = lastSent.get(key);
    if (last !== undefined && now - last < THROTTLE_MS) return false;
    lastSent.set(key, now);
    const channel = await ensureHealthChannel(client);
    if (!channel) return false;
    await channel.send({ content: String(text).slice(0, 1900) });
    return true;
  } catch (e) {
    console.error('Health alert failed:', e.message);
    return false;
  }
}

module.exports = { ensureHealthChannel, alertHealth, CHANNEL_NAME };
