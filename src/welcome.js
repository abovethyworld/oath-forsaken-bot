// Welcome message when someone joins the server.
// Requires the "Server Members Intent" enabled in the Developer Portal.
const { EmbedBuilder } = require('discord.js');
const config = require('./config');

async function handleWelcome(member) {
  const w = config.welcome;
  const channel = member.guild.channels.cache.get(config.channels.welcome);
  if (!channel) {
    console.error('Welcome channel not found. Check config.channels.welcome.');
    return;
  }

  const message = w.message
    .replaceAll('{user}', `<@${member.id}>`)
    .replaceAll('{server}', member.guild.name);

  const embed = new EmbedBuilder()
    .setTitle(w.title)
    .setDescription(message)
    .setColor(w.color)
    .setThumbnail(member.user.displayAvatarURL());

  if (w.banner) embed.setImage(w.banner);

  await channel.send({ embeds: [embed] }).catch((err) => {
    console.error('Failed to send welcome message:', err.message);
  });
}


// Sapphire-style join/leave log for the staff #joins-and-leaves channel.
// Pings Staff on join so someone reviews the new member.
async function logMembership(member, joined) {
  const channelId = config.channels.joinsLeaves;
  if (!channelId) return;
  const channel = member.guild.channels.cache.get(channelId);
  if (!channel) return;

  const accountAge = Math.floor((Date.now() - member.user.createdTimestamp) / 86400000);
  const embed = new EmbedBuilder()
    .setTitle(joined ? 'Member joined' : 'Member left')
    .setDescription(`<@${member.id}> (${member.user.tag})\nAccount age: ${accountAge} days`)
    .setColor(joined ? 0x57f287 : 0xed4245)
    .setThumbnail(member.user.displayAvatarURL())
    .setTimestamp()
    .setFooter({ text: `ID: ${member.id}` });

  const content = joined ? '<@&1558735997922054225> New member to review.' : null;
  await channel.send({ content, embeds: [embed] }).catch((err) => {
    console.error('Failed to send join/leave log:', err.message);
  });
}

module.exports = { handleWelcome, logMembership };
