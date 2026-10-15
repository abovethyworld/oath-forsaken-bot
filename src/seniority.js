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
const store = require('./store');
const { getOriginalJoinDate, backfill } = require('./join-dates');
const { addEntry: addCcEntry } = require('./cc-checklist');
const { getMembers } = require('./guild-cache');

const MONTH_MS = 30.44 * 24 * 3600 * 1000;
// All IDs from config.json
const SEN = config.seniority || {};
const GENERAL_CHANNEL_ID = SEN.generalChannelId;
const IRON_ROLE_ID = SEN.ironRoleId;
const MAIN_ROLE_ID = SEN.mainRoleId;

// Channel IDs for Initiate welcome
const INTRODUCE_CHANNEL_ID = SEN.introduceChannelId;
const ROLES_CHANNEL_ID = SEN.rolesChannelId;
const STAFF_ROLE_ID = SEN.staffRoleId;

const RANK_IDS = SEN.rankIds || {};

// Rank-up announcements, finalized 2026-10-13.
// Each has: header (with role mention), divider (matched to header length),
// tagline, and story. Plain text format for working @mentions.
const RANK_ANNOUNCEMENTS = {
  initiate: {
    get roleId() { return RANK_IDS.initiate; },
    get header() { return `⛧ <@&\${RANK_IDS.initiate}> ⛧`; },
    divider: '⛧ ━━━━━━━━━━━━━━━━━━━━━━━━ ⛧',
    tagline: (uid) => `<@${uid}> has joined Oath Forsaken.`,
    story: `Welcome to Oath Forsaken! Glad you're here. Take a look around and make yourself at home.\n\n• Drop an intro in <#${INTRODUCE_CHANNEL_ID}> so we can meet you\n• Grab your roles in <#${ROLES_CHANNEL_ID}>\n• Ping <@&${STAFF_ROLE_ID}> when you're ready for a clan chat invite`,
  },
  acolyte: {
    get roleId() { return RANK_IDS.acolyte; },
    get header() { return `⛧ <@&\${RANK_IDS.acolyte}> ⛧`; },
    divider: '⛧ ━━━━━━━━━━━━━━━━━━━━ ⛧',
    tagline: (uid) => `<@${uid}> has risen to Acolyte. The first step is taken.`,
    story: `You'd heard about the Chaos altar in south-east Varrock. Zamorak's altar. You went to see it. You knelt and took off your old god's amulet, setting it on the floor. Said 'Zamorak' out loud for the first time. The flames leaned toward you. You didn't know the prayers yet. But you'd started.`,
  },
  devout: {
    get roleId() { return RANK_IDS.devout; },
    get header() { return `⛧ <@&\${RANK_IDS.devout}> ⛧`; },
    divider: '⛧ ━━━━━━━━━━━━━━━━━━━ ⛧',
    tagline: (uid) => `<@${uid}> has risen to Devout. Faith, proven daily.`,
    story: `The flames stayed with you. You'd close your eyes and see them leaning toward you, the way they did at the altar. So you went back. Every night. You picked up the prayers from the others kneeling there. Your knees learned the stone floor. You weren't curious anymore. You were devoted.`,
  },
  zealot: {
    get roleId() { return RANK_IDS.zealot; },
    get header() { return `⛧ <@&\${RANK_IDS.zealot}> ⛧`; },
    divider: '⛧ ━━━━━━━━━━━━━━━━━━━ ⛧',
    tagline: (uid) => `<@${uid}> has risen to Zealot. Power recognizes power.`,
    story: `The others at the altar talked about Yama. A demon in the Chasm of Fire who trades armor for oaths. You'd heard what happens to people who go looking for him. You packed what you needed and left everything else behind.`,
  },
  heretic: {
    get roleId() { return RANK_IDS.heretic; },
    get header() { return `⛧ <@&\${RANK_IDS.heretic}> ⛧`; },
    divider: '⛧ ━━━━━━━━━━━━━━━━━━━━ ⛧',
    tagline: (uid) => `<@${uid}> has risen to Heretic. The oath is sealed.`,
    story: `You went down into the Chasm of Fire and found Yama on his throne. He offered you a contract \u2014 fight his weakened form, and the oathplate is yours if you win. You signed. Swore to the fire, swore you'd never kneel again. Then he stood, teleported to the middle of the room, axe in hand. The floor split into lava. You jumped stone to stone. Twice he sent his Judge to test you \u2014 his executioner, there to end anyone unworthy. You killed them both and went back for him. You barely walked out alive. But the oathplate was yours.`,
  },
  godslayer: {
    get roleId() { return RANK_IDS.godslayer; },
    get header() { return `⛧ <@&\${RANK_IDS.godslayer}> ⛧`; },
    divider: '⛧ ━━━━━━━━━━━━━━━━━━━ ⛧',
    tagline: (uid) => `<@${uid}> has risen to Godslayer. A general has fallen.`,
    story: `You walked into Zamorak's fortress wearing the oathplate. You'd spent months preparing \u2014 tracked down Emberlight, the demonbane blade, because you knew what was waiting. Past the bloodvelds and werewolves, forty kills deep. The chamber goes dark \u2014 the kind of dark that swallows torchlight. Then you hear him. K'ril Tsutsaroth. Zamorak's general. He screams and his next hit smashes straight through your prayer. You didn't flinch. When he fell, you stood over his corpse with his spear in your hands.`,
  },
  ascendant: {
    get roleId() { return RANK_IDS.ascendant; },
    get header() { return `⛧ <@&\${RANK_IDS.ascendant}> ⛧`; },
    divider: '⛧ ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ ⛧',
    tagline: (uid) => `<@${uid}> has ascended. Zamorak has noticed.`,
    story: `K'ril is dead. His massive frame still radiates heat on the stone \u2014 demon blood steams in the cold dark. His spear is in your hands. His bodyguards lie broken around you, their armor still warm from the fight. The chamber is silent.\n\nThen the dark moves.\n\nNot a figure \u2014 a presence. The air gets heavy, like the moment before lightning. You feel it in your chest first, a pressure, then in your skull. His voice doesn't come through your ears. It's inside you.\n\n**Zamorak:** 'You killed my general.'\n\nIt's so loud you want to kneel, to cover your head, to run. But you don't. You stand. And something shifts \u2014 the pressure eases, just slightly. Approval.\n\n**Zamorak:** 'He was strong. You were stronger. That is the only law I know.'\n\nThe presence wraps around you like heat from a forge. Not burning. Forging.\n\n**Zamorak:** 'You did not come because I called. You came because you chose.'\n\nA pause. The weight settles, then lifts.\n\n**Zamorak:** 'Ascend.'`,
  },
};

function storyKey(name) {
  return (name || '').toLowerCase().split(' ')[0]; // "Initiate (Under 1 month)" -> "initiate"
}

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
    await channel.send({ content: message, allowedMentions: { parse: ['users'] } }).catch((e) => console.error("[seniority.js] Silent failure:", e.message));
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

async function syncSeniority(client, { dryRun = false } = {}) {
  const changes = []; // collected for dry-run reporting
  try {
    const ranks = config.seniorityRanks || [];
    if (ranks.length === 0) return changes;
    const guild = client.guilds.cache.get(config.guildId);
    if (!guild) return changes;
    const rankIds = ranks.map((r) => r.roleId);
    const members = await getMembers(guild);
    if (!members) return changes;

    const now = Date.now();
    const rankUps = []; // stories to send after all role changes (batched, not interleaved)

    for (const m of members.values()) {
      if (m.user.bot) continue;
      // Seniority hold: staff-set exception (honorary rank, etc.) — skip entirely
      if (store.isSeniorityHeld(guild.id, m.id)) continue;
      // Guests and Friends of the Clan never get seniority roles (Gavin 2026-10-14)
      // Strip any they already have, then skip.
      const skipIds = [config.recruit?.types?.guest?.roleId, SEN.friendOfClanRoleId].filter(Boolean);
      if (skipIds.some((id) => m.roles.cache.has(id))) {
        const hasSeniority = rankIds.some((id) => m.roles.cache.has(id));
        if (hasSeniority) {
          if (dryRun) {
            changes.push(`${m.user.tag}: strip seniority (guest/friend)`);
          } else {
            await m.roles.remove(rankIds, 'Seniority sync: Guest/Friend of Clan should not have seniority roles').catch((e) => console.error("[seniority.js] Silent failure:", e.message));
          }
        }
        continue;
      }
      // Use original join date (survives leave/rejoin). Fall back to Discord's.
      const original = getOriginalJoinDate(m.id);
      const joinedAt = original || m.joinedAt;
      if (!joinedAt) continue;
      let months = (now - joinedAt.getTime()) / MONTH_MS;
      if (months < 0) {
        // Clock skew or bad data: clamp to 0 and log so it doesn't silently skip
        console.warn(`[seniority] Member ${m.id} has future join date ${joinedAt.toISOString()}, clamping to 0 months`);
        months = 0;
      }
      const want = rankForMonths(months);
      if (!want) continue;
      const has = m.roles.cache.has(want.roleId);
      const hasOther = rankIds.some((id) => id !== want.roleId && m.roles.cache.has(id));
      if (has && !hasOther) continue;
      // Detect actual rank-up (had a different seniority role before)
      const oldRank = ranks.find((r) => r.roleId !== want.roleId && m.roles.cache.has(r.roleId));
      const isRankUp = !!oldRank;
      const oldRankName = oldRank ? oldRank.name.split(' ')[0] : 'None';
      const newRankName = want.name.split(' ')[0];

      if (dryRun) {
        changes.push(`${m.user.tag}: ${oldRankName} → ${newRankName}${isRankUp ? '' : ' (initial)'}`);
        continue;
      }

      const remove = rankIds.filter((id) => id !== want.roleId);
      if (remove.length) await m.roles.remove(remove, 'Seniority sync').catch((e) => console.error("[seniority.js] Silent failure:", e.message));
      if (!has) await m.roles.add(want.roleId, 'Seniority sync').catch((e) => console.error("[seniority.js] Silent failure:", e.message));
      // Queue the story — sent after all role changes to avoid interleaved rate limits
      if (isRankUp) rankUps.push({ member: m, rankName: want.name, oldRankName, newRankName });
    }

    // Second pass: stories + CC checklist entries, paced
    for (const { member, rankName, oldRankName, newRankName } of rankUps) {
      await postRankUpStory(guild, member, rankName);
      await addCcEntry(guild, member.id, oldRankName, newRankName).catch((e) => console.error("[seniority.js] Silent failure:", e.message));
      await new Promise((r) => setTimeout(r, 2000));
    }

    const totalChanged = changes.length + rankUps.length;
    if (totalChanged && !dryRun) console.log(`Seniority sync: updated ${totalChanged} member(s).`);
    return changes;
  } catch (err) {
    console.error('Seniority sync failed:', err.message);
    return changes;
  }
}

async function syncCommand(interaction) {
  const dryRun = interaction.options.getBoolean('dryrun') || false;
  await interaction.deferReply({ ephemeral: true });
  const changes = await syncSeniority(interaction.client, { dryRun });
  if (dryRun) {
    if (changes.length === 0) {
      await interaction.editReply('Dry run: no changes would be made.');
    } else {
      await interaction.editReply(`Dry run — ${changes.length} change(s) would be made:\n${changes.slice(0, 20).join('\n')}${changes.length > 20 ? `\n…(${changes.length - 20} more)` : ''}`);
    }
  } else {
    await interaction.editReply('Seniority ranks synced.');
  }
}

const commands = [
  {
    data: new SlashCommandBuilder()
      .setName('sync-seniority')
      .setDescription('Re-check tenure ranks now (Manage Roles only)')
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles)
      .addBooleanOption((o) => o.setName('dryrun').setDescription('Show what would change without changing anything')),
    run: syncCommand,
  },
  {
    data: new SlashCommandBuilder()
      .setName('seniority-hold')
      .setDescription('Hold/unhold a member\'s seniority rank (Manage Roles only)')
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles)
      .addUserOption((o) => o.setName('user').setDescription('Who').setRequired(true))
      .addBooleanOption((o) => o.setName('hold').setDescription('Hold their rank (true) or release (false)').setRequired(true)),
    run: async (interaction) => {
      const user = interaction.options.getUser('user');
      const hold = interaction.options.getBoolean('hold');
      store.setSeniorityHold(interaction.guildId, user.id, hold);
      await interaction.reply({
        content: hold
          ? `${user.tag}'s seniority rank is now held. Sync will skip them.`
          : `${user.tag}'s seniority hold released. Sync will resume.`,
        ephemeral: true,
      });
    },
  },
];

module.exports = { commands, syncSeniority, rankForMonths, RANK_ANNOUNCEMENTS, postRankUpStory };
