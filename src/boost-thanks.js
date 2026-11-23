// Boost thank-you (Nov 23, 2026): when a member boosts the server,
// Discord drops a system message in chat. The bot answers with one
// thank-you post in General, in approved wording.
const { MessageType } = require('discord.js');
const config = require('./config');

const BOOST_TYPES = new Set([
  MessageType.GuildBoost,
  MessageType.GuildBoostTier1,
  MessageType.GuildBoostTier2,
  MessageType.GuildBoostTier3,
]);

function boostThanksText(userId) {
  return `⛧ **Server Boost** ⛧\nThe Forsaken grow stronger. <@${userId}> just boosted the server. Thank you.`;
}

async function handleBoostMessage(message) {
  try {
    if (!message || !message.guild) return false;
    if (!BOOST_TYPES.has(message.type)) return false;
    // System boost messages carry the booster as the author; bots never boost.
    if (!message.author || message.author.bot) return false;
    const channelId = config.channels && config.channels.general;
    if (!channelId) return false;
    const channel =
      message.guild.channels.cache.get(channelId) ||
      (await message.client.channels.fetch(channelId).catch(() => null));
    if (!channel) return false;
    await channel.send(boostThanksText(message.author.id));
    return true;
  } catch (e) {
    console.error('[boost] thank-you post failed:', e.message);
    return false;
  }
}

module.exports = { handleBoostMessage, boostThanksText, BOOST_TYPES };
