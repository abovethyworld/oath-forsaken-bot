// !-prefixed show-off commands: !kc <activity> [name], !clog <activity|total> [name],
// !profile [name], !leaderboard. Needs the Message Content privileged intent
// (code + portal toggle).
const { EmbedBuilder, AttachmentBuilder } = require('discord.js');
const { getStats, combatLevel } = require('./wom');
const { getClogPageWithItems, getClogTotal, getProfile, getCachedClogTotal } = require('./runeprofile');
const { ACTIVITIES, kcColumnsForTeam, getRsn, clogPageForActivity, loadRsnLinks } = require('./teams');
const { renderProfileCard, renderClogLeaderboard, renderClogCard, decodePng } = require('./party-board');
const { getItemIcon } = require('./item-icons');
const fs = require('fs');
const { ZAMORAK_RED } = require('./utils');

const RSN_RE = /^[A-Za-z0-9 ]{1,12}$/;

function prettyMetric(key) {
  return key.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

function fmtKc(n) {
  return typeof n === 'number' ? `${n.toLocaleString('en-US')} KC` : '-';
}

// Name: explicit arg wins, else the author's linked RSN.
function resolveName(args, authorId) {
  const named = args.join(' ').trim().replace(/\s+/g, ' ');
  if (named) {
    if (!RSN_RE.test(named)) return { error: 'That name has characters RuneScape does not allow. Try again.' };
    return { rsn: named };
  }
  const linked = getRsn(authorId);
  if (!linked) return { error: 'Link your RSN first with the Link RSN button, or pass a name: `!kc yama PTstud`.' };
  return { rsn: linked };
}

async function handleKcCommand(message, args) {
  const activity = (args.shift() || '').toLowerCase();
  if (!activity || !ACTIVITIES[activity]) {
    const list = Object.keys(ACTIVITIES).join(', ');
    await message.reply(`Pick an activity: \`!kc <activity> [name]\`\nActivities: ${list}`).catch(() => {});
    return;
  }
  const { rsn, error } = resolveName(args, message.author.id);
  if (error) {
    await message.reply(error).catch(() => {});
    return;
  }
  let st;
  try {
    st = await getStats(rsn);
  } catch (err) {
    await message.reply('Could not reach the stats service right now. Try again in a bit.').catch(() => {});
    return;
  }
  if (!st) {
    await message.reply('Could not reach the stats service right now. Try again in a bit.').catch(() => {});
    return;
  }
  if (st.notFound) {
    await message.reply(`Could not find the RuneScape name **${rsn}**. Check the spelling and try again.`).catch(() => {});
    return;
  }
  const cols = kcColumnsForTeam({ activity });
  const lines = cols.map((c) => `**${c.label || prettyMetric(c.metric)}:** ${fmtKc(st.kc ? st.kc[c.metric] : null)}`);
  const embed = new EmbedBuilder()
    .setColor(ZAMORAK_RED)
    .setTitle(`${rsn} — ${ACTIVITIES[activity].name}`)
    .setDescription(lines.join('\n'));
  await message.reply({ embeds: [embed] }).catch(() => {});
}

function progressBar(obtained, total) {
  const filled = total > 0 ? Math.round((obtained / total) * 10) : 0;
  const pct = total > 0 ? Math.round((obtained / total) * 100) : 0;
  return `${'█'.repeat(filled)}${'░'.repeat(10 - filled)} ${obtained}/${total} (${pct}%)`;
}

const RP_GUIDE = 'No RuneProfile profile found for that name. Run the RuneProfile plugin ([runeprofile.com/info/guide](https://runeprofile.com/info/guide)) and it syncs on its own.';

// !clog covers ALL activities, not just the four with board columns:
// the RuneProfile collection log is grouped by TAB, and each activity
// points at its page. Grouped by where the page lives.
const CLOG_PAGES = {
  toa: ['Raids', 'Tombs of Amascut'],
  toa_expert: ['Raids', 'Tombs of Amascut'],
  cox: ['Raids', 'Chambers of Xeric'],
  cox_cm: ['Raids', 'Chambers of Xeric'],
  tob: ['Raids', 'Theatre of Blood'],
  tob_hard: ['Raids', 'Theatre of Blood'],
  yama: ['Bosses', 'Yama'],
  nex: ['Bosses', 'Nex'],
  huey: ['Bosses', 'The Hueycoatl'],
  royals: ['Bosses', 'Royal Titans'],
  nm: ['Bosses', "The Nightmare"],
  venenatis: ['Bosses', 'Venenatis'],
  callisto: ['Bosses', 'Callisto'],
  vetion: ['Bosses', "Vet'ion"],
  wintertodt: ['Bosses', 'Wintertodt'],
  tempoross: ['Bosses', 'Tempoross'],
  zalcano: ['Bosses', 'Zalcano'],
  gotr: ['Minigames', 'Guardians of the Rift'],
  ba: ['Minigames', 'Barbarian Assault'],
  // wag: no Wilderness Agility page exists in the collection log.
};

function clogPageForCommand(key) {
  return CLOG_PAGES[key] || null;
}

// Drawn card in the in-game chat style: "{rsn}: {Page} (x/y)" + item icons.
async function handleClogCommand(message, args) {
  const key = (args.shift() || '').toLowerCase();
  if (!key) {
    await message.reply('Usage: `!clog <activity|total> [name]`').catch(() => {});
    return;
  }
  const { rsn, error } = resolveName(args, message.author.id);
  if (error) {
    await message.reply(error).catch(() => {});
    return;
  }
  if (key === 'total') {
    const res = await getClogTotal(rsn).catch(() => null);
    if (!res) {
      await message.reply('Could not reach the collection log service right now. Try again in a bit.').catch(() => {});
      return;
    }
    if (res.notFound) {
      await message.reply(RP_GUIDE).catch(() => {});
      return;
    }
    const embed = new EmbedBuilder()
      .setColor(ZAMORAK_RED)
      .setTitle(`${rsn} — Collection Log`)
      .setDescription(progressBar(res.obtained, res.total));
    await message.reply({ embeds: [embed] }).catch(() => {});
    return;
  }
  const page = clogPageForCommand(key);
  if (!page) {
    const wag = key === 'wag';
    await message.reply(wag
      ? 'Wilderness Agility has no collection log page to show.'
      : `No collection log page for \`${key}\`. Try one of: ${Object.keys(CLOG_PAGES).join(', ')}.`).catch(() => {});
    return;
  }
  const res = await getClogPageWithItems(rsn, page[0], page[1]).catch(() => null);
  if (!res) {
    await message.reply('Could not reach the collection log service right now. Try again in a bit.').catch(() => {});
    return;
  }
  if (res.notFound) {
    await message.reply(RP_GUIDE).catch(() => {});
    return;
  }
  const obtained = (res.items || []).filter((it) => it.quantity > 0);
  const drawn = [];
  for (const it of obtained.slice(0, 49)) {
    let icon = null;
    const p = await getItemIcon(it.id, it.name).catch(() => null);
    if (p) {
      try { icon = decodePng(fs.readFileSync(p)); } catch { icon = null; }
    }
    drawn.push({ icon, qty: it.quantity });
  }
  const buf = renderClogCard({
    title: `${rsn}: ${page[1]}`,
    obtained: res.obtained,
    total: res.total,
    items: drawn,
  });
  await message.reply({ files: [new AttachmentBuilder(buf, { name: 'clog.png' })] }).catch(() => {});
}

async function handleProfileCommand(message, args) {
  const { rsn, error } = resolveName(args, message.author.id);
  if (error) {
    await message.reply(error).catch(() => {});
    return;
  }
  const prof = await getProfile(rsn).catch(() => null);
  if (!prof) {
    await message.reply('Could not reach the profile service right now. Try again in a bit.').catch(() => {});
    return;
  }
  if (prof.notFound) {
    await message.reply(RP_GUIDE).catch(() => {});
    return;
  }
  const a = prof.account;
  const buf = renderProfileCard({
    name: a.username || rsn,
    accountLabel: a.accountType && a.accountType.name ? String(a.accountType.name).toUpperCase() : null,
    combat: prof.skills ? combatLevel(prof.skills.levels) : null,
    totalLevel: a.skills ? a.skills.totalLevel : null,
    totalXp: a.skills ? a.skills.totalXp : null,
    quests: { done: a.quests ? a.quests.completed : 0, total: a.quests ? a.quests.total : 0 },
    achievements: prof.diaries || { done: 0, total: 0 },
    combatTasks: prof.ca || { done: 0, total: 0 },
    clog: { done: a.collectionLog ? a.collectionLog.obtained : 0, total: a.collectionLog ? a.collectionLog.total : 0 },
    clan: a.clan && a.clan.name ? a.clan.name : null,
  });
  await message.reply({ files: [new AttachmentBuilder(buf, { name: 'profile.png' })] }).catch(() => {});
}

// Leaderboard rows from cached clog totals (instant); missing profiles get a
// background refresh so the next call is fuller, never a slow first call.
function leaderboardRows() {
  const links = loadRsnLinks();
  const rsns = [];
  for (const entry of Object.values(links || {})) {
    const name = entry && Array.isArray(entry.rsns) ? entry.active : entry && entry.rsn;
    if (name && !rsns.includes(name)) rsns.push(name);
  }
  const rows = [];
  for (const rsn of rsns) {
    const hit = getCachedClogTotal(rsn);
    if (hit && !hit.notFound) rows.push({ name: rsn, obtained: hit.obtained, total: hit.total });
    else getClogTotal(rsn).catch(() => null); // warm in the background
  }
  rows.sort((x, y) => y.obtained - x.obtained);
  return rows;
}

async function handleLeaderboardCommand(message) {
  const rows = leaderboardRows();
  if (!rows.length) {
    await message.reply('No ranked profiles yet. Link an RSN and use `!clog total` once, or wait a minute and try again.').catch(() => {});
    return;
  }
  const buf = renderClogLeaderboard(rows);
  await message.reply({ files: [new AttachmentBuilder(buf, { name: 'leaderboard.png' })] }).catch(() => {});
}

module.exports = { handleKcCommand, handleClogCommand, handleProfileCommand, handleLeaderboardCommand, progressBar, prettyMetric, clogPageForCommand, leaderboardRows };
