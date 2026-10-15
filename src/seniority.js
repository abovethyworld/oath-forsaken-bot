// Time-in-service (tenure) ranks, shown as separate groups in the member list.
// A daily loop assigns each member the seniority role matching their server
// join date: Initiate (<1 mo) -> Acolyte (1-2) -> Devout (3-5) ->
// Zealot (6-8) -> Heretic (9-11) -> Godslayer (1 yr+).
// Brackets come from config.seniorityRanks. /sync-seniority runs it on demand.
// On rank-up, the bot pings the member in #general with their story.
// Stories finalized 2026-10-13: unified single arc (no iron/main split).
// Format is PLAIN TEXT (not embeds) because Discord doesn't render role
// mentions in embed titles.
const { PermissionFlagsBits, SlashCommandBuilder } = require('discord.js');
const config = require('./config');
const { getOriginalJoinDate, backfill } = require('./join-dates');
const { addEntry: addCcEntry } = require('./cc-checklist');

const MONTH_MS = 30.44 * 24 * 3600 * 1000;
const GENERAL_CHANNEL_ID = '1558583385440395476';
const IRON_ROLE_ID = '1558540424048803860'; // Iron Sworn
const MAIN_ROLE_ID = '1558540434652008569'; // Unbound

// Channel IDs for Initiate welcome
const INTRODUCE_CHANNEL_ID = '1558428255940378715';
const ROLES_CHANNEL_ID = '1558399101454786670';
const STAFF_ROLE_ID = '1558735997922054225';

// Rank-up announcements, finalized 2026-10-13.
// Each has: header (with role mention), divider (matched to header length),
// tagline, and story. Plain text format for working @mentions.
const RANK_ANNOUNCEMENTS = {
  initiate: {
    roleId: '1558452023790276659',
    header: '⛧ <@&1558452023790276659> ⛧',
    divider: '⛧ ━━━━━━━━━━━━━━━━━━━━━━━━ ⛧',
    tagline: (uid) => `<@${uid}> has joined Oath Forsaken.`,
    story: `Welcome to Oath Forsaken! Glad you're here. Take a look around and make yourself at home.\n\n• Drop an intro in <#${INTRODUCE_CHANNEL_ID}> so we can meet you\n• Grab your roles in <#${ROLES_CHANNEL_ID}>\n• Ping <@&${STAFF_ROLE_ID}> when you're ready for a clan chat invite`,
  },
  acolyte: {
    roleId: '1558452012797136960',
    header: '⛧ <@&1558452012797136960> ⛧',
    divider: '⛧ ━━━━━━━━━━━━━━━━━━━━ ⛧',
    tagline: (uid) => `<@${uid}> has risen to Acolyte. The first step is taken.`,
    story: `You'd heard about the Chaos altar in south-east Varrock. Zamorak's altar. You went to see it. You knelt and took off your old god's amulet, setting it on the floor. Said 'Zamorak' out loud for the first time. The flames leaned toward you. You didn't know the prayers yet. But you'd started.`,
  },
  devout: {
    roleId: '1558452002319769631',
    header: '⛧ <@&1558452002319769631> ⛧',
    divider: '⛧ ━━━━━━━━━━━━━━━━━━━ ⛧',
    tagline: (uid) => `<@${uid}> has risen to Devout. Faith, proven daily.`,
    story: `The flames stayed with you. You'd close your eyes and see them leaning toward you, the way they did at the altar. So you went back. Every night. You picked up the prayers from the others kneeling there. Your knees learned the stone floor. You weren't curious anymore. You were devoted.`,
  },
  zealot: {
    roleId: '1558451991448129628',
    header: '⛧ <@&1558451991448129628> ⛧',
    divider: '⛧ ━━━━━━━━━━━━━━━━━━━ ⛧',
    tagline: (uid) => `<@${uid}> has risen to Zealot. Power recognizes power.`,
    story: `The others at the altar talked about Yama. A demon in the Chasm of Fire who trades armor for oaths. You'd heard what happens to people who go looking for him. You packed what you needed and left everything else behind.`,
  },
  heretic: {
    roleId: '1558451981562151062',
    header: '⛧ <@&1558451981562151062> ⛧',
    divider: '⛧ ━━━━━━━━━━━━━━━━━━━━ ⛧',
    tagline: (uid) => `<@${uid}> has risen to Heretic. The oath is sealed.`,
    story: `You went down into the Chasm of Fire and found Yama on his throne. He offered you a contract \u2014 fight his weakened form, and the oathplate is yours if you win. You signed. Swore to the fire, swore you'd never kneel again. Then he stood, teleported to the middle of the room, axe in hand. The floor split into lava. You jumped stone to stone. Twice he sent his Judge to test you \u2014 his executioner, there to end anyone unworthy. You killed them both and went back for him. You barely walked out alive. But the oathplate was yours.`,
  },
  godslayer: {
    roleId: '1558451970883453003',
    header: '⛧ <@&1558451970883453003> ⛧',
    divider: '⛧ ━━━━━━━━━━━━━━━━━━━ ⛧',
    tagline: (uid) => `<@${uid}> has risen to Godslayer. A general has fallen.`,
    story: `You walked into Zamorak's fortress wearing the oathplate. You'd spent months preparing \u2014 tracked down Emberlight, the demonbane blade, because you knew what was waiting. Past the bloodvelds and werewolves, forty kills deep. The chamber goes dark \u2014 the kind of dark that swallows torchlight. Then you hear him. K'ril Tsutsaroth. Zamorak's general. He screams and his next hit smashes straight through your prayer. You didn't flinch. When he fell, you stood over his corpse with his spear in your hands.`,
  },
  ascendant: {
    roleId: '1559619699493437482',
    header: '⛧ <@&1559619699493437482> ⛧',
    divider: '⛧ ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ ⛧',
    tagline: (uid) => `<@${uid}> has ascended. Zamorak has noticed.`,
    story: `K'ril is dead. His massive frame still radiates heat on the stone \u2014 demon blood steams in the cold dark. His spear is in your hands. His bodyguards lie broken around you, their armor still warm from the fight. The chamber is silent.\n\nThen the dark moves.\n\nNot a figure \u2014 a presence. The air gets heavy, like the moment before lightning. You feel it in your chest first, a pressure, then in your skull. His voice doesn't come through your ears. It's inside you.\n\n**Zamorak:** 'You killed my general.'\n\nIt's so loud you want to kneel, to cover your head, to run. But you don't. You stand. And something shifts \u2014 the pressure eases, just slightly. Approval.\n\n**Zamorak:** 'He was strong. You were stronger. That is the only law I know.'\n\nThe presence wraps around you like heat from a forge. Not burning. Forging.\n\n**Zamorak:** 'You did not come because I called. You came because you chose.'\n\nA pause. The weight settles, then lifts.\n\n**Zamorak:** 'Ascend.'`,
  },
};

function storyKey(name) {
  return (name || '').toLowerCase().split(' ')[0]; // "Initiate (Under 1 month)" -> "initiate"
}

const SENIORITY_ROLE_IDS = {
  initiate: '1558452023790276659',
  acolyte: '1558452012797136960',
  devout: '1558452002319769631',
  zealot: '1558451991448129628',
  heretic: '1558451981562151062',
  godslayer: '1558451970883453003',
};

async function postRankUpStory(guild, member, rankName) {
  try {
    const key = storyKey(rankName);
    const ann = RANK_ANNOUNCEMENTS[key];
    if (!ann) return;
    const isIron = member.roles.cache.has(IRON_ROLE_ID);
    const isMain = member.roles.cache.has(MAIN_ROLE_ID);
    if (!isIron && !isMain) return; // guests don't get rank-up stories
    const channel = guild.channels.cache.get(GENERAL_CHANNEL_ID);
    if (!channel) return;
    const message = `${ann.header}\n${ann.divider}\n${ann.tagline(member.id)}\n\n${ann.story}`;
    await channel.send({ content: message, allowedMentions: { parse: ['users'] } }).catch(() => {});
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
      if (m.user.bot) continue;
      // Guests and Friends of the Clan never get seniority roles (Alex 2026-10-14)
      // Strip any they already have, then skip.
      const skipIds = [config.recruit?.types?.guest?.roleId, '1558621489283211316'].filter(Boolean);
      if (skipIds.some((id) => m.roles.cache.has(id))) {
        const hasSeniority = rankIds.some((id) => m.roles.cache.has(id));
        if (hasSeniority) {
          await m.roles.remove(rankIds, 'Seniority sync: Guest/Friend of Clan should not have seniority roles').catch(() => {});
          changed++;
        }
        continue;
      }
      // Use original join date (survives leave/rejoin). Fall back to Discord's.
      const original = getOriginalJoinDate(m.id);
      const joinedAt = original || m.joinedAt;
      if (!joinedAt) continue;
      const months = (now - joinedAt.getTime()) / MONTH_MS;
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
        // Add to CC checklist for in-game rank update
        const oldRankName = oldRank ? oldRank.name.split(' ')[0] : 'None';
        const newRankName = want.name.split(' ')[0];
        await addCcEntry(guild, m.id, oldRankName, newRankName).catch(() => {});
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

module.exports = { commands, syncSeniority, rankForMonths, RANK_ANNOUNCEMENTS, postRankUpStory };
