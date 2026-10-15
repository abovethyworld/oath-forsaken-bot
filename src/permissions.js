// Permission drift detection — done correctly.
// Discord resolves View Channel through inheritance:
//   1. Channel's own @everyone overwrite (explicit allow/deny wins)
//   2. Parent category's @everyone overwrite (inherited)
//   3. Default: visible
//
// The 2026-10-15 false positive happened because the old detector checked
// guild-level role permissions instead of per-channel resolved permissions.
// This module always resolves per-channel. Never check base role perms alone.
const { PermissionFlagsBits, SlashCommandBuilder, ChannelType } = require('discord.js');
const config = require('./config');

const VIEW = PermissionFlagsBits.ViewChannel;

// Channel types to check: text, voice, announcement, stage, forum
const CHECK_TYPES = [
  ChannelType.GuildText,
  ChannelType.GuildVoice,
  ChannelType.GuildAnnouncement,
  ChannelType.GuildStageVoice,
  ChannelType.GuildForum,
];

/**
 * Returns true if @everyone can view the channel, resolving
 * Discord's permission inheritance correctly.
 */
function everyoneCanView(channel) {
  const guild = channel.guild;
  if (!guild) return false;
  const everyoneId = guild.id; // @everyone role ID == guild ID

  // Step 1: channel's own overwrite
  const chanOw = channel.permissionOverwrites.cache.get(everyoneId);
  if (chanOw) {
    if (chanOw.deny.has(VIEW)) return false;
    if (chanOw.allow.has(VIEW)) return true;
  }

  // Step 2: parent category inheritance
  if (channel.parent) {
    const catOw = channel.parent.permissionOverwrites.cache.get(everyoneId);
    if (catOw) {
      if (catOw.deny.has(VIEW)) return false;
      if (catOw.allow.has(VIEW)) return true;
    }
  }

  // Step 3: default visible
  return true;
}

/**
 * Returns names of channels visible to @everyone that shouldn't be.
 * expectedIds: array of channel IDs that are intentionally visible.
 */
function findDrift(guild, expectedIds) {
  const expected = new Set(expectedIds || []);
  const drifted = [];
  for (const channel of guild.channels.cache.values()) {
    if (!CHECK_TYPES.includes(channel.type)) continue;
    if (expected.has(channel.id)) continue;
    if (everyoneCanView(channel)) {
      drifted.push(channel.name);
    }
  }
  return drifted;
}

/**
 * Run the drift check. Returns array of drifted channel names (empty = all clear).
 * Logs the result; posts to the drift log channel only if drift is found.
 */
async function checkDrift(client, { silent = false } = {}) {
  try {
    const guild = client.guilds.cache.get(config.guildId);
    if (!guild) {
      console.error('Drift check: guild not found');
      return null;
    }
    const expected = config.permissions?.newMemberVisibleChannels || [];
    const drifted = findDrift(guild, expected);

    if (drifted.length === 0) {
      console.log('Drift check: all clear.');
      return [];
    }

    console.log(`Drift check: ${drifted.length} channel(s) exposed: ${drifted.join(', ')}`);

    if (!silent) {
      const logId = config.permissions?.driftLogChannelId;
      const logChan = logId ? guild.channels.cache.get(logId) : null;
      if (logChan) {
        await logChan.send(
          `**Permission drift detected.** These channels are visible to brand-new members ` +
          `(should only be ${expected.length ? 'the expected ones' : 'rules, clan-ranks, apply-here'}):\n` +
          drifted.map((n) => `• #${n}`).join('\n')
        ).catch((e) => console.error('Drift log post failed:', e.message));
      }
    }
    return drifted;
  } catch (err) {
    console.error('Drift check failed:', err.message);
    return null;
  }
}

async function checkCommand(interaction) {
  await interaction.deferReply({ ephemeral: true });
  const drifted = await checkDrift(interaction.client, { silent: true });
  if (drifted === null) {
    await interaction.editReply('Could not run the check. See console.');
  } else if (drifted.length === 0) {
    await interaction.editReply('All clear. New members can only see the expected channels.');
  } else {
    await interaction.editReply(
      `**Drift found** — ${drifted.length} channel(s) visible to new members that should not be:\n` +
      drifted.map((n) => `• #${n}`).join('\n')
    );
  }
}

const commands = [
  {
    data: new SlashCommandBuilder()
      .setName('check-permissions')
      .setDescription('Check for permission drift (Manage Roles only)')
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles),
    run: checkCommand,
  },
];

module.exports = { commands, everyoneCanView, findDrift, checkDrift };
