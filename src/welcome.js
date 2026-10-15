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


module.exports = { handleWelcome };
