// Time-in-service (tenure) ranks, shown as separate groups in the member list.
// A daily loop assigns each member the seniority role matching their server
// join date: Initiate (<1 mo) -> Acolyte (1-2) -> Bloodsworn (3-5) ->
// Revenant (6-8) -> Heretic (9-11) -> Godslayer (1 yr+).
// Brackets come from config.seniorityRanks. /sync-seniority runs it on demand.
const { PermissionFlagsBits, SlashCommandBuilder } = require('discord.js');
const config = require('./config');

const MONTH_MS = 30.44 * 24 * 3600 * 1000;

// Highest tier the member qualifies for (handles gaps between brackets).
function rankForMonths(months) {
  const ranks = [...(config.seniorityRanks || [])].sort((a, b) => a.minMonths - b.minMonths);
  let best = null;
  for (const r of ranks) {
    if (months >= r.minMonths) best = r;
  }
  return best;
}

async function syncSeniority(client) {
  try {
    const ranks = config.seniorityRanks || [];
    if (ranks.length === 0) return;
    const guild = client.guilds.cache.get(config.guildId);
    if (!guild) return;
    const rankIds = ranks.map((r) => r.roleId);
    const members = await guild.members.fetch().catch(() => null);
    if (!members) return;

    const now = Date.now();
    let changed = 0;
    for (const m of members.values()) {
      if (m.user.bot || !m.joinedAt) continue;
      const months = (now - m.joinedAt.getTime()) / MONTH_MS;
      const want = rankForMonths(months);
      if (!want) continue;
      const has = m.roles.cache.has(want.roleId);
      const hasOther = rankIds.some((id) => id !== want.roleId && m.roles.cache.has(id));
      if (has && !hasOther) continue;
      const remove = rankIds.filter((id) => id !== want.roleId);
      if (remove.length) await m.roles.remove(remove, 'Seniority sync').catch(() => {});
      if (!has) await m.roles.add(want.roleId, 'Seniority sync').catch(() => {});
      changed++;
    }
    if (changed) console.log(`Seniority sync: updated ${changed} member(s).`);
  } catch (err) {
    console.error('Seniority sync failed:', err.message);
  }
}

async function syncCommand(interaction) {
  await interaction.deferReply({ ephemeral: true });
  await syncSeniority(interaction.client);
  await interaction.editReply('Seniority ranks synced.');
}

const commands = [
  {
    data: new SlashCommandBuilder()
      .setName('sync-seniority')
      .setDescription('Re-check tenure ranks now (Manage Roles only)')
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles),
    run: syncCommand,
  },
];

module.exports = { commands, syncSeniority, rankForMonths };
