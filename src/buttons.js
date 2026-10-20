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
  if (kind === 'apply') return handleApplyButton(interaction);
  if (kind === 'poll') return handlePollButton(interaction);
  if (kind === 'cc') return handleCcButton(interaction);
  if (kind === 'roster') return handleRosterButton(interaction);
  if (kind === 'event') return handleEventButton(interaction);
  if (kind === 'suggest') return handleSuggestButton(interaction);
  if (kind === 'bounty') return handleBountyButton(interaction);
  if (kind === 'team') return handleTeamButton(interaction);
  if (kind === 'donate') {
    await interaction.reply({
      content: '⛧ **Support the Clan** ⛧\n\nDonate here: https://ko-fi.com/oathforsaken\n\nEvery bit helps. Chaos takes all.',
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
    await interaction.reply({ content: 'That role no longer exists. Tell staff to update the config.', ephemeral: true });
    return;
  }

  const member = interaction.member;
  const botMember = interaction.guild.members.me;

  // #1 gotcha with role bots: the bot's own role must sit ABOVE every role it hands out.
  if (botMember && role.position >= botMember.roles.highest.position) {
    await interaction.reply({
      content: `I can't assign **${role.name}** — my bot role sits below it.\nFix: Server Settings → Roles → drag my role above **${role.name}**.`,
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
