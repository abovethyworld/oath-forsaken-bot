// Time-in-service (tenure) ranks, shown as separate groups in the member list.
// A daily loop assigns each clan member the seniority role matching their
// accrued time in the clan chat: Initiate (<1 mo) -> Acolyte (1-2) ->
// Devout (3-5) -> Zealot (6-8) -> Heretic (9-11) -> Godslayer (1 yr+).
// Membership and tenure follow the clan rule (set Nov 5, 2026): nobody is a
// member until they are in the clan chat, and only time in the clan
// chat counts. Membership = any linked RSN on the WOM group list
// (src/membership.js); accrued time comes from the tenure ledger
// (src/tenure.js), which banks time across leaves, so time away never
// counts. Non-members are skipped and stripped of any seniority rank
// they hold, except anyone who joined the server within the last
// 7 days: a fresh approval needs time to get into the clan chat and
// onto the WOM list before the strip can apply. Ascendant is
// hand-picked and is not in
// config.seniorityRanks, so this sync never assigns or removes it.
// After each run the assigned ranks are published to
// data/seniority.json for the website, so site and bot cannot disagree.
// Brackets come from config.seniorityRanks. /sync-seniority runs it on demand.
// On rank-up, the bot pings the member in #general with their story.
// Stories finalized 2026-10-13: unified single arc (no iron/main split).
// Format is PLAIN TEXT (not embeds) because Discord doesn't render role
// mentions in embed titles.
const path = require('path');
const { PermissionFlagsBits, SlashCommandBuilder } = require('discord.js');
const config = require('./config');
const store = require('./store');
const { addEntry: addCcEntry } = require('./cc-checklist');
const { getMembers } = require('./guild-cache');
const { MONTH_MS, buildInitiateWelcome } = require('./utils');
const membership = require('./membership');
const tenure = require('./tenure');

// The website reads its roster ranks from this published file.
const SENIORITY_FILE = path.join(__dirname, '..', 'data', 'seniority.json');

// All IDs from config.json
const SEN = config.seniority || {};
const GENERAL_CHANNEL_ID = SEN.generalChannelId;

const RANK_IDS = SEN.rankIds || {};

// Rank-up announcements, finalized 2026-10-13.
// Each has: header (with role mention), divider (matched to header length),
// tagline, and story. Plain text format for working @mentions.
const RANK_ANNOUNCEMENTS = {
  acolyte: {
    get roleId() { return RANK_IDS.acolyte; },
    get header() { return `⛧ <@&${RANK_IDS.acolyte}> ⛧`; },
    divider: '⛧ ━━━━━━━━━━━━━━━━━━━━ ⛧',
    tagline: (uid) => `<@${uid}> has risen to Acolyte. The first step is taken.`,
    story: `You'd heard about the Chaos altar in south-east Varrock. Zamorak's altar. You went to see it. You knelt and took off your old god's amulet, setting it on the floor. Said 'Zamorak' out loud for the first time. The flames leaned toward you. You didn't know the prayers yet. But you'd started.`,
  },
  devout: {
    get roleId() { return RANK_IDS.devout; },
    get header() { return `⛧ <@&${RANK_IDS.devout}> ⛧`; },
    divider: '⛧ ━━━━━━━━━━━━━━━━━━━ ⛧',
    tagline: (uid) => `<@${uid}> has risen to Devout. Faith, proven daily.`,
    story: `The flames stayed with you. You'd close your eyes and see them leaning toward you, the way they did at the altar. So you went back. Every night. You picked up the prayers from the others kneeling there. Your knees learned the stone floor. You weren't curious anymore. You were devoted.`,
  },
  zealot: {
    get roleId() { return RANK_IDS.zealot; },
    get header() { return `⛧ <@&${RANK_IDS.zealot}> ⛧`; },
    divider: '⛧ ━━━━━━━━━━━━━━━━━━━ ⛧',
    tagline: (uid) => `<@${uid}> has risen to Zealot. Power recognizes power.`,
    story: `The others at the altar talked about Yama. A demon in the Chasm of Fire who trades armor for oaths. You'd heard what happens to people who go looking for him. You packed what you needed and left everything else behind.`,
  },
  heretic: {
    get roleId() { return RANK_IDS.heretic; },
    get header() { return `⛧ <@&${RANK_IDS.heretic}> ⛧`; },
    divider: '⛧ ━━━━━━━━━━━━━━━━━━━━ ⛧',
    tagline: (uid) => `<@${uid}> has risen to Heretic. The oath is sealed.`,
    story: `You went down into the Chasm of Fire and found Yama on his throne. He offered you a contract \u2014 fight his weakened form, and the oathplate is yours if you win. You signed. Swore to the fire, swore you'd never kneel again. Then he stood, teleported to the middle of the room, axe in hand. The floor split into lava. You jumped stone to stone. Twice he sent his Judge to test you \u2014 his executioner, there to end anyone unworthy. You killed them both and went back for him. You barely walked out alive. But the oathplate was yours.`,
  },
  godslayer: {
    get roleId() { return RANK_IDS.godslayer; },
    get header() { return `⛧ <@&${RANK_IDS.godslayer}> ⛧`; },
    divider: '⛧ ━━━━━━━━━━━━━━━━━━━ ⛧',
    tagline: (uid) => `<@${uid}> has risen to Godslayer. A general has fallen.`,
    story: `You walked into Zamorak's fortress wearing the oathplate. You'd spent months preparing \u2014 tracked down Emberlight, the demonbane blade, because you knew what was waiting. Past the bloodvelds and werewolves, forty kills deep. The chamber goes dark \u2014 the kind of dark that swallows torchlight. Then you hear him. K'ril Tsutsaroth. Zamorak's general. He screams and his next hit smashes straight through your prayer. You didn't flinch. When he fell, you stood over his corpse with his spear in your hands.`,
  },
  ascendant: {
    get roleId() { return RANK_IDS.ascendant; },
    get header() { return `⛧ <@&${RANK_IDS.ascendant}> ⛧`; },
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
    if (key === 'initiate') {
      const channel0 = guild.channels.cache.get(GENERAL_CHANNEL_ID);
      if (!channel0) return;
      if (!membership.isMember(member.id)) return; // only clan members get rank-up stories
      await channel0.send({ content: buildInitiateWelcome(member.id), allowedMentions: { parse: ['users'] } }).catch((e) => console.error("[seniority.js] Non-fatal error:", e.message));
      return;
    }
    const ann = RANK_ANNOUNCEMENTS[key];
    if (!ann) return;
    if (!membership.isMember(member.id)) return; // only clan members get rank-up stories
    const channel = guild.channels.cache.get(GENERAL_CHANNEL_ID);
    if (!channel) return;
    const message = `${ann.header}\n${ann.divider}\n${ann.tagline(member.id)}\n\n${ann.story}`;
    await channel.send({ content: message, allowedMentions: { parse: ['users'] } }).catch((e) => console.error("[seniority.js] Non-fatal error:", e.message));
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

    // Fail closed: membership comes from the published WOM group list
    // (the clan chat mirror). If it cannot be read there is no safe way
    // to tell members from non-members, so abort before any role changes.
    const memberIds = membership.memberIds();
    if (memberIds === null) {
      console.error('[seniority] WOM group list (data/wom-group.json) is unreadable. Aborting seniority sync.');
      return changes;
    }

    const now = Date.now();
    const rankUps = []; // stories to send after all role changes (batched, not interleaved)
    const firstRanks = []; // first-ever assignments: CC checklist entry only, no story
    let updatedCount = 0; // role changes actually made (non-dry-run log total)
    // Load holds once: the per-member store lookup re-read the file every time
    const seniorityHolds = store.getSeniorityHolds(guild.id);

    for (const m of members.values()) {
      if (m.user.bot) continue;
      // Seniority hold: staff-set exception (honorary rank, etc.) — skip entirely
      if (seniorityHolds.has(m.id)) continue;
      // Only clan members get seniority roles: a linked RSN on the WOM
      // group list (clan chat mirror). Everyone else, including account
      // holders whose characters sit in another clan, is stripped of
      // any seniority rank they hold, then skipped.
      // The permission-audit canary account must stay @everyone-only.
      const skipUsers = ['261537945943539712']; // audit canary
      if (skipUsers.includes(m.id)) continue;
      const isMember = memberIds.has(m.id);
      // Grace window: a member who joined the server in the last 7 days
      // is never stripped. Approval hands out Initiate before the new
      // member has had any chance to join the clan chat, so without
      // this the next sync run (including the one at bot startup)
      // takes it straight back.
      const GRACE_MS = 7 * 24 * 3600 * 1000;
      if (!isMember && m.joinedTimestamp && now - m.joinedTimestamp < GRACE_MS) continue;
      if (!isMember) {
        const hasSeniority = rankIds.some((id) => m.roles.cache.has(id));
        if (hasSeniority) {
          if (dryRun) {
            changes.push(`${m.user.tag}: strip seniority (not a clan member)`);
          } else {
            await m.roles.remove(rankIds, 'Seniority sync: only clan members hold seniority roles').catch((e) => console.error("[seniority.js] Non-fatal error:", e.message));
            updatedCount++;
          }
        }
        continue;
      }
      // Accrued time in the clan chat, from the tenure ledger. A member
      // with no ledger record yet has no accrued time.
      const months = tenure.accruedMs(tenure.getRecord(m.id), now) / MONTH_MS;
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
      if (remove.length) await m.roles.remove(remove, 'Seniority sync').catch((e) => console.error("[seniority.js] Non-fatal error:", e.message));
      if (!has) await m.roles.add(want.roleId, 'Seniority sync').catch((e) => console.error("[seniority.js] Non-fatal error:", e.message));
      updatedCount++;
      // Queue the story — sent after all role changes to avoid interleaved rate limits
      if (isRankUp) rankUps.push({ member: m, rankName: want.name, oldRankName, newRankName });
      // First-ever assignment: no story, but staff still need the in-game CC
      // rank set, so it gets a checklist entry below. Initiate excluded: a
      // new member carries the default icon in the clan chat anyway, so
      // there is nothing for staff to set until the first real rank-up.
      else if (newRankName !== 'Initiate') firstRanks.push({ member: m, newRankName });
    }

    // Publish the result for the website, so its roster ranks are the
    // ranks assigned here and the two cannot disagree. Members only,
    // keyed by Discord id, read back off the roles as they now stand;
    // a held Ascendant outranks the tenure ladder.
    if (!dryRun) {
      try {
        const ladder = ['ascendant', 'godslayer', 'heretic', 'zealot', 'devout', 'acolyte', 'initiate'];
        const published = {};
        for (const m of members.values()) {
          if (m.user.bot || !memberIds.has(m.id)) continue;
          let rank = null;
          for (const key of ladder) {
            if (RANK_IDS[key] && m.roles.cache.has(RANK_IDS[key])) {
              rank = key.charAt(0).toUpperCase() + key.slice(1);
              break;
            }
          }
          const rec = tenure.getRecord(m.id);
          published[m.id] = {
            rank,
            months: Math.round((tenure.accruedMs(rec, now) / MONTH_MS) * 100) / 100,
            stretchStart: rec ? rec.stretchStart : null,
            bankedMs: rec && typeof rec.bankedMs === 'number' ? rec.bankedMs : 0,
          };
        }
        store.atomicWrite(SENIORITY_FILE, { generatedAt: new Date(now).toISOString(), ranks: published });
      } catch (err) {
        console.error('Seniority publish failed:', err.message);
      }
    }

    // Second pass: stories + CC checklist entries, paced
    for (const { member, rankName, oldRankName, newRankName } of rankUps) {
      await postRankUpStory(guild, member, rankName);
      await addCcEntry(guild, member.id, oldRankName, newRankName).catch((e) => console.error("[seniority.js] Non-fatal error:", e.message));
      await new Promise((r) => setTimeout(r, 2000));
    }

    // First assignments get their checklist entry (old rank None), paced the
    // same way; addEntry dedupes, so a re-assignment never double-lists.
    for (const { member, newRankName } of firstRanks) {
      await addCcEntry(guild, member.id, 'None', newRankName).catch((e) => console.error("[seniority.js] Non-fatal error:", e.message));
      await new Promise((r) => setTimeout(r, 2000));
    }

    if (updatedCount && !dryRun) console.log(`Seniority sync: updated ${updatedCount} member(s).`);
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
