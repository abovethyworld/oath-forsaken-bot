// Time-in-service (tenure) ranks, shown as separate groups in the member list.
// A daily loop assigns each member the seniority role matching their server
// join date: Initiate (<1 mo) -> Acolyte (1-2) -> Bloodsworn (3-5) ->
// Revenant (6-8) -> Heretic (9-11) -> Godslayer (1 yr+).
// Brackets come from config.seniorityRanks. /sync-seniority runs it on demand.
// On rank-up, the bot pings the member in #general with their story
// (iron vs main arcs in docs/seniority-stories.md).
const { PermissionFlagsBits, SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const config = require('./config');

const MONTH_MS = 30.44 * 24 * 3600 * 1000;
const ZAMORAK_RED = 0x6b0e0e;
const GENERAL_CHANNEL_ID = '1558583385440395476';
const IRON_ROLE_ID = '1558540424048803860'; // Iron Sworn
const MAIN_ROLE_ID = '1558540434652008569'; // Unbound

// Rank-up stories, keyed by normalized rank name then account type.
// Finalized 2026-10-13. Source: docs/seniority-stories.md
const RANK_STORIES = {
  initiate: {
    iron: 'You stand before the clan with empty hands. No Grand Exchange. No trading. No one to carry you. Kneel.',
    main: "Zamorak never cared about bloodlines — only strength. You're one of us now. That's all that matters.",
  },
  acolyte: {
    iron: "You've learned the first truth: everything you own, you bled for. The easy path is still there, waiting. You walk past it every day. That is comfort, forsaken.",
    main: "The novelty wore off. You're still here. That's when it counts.",
  },
  bloodsworn: {
    iron: "Your bank is a graveyard of hours. Every bar smelted, every herb cleaned, every drop prayed for. Your blood is on the altar — not as sacrifice, but as proof.",
    main: "You've earned your place the same way everyone does here — by staying. The mode never mattered.",
  },
  revenant: {
    iron: "You've gone a thousand kills dry. You've farmed the same boss for months for one drop. Most people would have quit. You're still here. That's what revenants do — they don't stay down.",
    main: "You've watched people leave. Mains who got bored. Irons who burned out. You stayed.",
  },
  heretic: {
    iron: "You don't just play ironman. You believe in it. The old gods of convenience mean nothing to you now.",
    main: "Someone asked why a main stays in an ironman clan. You didn't have an answer. You didn't need one.",
  },
  godslayer: {
    iron: "Zamorak was a general who looked at eternity under Zaros and chose treachery, a staff, and godhood. You chose the harder path and walked it. The gods should be afraid.",
    main: "No mode bound you. No rule chained you. You stayed because you chose to. The gods should be afraid.",
  },
};

function storyKey(name) {
  return (name || '').toLowerCase().split(' ')[0]; // "Initiate (Under 1 month)" -> "initiate"
}

const SENIORITY_ROLE_IDS = {
  initiate: '1558452023790276659',
  acolyte: '1558452012797136960',
  bloodsworn: '1558452002319769631',
  revenant: '1558451991448129628',
  heretic: '1558451981562151062',
  godslayer: '1558451970883453003',
};

async function postRankUpStory(guild, member, rankName) {
  try {
    const key = storyKey(rankName);
    const stories = RANK_STORIES[key];
    if (!stories) return;
    const isIron = member.roles.cache.has(IRON_ROLE_ID);
    const isMain = member.roles.cache.has(MAIN_ROLE_ID);
    if (!isIron && !isMain) return; // guests don't get stories
    const story = isIron ? stories.iron : stories.main;
    const channel = guild.channels.cache.get(GENERAL_CHANNEL_ID);
    if (!channel) return;
    const roleId = SENIORITY_ROLE_IDS[key];
    const rankShort = rankName.split(' ')[0];
    const embed = new EmbedBuilder()
      .setDescription(`⛧ <@&${roleId}> ⛧\n<@${member.id}> has risen to ${rankShort}. Power recognizes power.\n\n*${story}*`)
      .setColor(ZAMORAK_RED)
      .setThumbnail(member.user.displayAvatarURL());
    await channel.send({ embeds: [embed] }).catch(() => {});
  } catch (err) {
    console.error('Rank-up story failed:', err.message);
  }
}

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
      // Detect actual rank-up (had a different seniority role before)
      const oldRank = ranks.find((r) => r.roleId !== want.roleId && m.roles.cache.has(r.roleId));
      const isRankUp = !!oldRank;
      const remove = rankIds.filter((id) => id !== want.roleId);
      if (remove.length) await m.roles.remove(remove, 'Seniority sync').catch(() => {});
      if (!has) await m.roles.add(want.roleId, 'Seniority sync').catch(() => {});
      changed++;
      // Ping their story on rank-up (not on initial assignment)
      if (isRankUp) {
        await postRankUpStory(guild, m, want.name);
        // Pace it out
        await new Promise((r) => setTimeout(r, 2000));
      }
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
