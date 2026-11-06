// Handles clicks on role-toggle buttons posted by /setup-roles.
// Button custom IDs look like: "role:<roleId>" or "ticket:<action>"
const { handleTicketButton } = require('./tickets');
const { handleApplyButton } = require('./recruit');
const { handlePollButton } = require('./polls');
const { handleCcButton } = require('./cc-checklist');
const { handleRosterButton } = require('./roster');
const { handleEventButton } = require('./calendar');
const { handleSuggestButton } = require('./suggestions');
const { handleBountyButton } = require('./bounty');
const { handleTeamButton } = require('./teams');
const { handleCompareButton, handleCompareSwapButton, handleCompareAltButton, handleCompareMineButton, handleLeaderboardButton, handleLbSwapButton, handleLbBackButton, handleGainsButton, handleBridgeButton, handleRefreshButton, handleDryCatButton, handleDryViewButton, handleHubButton, handleHubBackButton, handleHubMineButton, handleProfileButton, handleLbProfileButton } = require('./showoff');
const { handleWipeButton } = require('./wipe');
const { handleStaffLinkButton } = require('./staff-link');
const config = require('./config');

function panelRoleIds() {
  const ids = new Set();
  for (const panel of config.rolePanels || []) {
    for (const b of panel.buttons || []) {
      if (b.roleId) ids.add(b.roleId);
    }
  }
  return ids;
}

async function routeButton(interaction) {
  const [kind, roleId] = interaction.customId.split(':');
  if (kind === 'ticket') return handleTicketButton(interaction);
  if (kind === 'stafflink') return handleStaffLinkButton(interaction);
  if (kind === 'apply') return handleApplyButton(interaction);
  if (kind === 'poll') return handlePollButton(interaction);
  if (kind === 'cc') return handleCcButton(interaction);
  if (kind === 'roster') return handleRosterButton(interaction);
  if (kind === 'event') return handleEventButton(interaction);
  if (kind === 'suggest') return handleSuggestButton(interaction);
  if (kind === 'bounty') return handleBountyButton(interaction);
  if (kind === 'team') return handleTeamButton(interaction);
  if (kind === 'cmp') return handleCompareButton(interaction);
  if (kind === 'wipe') return handleWipeButton(interaction);
  if (kind === 'cmpswap') return handleCompareSwapButton(interaction);
  if (kind === 'cmpalt') return handleCompareAltButton(interaction);
  if (kind === 'cmpmine') return handleCompareMineButton(interaction);
  if (kind === 'lbtab' || kind === 'lbg' || kind === 'lbpage' || kind === 'lbvar') return handleLeaderboardButton(interaction);
  if (kind === 'lbswap') return handleLbSwapButton(interaction);
  if (kind === 'lbback') return handleLbBackButton(interaction);
  if (kind === 'gains') return handleGainsButton(interaction);
  if (kind === 'bridge') return handleBridgeButton(interaction);
  if (kind === 'refresh') return handleRefreshButton(interaction);
  if (kind === 'drycat') return handleDryCatButton(interaction);
  if (kind === 'dryview') return handleDryViewButton(interaction);
  if (kind === 'hub') return handleHubButton(interaction);
  if (kind === 'hubback') return handleHubBackButton(interaction);
  if (kind === 'hubmine') return handleHubMineButton(interaction);
  if (kind === 'prof') return handleProfileButton(interaction);
  if (kind === 'lbprof') return handleLbProfileButton(interaction);
  if (kind === 'lbopen') {
    await interaction.reply({
      content: 'That button is from before the board update. Run the command again for the new one.',
      ephemeral: true,
    }).catch(() => {});
    return;
  }
  if (kind === 'donate') {
    await interaction.reply({
      content: '⛧ **Support the Clan** ⛧\n\nDonate here: https://ko-fi.com/oathforsaken\n\nChaos takes all.',
      ephemeral: true,
    });
    return;
  }
  if (kind !== 'role') return;

  if (!panelRoleIds().has(roleId)) {
    await interaction.reply({ content: 'That button is not part of the role panels.', ephemeral: true });
    return;
  }

  const role = interaction.guild.roles.cache.get(roleId);
  if (!role) {
    await interaction.reply({ content: 'That role no longer exists. Tell staff.', ephemeral: true });
    return;
  }

  const member = interaction.member;
  const botMember = interaction.guild.members.me;

  // #1 gotcha with role bots: the bot's own role must sit ABOVE every role it hands out.
  if (botMember && role.position >= botMember.roles.highest.position) {
    await interaction.reply({
      content: `I can't assign **${role.name}**. My bot role sits below it. Move my role above **${role.name}** in Server Settings, under Roles.`,
      ephemeral: true,
    });
    return;
  }

  if (member.roles.cache.has(roleId)) {
    await member.roles.remove(roleId);
    await interaction.reply({ content: `Removed **${role.name}**.`, ephemeral: true });
  } else {
    await member.roles.add(roleId);
    await interaction.reply({ content: `Added **${role.name}**.`, ephemeral: true });
  }
}

module.exports = { routeButton };
