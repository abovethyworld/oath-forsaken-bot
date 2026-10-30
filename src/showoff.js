// !-prefixed show-off commands: !kc <activity> [name], !clog <activity|total> [name],
// !profile [name], !leaderboard. Needs the Message Content privileged intent
// (code + portal toggle).
const { AttachmentBuilder, SlashCommandBuilder } = require('discord.js');
const { getStats, combatLevel } = require('./wom');
const { getClogPageWithItems, getClogTotal, getClogSummary, getProfile, getCachedClogTotal } = require('./runeprofile');
const { ACTIVITIES, kcColumnsForTeam, getRsn, clogPageForActivity, loadRsnLinks, rsnLinkRow, teamsChannelId } = require('./teams');
const { renderProfileCard, renderClogLeaderboard, renderClogCard, renderClogSummaryCard, renderKcCard, getBossIcon, decodePng } = require('./party-board');
const { getItemIcon } = require('./item-icons');
const fs = require('fs');

const RSN_RE = /^[A-Za-z0-9 ]{1,12}$/;

// Per-user cooldown across every show-off command (! and slash share one
// bucket). The window exists to protect the WOM/RuneProfile paced queues;
// members get told once per window instead of silent nothing. The window
// starts when a lookup actually fires (inside the payload builders, via
// noteUse), never on a failed validation, so a typo costs nothing. The
// global API limiters still cap total traffic regardless.
const COOLDOWN_MS = 10_000;
const lastUseAt = new Map();
const lastNotifyAt = new Map();

function pruneCooldownMaps(now) {
  if (lastUseAt.size < 1000) return;
  for (const [uid, at] of lastUseAt) {
    if (now - at > COOLDOWN_MS) lastUseAt.delete(uid);
  }
  for (const [uid, at] of lastNotifyAt) {
    if (now - at > COOLDOWN_MS) lastNotifyAt.delete(uid);
  }
}

function checkCooldown(userId, now = Date.now()) {
  pruneCooldownMaps(now);
  const last = lastUseAt.get(userId) || 0;
  const waitMs = COOLDOWN_MS - (now - last);
  if (waitMs <= 0) return { wait: 0, notify: false };
  const notified = lastNotifyAt.get(userId) || 0;
  const notify = now - notified >= COOLDOWN_MS;
  if (notify) lastNotifyAt.set(userId, now);
  return { wait: Math.ceil(waitMs / 1000), notify };
}

function noteUse(userId, now = Date.now()) {
  lastUseAt.set(userId, now);
}

function cooldownText(wait) {
  return `Cooldown: too many lookups at once. Try again in ${wait}s.`;
}


function prettyMetric(key) {
  return key.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

function fmtKc(n) {
  return typeof n === 'number' ? `${n.toLocaleString('en-US')} KC` : '-';
}

// Unlinked users get the Link RSN button right on the reply, so they never
// have to go hunting for it. The button lives on the Find a Team panel in
// the teams channel, which the text names as the fallback.
function unlinkedPayload(example, extra) {
  const channelId = teamsChannelId();
  const where = channelId ? `<#${channelId}>` : '#find-a-team';
  const lines = [
    `Link your RSN first: tap Link RSN below, or use the same button in ${where}.`,
    `Or pass a name: \`${example}\`.`,
  ];
  if (extra) lines.push(extra);
  return { content: lines.join('\n'), components: rsnLinkRow() };
}

function unlinkedSlashPayload() {
  const channelId = teamsChannelId();
  const where = channelId ? `<#${channelId}>` : '#find-a-team';
  return {
    content: `Link your RSN first: tap Link RSN below, or use the same button in ${where}.\nOr pass a name in the player option.`,
    components: rsnLinkRow(),
  };
}

// Name: explicit arg wins, else the author's linked RSN.
function resolveName(args, authorId, example, extra) {
  const named = args.join(' ').trim().replace(/\s+/g, ' ');
  if (named) {
    if (!RSN_RE.test(named)) return { error: 'That name has characters RuneScape does not allow. Try again.' };
    return { rsn: named };
  }
  const linked = getRsn(authorId);
  if (!linked) return { payload: unlinkedPayload(example, extra) };
  return { rsn: linked };
}

// Activities can be typed as two words ("toa expert", "cox cm") — fold
// them into the underscored key when the pair matches.
function takeActivity(args, table) {
  if (args.length >= 2) {
    const two = `${args[0]}_${args[1]}`.toLowerCase();
    if (table[two]) {
      args.splice(0, 2);
      return two;
    }
  }
  return (args.shift() || '').toLowerCase();
}

// Payload builders: return what to reply with ({ files }, { embeds }, or
// { content }), shared by the !-commands and the slash commands.
async function kcPayload(activity, rsn, userId) {
  if (!activity || !ACTIVITIES[activity]) {
    return { content: `Pick an activity: \`!kc <activity> [name]\`\nActivities: ${Object.keys(ACTIVITIES).join(', ')}` };
  }
  if (userId) noteUse(userId); // a real lookup fires: start the cooldown
  let st;
  try {
    st = await getStats(rsn);
  } catch (err) {
    return { content: 'Could not reach the stats service right now. Try again in a bit.' };
  }
  if (!st) return { content: 'Could not reach the stats service right now. Try again in a bit.' };
  if (st.notFound) return { content: `Could not find the RuneScape name **${rsn}**. Check the spelling and try again.` };
  const cols = kcColumnsForTeam({ activity });
  if (!cols.length) return { content: `No kill count is tracked for ${ACTIVITIES[activity].name}.` };
  const entries = cols.map((c) => ({
    icon: getBossIcon(c.icon || c.metric),
    label: c.label || prettyMetric(c.metric),
    value: fmtKc(st.kc ? st.kc[c.metric] : null),
  }));
  const buf = renderKcCard({ title: `${rsn}: ${ACTIVITIES[activity].name}`, entries });
  return { files: [new AttachmentBuilder(buf, { name: 'kc.png' })] };
}

async function handleKcCommand(message, args) {
  const cd = checkCooldown(message.author.id);
  if (cd.wait) { if (cd.notify) await message.reply(cooldownText(cd.wait)).catch(() => {}); return; }
  const activity = takeActivity(args, ACTIVITIES);
  const extra = !activity || !ACTIVITIES[activity] ? 'Usage: `!kc <activity> [name]`' : null;
  const { rsn, error, payload } = resolveName(args, message.author.id, '!kc yama YourName', extra);
  if (error) { await message.reply(error).catch(() => {}); return; }
  if (payload) { await message.reply(payload).catch(() => {}); return; }
  await message.reply(await kcPayload(activity, rsn, message.author.id)).catch(() => {});
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
async function clogPayload(key, rsn, userId) {
  if (!key) return { content: 'Usage: `!clog <activity|total> [name]`' };
  if (key === 'total') {
    if (userId) noteUse(userId); // a real lookup fires: start the cooldown
    const res = await getClogSummary(rsn).catch(() => null);
    if (!res) return { content: 'Could not reach the collection log service right now. Try again in a bit.' };
    if (res.notFound) return { content: RP_GUIDE };
    const buf = renderClogSummaryCard({ name: rsn, obtained: res.obtained, total: res.total, tabs: res.tabs });
    return { files: [new AttachmentBuilder(buf, { name: 'clog.png' })] };
  }
  const page = clogPageForCommand(key);
  if (!page) {
    const wag = key === 'wag';
    return { content: wag
      ? 'Wilderness Agility has no collection log page to show.'
      : `No collection log page for \`${key}\`. Try one of: ${Object.keys(CLOG_PAGES).join(', ')}.` };
  }
  if (userId) noteUse(userId); // a real lookup fires: start the cooldown
  const res = await getClogPageWithItems(rsn, page[0], page[1]).catch(() => null);
  if (!res) return { content: 'Could not reach the collection log service right now. Try again in a bit.' };
  if (res.notFound) return { content: RP_GUIDE };
  const obtained = (res.items || []).filter((it) => it.quantity > 0);
  // Fetch the page's icons in parallel: item-icons serializes the actual
  // downloads through its own paced queue, so this stays polite while a
  // cold cache no longer stalls the render on 49 serial waits.
  const drawn = await Promise.all(obtained.slice(0, 49).map(async (it) => {
    let icon = null;
    const p = await getItemIcon(it.id, it.name).catch(() => null);
    if (p) {
      try { icon = decodePng(fs.readFileSync(p)); } catch { icon = null; }
    }
    return { icon, qty: it.quantity };
  }));
  const buf = renderClogCard({
    title: `${rsn}: ${page[1]}`,
    obtained: res.obtained,
    total: res.total,
    items: drawn,
  });
  return { files: [new AttachmentBuilder(buf, { name: 'clog.png' })] };
}

async function handleClogCommand(message, args) {
  const cd = checkCooldown(message.author.id);
  if (cd.wait) { if (cd.notify) await message.reply(cooldownText(cd.wait)).catch(() => {}); return; }
  const key = takeActivity(args, CLOG_PAGES);
  const extra = !key ? 'Usage: `!clog <activity|total> [name]`' : null;
  const { rsn, error, payload } = resolveName(args, message.author.id, '!clog total YourName', extra);
  if (error) { await message.reply(error).catch(() => {}); return; }
  if (payload) { await message.reply(payload).catch(() => {}); return; }
  await message.reply(await clogPayload(key, rsn, message.author.id)).catch(() => {});
}

async function profilePayload(rsn, userId) {
  if (userId) noteUse(userId); // a real lookup fires: start the cooldown
  const prof = await getProfile(rsn).catch(() => null);
  if (!prof) return { content: 'Could not reach the profile service right now. Try again in a bit.' };
  if (prof.notFound) return { content: RP_GUIDE };
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
  return { files: [new AttachmentBuilder(buf, { name: 'profile.png' })] };
}

async function handleProfileCommand(message, args) {
  const cd = checkCooldown(message.author.id);
  if (cd.wait) { if (cd.notify) await message.reply(cooldownText(cd.wait)).catch(() => {}); return; }
  const { rsn, error, payload } = resolveName(args, message.author.id, '!profile YourName');
  if (error) { await message.reply(error).catch(() => {}); return; }
  if (payload) { await message.reply(payload).catch(() => {}); return; }
  await message.reply(await profilePayload(rsn, message.author.id)).catch(() => {});
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

async function leaderboardPayload(userId) {
  // Served from cache, but it fires background warming lookups, so it
  // counts as a use like the other commands.
  if (userId) noteUse(userId);
  const rows = leaderboardRows();
  if (!rows.length) {
    return { content: 'No ranked profiles yet. Link an RSN and use `!clog total` once, or wait a minute and try again.' };
  }
  const buf = renderClogLeaderboard(rows);
  return { files: [new AttachmentBuilder(buf, { name: 'leaderboard.png' })] };
}

async function handleLeaderboardCommand(message) {
  const cd = checkCooldown(message.author.id);
  if (cd.wait) { if (cd.notify) await message.reply(cooldownText(cd.wait)).catch(() => {}); return; }
  await message.reply(await leaderboardPayload(message.author.id)).catch(() => {});
}

// ---- slash commands (same payloads as the !-commands) --------------------
function resolveNameFor(userId, named) {
  if (named && String(named).trim()) {
    const name = String(named).trim().replace(/\s+/g, ' ');
    if (!RSN_RE.test(name)) return { error: 'That name has characters RuneScape does not allow. Try again.' };
    return { rsn: name };
  }
  const linked = getRsn(userId);
  if (!linked) return { payload: unlinkedSlashPayload() };
  return { rsn: linked };
}

async function slashReply(interaction, payloadPromise) {
  const deferred = await interaction.deferReply().then(() => true).catch(() => false);
  const payload = await payloadPromise;
  // Defer failed (usually an expired interaction): editReply would fail
  // too, so bail instead of answering into the void.
  if (!deferred) return;
  await interaction.editReply(payload).catch(() => {});
}

// Returns true when the interaction was answered with a cooldown notice.
// Check only: the cooldown starts inside the payload builders, when the
// lookup actually fires.
async function slashCooldown(interaction) {
  const cd = checkCooldown(interaction.user.id);
  if (!cd.wait) return false;
  await interaction.reply({ content: cooldownText(cd.wait), ephemeral: true }).catch(() => {});
  return true;
}

const activityChoices = Object.entries(ACTIVITIES).map(([value, a]) => ({ name: a.name, value }));
const clogChoices = [
  { name: 'Total (whole log)', value: 'total' },
  ...Object.keys(CLOG_PAGES).map((k) => ({ name: ACTIVITIES[k] ? ACTIVITIES[k].name : k, value: k })),
];

const commands = [
  {
    data: new SlashCommandBuilder()
      .setName('kc')
      .setDescription("Show a player's boss kill count card")
      .addStringOption((o) => o.setName('activity').setDescription('Which boss or raid').setRequired(true).addChoices(...activityChoices))
      .addStringOption((o) => o.setName('player').setDescription('RuneScape name (defaults to your linked RSN)')),
    run: async (interaction) => {
      const { rsn, error, payload } = resolveNameFor(interaction.user.id, interaction.options.getString('player'));
      if (error) { await interaction.reply({ content: error, ephemeral: true }).catch(() => {}); return; }
      if (payload) { await interaction.reply({ ...payload, ephemeral: true }).catch(() => {}); return; }
      if (await slashCooldown(interaction)) return;
      await slashReply(interaction, kcPayload(interaction.options.getString('activity'), rsn, interaction.user.id));
    },
  },
  {
    data: new SlashCommandBuilder()
      .setName('clog')
      .setDescription("Show a player's collection log card")
      .addStringOption((o) => o.setName('activity').setDescription('Which page, or the whole log').setRequired(true).addChoices(...clogChoices))
      .addStringOption((o) => o.setName('player').setDescription('RuneScape name (defaults to your linked RSN)')),
    run: async (interaction) => {
      const { rsn, error, payload } = resolveNameFor(interaction.user.id, interaction.options.getString('player'));
      if (error) { await interaction.reply({ content: error, ephemeral: true }).catch(() => {}); return; }
      if (payload) { await interaction.reply({ ...payload, ephemeral: true }).catch(() => {}); return; }
      if (await slashCooldown(interaction)) return;
      await slashReply(interaction, clogPayload(interaction.options.getString('activity'), rsn, interaction.user.id));
    },
  },
  {
    data: new SlashCommandBuilder()
      .setName('profile')
      .setDescription("Show a player's RuneProfile card")
      .addStringOption((o) => o.setName('player').setDescription('RuneScape name (defaults to your linked RSN)')),
    run: async (interaction) => {
      const { rsn, error, payload } = resolveNameFor(interaction.user.id, interaction.options.getString('player'));
      if (error) { await interaction.reply({ content: error, ephemeral: true }).catch(() => {}); return; }
      if (payload) { await interaction.reply({ ...payload, ephemeral: true }).catch(() => {}); return; }
      if (await slashCooldown(interaction)) return;
      await slashReply(interaction, profilePayload(rsn, interaction.user.id));
    },
  },
  {
    data: new SlashCommandBuilder()
      .setName('leaderboard')
      .setDescription('Collection log leaderboard for linked clan members'),
    run: async (interaction) => {
      if (await slashCooldown(interaction)) return;
      await slashReply(interaction, leaderboardPayload(interaction.user.id));
    },
  },
];

module.exports = { handleKcCommand, handleClogCommand, handleProfileCommand, handleLeaderboardCommand, commands, kcPayload, clogPayload, profilePayload, leaderboardPayload, checkCooldown, noteUse, COOLDOWN_MS, takeActivity, progressBar, prettyMetric, clogPageForCommand, leaderboardRows, unlinkedPayload, unlinkedSlashPayload };
