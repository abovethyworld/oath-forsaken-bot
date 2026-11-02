// !-prefixed show-off commands: !kc <activity> [name], !clog <activity|total> [name],
// !profile [name], !leaderboard. Needs the Message Content privileged intent
// (code + portal toggle).
const { AttachmentBuilder, SlashCommandBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder, ModalBuilder, TextInputBuilder, TextInputStyle } = require('discord.js');
const { getStats, getCachedStats, combatLevel, kcStandings, mergedPlayers, getPlayerGains, getGainsTotals, updatePlayer, GAINS_PERIODS } = require('./wom');
const { getClogPageWithItems, getClogPages, getClogTotal, getClogSummary, getProfile, getCachedClogTotal, getCachedClogPage, getCachedClogPageItems } = require('./runeprofile');
const { ACTIVITIES, kcColumnsForTeam, getRsn, clogPageForActivity, loadRsnLinks, rsnLinkRow, getRsnEntry, getStatedBadge, badgeForAccount, BADGE_WORDS } = require('./teams');
const { decodePng } = require('./party-board');
const { getItemIcon } = require('./item-icons');
const { luckForPage, itemLuckScores, dryReport, scoredCounters, pluginCountersFor } = require('./luck');

// A player's full luck counter set: WOM boss/activity
// counts plus any plugin-synced log-header counters.
const countersFor = (stats, rsn) => ({
  ...(stats && stats.kc ? stats.kc : {}),
  ...pluginCountersFor(rsn),
});
const { bountyAutocompleteChoices } = require('./bounty');
const fs = require('fs');
const path = require('path');

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

// The cooldown is per command family (Nov 2, 2026): running
// /kc no longer blocks a /compare right after. Buttons never
// consume it; only a real lookup firing inside a payload does.
function checkCooldown(userId, family, now = Date.now()) {
  pruneCooldownMaps(now);
  const key = `${userId}:${family || 'card'}`;
  const last = lastUseAt.get(key) || 0;
  const waitMs = COOLDOWN_MS - (now - last);
  if (waitMs <= 0) return { wait: 0, notify: false };
  const notified = lastNotifyAt.get(key) || 0;
  const notify = now - notified >= COOLDOWN_MS;
  if (notify) lastNotifyAt.set(key, now);
  return { wait: Math.ceil(waitMs / 1000), notify };
}

function noteUse(userId, family, now = Date.now()) {
  lastUseAt.set(`${userId}:${family || 'card'}`, now);
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
// have to go hunting for it. One line, one job: get them linked. Passing a
// name for a one-off lookup stays supported, but the reply does not push
// it: an unlinked user typing a showoff command wants their own stats.
function unlinkedPayload() {
  return { content: 'No RSN linked yet. Tap below to link yours.', components: rsnLinkRow() };
}

// Name: explicit arg wins, else the author's linked RSN.
function resolveName(args, authorId) {
  const named = args.join(' ').trim().replace(/\s+/g, ' ');
  if (named) {
    if (!RSN_RE.test(named)) return { error: 'That name has characters RuneScape does not allow. Try again.' };
    return { rsn: named };
  }
  const linked = getRsn(authorId);
  if (!linked) return { payload: unlinkedPayload() };
  return { rsn: linked };
}

// Activities can be typed as two words ("toa expert", "cox cm") — fold
// them into the underscored key when the pair matches.
function takeActivity(args, table) {
  // Apostrophes never decide a match: "phosani's" and "phosanis"
  // are the same ask, and members type both.
  const clean = (s) => s.toLowerCase().replace(/['’]/g, '');
  if (args.length >= 2) {
    const two = `${clean(args[0])}_${clean(args[1])}`;
    if (table[two]) {
      args.splice(0, 2);
      return two;
    }
  }
  return clean(args.shift() || '');
}

// Payload builders: return what to reply with ({ files }, { embeds }, or
// { content }), shared by the !-commands and the slash commands.
// !kc beyond the team-finder activities: every other kill-count
// metric Wise Old Man tracks. Team activities stay in ACTIVITIES
// (teams.js) so the Find a Team panel is untouched; this table is
// show-off only. Multi-metric cards group the variants members
// expect together (Dagannoth Kings, Gauntlet, clue tiers).
const KC_ACTIVITIES = {
  sire: { name: 'Abyssal Sire', cols: [{ metric: 'abyssal_sire' }] },
  hydra: { name: 'Alchemical Hydra', cols: [{ metric: 'alchemical_hydra' }] },
  amoxliatl: { name: 'Amoxliatl', cols: [{ metric: 'amoxliatl' }] },
  araxxor: { name: 'Araxxor', cols: [{ metric: 'araxxor' }] },
  barrows: { name: 'Barrows', cols: [{ metric: 'barrows_chests', label: 'Chests' }] },
  bh: { name: 'Bounty Hunter', cols: [{ metric: 'bounty_hunter_hunter', label: 'Hunter' }, { metric: 'bounty_hunter_rogue', label: 'Rogue' }] },
  brutus: { name: 'Brutus', cols: [{ metric: 'brutus' }] },
  bryophyta: { name: 'Bryophyta', cols: [{ metric: 'bryophyta' }] },
  cerberus: { name: 'Cerberus', cols: [{ metric: 'cerberus' }] },
  chaos_ele: { name: 'Chaos Elemental', cols: [{ metric: 'chaos_elemental' }] },
  chaos_elemental: { name: 'Chaos Elemental', cols: [{ metric: 'chaos_elemental' }] },
  chaos_fanatic: { name: 'Chaos Fanatic', cols: [{ metric: 'chaos_fanatic' }] },
  clues: { name: 'Clue Scrolls', cols: [{ metric: 'clue_scrolls_all', label: 'All' }, { metric: 'clue_scrolls_beginner', label: 'Beginner' }, { metric: 'clue_scrolls_easy', label: 'Easy' }, { metric: 'clue_scrolls_medium', label: 'Medium' }, { metric: 'clue_scrolls_hard', label: 'Hard' }, { metric: 'clue_scrolls_elite', label: 'Elite' }, { metric: 'clue_scrolls_master', label: 'Master' }] },
  colosseum: { name: 'Fortis Colosseum', cols: [{ metric: 'sol_heredit', label: 'Sol Heredit' }, { metric: 'colosseum_glory', label: 'Glory' }] },
  zilyana: { name: 'Commander Zilyana', cols: [{ metric: 'commander_zilyana' }] },
  commander_zilyana: { name: 'Commander Zilyana', cols: [{ metric: 'commander_zilyana' }] },
  corp: { name: 'Corporeal Beast', cols: [{ metric: 'corporeal_beast' }] },
  crazy_arch: { name: 'Crazy Archaeologist', cols: [{ metric: 'crazy_archaeologist' }] },
  crazy_archaeologist: { name: 'Crazy Archaeologist', cols: [{ metric: 'crazy_archaeologist' }] },
  dks: { name: 'Dagannoth Kings', cols: [{ metric: 'dagannoth_rex', label: 'Rex' }, { metric: 'dagannoth_prime', label: 'Prime' }, { metric: 'dagannoth_supreme', label: 'Supreme' }] },
  dagannoth_kings: { name: 'Dagannoth Kings', cols: [{ metric: 'dagannoth_rex', label: 'Rex' }, { metric: 'dagannoth_prime', label: 'Prime' }, { metric: 'dagannoth_supreme', label: 'Supreme' }] },
  deranged_arch: { name: 'Deranged Archaeologist', cols: [{ metric: 'deranged_archaeologist' }] },
  deranged_archaeologist: { name: 'Deranged Archaeologist', cols: [{ metric: 'deranged_archaeologist' }] },
  doom: { name: 'Doom of Mokhaiotl', cols: [{ metric: 'doom_of_mokhaiotl' }] },
  duke: { name: 'Duke Sucellus', cols: [{ metric: 'duke_sucellus' }] },
  fractured_archive: { name: 'The Fractured Archive', cols: [{ metric: 'the_fractured_archive' }] },
  tfa: { name: 'The Fractured Archive', cols: [{ metric: 'the_fractured_archive' }] },
  gauntlet: { name: 'The Gauntlet', cols: [{ metric: 'the_gauntlet', label: 'Gauntlet' }, { metric: 'the_corrupted_gauntlet', label: 'Corrupted Gauntlet' }] },
  cg: { name: 'The Gauntlet', cols: [{ metric: 'the_gauntlet', label: 'Gauntlet' }, { metric: 'the_corrupted_gauntlet', label: 'Corrupted Gauntlet' }] },
  graardor: { name: 'General Graardor', cols: [{ metric: 'general_graardor' }] },
  mole: { name: 'Giant Mole', cols: [{ metric: 'giant_mole' }] },
  grotesque_guardians: { name: 'Grotesque Guardians', cols: [{ metric: 'grotesque_guardians' }] },
  gg: { name: 'Grotesque Guardians', cols: [{ metric: 'grotesque_guardians' }] },
  hespori: { name: 'Hespori', cols: [{ metric: 'hespori' }] },
  jad: { name: 'Fight Caves', cols: [{ metric: 'tztok_jad', label: 'TzTok-Jad' }] },
  fight_caves: { name: 'Fight Caves', cols: [{ metric: 'tztok_jad', label: 'TzTok-Jad' }] },
  zuk: { name: 'The Inferno', cols: [{ metric: 'tzkal_zuk', label: 'TzKal-Zuk' }] },
  inferno: { name: 'The Inferno', cols: [{ metric: 'tzkal_zuk', label: 'TzKal-Zuk' }] },
  kq: { name: 'Kalphite Queen', cols: [{ metric: 'kalphite_queen' }] },
  kbd: { name: 'King Black Dragon', cols: [{ metric: 'king_black_dragon' }] },
  kraken: { name: 'Kraken', cols: [{ metric: 'kraken' }] },
  kree: { name: 'Kree\'arra', cols: [{ metric: 'kreearra' }] },
  kreearra: { name: 'Kree\'arra', cols: [{ metric: 'kreearra' }] },
  kril: { name: 'K\'ril Tsutsaroth', cols: [{ metric: 'kril_tsutsaroth' }] },
  kril_tsutsaroth: { name: 'K\'ril Tsutsaroth', cols: [{ metric: 'kril_tsutsaroth' }] },
  leviathan: { name: 'The Leviathan', cols: [{ metric: 'the_leviathan' }] },
  lms: { name: 'Last Man Standing', cols: [{ metric: 'last_man_standing' }] },
  mad_angel: { name: 'The Mad Angel', cols: [{ metric: 'mad_angel' }] },
  maggot_king: { name: 'Maggot King', cols: [{ metric: 'maggot_king' }] },
  mimic: { name: 'The Mimic', cols: [{ metric: 'mimic' }] },
  nightmare: { name: 'The Nightmare', cols: [{ metric: 'nightmare', label: 'Nightmare' }, { metric: 'phosanis_nightmare', label: "Phosani's" }] },
  phosani: { name: "Phosani's Nightmare", cols: [{ metric: 'phosanis_nightmare' }] },
  phosanis: { name: "Phosani's Nightmare", cols: [{ metric: 'phosanis_nightmare' }] },
  tombs: { name: 'Tombs of Amascut', cols: [{ metric: 'tombs_of_amascut', label: 'Normal' }, { metric: 'tombs_of_amascut_expert', label: 'Expert' }] },
  tombs_of_amascut: { name: 'Tombs of Amascut', cols: [{ metric: 'tombs_of_amascut', label: 'Normal' }, { metric: 'tombs_of_amascut_expert', label: 'Expert' }] },
  moons: { name: 'Moons of Peril', cols: [{ metric: 'lunar_chests', label: 'Lunar Chests' }] },
  moons_of_peril: { name: 'Moons of Peril', cols: [{ metric: 'lunar_chests', label: 'Lunar Chests' }] },
  muspah: { name: 'Phantom Muspah', cols: [{ metric: 'phantom_muspah' }] },
  phantom_muspah: { name: 'Phantom Muspah', cols: [{ metric: 'phantom_muspah' }] },
  obor: { name: 'Obor', cols: [{ metric: 'obor' }] },
  pvp_arena: { name: 'PvP Arena', cols: [{ metric: 'pvp_arena' }] },
  sarachnis: { name: 'Sarachnis', cols: [{ metric: 'sarachnis' }] },
  scorpia: { name: 'Scorpia', cols: [{ metric: 'scorpia' }] },
  scurrius: { name: 'Scurrius', cols: [{ metric: 'scurrius' }] },
  shellbane: { name: 'Shellbane Gryphon', cols: [{ metric: 'shellbane_gryphon' }] },
  skotizo: { name: 'Skotizo', cols: [{ metric: 'skotizo' }] },
  soul_wars: { name: 'Soul Wars', cols: [{ metric: 'soul_wars_zeal', label: 'Zeal' }] },
  sw: { name: 'Soul Wars', cols: [{ metric: 'soul_wars_zeal', label: 'Zeal' }] },
  thermy: { name: 'Thermonuclear Smoke Devil', cols: [{ metric: 'thermonuclear_smoke_devil' }] },
  vardorvis: { name: 'Vardorvis', cols: [{ metric: 'vardorvis' }] },
  vorkath: { name: 'Vorkath', cols: [{ metric: 'vorkath' }] },
  whisperer: { name: 'The Whisperer', cols: [{ metric: 'the_whisperer' }] },
  zulrah: { name: 'Zulrah', cols: [{ metric: 'zulrah' }] },
};

// Every key !kc accepts: team activities plus the table above.
const KC_KEYS = { ...ACTIVITIES, ...KC_ACTIVITIES };

function kcEntry(key) {
  if (ACTIVITIES[key]) return { name: ACTIVITIES[key].name, cols: kcColumnsForTeam({ activity: key }) };
  const extra = KC_ACTIVITIES[key];
  if (extra) return { name: extra.name, cols: extra.cols };
  return null;
}

// The JSON body for the website KC card: the boss's numbers plus the
// player's standing on it across the tracked cache, and (when known)
// the collection log strip for the same boss, so !kc and !clog for one
// boss post the same combined card.
function kcCardBody(rsn, entry, st, clog, luck, pets) {
  const primary = entry.cols[0];
  const me = rsn.toLowerCase();
  const perCol = entry.cols.map((c) => {
    let standings = [];
    try { standings = kcStandings(c.metric); } catch { /* cache only */ }
    const idx = standings.findIndex((r) => r.name === me);
    return { standings, rank: idx >= 0 ? idx + 1 : null };
  });
  // Ranks (Alex, Nov 2, 2026): every variant on the card carries
  // its own clan rank, and multi-variant cards add a combined
  // rank and total. Two exceptions: Clue Scrolls, whose first
  // column already is the combined total, and the Fortis
  // Colosseum, whose second column is Glory, not kills, so its
  // rank stays on Sol Heredit kills alone.
  const isClues = primary.metric === 'clue_scrolls_all';
  const combined = entry.cols.length > 1 && entry.name !== 'Fortis Colosseum';
  let standings;
  let myKc;
  let rankLabel = null;
  if (isClues) {
    standings = perCol[0].standings;
    myKc = st.kc ? st.kc[primary.metric] : null;
    rankLabel = 'Combined rank';
  } else if (combined) {
    const totals = new Map();
    for (const p of perCol) {
      for (const row of p.standings) {
        totals.set(row.name, (totals.get(row.name) || 0) + row.kc);
      }
    }
    standings = [...totals.entries()]
      .map(([name, kc]) => ({ name, kc }))
      .sort((x, y) => y.kc - x.kc);
    const myVals = entry.cols.map((c) => (st.kc ? st.kc[c.metric] : null));
    myKc = myVals.every((v) => typeof v !== 'number')
      ? null
      : myVals.reduce((s, v) => s + (typeof v === 'number' ? v : 0), 0);
    rankLabel = 'Combined rank';
  } else {
    standings = perCol[0].standings;
    myKc = st.kc ? st.kc[primary.metric] : null;
  }
  const rankIdx = typeof myKc === 'number'
    ? standings.findIndex((r) => r.name === me)
    : -1;
  return {
    rsn,
    boss: entry.name,
    metric: primary.metric,
    entries: entry.cols.map((c, i) => {
      const n = st.kc ? st.kc[c.metric] : null;
      return {
        label: c.label || (entry.cols.length === 1 ? 'Kill count' : prettyMetric(c.metric)),
        value: typeof n === 'number' ? n.toLocaleString('en-US') : '-',
        // The All column of clues carries no line of its own: its
        // rank is the combined rank in the rank tile.
        rank: combined && !(isClues && i === 0) ? perCol[i].rank : null,
      };
    }),
    kcValue: typeof myKc === 'number' ? myKc : null,
    rank: rankIdx >= 0 ? rankIdx + 1 : null,
    rankLabel,
    // The player's own combined KC for the Total tile (Alex,
    // Nov 2, 2026). Clues stay off it: their All tile already is
    // the total. Single-variant cards and the Colosseum have none.
    totalValue: combined && !isClues && typeof myKc === 'number' ? myKc : null,
    totalLabel: combined && !isClues ? `${entry.name.replace(/^The /, '')} Total` : null,
    rankOf: standings.length,
    clanTotal: standings.length ? standings.reduce((s, r) => s + r.kc, 0) : null,
    members: standings.length,
    badge: cardBadgeFor(rsn, st ? st.accountType : null),
    clog: clog || null,
    luck: luck || null,
    pets: pets || null,
  };
}

// Clan standings for one skill (or overall) by XP, from the same
// merged cache population the KC ranks use.
function skillStandings(skillKey) {
  const dataKey = skillKey === 'runecraft' ? 'runecrafting' : skillKey;
  const rows = [];
  try {
    for (const [name, entry] of Object.entries(mergedPlayers())) {
      const st = entry && entry.stats;
      if (!st || st.notFound || !st.skills) continue;
      const sk = st.skills[dataKey];
      if (!sk || typeof sk.xp !== 'number' || sk.xp <= 0) continue;
      rows.push({ name, xp: sk.xp });
    }
  } catch { /* cache only */ }
  return rows.sort((a, b) => b.xp - a.xp);
}

function skillRank(rsn, skillKey) {
  const idx = skillStandings(skillKey)
    .findIndex((r) => r.name === rsn.toLowerCase());
  return idx >= 0 ? idx + 1 : null;
}

// Leaderboard swap button (Alex, Nov 2, 2026): any card that
// shows a clan rank carries one. Pressing it swaps the card
// itself into the matching board, compare-style, with a Back
// button that restores the card. The backId encodes how to
// rebuild the card the board replaced.
function lbSwapRow(boardArg, backId) {
  return new ActionRowBuilder().addComponents(new ButtonBuilder()
    .setCustomId(`lbswap:${boardArg}:${backId}`)
    .setLabel('Leaderboard')
    .setStyle(ButtonStyle.Danger));
}

function lbBackRow(backId) {
  // The button names the card it returns to (Alex, Nov 2, 2026):
  // a bare "Back" does not say where it goes.
  const segs = String(backId || '').split(':');
  let label = 'Back';
  if (segs[0] === 'kc') label = '\u2190 KC card';
  else if (segs[0] === 'skills') label = '\u2190 Skills card';
  else if (segs[0] === 'skill' && segs[1]) {
    label = `\u2190 ${segs[1].charAt(0).toUpperCase() + segs[1].slice(1)} card`;
  } else if (segs[0] === 'cmpboss' || segs[0] === 'cmpskill') label = '\u2190 Compare card';
  return new ActionRowBuilder().addComponents(new ButtonBuilder()
    .setCustomId(`lbback:${backId}`)
    .setLabel(label)
    .setStyle(ButtonStyle.Secondary));
}

// Card bridges (Nov 2, 2026): a boss's KC card and dry card
// swap into each other on the same message, the way cards swap
// into boards. The clue dry card bridges to the clue summary
// card instead; it has no single KC card.
function bridgeRow(target, key, rsn) {
  const enc = String(rsn).replace(/ /g, '_');
  const label = target === 'dry' ? 'Dry card' : target === 'clues' ? 'Clues card' : 'KC card';
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`bridge:${target}:${key}:${enc}`)
      .setLabel(label)
      .setStyle(ButtonStyle.Danger));
}

async function handleBridgeButton(interaction) {
  const parts = String(interaction.customId || '').split(':');
  const target = parts[1];
  const key = parts[2];
  const rsn = String(parts.slice(3).join(':') || '').replace(/_/g, ' ');
  if (!rsn) return;
  let payload = null;
  if (target === 'kc') payload = await kcPayload(key, rsn, interaction.user.id);
  else if (target === 'dry') payload = await dryPayload(key, rsn, interaction.user.id);
  else if (target === 'clues') payload = await clogPayload('clues', rsn, interaction.user.id);
  else return;
  if (payload && payload.files) {
    // A target with no buttons of its own must land clean:
    // omitting components leaves the old row in place (the
    // clue summary kept the Clues card button this way).
    await interaction.update({ ...payload, components: payload.components || [] }).catch(() => {});
  } else if (payload) {
    await interaction.reply({ ...payload, ephemeral: true }).catch(() => {});
  }
}

async function handleLbSwapButton(interaction) {
  const parts = interaction.customId.split(':');
  let boardArg;
  let backSegs;
  if (parts[1] === 'overall') { boardArg = 'overall'; backSegs = parts.slice(2); }
  else { boardArg = `${parts[1]}:${parts[2]}`; backSegs = parts.slice(3); }
  const payload = await leaderboardPayload(interaction.user.id, boardArg, true);
  const components = [...(payload.components || []), lbBackRow(backSegs.join(':'))];
  await interaction.update({
    content: payload.content || '',
    files: payload.files || [],
    attachments: [],
    components,
  }).catch(() => {});
}

async function handleLbBackButton(interaction) {
  const parts = interaction.customId.split(':');
  const kind = parts[1];
  const un = (s) => String(s || '').replace(/_/g, ' ');
  let payload = null;
  if (kind === 'kc') {
    payload = await kcPayload(parts[2], un(parts[3]), interaction.user.id);
  } else if (kind === 'skills') {
    payload = await skillsPayload(un(parts[2]), interaction.user.id);
  } else if (kind === 'skill') {
    payload = await skillPayload(un(parts[3]), parts[2], interaction.user.id);
  } else if (kind === 'cmpboss') {
    const pair = decodePair(parts[3]);
    if (pair) payload = await compareViewRender('boss', parts[2], pair.a, pair.b, pair.owner);
  } else if (kind === 'cmpskill') {
    const pair = decodePair(parts[3]);
    if (pair) payload = await compareSkillsPayload(pair.a, pair.b, interaction.user.id, pair.owner, { skill: parts[2] });
  }
  if (!payload) return;
  await interaction.update({
    content: payload.content || '',
    files: payload.files || [],
    attachments: [],
    components: payload.components || [],
  }).catch(() => {});
}

// Load a clog page's obtained items with their icons (decoded for the
// in-bot renderer, base64 for the website card). Icons fetch in
// parallel through the paced item-icon queue.
async function loadClogItems(res) {
  // EVERY item on the page, obtained and missing: missing items
  // render as dark silhouettes, the way the game log shows them.
  // Entries carry their item id so callers pair scores by id,
  // never by position.
  return Promise.all((res.items || []).slice(0, 250).map(async (it) => {
    let icon = null;
    let iconB64 = null;
    const p = await getItemIcon(it.id, it.name).catch(() => null);
    if (p) {
      try {
        const raw = fs.readFileSync(p);
        icon = decodePng(raw);
        iconB64 = raw.toString('base64');
      } catch { icon = null; }
    }
    return { id: it.id, icon, qty: it.quantity || 0, iconB64 };
  }));
}



// The compare boss card's per-player clog strip + luck line. One
// RuneProfile page fetch feeds both: the strip draws obtained items,
// the luck engine scores the full page (obtained and missing)
// against the player's counters. Never throws.
async function bossClogLuck(rsn, key, counters) {
  const page = CLOG_PAGES[key] || clogPageForActivity(key);
  if (!page) return { clog: null, luck: null };
  try {
    const res = await getClogPageWithItems(rsn, page[0], page[1]);
    if (!res || res.notFound) return { clog: null, luck: null };
    // Full strip: EVERY item on the page (obtained and
    // missing), each scored item carrying its luck percentile
    // (the plugin's overall luck, 0-100).
    const scores = itemLuckScores(counters, res.items || []);
    const fullItems = await Promise.all((res.items || []).map(async (it) => ({
      qty: it.quantity || 0,
      has: (it.quantity || 0) > 0,
      score: scores[it.id] != null ? scores[it.id] : null,
      icon: await petIconB64(it.id, it.name),
    })));
    return {
      clog: {
        obtained: res.obtained,
        total: res.total,
        items: fullItems,
      },
      luck: luckForPage(counters,
        (res.items || []).map((it) => ({ id: it.id, qty: it.quantity || 0 }))),
      pageItems: res.items || [],
    };
  } catch {
    return { clog: null, luck: null };
  }
}

// Pets in compare (Alex, Oct 31, 2026): the All Pets page is the
// source of truth for which clog items are pets. A boss card
// attaches the pet(s) on that boss's own page; a skill card
// attaches the skill's pet(s).
const SKILL_PETS = {
  agility: ['Giant Squirrel'],
  fishing: ['Heron'],
  woodcutting: ['Beaver'],
  thieving: ['Rocky'],
  farming: ['Tangleroot'],
  runecraft: ['Rift guardian'],
  hunter: ['Herbi', 'Baby chinchompa', 'Quetzin', 'Mr McGroot'],
  mining: ['Rock golem'],
  firemaking: ['Phoenix'],
  sailing: ['Soup'],
};

async function allPetsItems(rsn) {
  try {
    const res = await getClogPageWithItems(rsn, 'Other', 'All Pets');
    if (!res || res.notFound || !Array.isArray(res.items)) return null;
    return res.items;
  } catch { return null; }
}

async function petIconB64(id, name) {
  const p = await getItemIcon(id, name).catch(() => null);
  if (!p) return null;
  try { return fs.readFileSync(p).toString('base64'); } catch { return null; }
}

async function petIdSet(aName, bName) {
  const ids = new Set();
  for (const rsn of [aName, bName]) {
    const items = await allPetsItems(rsn);
    if (items) for (const it of items) ids.add(it.id);
  }
  return ids;
}

async function petsForSide(pageItems, petIds) {
  if (!Array.isArray(pageItems) || !petIds || !petIds.size) return null;
  const found = pageItems.filter((it) => petIds.has(it.id));
  if (!found.length) return null;
  return Promise.all(found.map(async (it) => ({
    name: it.name,
    has: (it.quantity || 0) > 0,
    icon: await petIconB64(it.id, it.name),
  })));
}


// ─── Account-type gate ───────────────────────────────────────────────
// A member's own account gets no card until its game mode is stated.
// Looking up someone else is never gated. Returns the setup reply, or
// null when the card may run.
function ownAccountGate(userId, rsn) {
  if (!userId || !rsn) return null;
  const entry = getRsnEntry(userId);
  if (!entry.rsns.some((r) => r.toLowerCase() === String(rsn).toLowerCase())) return null;
  if (getStatedBadge(userId, rsn)) return null;
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('team:badge')
      .setLabel('Account Type')
      .setStyle(ButtonStyle.Danger)
      .setEmoji({ name: 'accounttype', id: '1561578543501025313' })
  );
  if (entry.rsns.length > 1) {
    row.addComponents(
      new ButtonBuilder().setCustomId('team:rsnswitch').setLabel('Switch RSN').setStyle(ButtonStyle.Danger).setEmoji('⚔️')
    );
  }
  return {
    content: `Set the account type for **${rsn}** first. Press **Account Type**, pick its mode, then run the command again.`,
    components: [row],
  };
}

async function kcPayload(activity, rsn, userId) {
  const gate = ownAccountGate(userId, rsn);
  if (gate) return gate;
  const entry = activity ? kcEntry(activity) : null;
  if (!entry) {
    return { content: `Pick an activity: \`!kc <activity> [name]\`\nActivities: ${Object.keys(KC_KEYS).join(', ')}` };
  }
  if (userId) noteUse(userId, 'kc'); // a real lookup fires: start the cooldown
  let st;
  try {
    st = await getStats(rsn);
  } catch (err) {
    return { content: 'Could not reach the stats service right now. Try again in a bit.' };
  }
  if (!st) return { content: 'Could not reach the stats service right now. Try again in a bit.' };
  if (st.notFound) return { content: `Could not find the RuneScape name **${rsn}**. Check the spelling and try again.` };
  if (!entry.cols.length) return { content: `No kill count is tracked for ${entry.name}.` };
  // Website card first: same numbers, share-card style, plus
  // the player's standing on this boss. The collection log
  // block is the full strip with luck scores, from the same
  // one-fetch path as compare. No separate pet line: the pet
  // is an item on the page and shows in the strip.
  const cl = await bossClogLuck(rsn, activity, countersFor(st, rsn));
  const body = kcCardBody(rsn, entry, st, cl.clog, cl.luck, null);
  const card = await fetchCard('/kc', body);
  if (card) {
    const rows = [];
    if (body.rank) rows.push(lbSwapRow(`boss:${activity}`, `kc:${activity}:${rsn.replace(/ /g, '_')}`));
    if (dryScoredKeys().some((k) => kcEntry(k).name === entry.name)) rows.push(bridgeRow('dry', activity, rsn));
    return {
      files: [new AttachmentBuilder(card, { name: 'kc.png' })],
      components: rows,
    };
  }
  return CARD_DOWN;
}

// !dry <boss> [name]: one player's drop luck on one boss, from
// the same engine that scores the compare strips. Raids and
// the wilderness boss pairs are not scored and say so.
// Canonical scored bosses for /dry: one entry per boss name, only
// bosses the luck table can score (raids and the wilderness boss
// pairs are excluded in the table itself). First key wins per name,
// so aliases keep working when typed but never list twice.
function dryScoredKeys() {
  const scored = scoredCounters();
  const seen = new Set();
  const out = [];
  for (const k of Object.keys(KC_KEYS)) {
    const e = kcEntry(k);
    if (!e || seen.has(e.name)) continue;
    if (!(CLOG_PAGES[k] || clogPageForActivity(k))) continue;
    if (!e.cols.some((c) => scored.has(c.metric))) continue;
    seen.add(e.name);
    out.push(k);
  }
  return out;
}

function dryAutocompleteChoices(focused) {
  const q = String(focused || '').toLowerCase();
  return dryScoredKeys()
    .map((value) => ({ name: kcEntry(value).name, value }))
    .concat([{ name: 'Clue Scrolls (all tiers)', value: 'clue:all' }],
      CLUE_TIERS.map(([label]) => ({
        name: `${label} Clue Scrolls`, value: `clue:${label.toLowerCase()}`,
      })))
    .filter((c) => !q || c.name.toLowerCase().includes(q) || c.value.includes(q))
    .slice(0, 25);
}

async function dryPayload(activity, rsn, userId) {
  if (activity && String(activity).startsWith('clue:')) {
    const tier = String(activity).slice(5);
    if (tier === 'all') return dryCluesAllPayload(rsn, userId);
    return dryCluePayload(tier, rsn, userId);
  }
  const gate = ownAccountGate(userId, rsn);
  if (gate) return gate;
  const entry = activity ? kcEntry(activity) : null;
  if (!entry) {
    return { content: `Pick a scored boss: \`!dry <boss> [name]\`\nScored: ${dryScoredKeys().join(', ')}` };
  }
  if (userId) noteUse(userId, 'dry');
  let st;
  try {
    st = await getStats(rsn);
  } catch {
    return { content: 'Could not reach the stats service right now. Try again in a bit.' };
  }
  if (!st) return { content: 'Could not reach the stats service right now. Try again in a bit.' };
  if (st.notFound) return { content: `Could not find the RuneScape name **${rsn}**. Check the spelling and try again.` };
  const metric = entry.cols.length ? entry.cols[0].metric : null;
  // The Gauntlet is one boss with two counters: gauge the KC across
  // both, the way its luck items are scored (each at its own rates).
  let kc = metric && st.kc ? st.kc[metric] : null;
  if (entry.name === 'The Gauntlet' && st.kc) {
    kc = (st.kc.the_gauntlet || 0) + (st.kc.the_corrupted_gauntlet || 0) || null;
  }
  if (!kc) return { content: `**${rsn}** has no ${entry.name} kills yet, so there is no luck to check.` };
  const page = CLOG_PAGES[activity] || clogPageForActivity(activity);
  if (!page) return { content: `${entry.name} has no collection log page to score.` };
  const res = await getClogPageWithItems(rsn, page[0], page[1]).catch(() => null);
  if (!res || res.notFound) {
    const prof = await getProfile(rsn).catch(() => null);
    if (prof && !prof.notFound && prof.account) {
      return { content: `The ${entry.name} page is not synced for **${rsn}** yet. Their collection log total is in, but this page has not been read. Open the Collection Log in game, go to the ${entry.name} page, then press the RuneProfile button in the top-left.` };
    }
    return { content: `The collection log is not synced for **${rsn}** yet, so there is nothing to score. ${CLOG_SYNC_STEPS}` };
  }
  const report = dryReport(countersFor(st, rsn),
    (res.items || []).map((it) => ({ id: it.id, qty: it.quantity || 0 })));
  if (!report) {
    const scored = scoredCounters();
    if (!entry.cols.some((c) => scored.has(c.metric))) {
      return { content: `No luck scoring for ${entry.name}. Raids and the wilderness boss pairs are not scored.` };
    }
    return { content: `No scored drops could be checked for ${entry.name} on **${rsn}** yet.` };
  }
  const withIcons = async (list) => Promise.all(list.map(async (e) => ({
    ...e, icon: e.id ? await petIconB64(e.id, e.name) : null,
  })));
  const card = await fetchCard('/dry', {
    boss: entry.name, metric, rsn, kc, word: report.word,
    badge: cardBadgeFor(rsn, st ? st.accountType : null),
    missing: await withIcons(report.missing),
    obtained: await withIcons(report.obtained),
  });
  if (card) {
    return {
      files: [new AttachmentBuilder(card, { name: 'dry.png' })],
      components: [bridgeRow('kc', activity, rsn)],
    };
  }
  return CARD_DOWN;
}

// !dry clues: one dry report across all six clue tiers. Each
// item scores against its own tier's completions (the counters
// map carries them all), and every row names its tier. The
// word is the merged verdict across the whole clue log.
async function dryCluesAllPayload(rsn, userId) {
  const gate = ownAccountGate(userId, rsn);
  if (gate) return gate;
  if (userId) noteUse(userId, 'dry');
  let st;
  try {
    st = await getStats(rsn);
  } catch {
    return { content: 'Could not reach the stats service right now. Try again in a bit.' };
  }
  if (!st) return { content: 'Could not reach the stats service right now. Try again in a bit.' };
  if (st.notFound) return { content: `Could not find the RuneScape name **${rsn}**. Check the spelling and try again.` };
  const kc = st.kc ? st.kc.clue_scrolls_all : null;
  if (!kc) return { content: `**${rsn}** has not completed any clues yet, so there is no luck to check.` };
  const pages = await Promise.all(CLUE_TIERS.map(async ([label, title]) => {
    const res = await getClogPageWithItems(rsn, 'Clues', title).catch(() => null);
    return { label, res };
  }));
  const tierOf = {};
  const items = [];
  let anyPage = false;
  for (const { label, res } of pages) {
    if (!res || res.notFound) continue;
    anyPage = true;
    for (const it of res.items || []) {
      if (it.id in tierOf) continue;
      tierOf[it.id] = label;
      items.push({ id: it.id, qty: it.quantity || 0 });
    }
  }
  if (!anyPage) {
    const prof = await getProfile(rsn).catch(() => null);
    if (prof && !prof.notFound && prof.account) {
      return { content: `The Clue Scrolls pages are not synced for **${rsn}** yet. Their collection log total is in, but the clue pages have not been read. Open the Collection Log in game, go to a Clue Scrolls page, then press the RuneProfile button in the top-left.` };
    }
    return { content: `The collection log is not synced for **${rsn}** yet, so there is nothing to score. ${CLOG_SYNC_STEPS}` };
  }
  const report = dryReport(countersFor(st, rsn), items);
  if (!report) return { content: `No scored drops could be checked for Clue Scrolls on **${rsn}** yet.` };
  const withIcons = async (list) => Promise.all(list.map(async (e) => ({
    ...e,
    name: `${e.name} (${tierOf[e.id] || '?'})`,
    icon: e.id ? await petIconB64(e.id, e.name) : null,
  })));
  const card = await fetchCard('/dry', {
    boss: 'Clue Scrolls', metric: 'clue_scrolls_all', rsn, kc, word: report.word,
    badge: cardBadgeFor(rsn, st.accountType),
    missing: await withIcons(report.missing),
    obtained: await withIcons(report.obtained),
  });
  if (card) {
    return {
      files: [new AttachmentBuilder(card, { name: 'dry.png' })],
      components: [bridgeRow('clues', '-', rsn)],
    };
  }
  return CARD_DOWN;
}

// !dry hard clues: one tier of the clue log, scored like a
// boss page (the tier's completions are the counter). The
// summary card already proves the scoring; this is the full
// dry report for a single tier.
async function dryCluePayload(tierKey, rsn, userId) {
  const t = CLUE_TIERS.find((x) => x[2] === tierKey);
  if (!t) return { content: 'Pick a tier: `!dry beginner clues`, `!dry easy clues`, `!dry medium clues`, `!dry hard clues`, `!dry elite clues`, or `!dry master clues`.' };
  const [label, title, , metric] = t;
  const name = `${label} Clue Scrolls`;
  const gate = ownAccountGate(userId, rsn);
  if (gate) return gate;
  if (userId) noteUse(userId, 'dry');
  let st;
  try {
    st = await getStats(rsn);
  } catch {
    return { content: 'Could not reach the stats service right now. Try again in a bit.' };
  }
  if (!st) return { content: 'Could not reach the stats service right now. Try again in a bit.' };
  if (st.notFound) return { content: `Could not find the RuneScape name **${rsn}**. Check the spelling and try again.` };
  const kc = st.kc ? st.kc[metric] : null;
  if (!kc) return { content: `**${rsn}** has not completed any ${label.toLowerCase()} clues yet, so there is no luck to check.` };
  const res = await getClogPageWithItems(rsn, 'Clues', title).catch(() => null);
  if (!res || res.notFound) {
    const prof = await getProfile(rsn).catch(() => null);
    if (prof && !prof.notFound && prof.account) {
      return { content: `The ${name} page is not synced for **${rsn}** yet. Their collection log total is in, but this page has not been read. Open the Collection Log in game, go to the ${title} page, then press the RuneProfile button in the top-left.` };
    }
    return { content: `The collection log is not synced for **${rsn}** yet, so there is nothing to score. ${CLOG_SYNC_STEPS}` };
  }
  const report = dryReport(countersFor(st, rsn),
    (res.items || []).map((it) => ({ id: it.id, qty: it.quantity || 0 })));
  if (!report) return { content: `No scored drops could be checked for ${name} on **${rsn}** yet.` };
  const withIcons = async (list) => Promise.all(list.map(async (e) => ({
    ...e, icon: e.id ? await petIconB64(e.id, e.name) : null,
  })));
  const card = await fetchCard('/dry', {
    boss: name, metric, rsn, kc, word: report.word,
    badge: cardBadgeFor(rsn, st.accountType),
    missing: await withIcons(report.missing),
    obtained: await withIcons(report.obtained),
  });
  if (card) {
    return {
      files: [new AttachmentBuilder(card, { name: 'dry.png' })],
      components: [bridgeRow('clues', '-', rsn)],
    };
  }
  return CARD_DOWN;
}

async function handleDryCommand(message, args) {
  const cd = checkCooldown(message.author.id, 'dry');
  if (cd.wait) { if (cd.notify) await message.reply(cooldownText(cd.wait)).catch(() => {}); return; }
  const joined = args.join(' ').toLowerCase();
  if (/\bclues?\b|\bscrolls?\b/.test(joined)) {
    const t = CLUE_TIERS.find(([label]) => joined.includes(label.toLowerCase()));
    if (!t) {
      const rest = args.filter((a) => !['clue', 'clues', 'scroll', 'scrolls'].includes(String(a).toLowerCase()));
      const r = resolveName(rest, message.author.id);
      if (r.error) { await message.reply(r.error).catch(() => {}); return; }
      if (r.payload) { await message.reply(r.payload).catch(() => {}); return; }
      await message.reply(await dryCluesAllPayload(r.rsn, message.author.id)).catch(() => {});
      return;
    }
    const drop = new Set(['clue', 'clues', 'scroll', 'scrolls',
      ...CLUE_TIERS.map(([label]) => label.toLowerCase())]);
    const rest = args.filter((a) => !drop.has(String(a).toLowerCase()));
    const r = resolveName(rest, message.author.id);
    if (r.error) { await message.reply(r.error).catch(() => {}); return; }
    if (r.payload) { await message.reply(r.payload).catch(() => {}); return; }
    await message.reply(await dryCluePayload(t[2], r.rsn, message.author.id)).catch(() => {});
    return;
  }
  const activity = takeActivity(args, KC_KEYS);
  const { rsn, error, payload } = resolveName(args, message.author.id);
  if (error) { await message.reply(error).catch(() => {}); return; }
  if (payload) { await message.reply(payload).catch(() => {}); return; }
  await message.reply(await dryPayload(activity, rsn, message.author.id)).catch(() => {});
}

// !gains [name] [day|week|month|year]: XP and KC gained over
// the period, read from Wise Old Man deltas (src/wom
// getPlayerGains: their snapshot history, normalized + file
// cached). The bot's own daily snapshots keep recording as an
// independent backup but no longer feed this card.
const GAINS_PERIOD_DAYS = { day: 1, week: 7, month: 30, year: 365 };
const GAINS_PERIOD_LABEL = { day: 'Day', week: 'Week', month: 'Month', year: 'Year' };

function gainsPeriod(p) {
  if (p === 7 || p === '7') return 'week';
  if (p === 30 || p === '30') return 'month';
  if (p === 1 || p === '1') return 'day';
  if (p === 365 || p === '365') return 'year';
  const s = String(p || '').toLowerCase();
  return GAINS_PERIODS.includes(s) ? s : 'week';
}

function gainsPeriodRow(period, rsn) {
  const enc = String(rsn).replace(/ /g, '_');
  const btn = (p) => new ButtonBuilder()
    .setCustomId(`gains:${p}:${enc}`)
    .setLabel(GAINS_PERIOD_LABEL[p])
    .setStyle(p === period ? ButtonStyle.Danger : ButtonStyle.Secondary)
    .setDisabled(p === period);
  return new ActionRowBuilder().addComponents(
    btn('day'), btn('week'), btn('month'), btn('year'));
}

async function gainsPayload(rsn, periodIn, userId) {
  const period = gainsPeriod(periodIn);
  const gate = ownAccountGate(userId, rsn);
  if (gate) return gate;
  if (userId) noteUse(userId, 'gains');
  let st;
  try {
    st = await getStats(rsn);
  } catch {
    return { content: 'Could not reach the stats service right now. Try again in a bit.' };
  }
  if (!st) return { content: 'Could not reach the stats service right now. Try again in a bit.' };
  if (st.notFound) return { content: `Could not find the RuneScape name **${rsn}**. Check the spelling and try again.` };
  const g = await getPlayerGains(rsn, period);
  if (!g) return { content: `Wise Old Man has no gains history for **${rsn}** yet.` };
  const card = await fetchCard('/gains', {
    rsn, badge: cardBadgeFor(rsn, st.accountType), spanDays: GAINS_PERIOD_DAYS[period],
    totalXp: g.totalXp, totalKc: g.totalKc,
    skills: g.skills.slice(0, 5), bosses: g.bosses.slice(0, 5),
  });
  if (card) {
    return {
      files: [new AttachmentBuilder(card, { name: 'gains.png' })],
      components: [gainsPeriodRow(period, rsn)],
    };
  }
  return CARD_DOWN;
}

// Period flip on a posted gains card. Open to everyone like
// the compare and leaderboard view controls; a press that hits
// the account-type gate (only possible for the card owner on
// their own unstated account) answers privately instead of
// replacing the card.
async function handleGainsButton(interaction) {
  const parts = String(interaction.customId || '').split(':');
  const period = gainsPeriod(parts[1]);
  const rsn = String(parts.slice(2).join(':') || '').replace(/_/g, ' ');
  if (!rsn) return;
  const payload = await gainsPayload(rsn, period, interaction.user.id);
  if (payload && payload.files) {
    await interaction.update(payload).catch(() => {});
  } else if (payload) {
    await interaction.reply({ ...payload, ephemeral: true }).catch(() => {});
  }
}

async function handleGainsCommand(message, args) {
  const cd = checkCooldown(message.author.id, 'gains');
  if (cd.wait) { if (cd.notify) await message.reply(cooldownText(cd.wait)).catch(() => {}); return; }
  let period = 'week';
  const rest = [];
  for (const a of args) {
    const low = String(a).toLowerCase();
    if (low === 'day' || low === 'daily') period = 'day';
    else if (low === 'week' || low === 'weekly') period = 'week';
    else if (low === 'month' || low === 'monthly') period = 'month';
    else if (low === 'year' || low === 'yearly') period = 'year';
    else rest.push(a);
  }
  const { rsn, error, payload } = resolveName(rest, message.author.id);
  if (error) { await message.reply(error).catch(() => {}); return; }
  if (payload) { await message.reply(payload).catch(() => {}); return; }
  await message.reply(await gainsPayload(rsn, period, message.author.id)).catch(() => {});
}

async function handleKcCommand(message, args) {
  const cd = checkCooldown(message.author.id, 'kc');
  if (cd.wait) { if (cd.notify) await message.reply(cooldownText(cd.wait)).catch(() => {}); return; }
  const activity = takeActivity(args, KC_KEYS);
  const { rsn, error, payload } = resolveName(args, message.author.id);
  if (error) { await message.reply(error).catch(() => {}); return; }
  if (payload) { await message.reply(payload).catch(() => {}); return; }
  await message.reply(await kcPayload(activity, rsn, message.author.id)).catch(() => {});
}

function progressBar(obtained, total) {
  const filled = total > 0 ? Math.round((obtained / total) * 10) : 0;
  const pct = total > 0 ? Math.round((obtained / total) * 100) : 0;
  return `${'█'.repeat(filled)}${'░'.repeat(10 - filled)} ${obtained}/${total} (${pct}%)`;
}

const CLOG_SYNC_STEPS = 'To sync it: install the RuneProfile plugin in RuneLite, log in on that account, open your Collection Log, then press the RuneProfile button in the top-left. There is no RSN to type in; it reads the account you\'re on.';
const RP_GUIDE = 'No RuneProfile profile found for that name. ' + CLOG_SYNC_STEPS;

// !clog covers the whole collection log: every RuneProfile page,
// grouped by tab. Keys are the short names members type; common
// aliases point at the same page. Page names must match
// RuneProfile exactly (the paired wildy bosses live on combined
// pages: "Venenatis and Spindel", "Callisto and Artio",
// "Vet'ion and Calvar'ion").
const CLOG_PAGES = {
  toa: ['Raids', 'Tombs of Amascut'],
  toa_expert: ['Raids', 'Tombs of Amascut'],
  cox: ['Raids', 'Chambers of Xeric'],
  cox_cm: ['Raids', 'Chambers of Xeric'],
  tob: ['Raids', 'Theatre of Blood'],
  tob_hard: ['Raids', 'Theatre of Blood'],
  fractured_archive: ['Raids', 'The Fractured Archive'],
  tfa: ['Raids', 'The Fractured Archive'],
  abyssal_sire: ['Bosses', 'Abyssal Sire'],
  sire: ['Bosses', 'Abyssal Sire'],
  alchemical_hydra: ['Bosses', 'Alchemical Hydra'],
  hydra: ['Bosses', 'Alchemical Hydra'],
  amoxliatl: ['Bosses', 'Amoxliatl'],
  araxxor: ['Bosses', 'Araxxor'],
  barrows: ['Bosses', 'Barrows Chests'],
  barrows_chests: ['Bosses', 'Barrows Chests'],
  brutus: ['Bosses', 'Brutus'],
  bryophyta: ['Bosses', 'Bryophyta'],
  callisto: ['Bosses', 'Callisto and Artio'],
  cerberus: ['Bosses', 'Cerberus'],
  chaos_elemental: ['Bosses', 'Chaos Elemental'],
  chaos_ele: ['Bosses', 'Chaos Elemental'],
  chaos_fanatic: ['Bosses', 'Chaos Fanatic'],
  commander_zilyana: ['Bosses', 'Commander Zilyana'],
  zilyana: ['Bosses', 'Commander Zilyana'],
  corporeal_beast: ['Bosses', 'Corporeal Beast'],
  corp: ['Bosses', 'Corporeal Beast'],
  crazy_archaeologist: ['Bosses', 'Crazy Archaeologist'],
  crazy_arch: ['Bosses', 'Crazy Archaeologist'],
  dagannoth_kings: ['Bosses', 'Dagannoth Kings'],
  dks: ['Bosses', 'Dagannoth Kings'],
  deranged_archaeologist: ['Bosses', 'Deranged Archaeologist'],
  deranged_arch: ['Bosses', 'Deranged Archaeologist'],
  doom_of_mokhaiotl: ['Bosses', 'Doom of Mokhaiotl'],
  doom: ['Bosses', 'Doom of Mokhaiotl'],
  duke_sucellus: ['Bosses', 'Duke Sucellus'],
  duke: ['Bosses', 'Duke Sucellus'],
  fight_caves: ['Bosses', 'The Fight Caves'],
  jad: ['Bosses', 'The Fight Caves'],
  fortis_colosseum: ['Bosses', 'Fortis Colosseum'],
  colosseum: ['Bosses', 'Fortis Colosseum'],
  gauntlet: ['Bosses', 'The Gauntlet'],
  cg: ['Bosses', 'The Gauntlet'],
  general_graardor: ['Bosses', 'General Graardor'],
  graardor: ['Bosses', 'General Graardor'],
  giant_mole: ['Bosses', 'Giant Mole'],
  mole: ['Bosses', 'Giant Mole'],
  grotesque_guardians: ['Bosses', 'Grotesque Guardians'],
  gg: ['Bosses', 'Grotesque Guardians'],
  hespori: ['Bosses', 'Hespori'],
  huey: ['Bosses', 'The Hueycoatl'],
  inferno: ['Bosses', 'The Inferno'],
  zuk: ['Bosses', 'The Inferno'],
  kalphite_queen: ['Bosses', 'Kalphite Queen'],
  kq: ['Bosses', 'Kalphite Queen'],
  king_black_dragon: ['Bosses', 'King Black Dragon'],
  kbd: ['Bosses', 'King Black Dragon'],
  kraken: ['Bosses', 'Kraken'],
  kreearra: ['Bosses', 'Kree\'arra'],
  kree: ['Bosses', 'Kree\'arra'],
  kril_tsutsaroth: ['Bosses', 'K\'ril Tsutsaroth'],
  kril: ['Bosses', 'K\'ril Tsutsaroth'],
  leviathan: ['Bosses', 'The Leviathan'],
  mad_angel: ['Bosses', 'The Mad Angel'],
  maggot_king: ['Bosses', 'Maggot King'],
  moons_of_peril: ['Bosses', 'Moons of Peril'],
  moons: ['Bosses', 'Moons of Peril'],
  nex: ['Bosses', 'Nex'],
  nm: ['Bosses', 'The Nightmare'],
  obor: ['Bosses', 'Obor'],
  phantom_muspah: ['Bosses', 'Phantom Muspah'],
  muspah: ['Bosses', 'Phantom Muspah'],
  royals: ['Bosses', 'Royal Titans'],
  sarachnis: ['Bosses', 'Sarachnis'],
  scorpia: ['Bosses', 'Scorpia'],
  scurrius: ['Bosses', 'Scurrius'],
  shellbane_gryphon: ['Bosses', 'Shellbane Gryphon'],
  shellbane: ['Bosses', 'Shellbane Gryphon'],
  skotizo: ['Bosses', 'Skotizo'],
  tempoross: ['Bosses', 'Tempoross'],
  thermonuclear_smoke_devil: ['Bosses', 'Thermonuclear Smoke Devil'],
  thermy: ['Bosses', 'Thermonuclear Smoke Devil'],
  vardorvis: ['Bosses', 'Vardorvis'],
  venenatis: ['Bosses', 'Venenatis and Spindel'],
  vetion: ['Bosses', 'Vet\'ion and Calvar\'ion'],
  vorkath: ['Bosses', 'Vorkath'],
  whisperer: ['Bosses', 'The Whisperer'],
  wintertodt: ['Bosses', 'Wintertodt'],
  yama: ['Bosses', 'Yama'],
  zalcano: ['Bosses', 'Zalcano'],
  zulrah: ['Bosses', 'Zulrah'],
  clues_beginner: ['Clues', 'Beginner Treasure Trails'],
  clues_easy: ['Clues', 'Easy Treasure Trails'],
  clues_medium: ['Clues', 'Medium Treasure Trails'],
  clues_hard: ['Clues', 'Hard Treasure Trails'],
  clues_elite: ['Clues', 'Elite Treasure Trails'],
  clues_master: ['Clues', 'Master Treasure Trails'],
  beginner_clues: ['Clues', 'Beginner Treasure Trails'],
  easy_clues: ['Clues', 'Easy Treasure Trails'],
  medium_clues: ['Clues', 'Medium Treasure Trails'],
  hard_clues: ['Clues', 'Hard Treasure Trails'],
  elite_clues: ['Clues', 'Elite Treasure Trails'],
  master_clues: ['Clues', 'Master Treasure Trails'],
  beginner_clue: ['Clues', 'Beginner Treasure Trails'],
  easy_clue: ['Clues', 'Easy Treasure Trails'],
  medium_clue: ['Clues', 'Medium Treasure Trails'],
  hard_clue: ['Clues', 'Hard Treasure Trails'],
  elite_clue: ['Clues', 'Elite Treasure Trails'],
  master_clue: ['Clues', 'Master Treasure Trails'],
  nightmare: ['Bosses', 'The Nightmare'],
  phosani: ['Bosses', 'The Nightmare'],
  phosanis: ['Bosses', 'The Nightmare'],
  tombs: ['Raids', 'Tombs of Amascut'],
  tombs_of_amascut: ['Raids', 'Tombs of Amascut'],
  clues_hard_rare: ['Clues', 'Hard Treasure Trails (Rare)'],
  clues_elite_rare: ['Clues', 'Elite Treasure Trails (Rare)'],
  clues_master_rare: ['Clues', 'Master Treasure Trails (Rare)'],
  clues_shared: ['Clues', 'Shared Treasure Trail Rewards'],
  clues: ['Clues', 'Shared Treasure Trail Rewards'],
  scrolls_beginner: ['Clues', 'Beginner Treasure Trails'],
  scrolls_easy: ['Clues', 'Easy Treasure Trails'],
  scrolls_medium: ['Clues', 'Medium Treasure Trails'],
  scrolls_hard: ['Clues', 'Hard Treasure Trails'],
  scrolls_elite: ['Clues', 'Elite Treasure Trails'],
  scrolls_master: ['Clues', 'Master Treasure Trails'],
  beginner_scrolls: ['Clues', 'Beginner Treasure Trails'],
  easy_scrolls: ['Clues', 'Easy Treasure Trails'],
  medium_scrolls: ['Clues', 'Medium Treasure Trails'],
  hard_scrolls: ['Clues', 'Hard Treasure Trails'],
  elite_scrolls: ['Clues', 'Elite Treasure Trails'],
  master_scrolls: ['Clues', 'Master Treasure Trails'],
  beginner_scroll: ['Clues', 'Beginner Treasure Trails'],
  easy_scroll: ['Clues', 'Easy Treasure Trails'],
  medium_scroll: ['Clues', 'Medium Treasure Trails'],
  hard_scroll: ['Clues', 'Hard Treasure Trails'],
  elite_scroll: ['Clues', 'Elite Treasure Trails'],
  master_scroll: ['Clues', 'Master Treasure Trails'],
  scrolls_hard_rare: ['Clues', 'Hard Treasure Trails (Rare)'],
  scrolls_elite_rare: ['Clues', 'Elite Treasure Trails (Rare)'],
  scrolls_master_rare: ['Clues', 'Master Treasure Trails (Rare)'],
  scrolls_shared: ['Clues', 'Shared Treasure Trail Rewards'],
  scrolls: ['Clues', 'Shared Treasure Trail Rewards'],
  scroll_cases: ['Clues', 'Scroll Cases'],
  ba: ['Minigames', 'Barbarian Assault'],
  barracuda_trials: ['Minigames', 'Barracuda Trials'],
  brimhaven_agility_arena: ['Minigames', 'Brimhaven Agility Arena'],
  brimhaven: ['Minigames', 'Brimhaven Agility Arena'],
  castle_wars: ['Minigames', 'Castle Wars'],
  cw: ['Minigames', 'Castle Wars'],
  fishing_trawler: ['Minigames', 'Fishing Trawler'],
  trawler: ['Minigames', 'Fishing Trawler'],
  giants_foundry: ['Minigames', 'Giants\' Foundry'],
  foundry: ['Minigames', 'Giants\' Foundry'],
  gnome_restaurant: ['Minigames', 'Gnome Restaurant'],
  gotr: ['Minigames', 'Guardians of the Rift'],
  hallowed_sepulchre: ['Minigames', 'Hallowed Sepulchre'],
  sepulchre: ['Minigames', 'Hallowed Sepulchre'],
  last_man_standing: ['Minigames', 'Last Man Standing'],
  lms: ['Minigames', 'Last Man Standing'],
  magic_training_arena: ['Minigames', 'Magic Training Arena'],
  mta: ['Minigames', 'Magic Training Arena'],
  mahogany_homes: ['Minigames', 'Mahogany Homes'],
  mastering_mixology: ['Minigames', 'Mastering Mixology'],
  mixology: ['Minigames', 'Mastering Mixology'],
  pest_control: ['Minigames', 'Pest Control'],
  pc: ['Minigames', 'Pest Control'],
  rogues_den: ['Minigames', 'Rogues\' Den'],
  shades_of_mortton: ['Minigames', 'Shades of Mort\'ton'],
  shades: ['Minigames', 'Shades of Mort\'ton'],
  soul_wars: ['Minigames', 'Soul Wars'],
  sw: ['Minigames', 'Soul Wars'],
  temple_trekking: ['Minigames', 'Temple Trekking'],
  tithe_farm: ['Minigames', 'Tithe Farm'],
  tithe: ['Minigames', 'Tithe Farm'],
  trouble_brewing: ['Minigames', 'Trouble Brewing'],
  vale_totems: ['Minigames', 'Vale Totems'],
  volcanic_mine: ['Minigames', 'Volcanic Mine'],
  aerial_fishing: ['Other', 'Aerial Fishing'],
  all_pets: ['Other', 'All Pets'],
  pets: ['Other', 'All Pets'],
  boat_paints: ['Other', 'Boat Paints'],
  camdozaal: ['Other', 'Camdozaal'],
  champions_challenge: ['Other', 'Champion\'s Challenge'],
  chompy_bird_hunting: ['Other', 'Chompy Bird Hunting'],
  chompy: ['Other', 'Chompy Bird Hunting'],
  champions: ['Other', 'Champion\'s Challenge'],
  colossal_wyrm_agility: ['Other', 'Colossal Wyrm Agility'],
  colossal_wyrm: ['Other', 'Colossal Wyrm Agility'],
  creature_creation: ['Other', 'Creature Creation'],
  cyclopes: ['Other', 'Cyclopes'],
  elder_chaos_druids: ['Other', 'Elder Chaos Druids'],
  forestry: ['Other', 'Forestry'],
  fossil_island_notes: ['Other', 'Fossil Island Notes'],
  fossil_notes: ['Other', 'Fossil Island Notes'],
  gloughs_experiments: ['Other', 'Glough\'s Experiments'],
  gloughs: ['Other', 'Glough\'s Experiments'],
  hunter_guild: ['Other', 'Hunter Guild'],
  lost_schematics: ['Other', 'Lost Schematics'],
  monkey_backpacks: ['Other', 'Monkey Backpacks'],
  motherlode_mine: ['Other', 'Motherlode Mine'],
  mlm: ['Other', 'Motherlode Mine'],
  my_notes: ['Other', 'My Notes'],
  ocean_encounters: ['Other', 'Ocean Encounters'],
  random_events: ['Other', 'Random Events'],
  revenants: ['Other', 'Revenants'],
  revs: ['Other', 'Revenants'],
  rooftop_agility: ['Other', 'Rooftop Agility'],
  rooftops: ['Other', 'Rooftop Agility'],
  sailing_miscellaneous: ['Other', 'Sailing Miscellaneous'],
  sailing: ['Other', 'Sailing Miscellaneous'],
  sea_treasures: ['Other', 'Sea Treasures'],
  shayzien_armour: ['Other', 'Shayzien Armour'],
  shayzien: ['Other', 'Shayzien Armour'],
  shooting_stars: ['Other', 'Shooting Stars'],
  skilling_pets: ['Other', 'Skilling Pets'],
  slayer: ['Other', 'Slayer'],
  tormented_demons: ['Other', 'Tormented Demons'],
  tds: ['Other', 'Tormented Demons'],
  tzhaar: ['Other', 'TzHaar'],
  miscellaneous: ['Other', 'Miscellaneous'],
  misc: ['Other', 'Miscellaneous'],
  // wag: no Wilderness Agility page exists in the collection log.
};

function clogPageForCommand(key) {
  return CLOG_PAGES[key] || null;
}


// Drawn card in the in-game chat style: "{rsn}: {Page} (x/y)" + item icons.
// Clue tiers for the !clog clues summary card: display label, clog page
// title, clue-rates.json tier key, WOM completion metric.
const CLUE_TIERS = [
  ['Beginner', 'Beginner Treasure Trails', 'beginner', 'clue_scrolls_beginner'],
  ['Easy', 'Easy Treasure Trails', 'easy', 'clue_scrolls_easy'],
  ['Medium', 'Medium Treasure Trails', 'medium', 'clue_scrolls_medium'],
  ['Hard', 'Hard Treasure Trails', 'hard', 'clue_scrolls_hard'],
  ['Elite', 'Elite Treasure Trails', 'elite', 'clue_scrolls_elite'],
  ['Master', 'Master Treasure Trails', 'master', 'clue_scrolls_master'],
];
const CLUE_PAGE_METRIC = {
  'Beginner Treasure Trails': 'clue_scrolls_beginner',
  'Easy Treasure Trails': 'clue_scrolls_easy',
  'Medium Treasure Trails': 'clue_scrolls_medium',
  'Hard Treasure Trails': 'clue_scrolls_hard',
  'Elite Treasure Trails': 'clue_scrolls_elite',
  'Master Treasure Trails': 'clue_scrolls_master',
  'Shared Treasure Trail Rewards': 'clue_scrolls_all',
};
// Wiki casket drop rates per tier (tools/build-clue-rates.js), keyed by
// lowercased item name for matching against clog page item names.
const CLUE_RATES_LC = {};
try {
  const raw = require('./clue-rates.json');
  for (const [tier, table] of Object.entries(raw)) {
    CLUE_RATES_LC[tier] = {};
    for (const [name, rate] of Object.entries(table)) CLUE_RATES_LC[tier][name.toLowerCase()] = rate;
  }
} catch { /* rates missing: summary renders without the rarest tiles */ }

async function clueSummaryPayload(rsn, userId) {
  if (userId) noteUse(userId, 'clog'); // a real lookup fires: start the cooldown
  const st = await getStats(rsn).catch(() => null);
  const kc = st && !st.notFound && st.kc ? st.kc : {};
  const rows = [];
  let anyPage = false;
  for (const [label, title, tierKey, metric] of CLUE_TIERS) {
    const completed = typeof kc[metric] === 'number' ? kc[metric] : null;
    const res = await getClogPageWithItems(rsn, 'Clues', title).catch(() => null);
    if (!res || res.notFound) {
      rows.push({ tier: label, completed, obtained: null, total: null, items: [] });
      continue;
    }
    anyPage = true;
    const scores = st && !st.notFound
      ? itemLuckScores(countersFor(st, rsn), res.items || []) : {};
    const rates = CLUE_RATES_LC[tierKey] || {};
    const rarest = (res.items || [])
      .filter((it) => (it.quantity || 0) > 0 && rates[it.name.toLowerCase()] != null)
      .sort((a, b) => rates[a.name.toLowerCase()] - rates[b.name.toLowerCase()])
      .slice(0, 4);
    const drawn = await loadClogItems({ items: rarest });
    rows.push({
      tier: label, completed, obtained: res.obtained, total: res.total,
      items: drawn.map((d) => ({
        icon: d.iconB64,
        score: scores[d.id] != null ? scores[d.id] : null,
      })),
    });
  }
  const shared = await getClogPageWithItems(rsn, 'Clues', 'Shared Treasure Trail Rewards').catch(() => null);
  if (shared && !shared.notFound) {
    anyPage = true;
    rows.push({ tier: 'Shared Rewards', completed: null, obtained: shared.obtained, total: shared.total, items: [] });
  }
  if (!anyPage) return { content: RP_GUIDE };
  const card = await fetchCard('/clue-summary', {
    rsn, badge: cardBadgeFor(rsn, null),
    totalCompleted: typeof kc.clue_scrolls_all === 'number' ? kc.clue_scrolls_all : null,
    rows,
  });
  if (card) return { files: [new AttachmentBuilder(card, { name: 'clues.png' })] };
  return CARD_DOWN;
}

async function clogPayload(key, rsn, userId) {
  const gate = ownAccountGate(userId, rsn);
  if (gate) return gate;
  if (!key) return { content: 'Usage: `!clog <activity|total> [name]`' };
  if (key === 'clues' || key === 'scrolls') return clueSummaryPayload(rsn, userId);
  if (key === 'total') {
    if (userId) noteUse(userId, 'clog'); // a real lookup fires: start the cooldown
    const res = await getClogSummary(rsn).catch(() => null);
    if (!res) return { content: 'Could not reach the collection log service right now. Try again in a bit.' };
    if (res.notFound) return { content: RP_GUIDE };
    const card = await fetchCard('/clog-total', {
      rsn, badge: cardBadgeFor(rsn, null), obtained: res.obtained, total: res.total, tabs: res.tabs,
    });
    if (card) return { files: [new AttachmentBuilder(card, { name: 'clog.png' })] };
    return CARD_DOWN;
  }
  const page = clogPageForCommand(key);
  if (!page) {
    const wag = key === 'wag';
    return { content: wag
      ? 'Wilderness Agility has no collection log page to show.'
      : `No collection log page for \`${key}\`. Every boss, raid, clue, minigame, and other page works: try the boss or page name, or \`total\` for the whole log.` };
  }
  if (userId) noteUse(userId, 'clog'); // a real lookup fires: start the cooldown
  const res = await getClogPageWithItems(rsn, page[0], page[1]).catch(() => null);
  if (!res) return { content: 'Could not reach the collection log service right now. Try again in a bit.' };
  if (res.notFound) return { content: RP_GUIDE };
  const drawn = await loadClogItems(res);
  // A boss page and its KC are one combined card: when this page's
  // activity has kill counts, post the KC card with this page as its
  // clog strip, exactly what !kc posts for the same boss.
  const kcEnt = kcEntry(key);
  if (kcEnt && kcEnt.cols.length) {
    const st = await getStats(rsn).catch(() => null);
    if (st && !st.notFound) {
      const counters = countersFor(st, rsn);
      const scores = itemLuckScores(counters, res.items || []);
      const strip = {
        obtained: res.obtained,
        total: res.total,
        items: drawn.map((d) => ({
          qty: d.qty,
          has: (d.qty || 0) > 0,
          score: scores[d.id] != null ? scores[d.id] : null,
          icon: d.iconB64,
        })),
      };
      const luck = luckForPage(counters,
        (res.items || []).map((it) => ({ id: it.id, qty: it.quantity || 0 })));
      const body = kcCardBody(rsn, kcEnt, st, strip, luck, null);
      const combined = await fetchCard('/kc', body);
      if (combined) {
        return {
          files: [new AttachmentBuilder(combined, { name: 'clog.png' })],
          // The same card !kc posts, so it carries the same
          // Leaderboard swap when it shows a rank.
          components: body.rank
            ? [lbSwapRow(`boss:${key}`, `kc:${key}:${rsn.replace(/ /g, '_')}`)]
            : [],
        };
      }
    }
  }
  const st2 = await getStats(rsn).catch(() => null);
  const pageScores = st2 && !st2.notFound
    ? itemLuckScores(countersFor(st2, rsn), res.items || []) : {};
  const pageMetric = CLUE_PAGE_METRIC[page[1]];
  const completed = pageMetric && st2 && !st2.notFound && st2.kc
    && typeof st2.kc[pageMetric] === 'number' ? st2.kc[pageMetric] : null;
  const card = await fetchCard('/clog-page', {
    rsn, badge: cardBadgeFor(rsn, st2 ? st2.accountType : null),
    page: page[1],
    obtained: res.obtained,
    total: res.total,
    completed,
    items: drawn.map((d) => ({
      qty: d.qty, icon: d.iconB64,
      has: (d.qty || 0) > 0,
      score: pageScores[d.id] != null ? pageScores[d.id] : null,
    })),
  });
  if (card) return { files: [new AttachmentBuilder(card, { name: 'clog.png' })] };
  return CARD_DOWN;
}

async function handleClogCommand(message, args) {
  const cd = checkCooldown(message.author.id, 'clog');
  if (cd.wait) { if (cd.notify) await message.reply(cooldownText(cd.wait)).catch(() => {}); return; }
  const key = takeActivity(args, CLOG_PAGES);
  const { rsn, error, payload } = resolveName(args, message.author.id);
  if (error) { await message.reply(error).catch(() => {}); return; }
  if (payload) { await message.reply(payload).catch(() => {}); return; }
  await message.reply(await clogPayload(key, rsn, message.author.id)).catch(() => {});
}

const SITE_BASE = 'https://oathforsaken.cc';
const CARD_API = 'https://oathforsaken.cc/api/cards';

// The website renders the kc / clog / leaderboard cards in the same
// share-card style as the profile card. The bot POSTs the numbers it
// already computed and posts the PNG that comes back. Any failure
// returns null and the caller falls back to the in-bot renderers, so
// a card outage never kills a command.
async function fetchCard(path, body) {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15000);
    const res = await fetch(CARD_API + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'OathForsaken-Bot/1.0 (https://oathforsaken.cc)' },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    return Buffer.from(await res.arrayBuffer());
  } catch {
    return null;
  }
}

// Card commands have one visual style: the card service. When it is
// down the command says so; there is no old-style fallback card.
const CARD_DOWN = { content: 'The card service is down right now. Try again in a bit.' };

// The website builds a share card for every tracked member: the same
// numbers as the RuneProfile card below, in house style, with clan
// standing. When a card exists for the name, the profile command posts
// it (with a quiet link to the full page) and that is the one card.
// Names the site does not track yet fall through to the RuneProfile
// card. Slug rule mirrors the site builder's slugify.
function siteSlug(rsn) {
  return String(rsn).toLowerCase().replace(/[^a-z0-9]+/g, '-');
}

async function siteCardPayload(rsn) {
  const slug = siteSlug(rsn);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const res = await fetch(`${SITE_BASE}/members/${slug}-card.png`, {
      headers: { 'User-Agent': 'OathForsaken-Bot/1.0 (https://oathforsaken.cc)' },
      signal: ctrl.signal,
    });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length) return null;
    return {
      content: `<${SITE_BASE}/members/${slug}.html>`,
      files: [new AttachmentBuilder(buf, { name: 'profile.png' })],
    };
  } catch (e) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// The player's driest missing scored item across every synced
// collection log page, in the luck plugin's phrasing ("85%
// luckier than you"). Cache-only: pages the bot has never seen
// are skipped, never fetched. Null when nothing scores, or when
// the driest item sits under the 50% line the boss cards use.
function driestItemText(rsn, st) {
  if (!st || st.notFound) return null;
  const counters = countersFor(st, rsn);
  const seen = new Set();
  let worst = null;
  for (const pair of Object.values(CLOG_PAGES)) {
    const tab = pair[0];
    const title = pair[1];
    const key = `${tab}|${title}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const page = getCachedClogPageItems(rsn, tab, title);
    if (!page || !page.items.length) continue;
    const rep = dryReport(counters, page.items);
    if (!rep || !rep.missing.length) continue;
    const top = rep.missing[0];
    if (!worst || top.score < worst.score) worst = top;
  }
  if (!worst) return null;
  // A missing item's score is (1 - dryness) / 2 on the 0-100
  // scale, so the dryness share inverts straight back out.
  const pct = Math.round(100 - 2 * worst.score);
  if (pct < 50) return null;
  return `${worst.name} (${pct}% luckier than you)`;
}

// The website share cards carry the same driest-item fact; the
// site builder reads it from this file in the bot data dir,
// beside the RuneProfile cache it already loads. Refreshed on
// a timer from index.js.
async function refreshProfileLuck() {
  const out = {};
  for (const rsn of await rankedNames()) {
    const st = await getStats(rsn).catch(() => null);
    const text = driestItemText(rsn, st);
    if (text) out[rsn.toLowerCase()] = text;
  }
  fs.writeFileSync('data/profile-luck.json', JSON.stringify(out));
}

async function profilePayload(rsn, userId) {
  const gate = ownAccountGate(userId, rsn);
  if (gate) return gate;
  if (userId) noteUse(userId, 'profile'); // a real lookup fires: start the cooldown
  const site = await siteCardPayload(rsn);
  if (site) return site;
  const prof = await getProfile(rsn).catch(() => null);
  if (!prof) return { content: 'Could not reach the profile service right now. Try again in a bit.' };
  if (prof.notFound) return { content: RP_GUIDE };
  const a = prof.account;
  const fields = {
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
  };
  // House-style card from the card service. If it is down the
  // command says so; there is no old-style fallback.
  const pBadgeId = badgeForAccount(fields.name, null);
  const stL = await getStats(fields.name).catch(() => null);
  const luckLine = driestItemText(fields.name, stL);
  const card = await fetchCard('/profile', { rsn: fields.name, ...fields, badge: lbBadgeIconById(pBadgeId), badgeWord: pBadgeId && !fields.accountLabel ? BADGE_WORDS[pBadgeId] : null, luckLine });
  if (card) return { files: [new AttachmentBuilder(card, { name: 'profile.png' })] };
  return CARD_DOWN;
}

async function handleProfileCommand(message, args) {
  const cd = checkCooldown(message.author.id, 'profile');
  if (cd.wait) { if (cd.notify) await message.reply(cooldownText(cd.wait)).catch(() => {}); return; }
  const { rsn, error, payload } = resolveName(args, message.author.id);
  if (error) { await message.reply(error).catch(() => {}); return; }
  if (payload) { await message.reply(payload).catch(() => {}); return; }
  await message.reply(await profilePayload(rsn, message.author.id)).catch(() => {});
}

// Leaderboard rows from cached clog totals (instant); missing profiles get a
// background refresh so the next call is fuller, never a slow first call.
// ---- Leaderboards ------------------------------------------------------
// One card, five boards (Overall / PvM / Skills / Clogs / Gains), wearing
// the compare card's menu: tab buttons plus a picker per tab, view
// controls open to everyone. Design: files/leaderboard-design-draft-
// 2026-11-02.md in the clan goal (drafted with Alex, Nov 1-2 2026).
// Ranked set = the website population (see rankedNames). Numbers come
// straight from the caches (WOM / RuneProfile); a member appears on a
// board only when they have a number for it (no invented zeros), and KC
// is whatever WOM returns, so WOM's own ranking cutoffs apply.

const LB_PAGE_SIZE = 25; // paging machinery exists from day one; the
// flips only render once a board outgrows one page.
const LB_VIEWS = ['overall', 'pvm', 'skills', 'clogs', 'gains'];

function lbDefaultState() {
  return { v: 'overall', k: null, p: 0, cat: null, cp: 0, ctab: null, cpg: 0, gk: 'xp', gd: 'week', var: null };
}
// Compact positional state: Discord caps custom ids at 100 chars, and a
// JSON blob overflows it. Fields join with '|' (never in a page title),
// '-' means null, the view is one letter.
const LB_VIEW_LETTER = { overall: 'o', pvm: 'p', skills: 's', clogs: 'c', gains: 'g' };
const LB_LETTER_VIEW = { o: 'overall', p: 'pvm', s: 'skills', c: 'clogs', g: 'gains' };
function lbEncode(st) {
  return [LB_VIEW_LETTER[st.v] || 'o', st.k || '-', st.p || 0, st.cat || '-',
    st.cp || 0, st.ctab || '-', st.cpg || 0, st.gk === 'kc' ? 'k' : 'x',
    ({ day: 'd', week: '7', month: '3', year: 'y' })[st.gd] || '7', st.var == null ? '-' : String(st.var)].join('|');
}
function lbDecode(s) {
  const parts = String(s || '').split('|');
  const st = lbDefaultState();
  if (LB_LETTER_VIEW[parts[0]]) st.v = LB_LETTER_VIEW[parts[0]];
  if (parts[1] && parts[1] !== '-') st.k = parts[1];
  st.p = parseInt(parts[2], 10) || 0;
  if (parts[3] && parts[3] !== '-') st.cat = parts[3];
  st.cp = parseInt(parts[4], 10) || 0;
  if (parts[5] && parts[5] !== '-') st.ctab = parts[5];
  st.cpg = parseInt(parts[6], 10) || 0;
  st.gk = parts[7] === 'k' ? 'kc' : 'xp';
  st.gd = ({ d: 'day', 7: 'week', 3: 'month', y: 'year' })[parts[8]] || 'week';
  if (parts[9] && parts[9] !== '-') st.var = parseInt(parts[9], 10) || 0;
  return st;
}

// Variant boards (Alex, Nov 2, 2026): a multi-variant boss ranks
// three ways, the total or one variant alone, through toggle
// buttons named for that boss. Labels are the buttons; titles name
// the board. Keyed by the entry's first metric, arrays aligned
// with its cols order. The Colosseum is absent on purpose: its
// second column is Glory, not kills.
const LB_VARIANT_INFO = {
  tombs_of_amascut: { labels: ['Normal', 'Expert'], titles: ['Tombs of Amascut', 'Tombs of Amascut Expert'] },
  chambers_of_xeric: { labels: ['Normal', 'CM'], titles: ['Chambers of Xeric', 'Chambers of Xeric CM'] },
  theatre_of_blood: { labels: ['Regular', 'Hard Mode'], titles: ['Theatre of Blood', 'Hard Mode Theatre of Blood'] },
  the_gauntlet: { labels: ['Gauntlet', 'Corrupted Gauntlet'], titles: ['The Gauntlet', 'The Corrupted Gauntlet'] },
  dagannoth_rex: { labels: ['Rex', 'Prime', 'Supreme'], titles: ['Dagannoth Rex', 'Dagannoth Prime', 'Dagannoth Supreme'] },
  nightmare: { labels: ['Nightmare', "Phosani's"], titles: ['The Nightmare', "Phosani's Nightmare"] },
  artio: { labels: ['Artio', 'Callisto'], titles: ['Artio', 'Callisto'] },
  spindel: { labels: ['Spindel', 'Venenatis'], titles: ['Spindel', 'Venenatis'] },
  calvarion: { labels: ['Calvarion', "Vet'ion"], titles: ['Calvarion', "Vet'ion"] },
  bounty_hunter_hunter: { labels: ['Hunter', 'Rogue'], titles: ['Bounty Hunter (Hunter)', 'Bounty Hunter (Rogue)'] },
};
function lbVariantInfo(entry) {
  if (!entry || entry.cols.length < 2 || entry.name === 'Fortis Colosseum') return null;
  const info = LB_VARIANT_INFO[entry.cols[0].metric];
  return info && info.labels.length === entry.cols.length ? info : null;
}

// The ranked set mirrors the site exporter's allowed set (export_site_
// data.py is the source of truth): the WOM group file, the exporter's
// EXTRA_MEMBERS, its EXTRA_FRIENDS (verified friends who have not linked
// an RSN here yet), and the friends file. It deliberately does NOT read
// ladder-data.json: that file only holds players the exporter's own
// cache has complete records for, which runs smaller than the roster.
const LB_EXTRA_MEMBERS = ['IronVale'];
const LB_EXTRA_FRIENDS = ['ksen', 'merryshake', 'brez', 'm o u z'];
async function rankedNames() {
  const names = [];
  const seen = new Set();
  const push = (rsn) => {
    const n = String(rsn || '').trim();
    const key = n.toLowerCase();
    if (n && !seen.has(key)) { seen.add(key); names.push(n); }
  };
  const dataDir = path.join(__dirname, '..', 'data');
  try {
    for (const e of JSON.parse(fs.readFileSync(path.join(dataDir, 'wom-group.json'), 'utf8'))) push(e.rsn);
  } catch { /* file not published yet */ }
  for (const n of LB_EXTRA_MEMBERS) push(n);
  for (const n of LB_EXTRA_FRIENDS) push(n);
  try {
    for (const e of JSON.parse(fs.readFileSync(path.join(dataDir, 'friends.json'), 'utf8'))) push(e.rsn);
  } catch { /* file not published yet */ }
  return names;
}

// Account-type badge (same icon set the party board uses). WOM's record
// for the account decides; group types fold to their badge family.
function lbBadgeId(accountType) {
  const t = String(accountType || '').toLowerCase();
  if (!t) return null;
  if (t.includes('hardcore') && t.includes('group')) return 'hcgim';
  if (t.includes('group')) return 'gim';
  if (t.includes('hardcore')) return 'hc';
  if (t.includes('ultimate')) return 'ult';
  if (t.includes('ironman')) return 'ironman';
  if (t.includes('regular')) return 'main';
  return null;
}
const lbBadgeCache = new Map();
function lbBadgeIconById(id) {
  if (!id) return null;
  if (!lbBadgeCache.has(id)) {
    let b64 = null;
    try {
      b64 = fs.readFileSync(path.join(__dirname, '..', 'assets', 'party-board',
        'badge-icons', `${id}.png`)).toString('base64');
    } catch { /* icon missing: no badge */ }
    lbBadgeCache.set(id, b64);
  }
  return lbBadgeCache.get(id);
}
// The shared account badge for cards: stated mode first, then WOM's type.
function cardBadgeFor(rsn, accountType) {
  return lbBadgeIconById(badgeForAccount(rsn, accountType));
}
const lbBadgeFor = cardBadgeFor;
function lbBadgeIcon(accountType) {
  const id = lbBadgeId(accountType);
  if (!id) return null;
  if (!lbBadgeCache.has(id)) {
    let b64 = null;
    try {
      b64 = fs.readFileSync(path.join(__dirname, '..', 'assets', 'party-board',
        'badge-icons', `${id}.png`)).toString('base64');
    } catch { /* icon missing: the row just has no badge */ }
    lbBadgeCache.set(id, b64);
  }
  return lbBadgeCache.get(id);
}

// Cache-first data access; misses and stale entries warm in the
// background and join the board on the next render.
function lbStats(rsn) {
  const hit = getCachedStats(rsn);
  if (!hit) { getStats(rsn).catch(() => null); return null; }
  if (!hit.fresh) getStats(rsn).catch(() => null);
  return hit.stats && !hit.stats.notFound ? hit.stats : null;
}
function lbClogPage(rsn, tab, title) {
  const hit = getCachedClogPage(rsn, tab, title);
  if (!hit) { getClogPageWithItems(rsn, tab, title).catch(() => null); return null; }
  if (!hit.fresh) getClogPageWithItems(rsn, tab, title).catch(() => null);
  return hit.notFound ? null : hit;
}
function lbClogTotal(rsn) {
  const hit = getCachedClogTotal(rsn);
  if (!hit) { getClogTotal(rsn).catch(() => null); return null; }
  if (!hit.fresh) getClogTotal(rsn).catch(() => null);
  return hit.notFound ? null : hit;
}

const fmtNum = (n) => Math.round(n).toLocaleString('en-US');

function lbBuildBoard(st, names) {
  const rows = [];
  if (st.v === 'overall') {
    for (const rsn of names) {
      const s = lbStats(rsn);
      const xp = s && s.skills && s.skills.overall ? s.skills.overall.xp : null;
      if (typeof xp !== 'number') continue;
      rows.push({ name: rsn, badge: lbBadgeFor(rsn, s.accountType), value: xp, valueText: fmtNum(xp) });
    }
    rows.sort((a, b) => b.value - a.value);
    return { title: 'Total XP', unit: 'XP', rows };
  }
  if (st.v === 'skills') {
    const key = st.k || 'attack';
    const dataKey = key === 'runecraft' ? 'runecrafting' : key;
    for (const rsn of names) {
      const s = lbStats(rsn);
      const sk = s && s.skills ? s.skills[dataKey] : null;
      if (!sk || typeof sk.xp !== 'number') continue;
      rows.push({
        name: rsn, badge: lbBadgeFor(rsn, s.accountType), level: sk.level,
        value: sk.xp, valueText: `${fmtNum(sk.xp)} XP`,
      });
    }
    rows.sort((a, b) => b.value - a.value);
    return { title: key.charAt(0).toUpperCase() + key.slice(1), unit: 'XP', rows };
  }
  if (st.v === 'pvm') {
    const key = st.k || 'zulrah';
    const entry = kcEntry(key);
    if (!entry) return { title: 'PvM', unit: 'KC', rows: [] };
    const page = clogPageForCommand(key);
    const vInfo = lbVariantInfo(entry);
    const vi = vInfo && st.var != null && entry.cols[st.var] ? st.var : null;
    for (const rsn of names) {
      const s = lbStats(rsn);
      if (!s) continue;
      const counters = countersFor(s, rsn);
      // WOM's snapshot carries an explicit 0 for bosses the hiscores do
      // not rank the player at, so a real rank always has kills.
      let value;
      if (vi != null) {
        const v = counters[entry.cols[vi].metric];
        if (typeof v !== 'number' || v <= 0) continue;
        value = v;
      } else {
        const present = entry.cols.map((c) => c.metric)
          .filter((m) => typeof counters[m] === 'number' && counters[m] > 0);
        if (!present.length) continue; // WOM does not rank them here
        value = present.reduce((sum, m) => sum + counters[m], 0);
      }
      let sub = null;
      if (page) {
        const c = lbClogPage(rsn, page[0], page[1]);
        sub = c ? `${c.obtained} / ${c.total} clog` : 'no clog';
      }
      rows.push({
        name: rsn, badge: lbBadgeFor(rsn, s.accountType), sub,
        value, valueText: `${fmtNum(value)} KC`,
      });
    }
    rows.sort((a, b) => b.value - a.value);
    const title = vi != null ? vInfo.titles[vi]
      : vInfo ? `${entry.name} Total` : entry.name;
    return { title, unit: 'KC', rows };
  }
  if (st.v === 'clogs') {
    if (!st.k || st.k === 'total') {
      for (const rsn of names) {
        const s = lbStats(rsn);
        const c = lbClogTotal(rsn);
        if (!c) continue;
        rows.push({
          name: rsn, badge: lbBadgeFor(rsn, s ? s.accountType : null),
          value: c.obtained, valueText: `${fmtNum(c.obtained)} / ${fmtNum(c.total)}`,
          frac: c.total ? c.obtained / c.total : 0,
        });
      }
      rows.sort((a, b) => b.value - a.value);
      return { title: 'Collection Log', unit: 'items', rows };
    }
    const tab = (Object.values(CLOG_PAGES).find((p) => p[1] === st.k) || [])[0];
    if (!tab) return { title: st.k, unit: 'items', rows: [] };
    for (const rsn of names) {
      const s = lbStats(rsn);
      const c = lbClogPage(rsn, tab, st.k);
      if (!c) continue;
      rows.push({
        name: rsn, badge: lbBadgeFor(rsn, s ? s.accountType : null),
        value: c.obtained, valueText: `${fmtNum(c.obtained)} / ${fmtNum(c.total)}`,
        frac: c.total ? c.obtained / c.total : 0,
      });
    }
    rows.sort((a, b) => b.value - a.value);
    return { title: st.k, unit: 'items', rows };
  }
  // gains: Wise Old Man deltas, read from the file cache the
  // gains card and the daily sync keep warm. A player with no
  // cached totals sits this board out until the next sync.
  const period = GAINS_PERIODS.includes(st.gd) ? st.gd : 'week';
  for (const rsn of names) {
    const s = lbStats(rsn);
    const tot = getGainsTotals(rsn, period);
    if (!tot) continue;
    const gain = st.gk === 'kc' ? tot.kc : tot.xp;
    if (gain <= 0) continue;
    rows.push({
      name: rsn, badge: lbBadgeFor(rsn, s ? s.accountType : null), value: gain,
      valueText: st.gk === 'kc' ? `+${fmtNum(gain)} KC` : `+${fmtNum(gain)} XP`,
    });
  }
  rows.sort((a, b) => b.value - a.value);
  return {
    title: st.gk === 'kc' ? 'KC Gained' : 'XP Gained',
    note: { day: 'Last 24 hours', week: 'Last 7 days', month: 'Last 30 days', year: 'Last 365 days' }[period],
    unit: st.gk === 'kc' ? 'KC' : 'XP', rows,
  };
}

function lbVariantRow(st) {
  const entry = kcEntry(st.k || '');
  const info = entry && lbVariantInfo(entry);
  if (!info) return null;
  const enc = lbEncode(st);
  const mk = (sel, label) => {
    const active = sel === '-' ? st.var == null : st.var === parseInt(sel, 10);
    return new ButtonBuilder()
      .setCustomId(`lbvar:${sel}:${enc}`)
      .setLabel(label)
      .setStyle(active ? ButtonStyle.Danger : ButtonStyle.Secondary)
      .setDisabled(active);
  };
  return new ActionRowBuilder().addComponents(
    mk('-', 'Total'), ...info.labels.map((l, i) => mk(String(i), l)));
}

function lbComponents(st, pages, scoped = false) {
  // A board entered from a card is scoped to that card's boss
  // (Alex, Nov 2, 2026): its variant toggle and nothing else. The
  // caller's return row is appended on top of these.
  if (scoped) {
    if (st.v !== 'pvm') return [];
    const vr = lbVariantRow(st);
    return vr ? [vr] : [];
  }
  const enc = lbEncode(st);
  const tabBtn = (v, label) => new ButtonBuilder()
    .setCustomId(`lbtab:${v}:${enc}`)
    .setLabel(label)
    .setStyle(st.v === v ? ButtonStyle.Danger : ButtonStyle.Secondary)
    .setDisabled(st.v === v);
  const rows = [new ActionRowBuilder().addComponents(
    tabBtn('overall', 'Overall'), tabBtn('pvm', 'PvM'), tabBtn('skills', 'Skills'),
    tabBtn('clogs', 'Clogs'), tabBtn('gains', 'Gains'))];
  if (st.v === 'pvm') {
    const vr = lbVariantRow(st);
    if (vr) rows.push(vr);
  }
  if (st.v === 'pvm') {
    const catalog = bossCatalog();
    if (!st.cat || !catalog.byCat[st.cat]) {
      const cats = CMP_CATEGORIES.filter((c) => catalog.byCat[c.id].length);
      if (cats.length) {
        rows.push(new ActionRowBuilder().addComponents(
          new StringSelectMenuBuilder()
            .setCustomId(`lbpick:${enc}`)
            .setPlaceholder('Pick a category...')
            .addOptions(cats.map((c) => ({ label: c.label, value: `cat:${c.id}` })))));
      }
    } else {
      const list = catalog.byCat[st.cat];
      const page = Math.max(0, Math.min(st.cp || 0, Math.ceil(list.length / CMP_PAGE_SIZE) - 1));
      const slice = list.slice(page * CMP_PAGE_SIZE, page * CMP_PAGE_SIZE + CMP_PAGE_SIZE);
      const options = [{ label: '← All categories', value: 'back' }];
      if (page > 0) options.push({ label: '← Previous bosses', value: `page:${page - 1}` });
      for (const o of slice) options.push({ label: String(o.name).slice(0, 100), value: o.key });
      if ((page + 1) * CMP_PAGE_SIZE < list.length) {
        options.push({ label: 'More bosses →', value: `page:${page + 1}` });
      }
      const catLabel = (CMP_CATEGORIES.find((c) => c.id === st.cat) || {}).label || 'Bosses';
      rows.push(new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(`lbpick:${enc}`)
          .setPlaceholder(`Pick a boss (${catLabel})...`)
          .addOptions(options)));
    }
  } else if (st.v === 'skills') {
    const options = [...SKILL_ORDER].sort((a, b) => a.localeCompare(b)).map((key) => ({
      label: key.charAt(0).toUpperCase() + key.slice(1), value: key, default: key === st.k,
    }));
    rows.push(new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(`lbpick:${enc}`)
        .setPlaceholder('Pick a skill...')
        .addOptions(options.slice(0, 25))));
  } else if (st.v === 'clogs') {
    if (!st.ctab) {
      const tabs = [...new Set(Object.values(CLOG_PAGES).map((p) => p[0]))].sort();
      rows.push(new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(`lbpick:${enc}`)
          .setPlaceholder('Pick a section, or the whole log...')
          .addOptions([
            { label: 'Total (whole log)', value: 'total' },
            ...tabs.map((t) => ({ label: t, value: `tab:${t}` })),
          ])));
    } else {
      const titles = [...new Set(Object.values(CLOG_PAGES)
        .filter((p) => p[0] === st.ctab).map((p) => p[1]))].sort();
      const size = 22;
      const page = Math.max(0, Math.min(st.cpg || 0, Math.ceil(titles.length / size) - 1));
      const options = [{ label: '← All sections', value: 'tabs' }];
      if (page > 0) options.push({ label: '← Previous pages', value: `pg:${page - 1}` });
      for (const t of titles.slice(page * size, page * size + size)) {
        options.push({ label: t.slice(0, 100), value: `page:${t}` });
      }
      if ((page + 1) * size < titles.length) {
        options.push({ label: 'More pages →', value: `pg:${page + 1}` });
      }
      rows.push(new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(`lbpick:${enc}`)
          .setPlaceholder(`Pick a page (${st.ctab})...`)
          .addOptions(options.slice(0, 25))));
    }
  } else if (st.v === 'gains') {
    const gBtn = (what, label, active) => new ButtonBuilder()
      .setCustomId(`lbg:${what}:${enc}`)
      .setLabel(label)
      .setStyle(active ? ButtonStyle.Danger : ButtonStyle.Secondary)
      .setDisabled(active);
    rows.push(new ActionRowBuilder().addComponents(
      gBtn('xp', 'XP', st.gk === 'xp'), gBtn('kc', 'KC', st.gk === 'kc')));
    rows.push(new ActionRowBuilder().addComponents(
      gBtn('pd', 'Day', st.gd === 'day'), gBtn('pw', 'Week', st.gd === 'week'),
      gBtn('pm', 'Month', st.gd === 'month'), gBtn('py', 'Year', st.gd === 'year')));
  }
  if (pages > 1) {
    rows.push(new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`lbpage:prev:${enc}`).setLabel('◀ Prev')
        .setStyle(ButtonStyle.Secondary).setDisabled(st.p <= 0),
      new ButtonBuilder().setCustomId(`lbpage:noop:${enc}`)
        .setLabel(`Page ${st.p + 1} of ${pages}`).setStyle(ButtonStyle.Secondary).setDisabled(true),
      new ButtonBuilder().setCustomId(`lbpage:next:${enc}`).setLabel('Next ▶')
        .setStyle(ButtonStyle.Secondary).setDisabled(st.p >= pages - 1)));
  }
  return rows;
}

async function lbView(st, userId, scoped = false) {
  const board = lbBuildBoard(st, await rankedNames());
  const components = lbComponents(st, 1, scoped);
  if (board.unavailable) return { content: board.unavailable, components };
  const rows = board.rows;
  if (!rows.length) {
    return { content: 'No ranked members have numbers for this board yet.', components };
  }
  const top = rows[0].value;
  for (const r of rows) if (r.frac == null) r.frac = top > 0 ? r.value / top : 0;
  const viewer = userId ? getRsn(userId) : null;
  if (viewer) {
    const i = rows.findIndex((r) => r.name.toLowerCase() === viewer.toLowerCase());
    if (i >= 0) {
      rows[i].mine = true;
      if (i > 0 && rows[i - 1].value > rows[i].value) {
        rows[i].gap = `${fmtNum(rows[i - 1].value - rows[i].value)} ${board.unit} behind ${rows[i - 1].name}`;
      }
    }
  }
  const pages = Math.max(1, Math.ceil(rows.length / LB_PAGE_SIZE));
  st.p = Math.min(st.p || 0, pages - 1);
  const slice = rows.slice(st.p * LB_PAGE_SIZE, st.p * LB_PAGE_SIZE + LB_PAGE_SIZE);
  const card = await fetchCard('/leaderboard', {
    title: board.title, note: board.note || null, rows: slice,
    page: st.p, pages, pageSize: LB_PAGE_SIZE,
  });
  if (!card) return CARD_DOWN;
  return {
    files: [new AttachmentBuilder(card, { name: 'leaderboard.png' })],
    components: lbComponents(st, pages, scoped),
  };
}

function lbStateForArg(arg) {
  const st = lbDefaultState();
  if (!arg) return st;
  const raw = String(arg).trim();
  const q = raw.toLowerCase();
  if (q.startsWith('boss:')) { st.v = 'pvm'; st.k = q.slice(5); return st; }
  if (q.startsWith('skill:')) { st.v = 'skills'; st.k = q.slice(6); return st; }
  if (q.startsWith('clog:')) { st.v = 'clogs'; st.k = raw.slice(5); return st; }
  if (q === 'clogtotal') { st.v = 'clogs'; st.k = 'total'; return st; }
  if (q === 'overall' || q === 'total xp' || q === 'xp') return st;
  if (q === 'gains' || q === 'gained') { st.v = 'gains'; return st; }
  if (q === 'clog' || q === 'clogs' || q === 'collection log' || q === 'total') {
    st.v = 'clogs'; st.k = 'total'; return st;
  }
  const key = q.replace(/['’]/g, '').replace(/\s+/g, '_');
  if (kcEntry(key)) { st.v = 'pvm'; st.k = key; return st; }
  if (SKILL_ORDER.includes(key)) { st.v = 'skills'; st.k = key; return st; }
  const page = clogPageForCommand(key);
  if (page) { st.v = 'clogs'; st.k = page[1]; return st; }
  const byTitle = Object.values(CLOG_PAGES).find((p) => p[1].toLowerCase() === q);
  if (byTitle) { st.v = 'clogs'; st.k = byTitle[1]; return st; }
  return st;
}

async function leaderboardPayload(userId, boardArg, scoped = false) {
  // Served from cache, but it fires background warming lookups, so it
  // counts as a use like the other commands.
  if (userId) noteUse(userId, 'leaderboard');
  if (!(await rankedNames()).length) {
    return { content: 'No ranked profiles yet. The roster syncs from the website list; try again in a bit.' };
  }
  return lbView(lbStateForArg(boardArg), userId, scoped);
}

async function lbUpdate(interaction, st) {
  // A board swapped in from a card carries that card's return
  // button on the message. Its presence marks the board as scoped:
  // flips keep the scoped components and the return button.
  const rows = (interaction.message && interaction.message.components) || [];
  let backId = null;
  for (const row of rows) {
    for (const comp of row.components || []) {
      const cid = comp.customId || (comp.data && comp.data.custom_id);
      if (cid && cid.startsWith('lbback:')) backId = cid.slice('lbback:'.length);
    }
  }
  const payload = await lbView(st, interaction.user.id, !!backId);
  const msg = { content: payload.content || '', components: payload.components || [] };
  if (payload.files) { msg.files = payload.files; msg.attachments = []; }
  else { msg.files = []; msg.attachments = []; }
  if (backId) msg.components = [...msg.components, lbBackRow(backId)];
  await interaction.update(msg).catch(() => {});
}

async function handleLeaderboardButton(interaction) {
  const parts = interaction.customId.split(':');
  const kind = parts[0];
  const st = lbDecode(parts[parts.length - 1]);
  if (kind === 'lbtab') {
    const target = parts[1];
    st.p = 0;
    if (target !== st.v) {
      st.v = target;
      st.k = target === 'pvm' ? 'zulrah'
        : target === 'skills' ? 'attack'
        : target === 'clogs' ? 'total' : null;
      st.cat = null; st.cp = 0; st.ctab = null; st.cpg = 0; st.var = null;
    }
  } else if (kind === 'lbg') {
    if (parts[1] === 'xp') st.gk = 'xp';
    else if (parts[1] === 'kc') st.gk = 'kc';
    else if (parts[1] === 'pd') st.gd = 'day';
    else if (parts[1] === 'pw') st.gd = 'week';
    else if (parts[1] === 'pm') st.gd = 'month';
    else if (parts[1] === 'py') st.gd = 'year';
    st.p = 0;
  } else if (kind === 'lbvar') {
    st.var = parts[1] === '-' ? null : (parseInt(parts[1], 10) || 0);
    st.p = 0;
  } else if (kind === 'lbpage') {
    if (parts[1] === 'prev') st.p = Math.max(0, (st.p || 0) - 1);
    else if (parts[1] === 'next') st.p = (st.p || 0) + 1;
    else return;
  } else return;
  await lbUpdate(interaction, st);
}

async function handleLeaderboardSelect(interaction) {
  const st = lbDecode(interaction.customId.split(':')[1]);
  const value = interaction.values[0];
  if (st.v === 'pvm') {
    if (value.startsWith('cat:')) { st.cat = value.slice(4); st.cp = 0; }
    else if (value === 'back') st.cat = null;
    else if (value.startsWith('page:')) st.cp = parseInt(value.slice(5), 10) || 0;
    else { st.k = value; st.p = 0; st.var = null; }
  } else if (st.v === 'skills') {
    st.k = value; st.p = 0;
  } else if (st.v === 'clogs') {
    if (value === 'total') { st.k = 'total'; st.ctab = null; st.p = 0; }
    else if (value.startsWith('tab:')) { st.ctab = value.slice(4); st.cpg = 0; }
    else if (value === 'tabs') st.ctab = null;
    else if (value.startsWith('pg:')) st.cpg = parseInt(value.slice(3), 10) || 0;
    else if (value.startsWith('page:')) { st.k = value.slice(5); st.p = 0; }
  }
  await lbUpdate(interaction, st);
}

function lbAutocompleteChoices(focused) {
  const q = String(focused || '').toLowerCase();
  const all = [
    { name: 'Total XP', value: 'overall' },
    { name: 'Collection Log (total)', value: 'clogtotal' },
    { name: 'Gains', value: 'gains' },
  ];
  const catalog = bossCatalog();
  for (const list of Object.values(catalog.byCat)) {
    for (const o of list) all.push({ name: o.name, value: `boss:${o.key}` });
  }
  for (const key of SKILL_ORDER) {
    all.push({ name: key.charAt(0).toUpperCase() + key.slice(1), value: `skill:${key}` });
  }
  const titles = [...new Set(Object.values(CLOG_PAGES).map((p) => p[1]))].sort();
  for (const t of titles) all.push({ name: `${t} (collection log)`, value: `clog:${t}` });
  return all.filter((c) => !q || c.name.toLowerCase().includes(q) || c.value.includes(q)).slice(0, 25);
}

const PLUGIN_MEMBERS_DIR = path.join(__dirname, '..', 'data', 'plugin-sync', 'members');

// A member's plugin-sync record (personal bests, collection log),
// or null when they have never synced.
function pluginRecord(rsn) {
  try {
    const raw = fs.readFileSync(path.join(PLUGIN_MEMBERS_DIR, `${siteSlug(rsn)}.json`), 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function normName(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function pbTime(entry) {
  if (entry.time) return String(entry.time);
  if (typeof entry.seconds === 'number') {
    const m = Math.floor(entry.seconds / 60);
    const s = entry.seconds - m * 60;
    return m ? `${m}:${s.toFixed(1).padStart(4, '0')}` : `${s.toFixed(1)}s`;
  }
  return '-';
}

// !pb: personal bests from the clan plugin's sync. !pb [name] lists
// them; !pb <boss> [name] shows one boss. Nothing is fetched live:
// the record is a local file the plugin API writes.
async function pbPayload(activity, rsn, userId) {
  const gate = ownAccountGate(userId, rsn);
  if (gate) return gate;
  const record = pluginRecord(rsn);
  const pbs = (record && record.personalBests) || {};
  const all = Object.entries(pbs).filter(([, e]) => e && typeof e === 'object');
  if (!all.length) {
    return { content: `No personal bests synced for **${rsn}** yet. PBs come from the clan plugin. This feature works when our clan plugin is live.` };
  }
  if (userId) noteUse(userId, 'pb');
  if (activity) {
    const entry = kcEntry(activity);
    const targets = new Set([normName(activity)]);
    if (entry) {
      targets.add(normName(entry.name));
      for (const c of entry.cols) targets.add(normName(c.metric));
    }
    const hit = all.find(([key, e]) => targets.has(normName(e.boss || key)) || targets.has(normName(key)));
    if (!hit) {
      return { content: `No ${entry ? entry.name : activity} personal best synced for **${rsn}** yet. \`!pb\` shows the ${all.length} they do have.` };
    }
    const [key, e] = hit;
    const boss = e.boss || (entry && entry.name) || key;
    const card = await fetchCard('/pb', {
      mode: 'single', rsn, badge: cardBadgeFor(rsn, null), boss, time: pbTime(e),
      killCount: e.killCount || null, at: e.at || null,
    });
    if (card) return { files: [new AttachmentBuilder(card, { name: 'pb.png' })] };
    return CARD_DOWN;
  }
  const rows = all
    .map(([key, e]) => ({ boss: e.boss || key, time: pbTime(e) }))
    .sort((a, b) => a.boss.localeCompare(b.boss));
  const card = await fetchCard('/pb', { mode: 'list', rsn, badge: cardBadgeFor(rsn, null), rows });
  if (card) return { files: [new AttachmentBuilder(card, { name: 'pb.png' })] };
  return CARD_DOWN;
}

// Like takeActivity, but the activity is optional: only consumes the
// leading tokens when they actually name a known activity.
function takeOptionalActivity(args) {
  if (args.length >= 2) {
    const two = `${args[0]}_${args[1]}`.toLowerCase();
    if (KC_KEYS[two]) {
      args.splice(0, 2);
      return two;
    }
  }
  const one = (args[0] || '').toLowerCase();
  if (KC_KEYS[one]) {
    args.shift();
    return one;
  }
  return null;
}

// Skill grid order, mirroring the website profile pages.
const SKILL_ORDER = [
  'attack', 'defence', 'strength', 'hitpoints', 'ranged', 'prayer',
  'magic', 'cooking', 'woodcutting', 'fletching', 'fishing',
  'firemaking', 'crafting', 'smithing', 'mining', 'herblore',
  'agility', 'thieving', 'slayer', 'farming', 'runecraft', 'hunter',
  'construction', 'sailing',
];

// !skills: the full skill grid from Wise Old Man, same numbers the
// website profile pages show.
async function skillsPayload(rsn, userId) {
  const gate = ownAccountGate(userId, rsn);
  if (gate) return gate;
  if (userId) noteUse(userId, 'skills'); // a real lookup fires: start the cooldown
  let st;
  try {
    st = await getStats(rsn);
  } catch (err) {
    return { content: 'Could not reach the stats service right now. Try again in a bit.' };
  }
  if (!st) return { content: 'Could not reach the stats service right now. Try again in a bit.' };
  if (st.notFound) return { content: `Could not find the RuneScape name **${rsn}**. Check the spelling and try again.` };
  const skillsMap = st.skills || {};
  // WOM names the skill runecrafting; the display order (and the
  // website) call it runecraft.
  const SKILL_DATA_KEYS = { runecraft: 'runecrafting' };
  const skills = SKILL_ORDER.map((key) => {
    const entry = skillsMap[key] || skillsMap[SKILL_DATA_KEYS[key]];
    return {
      key,
      name: key.charAt(0).toUpperCase() + key.slice(1),
      level: entry && typeof entry.level === 'number' ? entry.level : null,
      xp: entry && typeof entry.xp === 'number' ? entry.xp : null,
    };
  });
  const overall = skillsMap.overall;
  const totalLevel = overall && typeof overall.level === 'number'
    ? overall.level
    : skills.reduce((s, sk) => s + (sk.level || 0), 0);
  const totalXp = overall && typeof overall.xp === 'number'
    ? overall.xp
    : skills.reduce((s, sk) => s + (sk.xp || 0), 0);
  // Skilling boss counts ride along as a strip under the grid.
  const SKILLING_BOSSES = [
    ['wintertodt', 'Wintertodt'],
    ['tempoross', 'Tempoross'],
    ['guardians_of_the_rift', 'Guardians of the Rift'],
    ['zalcano', 'Zalcano'],
  ];
  const skillingBosses = SKILLING_BOSSES
    .map(([metric, name]) => ({ key: metric, name, kc: st.kc ? st.kc[metric] : null }))
    .filter((b) => typeof b.kc === 'number' && b.kc > 0);
  const rank = skillRank(rsn, 'overall');
  const card = await fetchCard('/skills', {
    rsn, badge: cardBadgeFor(rsn, st ? st.accountType : null), combat: st.combat, totalLevel, totalXp, skills, skillingBosses, rank,
  });
  if (card) {
    return {
      files: [new AttachmentBuilder(card, { name: 'skills.png' })],
      components: rank ? [lbSwapRow('overall', `skills:${rsn.replace(/ /g, '_')}`)] : [],
    };
  }
  return CARD_DOWN;
}

// !skills <skill> [name]: the solo single-skill card (Alex,
// Nov 2, 2026). Same sections the compare inspect shows, one
// player: level, XP and clan rank tiles, the skill's pet, and
// its collection log pages as tile strips, scored where the
// game gives a counter.
const SKILL_ALIASES = { rc: 'runecraft', runecrafting: 'runecraft', hp: 'hitpoints' };

function takeSkill(args) {
  if (!args || !args.length) return null;
  const fold = (s) => String(s || '').toLowerCase().replace(/[^a-z]/g, '');
  const tries = [];
  if (args.length > 1) tries.push([fold(args[0] + args[1]), args.slice(2)]);
  tries.push([fold(args[0]), args.slice(1)]);
  for (const [cand, rest] of tries) {
    if (!cand) continue;
    const key = SKILL_ALIASES[cand] || (SKILL_ORDER.includes(cand) ? cand : null);
    if (key) return { skill: key, rest };
  }
  return null;
}

async function skillPayload(rsn, skillKey, userId) {
  const gate = ownAccountGate(userId, rsn);
  if (gate) return gate;
  if (userId) noteUse(userId, 'skills');
  let st;
  try {
    st = await getStats(rsn);
  } catch (err) {
    return { content: 'Could not reach the stats service right now. Try again in a bit.' };
  }
  if (!st) return { content: 'Could not reach the stats service right now. Try again in a bit.' };
  if (st.notFound) return { content: `Could not find the RuneScape name **${rsn}**. Check the spelling and try again.` };
  const dataKey = skillKey === 'runecraft' ? 'runecrafting' : skillKey;
  const sk = (st.skills || {})[dataKey] || {};
  const counters = countersFor(st, rsn);
  const pageList = SKILL_CLOG_PAGES[skillKey] || [];
  const sections = [];
  for (const [tab, title] of pageList) {
    let res = null;
    try { res = await getClogPageWithItems(rsn, tab, title); } catch { res = null; }
    if (!res || res.notFound) continue;
    const scores = itemLuckScores(counters, res.items || []);
    const items = await Promise.all((res.items || []).map(async (it) => ({
      name: it.name,
      has: (it.quantity || 0) > 0,
      qty: it.quantity || 0,
      score: scores[it.id] != null ? scores[it.id] : null,
      icon: await petIconB64(it.id, it.name),
    })));
    const lk = luckForPage(counters,
      (res.items || []).map((it) => ({ id: it.id, qty: it.quantity || 0 })));
    sections.push({
      title, got: res.obtained, total: res.total, items,
      luckLine: lk ? `Luck: ${lk.word}${lk.dry ? ` · Driest item: ${lk.dry}` : ''}` : null,
    });
  }
  // The skill has pages but none are synced, and the player has
  // no RuneProfile profile at all: explain syncing instead of
  // posting an empty card.
  if (pageList.length && !sections.length) {
    const total = await getClogTotal(rsn).catch(() => null);
    if (!total || total.notFound) return { content: RP_GUIDE };
  }
  let pets = [];
  const petNames = SKILL_PETS[skillKey] || [];
  if (petNames.length) {
    const all = await allPetsItems(rsn);
    if (all) {
      pets = [];
      for (const nm of petNames) {
        const it = all.find((x) => x.name === nm);
        pets.push({
          name: nm,
          has: !!(it && (it.quantity || 0) > 0),
          qty: it ? (it.quantity || 0) : 0,
          icon: it ? await petIconB64(it.id, it.name) : null,
        });
      }
    }
  }
  const rank = skillRank(rsn, skillKey);
  const card = await fetchCard('/skill', {
    rsn,
    skillName: skillKey.charAt(0).toUpperCase() + skillKey.slice(1),
    skillKey,
    badge: cardBadgeFor(rsn, st ? st.accountType : null),
    level: typeof sk.level === 'number' ? sk.level : null,
    xp: typeof sk.xp === 'number' ? sk.xp : null,
    rank, pets, sections,
    noSections: !pageList.length,
  });
  if (card) {
    return {
      files: [new AttachmentBuilder(card, { name: 'skill.png' })],
      components: rank ? [lbSwapRow(`skill:${skillKey}`, `skill:${skillKey}:${rsn.replace(/ /g, '_')}`)] : [],
    };
  }
  return CARD_DOWN;
}

async function handleSkillsCommand(message, args) {
  const cd = checkCooldown(message.author.id, 'skills');
  if (cd.wait) { if (cd.notify) await message.reply(cooldownText(cd.wait)).catch(() => {}); return; }
  const sk = takeSkill(args);
  if (sk) {
    const { rsn, error, payload } = resolveName(sk.rest, message.author.id);
    if (error) { await message.reply(error).catch(() => {}); return; }
    if (payload) { await message.reply(payload).catch(() => {}); return; }
    await message.reply(await skillPayload(rsn, sk.skill, message.author.id)).catch(() => {});
    return;
  }
  const { rsn, error, payload } = resolveName(args, message.author.id);
  if (error) { await message.reply(error).catch(() => {}); return; }
  if (payload) { await message.reply(payload).catch(() => {}); return; }
  await message.reply(await skillsPayload(rsn, message.author.id)).catch(() => {});
}

// ---- Compare (added Oct 31, 2026) -----------------------------------
// !compare in three shapes: overall versus, skills diff, and boss
// head-to-head. Everything reads the same cached WOM + RuneProfile
// data as the other commands.
const fmt = (n) => (typeof n === 'number' ? n.toLocaleString('en-US') : '-');

// WOM activity scores that live in the kc map but are not kill
// counts (Colosseum Glory, PvP Arena, clue completions, the
// collection log count itself). Total KC sums real kills only.
const NON_KC_SCORES = new Set([
  'league_points', 'bounty_hunter_hunter', 'bounty_hunter_rogue',
  'bounty_hunter_hunter_hardcore', 'bounty_hunter_rogue_hardcore',
  'clue_scrolls_all', 'clue_scrolls_beginner', 'clue_scrolls_easy',
  'clue_scrolls_medium', 'clue_scrolls_hard', 'clue_scrolls_elite',
  'clue_scrolls_master', 'last_man_standing', 'pvp_arena',
  'soul_wars_zeal', 'colosseum_glory', 'collections_logged',
]);

async function compareSnapshot(rsn) {
  const st = await getStats(rsn);
  if (!st || st.notFound) return { st };
  const skillsMap = st.skills || {};
  const SKILL_DATA_KEYS = { runecraft: 'runecrafting' };
  const skills = SKILL_ORDER.map((key) => {
    const entry = skillsMap[key] || skillsMap[SKILL_DATA_KEYS[key]];
    return {
      key,
      name: key.charAt(0).toUpperCase() + key.slice(1),
      level: entry && typeof entry.level === 'number' ? entry.level : null,
      xp: entry && typeof entry.xp === 'number' ? entry.xp : null,
    };
  });
  const overall = skillsMap.overall;
  const totalLevel = overall && typeof overall.level === 'number'
    ? overall.level : skills.reduce((s, sk) => s + (sk.level || 0), 0);
  const totalXp = overall && typeof overall.xp === 'number'
    ? overall.xp : skills.reduce((s, sk) => s + (sk.xp || 0), 0);
  const totalKc = Object.entries(st.kc || {}).reduce(
    (s, [k, v]) => s + (typeof v === 'number' && !NON_KC_SCORES.has(k) ? v : 0), 0);
  const n99 = skills.filter((sk) => sk.level === 99).length;
  return { st, skills, totalLevel, totalXp, totalKc, combat: st.combat, n99 };
}

function skillsLed(aSkills, bSkills) {
  let a = 0, b = 0;
  const cells = aSkills.map((sk, i) => {
    const o = bSkills[i];
    let winner = 'tie';
    if (sk.level != null && o.level != null) {
      if (sk.level !== o.level) winner = sk.level > o.level ? 'a' : 'b';
      else if ((sk.xp || 0) !== (o.xp || 0)) winner = (sk.xp || 0) > (o.xp || 0) ? 'a' : 'b';
    }
    if (winner === 'a') a += 1;
    if (winner === 'b') b += 1;
    let gap = '';
    if (winner !== 'tie') {
      const lead = winner === 'a' ? sk : o;
      const trail = winner === 'a' ? o : sk;
      if (lead.level !== trail.level) gap = `+${Math.abs(lead.level - trail.level)} lvl`;
      else gap = `+${abbrXp(Math.abs((lead.xp || 0) - (trail.xp || 0)))} xp`;
    } else if (sk.level != null) gap = 'tied';
    return { key: sk.key, name: sk.name, aLevel: sk.level, bLevel: o.level, winner, gap };
  });
  return { a, b, cells };
}

function abbrXp(n) {
  if (n >= 1000000) return `${(n / 1000000).toFixed(1).replace(/\.0$/, '')}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}k`;
  return `${n}`;
}

async function compareOverallPayload(aName, bName, userId, ownerId, ui = {}) {
  if (userId) noteUse(userId, 'compare');
  const [sa, sb] = await Promise.all([compareSnapshot(aName), compareSnapshot(bName)]).catch(() => [null, null]);
  if (!sa || !sb) return { content: 'Could not reach the stats service right now. Try again in a bit.' };
  if (!sa.st) return { content: `Could not find the RuneScape name **${aName}**.` };
  if (!sb.st) return { content: `Could not find the RuneScape name **${bName}**.` };
  const [clogA, clogB] = await Promise.all([
    getClogTotal(aName).catch(() => null), getClogTotal(bName).catch(() => null),
  ]);
  const led = skillsLed(sa.skills, sb.skills);
  const win = (x, y) => (x == null || y == null || x === y ? 'tie' : x > y ? 'a' : 'b');
  const rows = [
    { label: 'Total level', aText: fmt(sa.totalLevel), bText: fmt(sb.totalLevel), winner: win(sa.totalLevel, sb.totalLevel) },
    { label: 'Total XP', aText: fmt(sa.totalXp), bText: fmt(sb.totalXp), winner: win(sa.totalXp, sb.totalXp) },
    { label: 'Combat', aText: fmt(sa.combat), bText: fmt(sb.combat), winner: win(sa.combat, sb.combat) },
    { label: '99s', aText: fmt(sa.n99), bText: fmt(sb.n99), winner: win(sa.n99, sb.n99) },
    {
      label: 'Collection log',
      aText: clogA && !clogA.notFound ? `${fmt(clogA.obtained)} / ${fmt(clogA.total)}` : '-',
      bText: clogB && !clogB.notFound ? `${fmt(clogB.obtained)} / ${fmt(clogB.total)}` : '-',
      winner: win(clogA && !clogA.notFound ? clogA.obtained : null, clogB && !clogB.notFound ? clogB.obtained : null),
    },
    { label: 'Total KC', aText: fmt(sa.totalKc), bText: fmt(sb.totalKc), winner: win(sa.totalKc, sb.totalKc) },
    { label: 'Skills led', aText: `${led.a}`, bText: `${led.b}`, winner: win(led.a, led.b) },
  ];
  const wa = rows.filter((r) => r.winner === 'a').length;
  const wb = rows.filter((r) => r.winner === 'b').length;
  // The score always reads in card order (player A first, player B
  // second), whichever side leads.
  const tally = wa === wb ? `ALL SQUARE AT ${wa} - ${wb}`
    : `${(wa > wb ? aName : bName).toUpperCase()} LEADS ${wa} - ${wb}`;
  const card = await fetchCard('/compare', { a: { rsn: aName, badge: cardBadgeFor(aName, sa && sa.st ? sa.st.accountType : null) }, b: { rsn: bName, badge: cardBadgeFor(bName, sb && sb.st ? sb.st.accountType : null) }, rows, tally });
  if (card) return { files: [new AttachmentBuilder(card, { name: 'compare.png' })], components: await compareComponents('overall', aName, bName, ui.bossKey || null, ownerId ?? userId, ui) };
  return { content: `**${aName}** vs **${bName}** - ${tally.charAt(0) + tally.slice(1).toLowerCase()}. The card service is down right now.` };
}

// Which collection log pages belong to a skill, for the single-
// skill inspect card (mapping set Oct 31, 2026): the skill's
// own pages plus its skilling boss. Pages are [tab, title] in
// RuneProfile terms. Scored pages (single KC counter) also get a
// luck line via SKILL_SECTION_METRIC.
const SKILL_CLOG_PAGES = {
  woodcutting: [['Other', 'Forestry'], ['Minigames', 'Temple Trekking']],
  fletching: [['Minigames', 'Vale Totems']],
  agility: [['Other', 'Rooftop Agility'], ['Minigames', 'Hallowed Sepulchre'], ['Other', 'Colossal Wyrm Agility'], ['Minigames', 'Brimhaven Agility Arena']],
  firemaking: [['Bosses', 'Wintertodt'], ['Minigames', "Shades of Mort'ton"]],
  fishing: [['Bosses', 'Tempoross'], ['Minigames', 'Fishing Trawler'], ['Other', 'Aerial Fishing']],
  runecraft: [['Minigames', 'Guardians of the Rift']],
  mining: [['Bosses', 'Zalcano'], ['Other', 'Motherlode Mine'], ['Minigames', 'Volcanic Mine'], ['Other', 'Shooting Stars']],
  slayer: [['Other', 'Slayer']],
  farming: [['Minigames', 'Tithe Farm'], ['Bosses', 'Hespori']],
  hunter: [['Other', 'Hunter Guild'], ['Other', 'Chompy Bird Hunting']],
  sailing: [['Minigames', 'Barracuda Trials'], ['Other', 'Ocean Encounters'], ['Other', 'Sea Treasures'], ['Other', 'Sailing Miscellaneous'], ['Other', 'Boat Paints']],
  magic: [['Minigames', 'Magic Training Arena']],
  cooking: [['Minigames', 'Gnome Restaurant']],
  thieving: [['Minigames', "Rogues' Den"]],
  herblore: [['Minigames', 'Mastering Mixology']],
  construction: [['Minigames', 'Mahogany Homes']],
  smithing: [['Minigames', "Giants' Foundry"]],
};
const SKILL_SECTION_METRIC = { Wintertodt: 'wintertodt', Tempoross: 'tempoross', Zalcano: 'zalcano' };

// Draft 3 skill sections (Alex's pick, Oct 31, 2026): paired
// per page, only the items the two players differ on, plus how
// many they share. Scored skilling-boss pages keep a compact
// luck-words line (the full luck % treatment lives on boss
// cards). Never throws.
async function skillDiffSections(aName, bName, skillKey, kcMapA, kcMapB) {
  const out = [];
  for (const [tab, title] of SKILL_CLOG_PAGES[skillKey] || []) {
    try {
      const [ra, rb] = await Promise.all([
        getClogPageWithItems(aName, tab, title).catch(() => null),
        getClogPageWithItems(bName, tab, title).catch(() => null),
      ]);
      const okA = !!(ra && !ra.notFound);
      const okB = !!(rb && !rb.notFound);
      if (!okA && !okB) continue;
      const itemsA = new Map((okA ? ra.items || [] : []).map((it) => [it.id, it]));
      const itemsB = new Map((okB ? rb.items || [] : []).map((it) => [it.id, it]));
      const ids = [...new Set([...itemsA.keys(), ...itemsB.keys()])];
      const diffs = [];
      let shared = 0;
      for (const id of ids) {
        const ia = itemsA.get(id);
        const ib = itemsB.get(id);
        const ha = !!ia && (ia.quantity || 0) > 0;
        const hb = !!ib && (ib.quantity || 0) > 0;
        if (ha && hb) { shared++; continue; }
        if (ha === hb) continue;
        const ref = ia || ib;
        diffs.push({
          name: ref.name, aHas: ha, bHas: hb,
          icon: await petIconB64(ref.id, ref.name),
        });
      }
      diffs.sort((x, y) => String(x.name).localeCompare(String(y.name)));
      const metric = SKILL_SECTION_METRIC[title] || null;
      let luckLine = null;
      if (metric) {
        const parts = [];
        const pageItems = (res) => (res.items || []).map((it) => ({ id: it.id, qty: it.quantity || 0 }));
        const la = okA ? luckForPage({ ...(kcMapA || {}), ...pluginCountersFor(aName) }, pageItems(ra)) : null;
        const lb = okB ? luckForPage({ ...(kcMapB || {}), ...pluginCountersFor(bName) }, pageItems(rb)) : null;
        if (la) parts.push(`${aName} ${la.word}`);
        if (lb) parts.push(`${bName} ${lb.word}`);
        if (parts.length) luckLine = `Luck: ${parts.join(' · ')}`;
      }
      out.push({
        title,
        aGot: okA ? ra.obtained : 0,
        bGot: okB ? rb.obtained : 0,
        total: (okA ? ra.total : 0) || (okB ? rb.total : 0) || 0,
        diffs, shared, luckLine,
      });
    } catch { /* one missing page must not cost the card */ }
  }
  return out;
}

async function compareSkillsPayload(aName, bName, userId, ownerId, ui = {}) {
  if (userId) noteUse(userId, 'compare');
  const [sa, sb] = await Promise.all([compareSnapshot(aName), compareSnapshot(bName)]).catch(() => [null, null]);
  if (!sa || !sb) return { content: 'Could not reach the stats service right now. Try again in a bit.' };
  if (!sa.st) return { content: `Could not find the RuneScape name **${aName}**.` };
  if (!sb.st) return { content: `Could not find the RuneScape name **${bName}**.` };
  const picked = ui.skill && SKILL_ORDER.includes(ui.skill) ? ui.skill : null;
  if (picked) {
    // Single-skill inspect: the skill big, plus its clog sections.
    const ai = sa.skills.find((s) => s.key === picked);
    const bi = sb.skills.find((s) => s.key === picked);
    const sections = await skillDiffSections(
      aName, bName, picked, sa.st.kc, sb.st.kc);
    let leader = null;
    if (ai && bi && ai.level != null && bi.level != null) {
      if (ai.level !== bi.level) leader = ai.level > bi.level ? 'a' : 'b';
      else if ((ai.xp || 0) !== (bi.xp || 0)) leader = (ai.xp || 0) > (bi.xp || 0) ? 'a' : 'b';
    }
    const leadName = leader === 'a' ? aName : leader === 'b' ? bName : null;
    const note = !leadName ? 'Dead level.'
      : ai.level !== bi.level
        ? `${leadName} leads by ${Math.abs(ai.level - bi.level)} level${Math.abs(ai.level - bi.level) === 1 ? '' : 's'}`
        : `${leadName} leads on XP`;
    const noMap = !(picked in SKILL_CLOG_PAGES);
    let skillPets = null;
    const petNames = SKILL_PETS[picked] || [];
    if (petNames.length) {
      const [petItemsA, petItemsB] = await Promise.all([
        allPetsItems(aName), allPetsItems(bName),
      ]);
      const list = [];
      for (const name of petNames) {
        const ia = (petItemsA || []).find((it) => it.name === name);
        const ib = (petItemsB || []).find((it) => it.name === name);
        if (!ia && !ib) continue;
        const ref = ia || ib;
        list.push({
          name,
          aHas: !!(ia && (ia.quantity || 0) > 0),
          bHas: !!(ib && (ib.quantity || 0) > 0),
          icon: await petIconB64(ref.id, ref.name),
        });
      }
      if (list.length) skillPets = list;
    }
    const card = await fetchCard('/compare-skill', {
      skillKey: picked, skillName: ai ? ai.name : picked,
      a: { rsn: aName, badge: cardBadgeFor(aName, sa && sa.st ? sa.st.accountType : null), level: ai ? ai.level : null, xp: ai ? ai.xp : null, rank: skillRank(aName, picked) },
      b: { rsn: bName, badge: cardBadgeFor(bName, sb && sb.st ? sb.st.accountType : null), level: bi ? bi.level : null, xp: bi ? bi.xp : null, rank: skillRank(bName, picked) },
      sections, noSections: noMap,
      noSync: !noMap && sections.length === 0,
      leader, note, pets: skillPets,
    });
    const components = await compareComponents('skills', aName, bName,
      ui.bossKey || null, ownerId ?? userId, ui);
    components.push(lbSwapRow(`skill:${picked}`, `cmpskill:${picked}:${encodePair(aName, bName, ownerId ?? userId)}`));
    if (card) return { files: [new AttachmentBuilder(card, { name: 'compare-skill.png' })], components };
    return { content: `**${ai ? ai.name : picked}** - ${aName}: ${ai ? ai.level ?? '-' : '-'} · ${bName}: ${bi ? bi.level ?? '-' : '-'}`, components };
  }
  const led = skillsLed(sa.skills, sb.skills);
  const tied = 24 - led.a - led.b;
  const summary = `Skills led: ${aName} ${led.a} - ${led.b} ${bName}${tied ? ` · ${tied} tied` : ''}`;
  const card = await fetchCard('/compare-skills', {
    a: { rsn: aName, badge: cardBadgeFor(aName, sa && sa.st ? sa.st.accountType : null) }, b: { rsn: bName, badge: cardBadgeFor(bName, sb && sb.st ? sb.st.accountType : null) }, summary, cells: led.cells,
    highlight: null, focusLine: '',
  });
  if (card) return { files: [new AttachmentBuilder(card, { name: 'compare-skills.png' })], components: await compareComponents('skills', aName, bName, ui.bossKey || null, ownerId ?? userId, ui) };
  return { content: summary };
}

// Combined raid compare (toa / cox / tob from the Raids menu):
// total KC up top, per-variant kills on each side, the difference
// per variant as the note, rank by combined total, and the raid's
// one collection log strip. Raids carry no luck score.
async function compareRaidCombinedPayload(key, entry, aName, bName, sa, sb, ownerId) {
  const raidDef = combinedDef(key);
  const bossName = raidDef ? raidDef.name : entry.name;
  const cols = entry.cols.map((c) => ({ label: raidColLabel(c), metric: c.metric }));
  // Paired bosses list the variant column first; put the base
  // boss first on the card.
  const baseMetric = CMP_COMBINED_BASE_METRIC[key];
  if (baseMetric) {
    cols.sort((x, y) => (x.metric === baseMetric ? 0 : 1)
      - (y.metric === baseMetric ? 0 : 1));
  }
  const kcOf = (stats, m) => (stats && stats.kc && typeof stats.kc[m] === 'number' ? stats.kc[m] : null);
  const totalOf = (stats) => {
    let sum = 0;
    let any = false;
    for (const c of cols) {
      const v = kcOf(stats, c.metric);
      if (v != null) { sum += v; any = true; }
    }
    return any ? sum : null;
  };
  const kcA = totalOf(sa);
  const kcB = totalOf(sb);
  const totals = new Map();
  for (const c of cols) {
    try {
      for (const row of kcStandings(c.metric)) {
        totals.set(row.name, (totals.get(row.name) || 0) + row.kc);
      }
    } catch { /* cache only */ }
  }
  const rankOf = (rsn) => {
    if (!totals.size) return null;
    const sorted = [...totals.entries()].sort((x, y) => y[1] - x[1]);
    const i = sorted.findIndex(([n]) => n === rsn.toLowerCase());
    return i >= 0 ? i + 1 : null;
  };
  const parts = [];
  for (const c of cols) {
    const va = kcOf(sa, c.metric);
    const vb = kcOf(sb, c.metric);
    if (va != null && vb != null && va !== vb) {
      parts.push(`${c.label}: ${va > vb ? aName : bName} +${fmt(Math.abs(va - vb))}`);
    } else if (va != null && vb != null) {
      parts.push(`${c.label}: tied`);
    }
  }
  const leader = kcA != null && kcB != null && kcA !== kcB ? (kcA > kcB ? 'a' : 'b') : null;
  const [ca, cb] = await Promise.all([
    bossClogLuck(aName, key, countersFor(sa, aName)),
    bossClogLuck(bName, key, countersFor(sb, bName)),
  ]);
  const sideCols = (stats) => cols.map((c) => ({ label: c.label, kc: kcOf(stats, c.metric) }));
  const card = await fetchCard('/compare-boss', {
    boss: bossName, metric: cols[0].metric,
    a: { rsn: aName, badge: cardBadgeFor(aName, sa && sa.st ? sa.st.accountType : null), kc: kcA, rank: rankOf(aName), cols: sideCols(sa), clog: ca.clog, luck: null, pets: null },
    b: { rsn: bName, badge: cardBadgeFor(bName, sb && sb.st ? sb.st.accountType : null), kc: kcB, rank: rankOf(bName), cols: sideCols(sb), clog: cb.clog, luck: null, pets: null },
    leader, note: parts.join(' · '),
  });
  if (card) {
    const components = await compareComponents('boss', aName, bName, key, ownerId, { cat: raidDef && raidDef.cat ? raidDef.cat : 'raids', catPage: 0 });
    components.push(lbSwapRow(`boss:${key}`, `cmpboss:${key}:${encodePair(aName, bName, ownerId)}`));
    return { files: [new AttachmentBuilder(card, { name: 'compare-boss.png' })], components };
  }
  return { content: `**${bossName}** - ${aName}: ${kcA == null ? '-' : fmt(kcA)} · ${bName}: ${kcB == null ? '-' : fmt(kcB)}${parts.length ? ` (${parts.join(' · ')})` : ''}` };
}

async function compareBossPayload(key, aName, bName, userId, ownerId, ui = {}) {
  if (userId) noteUse(userId, 'compare');
  const entry = kcEntry(key);
  if (!entry) return { content: `I do not track a boss or activity called **${key}**.` };
  const [sa, sb] = await Promise.all([
    getStats(aName).catch(() => null), getStats(bName).catch(() => null),
  ]);
  // Multi-column activities (raids, the Gauntlet) list the base
  // metric first and the variant second for BOTH keys, so pick the
  // column the requested key actually means: toa_expert is the
  // expert metric, cg is the corrupted column, and so on.
  const variantKey = key === 'cg' || /(_expert|_cm|_hard)$/.test(key);
  const col = entry.cols.length > 1 && variantKey
    ? entry.cols[entry.cols.length - 1] : entry.cols[0];
  const metric = col.metric;
  const bossName = key === 'cg' ? 'The Corrupted Gauntlet' : entry.name;
  let standings = null;
  try { standings = kcStandings(metric); } catch { standings = null; }
  if (!sa || !sb) return { content: 'Could not reach the stats service right now. Try again in a bit.' };
  if (sa.notFound) return { content: `Could not find the RuneScape name **${aName}**.` };
  if (sb.notFound) return { content: `Could not find the RuneScape name **${bName}**.` };
  // Combined entries (raids from the Raids menu, plus the
  // folded Gauntlet and wilderness pairs): one card over every
  // variant column instead of a separate card per variant.
  if (combinedDef(key) && entry.cols.length > 1) {
    return compareRaidCombinedPayload(key, entry, aName, bName, sa, sb, ownerId ?? userId);
  }
  const rankOf = (rsn) => {
    if (!standings) return null;
    const i = standings.findIndex((r) => r.name === rsn.toLowerCase());
    return i >= 0 ? i + 1 : null;
  };
  const kcA = sa.kc && typeof sa.kc[metric] === 'number' ? sa.kc[metric] : null;
  const kcB = sb.kc && typeof sb.kc[metric] === 'number' ? sb.kc[metric] : null;
  const leader = kcA != null && kcB != null && kcA !== kcB ? (kcA > kcB ? 'a' : 'b') : null;
  const note = leader
    ? `${leader === 'a' ? aName : bName} leads by ${fmt(Math.abs(kcA - kcB))}`
    : kcA != null && kcA === kcB ? 'Dead level.' : '';
  const [ca, cb] = await Promise.all([
    bossClogLuck(aName, key, countersFor(sa, aName)), bossClogLuck(bName, key, countersFor(sb, bName)),
  ]);
  const card = await fetchCard('/compare-boss', {
    boss: bossName, metric,
    a: { rsn: aName, badge: cardBadgeFor(aName, sa && sa.st ? sa.st.accountType : null), kc: kcA, rank: rankOf(aName), clog: ca.clog, luck: ca.luck, pets: null },
    b: { rsn: bName, badge: cardBadgeFor(bName, sb && sb.st ? sb.st.accountType : null), kc: kcB, rank: rankOf(bName), clog: cb.clog, luck: cb.luck, pets: null },
    leader, note,
  });
  if (card) {
    const components = await compareComponents('boss', aName, bName, key, ownerId ?? userId, { cat: ui.cat === undefined ? compareCategoryOf(key) : ui.cat, catPage: ui.catPage || 0 });
    components.push(lbSwapRow(`boss:${key}`, `cmpboss:${key}:${encodePair(aName, bName, ownerId ?? userId)}`));
    return { files: [new AttachmentBuilder(card, { name: 'compare-boss.png' })], components };
  }
  return { content: `**${bossName}** - ${aName}: ${kcA == null ? '-' : fmt(kcA)} · ${bName}: ${kcB == null ? '-' : fmt(kcB)}${note ? ` (${note})` : ''}` };
}

// ---- Boss base page: totals before a boss is picked ----
// Merged units match the website's boss pages: raid variants and
// the wilderness pairs count as one boss.
const BOSS_GROUPS = new Map([
  ['tombs_of_amascut', 'Tombs of Amascut'], ['tombs_of_amascut_expert', 'Tombs of Amascut'],
  ['chambers_of_xeric', 'Chambers of Xeric'], ['chambers_of_xeric_challenge_mode', 'Chambers of Xeric'],
  ['theatre_of_blood', 'Theatre of Blood'], ['theatre_of_blood_hard_mode', 'Theatre of Blood'],
  ['the_gauntlet', 'The Gauntlet'], ['the_corrupted_gauntlet', 'The Gauntlet'],
  ['callisto', 'Callisto and Artio'], ['artio', 'Callisto and Artio'],
  ['venenatis', 'Venenatis and Spindel'], ['spindel', 'Venenatis and Spindel'],
  ["vet'ion", "Vet'ion and Calvar'ion"], ["calvar'ion", "Vet'ion and Calvar'ion"],
]);
const RAID_METRICS = ['tombs_of_amascut', 'tombs_of_amascut_expert', 'chambers_of_xeric',
  'chambers_of_xeric_challenge_mode', 'theatre_of_blood', 'theatre_of_blood_hard_mode'];
const SKILLING_METRICS = ['wintertodt', 'tempoross', 'guardians_of_the_rift', 'zalcano'];

async function compareBossBasePayload(aName, bName, userId, ownerId, ui = {}) {
  if (userId) noteUse(userId, 'compare');
  const [sa, sb] = await Promise.all([compareSnapshot(aName), compareSnapshot(bName)]).catch(() => [null, null]);
  if (!sa || !sb) return { content: 'Could not reach the stats service right now. Try again in a bit.' };
  if (!sa.st) return { content: `Could not find the RuneScape name **${aName}**.` };
  if (!sb.st) return { content: `Could not find the RuneScape name **${bName}**.` };
  const kcOf = (st, metric) => (st.kc && typeof st.kc[metric] === 'number' ? st.kc[metric] : 0);
  // One unit per boss page: dedupe metrics across activity keys,
  // then fold grouped metrics into their merged unit.
  const units = new Map();
  const seenMetrics = new Set();
  for (const key of Object.keys(KC_KEYS)) {
    const entry = kcEntry(key);
    if (!entry || !entry.cols || !entry.cols.length) continue;
    const variantKey = key === 'cg' || /(_expert|_cm|_hard)$/.test(key);
    const col = entry.cols.length > 1 && variantKey
      ? entry.cols[entry.cols.length - 1] : entry.cols[0];
    if (NON_KC_SCORES.has(col.metric)) continue;
    if (seenMetrics.has(col.metric)) continue; // alias keys share a metric
    seenMetrics.add(col.metric);
    const unit = BOSS_GROUPS.get(col.metric) || entry.name;
    if (!units.has(unit)) units.set(unit, { name: unit, a: 0, b: 0 });
    const u = units.get(unit);
    u.a += kcOf(sa.st, col.metric);
    u.b += kcOf(sb.st, col.metric);
  }
  const fought = [...units.values()].filter((u) => u.a + u.b > 0);
  const ledA = fought.filter((u) => u.a > u.b).length;
  const ledB = fought.filter((u) => u.b > u.a).length;
  const sum = (st, metrics) => metrics.reduce((s, m) => s + kcOf(st, m), 0);
  const raidA = sum(sa.st, RAID_METRICS);
  const raidB = sum(sb.st, RAID_METRICS);
  const skilA = sum(sa.st, SKILLING_METRICS);
  const skilB = sum(sb.st, SKILLING_METRICS);
  const win = (x, y) => (x === y ? 'tie' : x > y ? 'a' : 'b');
  const rows = [
    { label: 'Total KC', aText: fmt(sa.totalKc), bText: fmt(sb.totalKc), winner: win(sa.totalKc, sb.totalKc) },
    { label: 'Bosses led', aText: `${ledA}`, bText: `${ledB}`, winner: win(ledA, ledB) },
    { label: 'Raid KC', aText: fmt(raidA), bText: fmt(raidB), winner: win(raidA, raidB) },
    { label: 'Skilling boss KC', aText: fmt(skilA), bText: fmt(skilB), winner: win(skilA, skilB) },
  ];
  const top = fought
    .sort((x, y) => (y.a + y.b) - (x.a + x.b))
    .slice(0, 6)
    .map((u) => ({ name: u.name, aText: fmt(u.a), bText: fmt(u.b), winner: win(u.a, u.b) }));
  const components = await compareComponents('bossbase', aName, bName,
    ui.bossKey || null, ownerId ?? userId, ui);
  const card = await fetchCard('/compare-boss-base', {
    a: { rsn: aName }, b: { rsn: bName }, rows, top,
  });
  if (card) return { files: [new AttachmentBuilder(card, { name: 'compare-boss-base.png' })], components };
  return {
    content: `**Bosses** - ${aName}: ${fmt(sa.totalKc)} total KC · ${bName}: ${fmt(sb.totalKc)} total KC. The card service is down right now.`,
    components,
  };
}

// Splits the text-command tail into the two players. A name on its
// own means "that player vs my linked RSN"; two names need " vs ".
function compareNames(rest, userId) {
  const parts = rest.split(/\s+vs\s+/i).map((s) => s.trim()).filter(Boolean);
  const first = resolveNameFor(userId, parts[0] || null);
  if (first.error || first.payload) return first;
  if (parts.length > 1) {
    const second = resolveNameFor(userId, parts[1]);
    if (second.error || second.payload) return second;
    const gate = ownAccountGate(userId, first.rsn) || ownAccountGate(userId, second.rsn);
    if (gate) return { payload: gate };
    return { a: first.rsn, b: second.rsn };
  }
  const linked = resolveNameFor(userId, null);
  if (linked.error || linked.payload) return linked;
  const gate = ownAccountGate(userId, first.rsn) || ownAccountGate(userId, linked.rsn);
  if (gate) return { payload: gate };
  return { a: first.rsn, b: linked.rsn };
}

async function handleCompareCommand(message, args) {
  const cd = checkCooldown(message.author.id, 'compare');
  if (cd.wait) { if (cd.notify) await message.reply(cooldownText(cd.wait)).catch(() => {}); return; }
  const joined = args.join(' ').trim();
  const usage = 'Usage: `!compare <name>` (vs your linked RSN), `!compare <name> vs <name>`, `!compare skills <name> vs <name>`, or `!compare <boss> <name> vs <name>`.';
  if (!joined) { await message.reply(usage).catch(() => {}); return; }
  const uid = message.author.id;
  if (/^skills\s+/i.test(joined)) {
    const names = compareNames(joined.replace(/^skills\s+/i, ''), uid);
    if (names.error) { await message.reply(names.error).catch(() => {}); return; }
    if (names.payload) { await message.reply(names.payload).catch(() => {}); return; }
    if (normName(names.a) === normName(names.b)) { await message.reply('Pick two different players to compare.').catch(() => {}); return; }
    await message.reply(await compareSkillsPayload(names.a, names.b, uid)).catch(() => {});
    return;
  }
  const tokens = joined.split(/\s+/);
  const actKey = takeOptionalActivity(tokens);
  if (actKey && tokens.length) {
    const names = compareNames(tokens.join(' '), uid);
    if (names.error) { await message.reply(names.error).catch(() => {}); return; }
    if (names.payload) { await message.reply(names.payload).catch(() => {}); return; }
    if (normName(names.a) === normName(names.b)) { await message.reply('Pick two different players to compare.').catch(() => {}); return; }
    await message.reply(await compareBossPayload(actKey, names.a, names.b, uid)).catch(() => {});
    return;
  }
  const names = compareNames(joined, uid);
  if (names.error) { await message.reply(names.error).catch(() => {}); return; }
  if (names.payload) { await message.reply(names.payload).catch(() => {}); return; }
  if (normName(names.a) === normName(names.b)) { await message.reply('Pick two different players to compare.').catch(() => {}); return; }
  await message.reply(await compareOverallPayload(names.a, names.b, uid)).catch(() => {});
}

async function handlePbCommand(message, args) {
  const cd = checkCooldown(message.author.id, 'pb');
  if (cd.wait) { if (cd.notify) await message.reply(cooldownText(cd.wait)).catch(() => {}); return; }
  const activity = takeOptionalActivity(args);
  const { rsn, error, payload } = resolveName(args, message.author.id);
  if (error) { await message.reply(error).catch(() => {}); return; }
  if (payload) { await message.reply(payload).catch(() => {}); return; }
  await message.reply(await pbPayload(activity, rsn, message.author.id)).catch(() => {});
}

// !tfa [name]: the Fractured Archive combined card, shorthand for
// !kc tfa with its clog strip.
async function handleTfaCommand(message, args) {
  const cd = checkCooldown(message.author.id, 'tfa');
  if (cd.wait) { if (cd.notify) await message.reply(cooldownText(cd.wait)).catch(() => {}); return; }
  const { rsn, error, payload } = resolveName(args, message.author.id);
  if (error) { await message.reply(error).catch(() => {}); return; }
  if (payload) { await message.reply(payload).catch(() => {}); return; }
  await message.reply(await kcPayload('tfa', rsn, message.author.id)).catch(() => {});
}

async function handleLeaderboardCommand(message, args) {
  const cd = checkCooldown(message.author.id, 'leaderboard');
  if (cd.wait) { if (cd.notify) await message.reply(cooldownText(cd.wait)).catch(() => {}); return; }
  await message.reply(await leaderboardPayload(message.author.id, (args || []).join(' '))).catch(() => {});
}

// ---- slash commands (same payloads as the !-commands) --------------------
function resolveNameFor(userId, named) {
  if (named && String(named).trim()) {
    const name = String(named).trim().replace(/\s+/g, ' ');
    if (!RSN_RE.test(name)) return { error: 'That name has characters RuneScape does not allow. Try again.' };
    return { rsn: name };
  }
  const linked = getRsn(userId);
  if (!linked) return { payload: unlinkedPayload() };
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
async function slashCooldown(interaction, family) {
  const cd = checkCooldown(interaction.user.id, family);
  if (!cd.wait) return false;
  await interaction.reply({ content: cooldownText(cd.wait), ephemeral: true }).catch(() => {});
  return true;
}

// Slash activity options use autocomplete, not fixed choices: the full
// kc and clog lists are far past Discord's 25-choice cap. Choices are
// { name, value } pairs filtered by what the member has typed.
function kcAutocompleteChoices(focused) {
  const q = String(focused || '').toLowerCase();
  // One row per boss: variant singles (ToA Expert, CoX CM,
  // Hard Mode ToB) fold into the combined card's row, and alias
  // keys share a row under the boss's plain name.
  const seen = new Set();
  const all = [];
  for (const [value] of Object.entries(KC_KEYS)) {
    const entry = kcEntry(value);
    if (!entry) continue;
    const name = String(entry.name)
      .replace(/^Hard Mode /, '')
      .replace(/ (Normal|Expert|CM|Challenge Mode)$/, '');
    if (seen.has(name)) continue;
    seen.add(name);
    all.push({ name, value });
  }
  return all.filter((c) => !q || c.name.toLowerCase().includes(q) || c.value.includes(q)).slice(0, 25);
}

function skillAutocompleteChoices(focused) {
  const q = String(focused || '').toLowerCase();
  return SKILL_ORDER
    .map((key) => ({ name: key.charAt(0).toUpperCase() + key.slice(1), value: key }))
    .filter((c) => !q || c.name.toLowerCase().includes(q) || c.value.includes(q))
    .slice(0, 25);
}

function clogAutocompleteChoices(focused) {
  const q = String(focused || '').toLowerCase();
  const seen = new Set();
  const all = [{ name: 'Total (whole log)', value: 'total' },
    { name: 'Clue Scrolls (all tiers)', value: 'clues' }];
  for (const [value, page] of Object.entries(CLOG_PAGES)) {
    if (seen.has(page[1])) continue; // aliases share one dropdown row
    seen.add(page[1]);
    all.push({ name: page[1], value });
  }
  return all.filter((c) => !q || c.name.toLowerCase().includes(q) || c.value.includes(q)).slice(0, 25);
}

async function handleAutocomplete(interaction) {
  const focused = interaction.options.getFocused();
  const choices = interaction.commandName === 'dry'
    ? dryAutocompleteChoices(focused)
    : interaction.commandName === 'kc' || interaction.commandName === 'pb'
    ? kcAutocompleteChoices(focused)
    : interaction.commandName === 'clog'
      ? clogAutocompleteChoices(focused)
    : interaction.commandName === 'skills'
      ? skillAutocompleteChoices(focused)
      : interaction.commandName === 'leaderboard'
        ? lbAutocompleteChoices(focused)
        : interaction.commandName === 'bounty'
        ? bountyAutocompleteChoices(focused)
        : [];
  await interaction.respond(choices).catch(() => {});
}

// ---- Compare card components: view buttons + boss picker ----
// The pair travels inside the component ids (base64url of "a\nb"), so
// the buttons keep working without any server-side state.

function encodePair(a, b, ownerId) {
  return Buffer.from(`${a}\n${b}\n${ownerId || ''}`, 'utf8').toString('base64url');
}

function decodePair(enc) {
  try {
    const parts = Buffer.from(String(enc || ''), 'base64url').toString('utf8').split('\n');
    if (parts.length < 2 || !parts[0] || !parts[1]) return null;
    return { a: parts[0], b: parts[1], owner: parts[2] || null };
  } catch {
    return null;
  }
}

async function compareClogsPayload(aName, bName, userId, ownerId, ui = {}) {
  if (userId) noteUse(userId, 'compare');
  const owner = ownerId ?? userId;
  const [pa, pb] = await Promise.all([clogPagesOf(aName), clogPagesOf(bName)]);
  // The card's shared state slot carries the clog page title in
  // this view, so menu page flips and player swaps keep the
  // page the card is showing.
  const components = await compareComponents('clogs', aName, bName,
    ui.page || ui.bossKey || null, owner, ui);
  if (!pa || !pb) {
    const missing = !pa ? aName : bName;
    return {
      content: `The collection log is not synced for **${missing}** yet, so there is nothing to compare. ${CLOG_SYNC_STEPS}`,
      components,
    };
  }
  const pageTitle = ui.page && (pa[ui.page] || pb[ui.page]) ? ui.page
    : (ui.bossKey && (pa[ui.bossKey] || pb[ui.bossKey]) ? ui.bossKey : null);
  if (pageTitle) {
    const gap = pa[pageTitle] || { obtained: 0, total: 0, items: [] };
    const gbp = pb[pageTitle] || { obtained: 0, total: 0, items: [] };
    const byId = new Map();
    for (const it of gap.items || []) byId.set(it.id, { id: it.id, name: it.name, aHas: true, bHas: false });
    for (const it of gbp.items || []) {
      const held = byId.get(it.id);
      if (held) held.bHas = true;
      else byId.set(it.id, { id: it.id, name: it.name, aHas: false, bHas: true });
    }
    const all = [...byId.values()].sort((x, y) => String(x.name).localeCompare(String(y.name)));
    const shown = all.slice(0, 16);
    // Luck percentiles per player for this page's items, when
    // their counters are known (best effort: stats or plugin
    // counters missing just means no chips on the card).
    let aScores = {};
    let bScores = {};
    let fa = null;
    let fb = null;
    let sta = null;
    let stb = null;
    const tab0 = gap.tab || gbp.tab;
    if (tab0) {
      [fa, fb, sta, stb] = await Promise.all([
        getClogPageWithItems(aName, tab0, pageTitle).catch(() => null),
        getClogPageWithItems(bName, tab0, pageTitle).catch(() => null),
        getStats(aName).catch(() => null),
        getStats(bName).catch(() => null),
      ]);
      if (fa && sta && !sta.notFound) aScores = itemLuckScores(countersFor(sta, aName), fa.items || []);
      if (fb && stb && !stb.notFound) bScores = itemLuckScores(countersFor(stb, bName), fb.items || []);
    }
    const items = await Promise.all(shown.map(async (it) => {
      let iconB64 = null;
      const p = await getItemIcon(it.id, it.name).catch(() => null);
      if (p) {
        try { iconB64 = fs.readFileSync(p).toString('base64'); } catch { iconB64 = null; }
      }
      return {
        ...it, iconB64,
        aScore: aScores[it.id] != null ? aScores[it.id] : null,
        bScore: bScores[it.id] != null ? bScores[it.id] : null,
      };
    }));
    // Pets living on this page attach to the page card (Alex,
    // Oct 31, 2026): covers the activity pets with no boss or
    // skill card of their own (Bloodhound, Pet Penance Queen,
    // Lil' Creator, Chompy chick) and boss pets alike.
    let pagePets = null;
    const pageTab = tab0;
    if (pageTab) {
      const full = await getClogPageWithItems(aName, pageTab, pageTitle).catch(() => null);
      if (full && Array.isArray(full.items)) {
        const ids = await petIdSet(aName, bName);
        const found = full.items.filter((it) => ids.has(it.id));
        if (found.length) {
          const aIds = new Set((gap.items || []).map((i) => i.id));
          const bIds = new Set((gbp.items || []).map((i) => i.id));
          pagePets = await Promise.all(found.map(async (it) => ({
            name: it.name,
            aHas: aIds.has(it.id),
            bHas: bIds.has(it.id),
            icon: await petIconB64(it.id, it.name),
          })));
        }
      }
    }
    // Game-style grids (Alex, Nov 1, 2026): the whole page
    // for each player, obtained in colour and missing dark,
    // the way the in-game log shows it. Built from the full
    // page fetches above; when those fail the card service
    // falls back to the item rows.
    let grids = null;
    if (fa && fb && Array.isArray(fa.items) && Array.isArray(fb.items)) {
      const gridFor = async (full, scores) => Promise.all(
        (full.items || []).map(async (it) => {
          let icon = null;
          const p = await getItemIcon(it.id, it.name).catch(() => null);
          if (p) {
            try { icon = fs.readFileSync(p).toString('base64'); } catch { icon = null; }
          }
          return {
            icon,
            qty: it.quantity || 0,
            has: (it.quantity || 0) > 0,
            score: scores[it.id] != null ? scores[it.id] : null,
          };
        }));
      grids = {
        a: await gridFor(fa, aScores),
        b: await gridFor(fb, bScores),
      };
    }
    // The page's counter line, worded the way the in-game
    // header shows it, where that wording is known: clue
    // completions, boss kills, raid completions.
    const counterLine = (st) => {
      if (!st || st.notFound || !st.kc) return null;
      const num = (n) => n.toLocaleString('en-US');
      if (pageTab === 'Clues') {
        const tier = pageTitle.split(' ')[0];
        const n = st.kc[`clue_scrolls_${tier.toLowerCase()}`];
        return typeof n === 'number'
          ? `${tier} clues completed: ${num(n)}` : null;
      }
      const key = Object.keys(CLOG_PAGES).find(
        (k) => CLOG_PAGES[k][1] === pageTitle);
      if (!key) return null;
      const ent = kcEntry(key);
      if (!ent || ent.cols.length !== 1) return null;
      const metric = ent.cols[0].metric;
      const n = st.kc[metric];
      if (typeof n !== 'number') return null;
      if (pageTab === 'Bosses' && metric !== 'wintertodt') {
        return `${pageTitle} kills: ${num(n)}`;
      }
      if (pageTab === 'Raids') {
        return `${pageTitle} completions: ${num(n)}`;
      }
      return null;
    };
    const card = await fetchCard('/compare-clog', {
      mode: 'page', page: pageTitle,
      a: { rsn: aName, badge: cardBadgeFor(aName, sta ? sta.accountType : null), got: gap.obtained || 0, total: gap.total || gbp.total || 0 },
      b: { rsn: bName, badge: cardBadgeFor(bName, stb ? stb.accountType : null), got: gbp.obtained || 0, total: gbp.total || gap.total || 0 },
      items, moreCount: Math.max(0, all.length - shown.length),
      pets: pagePets,
      grids,
      counterA: counterLine(sta),
      counterB: counterLine(stb),
    });
    if (card) return { files: [new AttachmentBuilder(card, { name: 'compare-clog.png' })], components };
    return { content: `${pageTitle}: ${aName} ${gap.obtained || 0} - ${gbp.obtained || 0} ${bName}`, components };
  }
  const raidTitles = new Set();
  const bossTitles = new Set();
  for (const [cat, title] of Object.values(CLOG_PAGES)) {
    if (cat === 'Raids') raidTitles.add(title);
    if (cat === 'Bosses') bossTitles.add(title);
  }
  const sumGot = (pages, titles) => Object.entries(pages)
    .reduce((s, [t, p]) => s + (titles.has(t) ? (p.obtained || 0) : 0), 0);
  const totalOf = (pages) => Object.values(pages)
    .reduce((s, p) => ({ got: s.got + (p.obtained || 0), total: s.total + (p.total || 0) }), { got: 0, total: 0 });
  const ta = totalOf(pa);
  const tb = totalOf(pb);
  // Headline uses the official log totals (Alex, Oct 31, 2026):
  // page sums double-count pages that repeat items (All Pets,
  // Slayer), so they overstate the real total.
  const [sumA, sumB] = await Promise.all([
    getClogSummary(aName).catch(() => null),
    getClogSummary(bName).catch(() => null),
  ]);
  const headA = sumA && typeof sumA.obtained === 'number'
    ? { got: sumA.obtained, total: sumA.total } : ta;
  const headB = sumB && typeof sumB.obtained === 'number'
    ? { got: sumB.obtained, total: sumB.total } : tb;
  // The totals card carries the same account badges as the page
  // view. Its stats are fetched here: the page view's sta/stb are
  // scoped to that branch and do not reach this code.
  const [staT, stbT] = await Promise.all([
    getStats(aName).catch(() => null),
    getStats(bName).catch(() => null),
  ]);
  const bossA = sumGot(pa, bossTitles);
  const bossB = sumGot(pb, bossTitles);
  const raidA = sumGot(pa, raidTitles);
  const raidB = sumGot(pb, raidTitles);
  const num = (v) => v.toLocaleString('en-US');
  const row = (label, x, y) => ({
    label, aText: num(x), bText: num(y), winner: x === y ? 'tie' : (x > y ? 'a' : 'b'),
  });
  const petsA = pa['All Pets'] ? pa['All Pets'].obtained || 0 : 0;
  const petsB = pb['All Pets'] ? pb['All Pets'].obtained || 0 : 0;
  const rows = [
    {
      label: 'Collection Log',
      aText: `${num(headA.got)} / ${num(headA.total)}`,
      bText: `${num(headB.got)} / ${num(headB.total)}`,
      winner: headA.got === headB.got ? 'tie' : (headA.got > headB.got ? 'a' : 'b'),
    },
    row('Bosses', bossA, bossB),
    row('Raids', raidA, raidB),
    row('Pets', petsA, petsB),
    row('Everything Else', headA.got - bossA - raidA, headB.got - bossB - raidB),
  ];
  const diff = headA.got - headB.got;
  const tally = diff === 0
    ? 'TIED ON THE COLLECTION LOG'
    : `${(diff > 0 ? aName : bName).toUpperCase()} LEADS BY ${num(Math.abs(diff))} ITEMS`;
  const card = await fetchCard('/compare-clog', {
    mode: 'totals', a: { rsn: aName, badge: cardBadgeFor(aName, staT ? staT.accountType : null) }, b: { rsn: bName, badge: cardBadgeFor(bName, stbT ? stbT.accountType : null) }, rows, tally,
  });
  if (card) return { files: [new AttachmentBuilder(card, { name: 'compare-clog.png' })], components };
  return { content: tally, components };
}

// Compare menus group bosses by type, alphabetical inside each type
// Category order is Alex's (Nov 1, 2026): Raids first, then
// Bosses, Skilling bosses, Slayer bosses. The catalog is the
// canonical metric-deduped boss list, keeping only bosses the
// clan has KC on.
const CMP_CATEGORIES = [
  { id: 'raids', label: 'Raids' },
  { id: 'solo', label: 'Bosses' },
  { id: 'skilling', label: 'Skilling bosses' },
  { id: 'slayer', label: 'Slayer bosses' },
];
const CMP_RAID_KEYS = new Set(['toa', 'toa_expert', 'cox', 'cox_cm', 'tob', 'tob_hard', 'fractured_archive', 'tfa']);
const CMP_SLAYER_KEYS = new Set(['sire', 'hydra', 'cerberus', 'kraken', 'thermy', 'grotesque_guardians']);
const CMP_SKILLING_KEYS = new Set(['wintertodt', 'gotr', 'tempoross', 'zalcano']);
const CMP_PAGE_SIZE = 22;

// The Raids category lists four combined entries (Alex, Oct 31,
// 2026): variants fold into one entry each, and The Fractured
// Archive is listed even at zero clan KC. Picking a multi-variant
// entry opens a combined card (per-variant kills + differences).
const CMP_RAID_COMBINED = [
  { key: 'fractured_archive', name: 'The Fractured Archive' },
  { key: 'toa', name: 'Tombs of Amascut' },
  { key: 'cox', name: 'Chambers of Xeric' },
  { key: 'tob', name: 'Theatre of Blood' },
];
const CMP_RAID_MEMBER_KEYS = new Set(['toa', 'toa_expert', 'cox', 'cox_cm',
  'tob', 'tob_hard', 'fractured_archive', 'tfa']);

// Non-raid bosses folded into one picker entry the same way
// (Alex, Nov 1, 2026): the Gauntlet pair and the wilderness
// pairs. One entry opens a combined card over both columns
// instead of listing the halves separately (or, for ToA's
// alias keys, leaking a second entry into Solo).
const CMP_COMBINED_EXTRA = [
  { key: 'gauntlet', name: 'The Gauntlet', cat: 'solo' },
  { key: 'callisto', name: 'Callisto and Artio', cat: 'solo' },
  { key: 'venenatis', name: 'Venenatis and Spindel', cat: 'solo' },
  { key: 'vetion', name: "Vet'ion and Calvar'ion", cat: 'solo' },
];
const CMP_COMBINED_EXTRA_KEYS = new Set(['gauntlet', 'cg', 'callisto',
  'venenatis', 'vetion']);
const CMP_COMBINED_BASE_METRIC = { callisto: 'callisto',
  venenatis: 'venenatis', vetion: 'vetion' };

function combinedDef(key) {
  return CMP_RAID_COMBINED.find((r) => r.key === key)
    || CMP_COMBINED_EXTRA.find((r) => r.key === key) || null;
}

function raidColLabel(col) {
  if (col.label) return col.label;
  if (col.metric.endsWith('_expert')) return 'Expert';
  if (col.metric.endsWith('_challenge_mode')) return 'Challenge Mode';
  if (col.metric.endsWith('_hard_mode')) return 'Hard Mode';
  return 'Normal';
}

function compareCategoryOf(key) {
  if (CMP_RAID_KEYS.has(key)) return 'raids';
  if (CMP_SLAYER_KEYS.has(key)) return 'slayer';
  if (CMP_SKILLING_KEYS.has(key)) return 'skilling';
  return 'solo';
}

let bossCatalogCache = { at: 0, byCat: null, top: null };
function bossCatalog() {
  if (bossCatalogCache.byCat && Date.now() - bossCatalogCache.at < 10 * 60 * 1000) {
    return bossCatalogCache;
  }
  const byMetric = new Map();
  for (const key of Object.keys(KC_KEYS)) {
    if (CMP_RAID_MEMBER_KEYS.has(key)) continue; // raids built below
    if (CMP_COMBINED_EXTRA_KEYS.has(key)) continue; // folded below
    const entry = kcEntry(key);
    if (!entry || !entry.cols || !entry.cols.length) continue;
    const variantKey = key === 'cg' || /(_expert|_cm|_hard)$/.test(key);
    const col = entry.cols.length > 1 && variantKey
      ? entry.cols[entry.cols.length - 1] : entry.cols[0];
    if (byMetric.has(col.metric)) continue;
    if (NON_KC_SCORES.has(col.metric)) continue;
    // Raid alias keys (tombs, tombs_of_amascut) resolve to a
    // raid metric: the raid's combined entry already covers
    // them, so they must not leak into Solo as a second entry.
    if (RAID_METRICS.includes(col.metric)) continue;
    let total = 0;
    try { for (const row of kcStandings(col.metric)) total += row.kc; } catch { /* cache only */ }
    if (total > 0) byMetric.set(col.metric, { key, name: entry.name, total });
  }
  const byCat = { raids: [], slayer: [], solo: [], skilling: [] };
  let top = null;
  for (const item of byMetric.values()) {
    if (!top || item.total > top.total) top = item;
    byCat[compareCategoryOf(item.key)].push(item);
  }
  for (const r of CMP_RAID_COMBINED) {
    const entry = kcEntry(r.key);
    if (!entry || !entry.cols || !entry.cols.length) continue;
    let total = 0;
    for (const col of entry.cols) {
      try { for (const row of kcStandings(col.metric)) total += row.kc; } catch { /* cache only */ }
    }
    byCat.raids.push({ key: r.key, name: r.name, total });
  }
  for (const r of CMP_COMBINED_EXTRA) {
    const entry = kcEntry(r.key);
    if (!entry || !entry.cols || !entry.cols.length) continue;
    let total = 0;
    for (const col of entry.cols) {
      try { for (const row of kcStandings(col.metric)) total += row.kc; } catch { /* cache only */ }
    }
    byCat[r.cat].push({ key: r.key, name: r.name, total });
  }
  for (const list of Object.values(byCat)) {
    list.sort((x, y) => String(x.name).localeCompare(String(y.name)));
  }
  bossCatalogCache = { at: Date.now(), byCat, top: top ? top.key : null };
  return bossCatalogCache;
}

// getClogPages wraps its result ({ pages: { title: { obtained,
// total, items } } }); unwrap to the page map or null.
async function clogPagesOf(name) {
  const wrap = await getClogPages(name).catch(() => null);
  return wrap && wrap.pages ? wrap.pages : null;
}

// The compare clog picker mirrors the in-game collection log
// (Alex, Nov 1, 2026): pick a tab first, then a page inside
// it, A to Z like the game. Bosses and Raids are NOT listed:
// those pages live under the Boss view, whose cards carry
// their kills and log strips. Only pages either player has
// progress on are listed. Select menus cap at 25 options, so
// a long tab pages inside itself the same way the boss list
// does.
const CLOG_TABS = [
  { id: 'bosses', label: 'Bosses' },
  { id: 'raids', label: 'Raids' },
  { id: 'clues', label: 'Clues' },
  { id: 'minigames', label: 'Minigames' },
  { id: 'other', label: 'Other' },
];
const CMP_CLOG_PAGE_SIZE = 22;

async function clogPickerData(a, b) {
  const [pa, pb] = await Promise.all([clogPagesOf(a), clogPagesOf(b)]);
  if (!pa || !pb) return null;
  const got = new Map();
  for (const pages of [pa, pb]) {
    for (const [title, page] of Object.entries(pages)) {
      const cur = got.get(title) || { got: 0, tab: page.tab || 'Other' };
      cur.got += page.obtained || 0;
      got.set(title, cur);
    }
  }
  const byTab = new Map(CLOG_TABS.map((t) => [t.id, []]));
  for (const [title, info] of got) {
    if (info.got <= 0) continue;
    // Boss and raid pages live under the Boss view (Alex,
    // Nov 1, 2026): the Boss cards already carry their kills
    // and log strips, so the Clogs picker is non-boss pages
    // only: Clues, Minigames, Other.
    if (info.tab === 'Bosses' || info.tab === 'Raids') continue;
    const tabId = CLOG_TABS.some((t) => t.label === info.tab)
      ? info.tab.toLowerCase() : 'other';
    byTab.get(tabId).push(title);
  }
  for (const list of byTab.values()) {
    list.sort((x, y) => x.localeCompare(y));
  }
  // The game's Clues list is not A to Z (Alex, Nov 1, 2026):
  // tiers run Beginner to Master, then the (Rare) pages, then
  // the shared pages. Match that order in the menu.
  const clueOrder = [
    'Beginner Treasure Trails', 'Easy Treasure Trails',
    'Medium Treasure Trails', 'Hard Treasure Trails',
    'Elite Treasure Trails', 'Master Treasure Trails',
    'Hard Treasure Trails (Rare)', 'Elite Treasure Trails (Rare)',
    'Master Treasure Trails (Rare)', 'Shared Treasure Trail Rewards',
    'Scroll Cases',
  ];
  byTab.get('clues').sort((x, y) => {
    const ix = clueOrder.indexOf(x);
    const iy = clueOrder.indexOf(y);
    return (ix === -1 ? 99 : ix) - (iy === -1 ? 99 : iy)
      || x.localeCompare(y);
  });
  return byTab;
}

async function compareComponents(view, a, b, bossKey, ownerId, ui = {}) {
  const enc = encodePair(a, b, ownerId);
  const viewBtn = (v, label) => new ButtonBuilder()
    .setCustomId(`cmp:${v}:${bossKey || '-'}:${enc}`)
    .setLabel(label)
    .setStyle(view === v ? ButtonStyle.Danger : ButtonStyle.Secondary)
    .setDisabled(view === v);
  const swapBtn = new ButtonBuilder()
    .setCustomId(`cmpswap:${view}:${bossKey || '-'}:${enc}`)
    .setLabel('Change players')
    .setStyle(ButtonStyle.Secondary);
  // The Boss button lands on the boss base page (totals first);
  // picking a boss from its menus drills into that boss.
  const bossBtn = new ButtonBuilder()
    .setCustomId(`cmp:bossbase:${bossKey || '-'}:${enc}`)
    .setLabel('PvM')
    // The PvM tab covers both PvM views, so it lights on a boss
    // card too. It stays clickable there: pressing it is how you
    // get back to the base page.
    .setStyle(view === 'bossbase' || view === 'boss' ? ButtonStyle.Danger : ButtonStyle.Secondary)
    .setDisabled(view === 'bossbase');
  const rows = [new ActionRowBuilder().addComponents(
    viewBtn('overall', 'Overall'), bossBtn,
    viewBtn('skills', 'Skills'), viewBtn('clogs', 'Clogs'), swapBtn)];
  if (view === 'skills') {
    const options = [{ label: 'All skills', value: 'all' }];
    for (const key of [...SKILL_ORDER].sort((x, y) => x.localeCompare(y))) {
      options.push({ label: key.charAt(0).toUpperCase() + key.slice(1), value: key });
    }
    rows.push(new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(`cmpskill:${enc}`)
        .setPlaceholder('Pick a skill...')
        .addOptions(options.slice(0, 25))));
  } else if (view === 'boss' || view === 'bossbase') {
    const catalog = bossCatalog();
    const cat = ui.cat && catalog.byCat[ui.cat] ? ui.cat : null;
    if (!cat) {
      const cats = CMP_CATEGORIES.filter((c) => catalog.byCat[c.id].length);
      if (cats.length) {
        rows.push(new ActionRowBuilder().addComponents(
          new StringSelectMenuBuilder()
            .setCustomId(`cmpboss:menu:${enc}`)
            .setPlaceholder('Pick a category...')
            .addOptions(cats.map((c) => ({ label: c.label, value: `cat:${c.id}` })))));
      }
    } else {
      const list = catalog.byCat[cat];
      const page = Math.max(0, Math.min(ui.catPage || 0,
        Math.ceil(list.length / CMP_PAGE_SIZE) - 1));
      const slice = list.slice(page * CMP_PAGE_SIZE, page * CMP_PAGE_SIZE + CMP_PAGE_SIZE);
      const options = [{ label: '← All categories', value: 'back' }];
      if (page > 0) options.push({ label: '← Previous bosses', value: `page:${page - 1}` });
      for (const o of slice) options.push({ label: String(o.name).slice(0, 100), value: o.key });
      if ((page + 1) * CMP_PAGE_SIZE < list.length) {
        options.push({ label: 'More bosses →', value: `page:${page + 1}` });
      }
      const catLabel = (CMP_CATEGORIES.find((c) => c.id === cat) || {}).label || 'Bosses';
      rows.push(new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(`cmpboss:list:${cat}:${page}:${enc}`)
          .setPlaceholder(`Pick a boss (${catLabel})...`)
          .addOptions(options)));
    }
  } else if (view === 'clogs') {
    const byTab = await clogPickerData(a, b);
    if (byTab) {
      const tab = CLOG_TABS.find(
        (t) => t.id === ui.clogTab && byTab.get(t.id).length) || null;
      if (!tab) {
        const tabs = CLOG_TABS.filter((t) => byTab.get(t.id).length);
        if (tabs.length) {
          rows.push(new ActionRowBuilder().addComponents(
            new StringSelectMenuBuilder()
              .setCustomId(`cmpclog:menu:${enc}`)
              .setPlaceholder('Pick a tab...')
              .addOptions(tabs.map((t) => ({
                label: t.label,
                value: `tab:${t.id}`,
                description: `${byTab.get(t.id).length} pages`,
              })))));
        }
      } else {
        const list = byTab.get(tab.id);
        const page = Math.max(0, Math.min(ui.clogPage || 0,
          Math.ceil(list.length / CMP_CLOG_PAGE_SIZE) - 1));
        const slice = list.slice(page * CMP_CLOG_PAGE_SIZE,
          page * CMP_CLOG_PAGE_SIZE + CMP_CLOG_PAGE_SIZE);
        const options = [{ label: '← All tabs', value: 'back' }];
        if (page > 0) {
          options.push({ label: '← Previous pages', value: `page:${page - 1}` });
        }
        for (const title of slice) {
          options.push({
            label: String(title).slice(0, 100),
            value: String(title).slice(0, 100),
          });
        }
        if ((page + 1) * CMP_CLOG_PAGE_SIZE < list.length) {
          options.push({ label: 'More pages →', value: `page:${page + 1}` });
        }
        rows.push(new ActionRowBuilder().addComponents(
          new StringSelectMenuBuilder()
            .setCustomId(`cmpclog:list:${tab.id}:${page}:${enc}`)
            .setPlaceholder(`Pick a page (${tab.label})...`)
            .addOptions(options)));
      }
    }
  }
  // Quick picks: the owner's other saved RSNs (from /link), one tap to
  // swap their own side of the compare without typing.
  if (ownerId) {
    const saved = savedRsnsFor(ownerId);
    const inPair = new Set([normName(a), normName(b)]);
    const alts = saved.filter((r) => !inPair.has(normName(r))).slice(0, 5);
    if (alts.length) {
      rows.push(new ActionRowBuilder().addComponents(alts.map((alt) => new ButtonBuilder()
        .setCustomId(`cmpalt:${view}:${bossKey || '-'}:${saved.indexOf(alt)}:${enc}`)
        .setLabel(String(alt).slice(0, 80))
        .setStyle(ButtonStyle.Secondary))));
    }
  }
  return rows;
}

function savedRsnsFor(userId) {
  const entry = loadRsnLinks()[userId];
  if (!entry || typeof entry !== 'object') return [];
  if (Array.isArray(entry.rsns)) return entry.rsns.filter((r) => typeof r === 'string' && r);
  return typeof entry.rsn === 'string' && entry.rsn ? [entry.rsn] : [];
}

async function compareViewRender(view, bossKey, a, b, owner) {
  if (view === 'skills') return compareSkillsPayload(a, b, null, owner, { bossKey });
  if (view === 'clogs') return compareClogsPayload(a, b, null, owner, { bossKey });
  if (view === 'bossbase') return compareBossBasePayload(a, b, null, owner, { bossKey });
  if (view === 'boss') {
    const key = bossKey && KC_KEYS[bossKey] ? bossKey : bossCatalog().top;
    if (key) return compareBossPayload(key, a, b, null, owner, { cat: compareCategoryOf(key) });
  }
  return compareOverallPayload(a, b, null, owner, { bossKey });
}

// The card's own state (current view + boss) lives on its Change
// players button; select handlers read it back so a menu pick keeps
// the boss the card was showing.
function compareStateOf(interaction) {
  const rows = (interaction.message && interaction.message.components) || [];
  for (const row of rows) {
    for (const comp of row.components || []) {
      const id = comp.customId || '';
      if (id.startsWith('cmpswap:')) {
        const [, view, bossKey] = id.split(':');
        return { view, bossKey: bossKey && bossKey !== '-' ? bossKey : null };
      }
    }
  }
  return { view: null, bossKey: null };
}

async function handleCompareSwapButton(interaction) {
  const [, view, bossKey, enc] = interaction.customId.split(':');
  const pair = decodePair(enc);
  if (!pair) {
    await interaction.reply({ content: 'That compare card has expired. Run the command again.', ephemeral: true }).catch(() => {});
    return;
  }
  if (!await compareOwnerGate(interaction, pair, { view, bossKey, enc })) return;
  const input = (id, label, value) => new ActionRowBuilder().addComponents(
    new TextInputBuilder().setCustomId(id).setLabel(label)
      .setStyle(TextInputStyle.Short).setRequired(true)
      .setMaxLength(12).setValue(value));
  const modal = new ModalBuilder()
    .setCustomId(`cmpmodal:${view}:${bossKey}:${enc}`)
    .setTitle('Change players')
    .addComponents(
      input('player_a', 'Player A', pair.a),
      input('player_b', 'Player B', pair.b));
  await interaction.showModal(modal).catch(() => {});
}

async function handleCompareSwapModal(interaction) {
  const [, view, bossKey, enc] = interaction.customId.split(':');
  const pair = decodePair(enc);
  if (!pair) {
    await interaction.reply({ content: 'That compare card has expired. Run the command again.', ephemeral: true }).catch(() => {});
    return;
  }
  if (!await compareOwnerGate(interaction, pair)) return;
  const na = interaction.fields.getTextInputValue('player_a').trim();
  const nb = interaction.fields.getTextInputValue('player_b').trim();
  if (!RSN_RE.test(na) || !RSN_RE.test(nb) || normName(na) === normName(nb)) {
    await interaction.reply({ content: 'Those names do not work. Use two different RuneScape names.', ephemeral: true }).catch(() => {});
    return;
  }
  await interaction.deferUpdate().catch(() => {});
  const payload = await compareViewRender(view, bossKey === '-' ? null : bossKey, na, nb, pair.owner);
  if (!payload || !payload.files) {
    await interaction.followUp({ content: (payload && payload.content) || 'Could not load those players.', ephemeral: true }).catch(() => {});
    return;
  }
  await editCompareMessage(interaction, payload);
}

async function handleCompareAltButton(interaction) {
  const [, view, bossKey, idxRaw, enc] = interaction.customId.split(':');
  const pair = decodePair(enc);
  if (!pair) {
    await interaction.reply({ content: 'That compare card has expired. Run the command again.', ephemeral: true }).catch(() => {});
    return;
  }
  if (!await compareOwnerGate(interaction, pair)) return;
  const saved = savedRsnsFor(interaction.user.id);
  const alt = saved[Number(idxRaw)];
  if (!alt) {
    await interaction.reply({ content: 'That saved name is not on your link anymore.', ephemeral: true }).catch(() => {});
    return;
  }
  const mine = new Set(saved.map((r) => normName(r)));
  let a = pair.a;
  let b = pair.b;
  if (mine.has(normName(a))) a = alt;
  else if (mine.has(normName(b))) b = alt;
  else a = alt;
  if (normName(a) === normName(b)) {
    await interaction.reply({ content: 'That account is already in this compare.', ephemeral: true }).catch(() => {});
    return;
  }
  await interaction.deferUpdate().catch(() => {});
  const payload = await compareViewRender(view, bossKey === '-' ? null : bossKey, a, b, pair.owner);
  await editCompareMessage(interaction, payload);
}

async function editCompareMessage(interaction, payload) {
  if (!payload || (!payload.files && !payload.content)) {
    await interaction.followUp({ content: 'That view is not available right now.', ephemeral: true }).catch(() => {});
    return;
  }
  const edit = { ...payload, attachments: [] };
  if (!payload.components) edit.components = [];
  delete edit.ephemeral;
  await interaction.editReply(edit).catch(() => {});
}

// View controls on a compare card are open to everyone (Alex,
// Nov 1, 2026): the card is a shared surface in the channel. Only
// the controls that change who is being compared (Change players,
// alt-account buttons) stay with the member who ran the compare.
// Cards posted before owner ids existed carry no owner and stay open.
async function compareOwnerGate(interaction, pair, offer) {
  if (pair.owner && interaction.user.id !== pair.owner) {
    if (offer) {
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`cmpmine:${offer.view}:${offer.bossKey || '-'}:${offer.enc}`)
          .setLabel('Make my own')
          .setStyle(ButtonStyle.Danger));
      await interaction.reply({
        content: "You can't change the players on this one. Would you like to make your own card?",
        components: [row],
        ephemeral: true,
      }).catch(() => {});
    } else {
      await interaction.reply({ content: 'That is not your compare card. Run /compare to make your own.', ephemeral: true }).catch(() => {});
    }
    return false;
  }
  return true;
}

// The Make my own button on the not-your-card note: posts the same
// matchup in the channel as the presser's own compare card, opened
// on the view the original card was showing.
async function handleCompareMineButton(interaction) {
  const [, view, bossKey, enc] = interaction.customId.split(':');
  const pair = decodePair(enc);
  if (!pair) {
    await interaction.reply({ content: 'That compare card has expired. Run the command again.', ephemeral: true }).catch(() => {});
    return;
  }
  const payload = await compareViewRender(view, bossKey === '-' ? null : bossKey, pair.a, pair.b, interaction.user.id);
  if (!payload || !payload.files) {
    await interaction.update({ content: (payload && payload.content) || 'Could not load those players.', components: [] }).catch(() => {});
    return;
  }
  const post = { files: payload.files, components: payload.components || [] };
  if (payload.content) post.content = payload.content;
  const sent = interaction.channel
    ? await interaction.channel.send(post).catch(() => null) : null;
  if (sent) {
    await interaction.update({ content: 'Your card is posted in the channel.', components: [] }).catch(() => {});
  } else {
    await interaction.update({ ...post, attachments: [] }).catch(() => {});
  }
}

async function handleCompareButton(interaction) {
  const parts = interaction.customId.split(':');
  const view = parts[1];
  const bossSeg = parts.length >= 4 ? parts[2] : '-';
  const pair = decodePair(parts[parts.length - 1]);
  if (!pair || !['overall', 'skills', 'boss', 'bossbase', 'clogs'].includes(view)) {
    await interaction.reply({ content: 'That compare card has expired. Run the command again.', ephemeral: true }).catch(() => {});
    return;
  }
  await interaction.deferUpdate().catch(() => {});
  const bossKey = bossSeg && bossSeg !== '-' && KC_KEYS[bossSeg] ? bossSeg : null;
  await editCompareMessage(interaction,
    await compareViewRender(view, bossKey, pair.a, pair.b, pair.owner));
}

async function handleCompareBossSelect(interaction) {
  const parts = interaction.customId.split(':');
  const value = interaction.values && interaction.values[0];
  // Legacy cards: cmpboss:<enc>, and the value is a boss key.
  if (parts.length === 2) {
    const pair = decodePair(parts[1]);
    if (!pair) {
      await interaction.reply({ content: 'That compare card has expired. Run the command again.', ephemeral: true }).catch(() => {});
      return;
    }
    if (!value || !KC_KEYS[value]) return;
    await interaction.deferUpdate().catch(() => {});
    await editCompareMessage(interaction, await compareBossPayload(
      value, pair.a, pair.b, null, pair.owner, { cat: compareCategoryOf(value) }));
    return;
  }
  const pair = decodePair(parts[parts.length - 1]);
  if (!pair) {
    await interaction.reply({ content: 'That compare card has expired. Run the command again.', ephemeral: true }).catch(() => {});
    return;
  }
  if (!value) return;
  const state = compareStateOf(interaction);
  const current = state.bossKey && KC_KEYS[state.bossKey] ? state.bossKey : bossCatalog().top;
  const onBase = state.view === 'bossbase';
  await interaction.deferUpdate().catch(() => {});
  if (parts[1] === 'menu') {
    const cat = value.startsWith('cat:') ? value.slice(4) : null;
    if (onBase) {
      await editCompareMessage(interaction, await compareBossBasePayload(
        pair.a, pair.b, null, pair.owner,
        { cat: cat || null, catPage: 0, bossKey: state.bossKey }));
      return;
    }
    await editCompareMessage(interaction, await compareBossPayload(
      current, pair.a, pair.b, null, pair.owner,
      { cat: cat || compareCategoryOf(current), catPage: 0 }));
    return;
  }
  // cmpboss:list:<cat>:<page>:<enc>
  const cat = parts[2];
  const page = parseInt(parts[3], 10) || 0;
  if (value === 'back') {
    if (onBase) {
      await editCompareMessage(interaction, await compareBossBasePayload(
        pair.a, pair.b, null, pair.owner, { cat: null, bossKey: state.bossKey }));
    } else {
      await editCompareMessage(interaction, await compareBossPayload(
        current, pair.a, pair.b, null, pair.owner, { cat: null }));
    }
  } else if (value.startsWith('page:')) {
    const nextPage = parseInt(value.slice(5), 10) || 0;
    if (onBase) {
      await editCompareMessage(interaction, await compareBossBasePayload(
        pair.a, pair.b, null, pair.owner,
        { cat, catPage: nextPage, bossKey: state.bossKey }));
    } else {
      await editCompareMessage(interaction, await compareBossPayload(
        current, pair.a, pair.b, null, pair.owner,
        { cat, catPage: nextPage }));
    }
  } else if (KC_KEYS[value]) {
    await editCompareMessage(interaction, await compareBossPayload(
      value, pair.a, pair.b, null, pair.owner, { cat, catPage: page }));
  }
}

async function handleCompareSkillSelect(interaction) {
  const pair = decodePair(interaction.customId.slice('cmpskill:'.length));
  if (!pair) {
    await interaction.reply({ content: 'That compare card has expired. Run the command again.', ephemeral: true }).catch(() => {});
    return;
  }
  const value = interaction.values && interaction.values[0];
  if (!value) return;
  const state = compareStateOf(interaction);
  await interaction.deferUpdate().catch(() => {});
  await editCompareMessage(interaction, await compareSkillsPayload(
    pair.a, pair.b, null, pair.owner,
    { bossKey: state.bossKey, skill: value === 'all' ? null : value }));
}

async function handleCompareClogSelect(interaction) {
  const parts = interaction.customId.split(':');
  const kind = parts[1];
  // Legacy cards: cmpclog:<enc>. Current: cmpclog:menu:<enc>
  // and cmpclog:list:<tab>:<page>:<enc>.
  const pair = decodePair(kind === 'menu' || kind === 'list'
    ? parts[parts.length - 1] : parts.slice(1).join(':'));
  if (!pair) {
    await interaction.reply({ content: 'That compare card has expired. Run the command again.', ephemeral: true }).catch(() => {});
    return;
  }
  const value = interaction.values && interaction.values[0];
  if (!value) return;
  const state = compareStateOf(interaction);
  await interaction.deferUpdate().catch(() => {});
  if (kind === 'menu') {
    const tab = value.startsWith('tab:') ? value.slice(4) : null;
    await editCompareMessage(interaction, await compareClogsPayload(
      pair.a, pair.b, null, pair.owner,
      { bossKey: state.bossKey, clogTab: tab, clogPage: 0 }));
    return;
  }
  if (kind === 'list') {
    const tab = parts[2];
    const menuPage = parseInt(parts[3], 10) || 0;
    if (value === 'back') {
      await editCompareMessage(interaction, await compareClogsPayload(
        pair.a, pair.b, null, pair.owner,
        { bossKey: state.bossKey, clogTab: null, clogPage: 0 }));
    } else if (value.startsWith('page:')) {
      // Menu page flip inside the tab: same card, new slice.
      await editCompareMessage(interaction, await compareClogsPayload(
        pair.a, pair.b, null, pair.owner,
        { bossKey: state.bossKey, clogTab: tab,
          clogPage: parseInt(value.slice(5), 10) || 0 }));
    } else {
      await editCompareMessage(interaction, await compareClogsPayload(
        pair.a, pair.b, null, pair.owner,
        { bossKey: state.bossKey, page: value,
          clogTab: tab, clogPage: menuPage }));
    }
    return;
  }
  await editCompareMessage(interaction, await compareClogsPayload(
    pair.a, pair.b, null, pair.owner, { bossKey: state.bossKey, page: value }));
}

// Shared name resolution for the compare commands: each name box is
// optional and defaults to the caller's linked RSN (one filled box
// compares that player against the caller). Returns { a, b } or null
// after replying with the problem.
async function resolveComparePair(interaction) {
  const uid = interaction.user.id;
  const aOpt = interaction.options.getString('player_a');
  const bOpt = interaction.options.getString('player_b');
  const aRes = resolveNameFor(uid, aOpt);
  if (aRes.error) { await interaction.reply({ content: aRes.error, ephemeral: true }).catch(() => {}); return null; }
  if (aRes.payload) { await interaction.reply({ ...aRes.payload, ephemeral: true }).catch(() => {}); return null; }
  const bRes = bOpt ? resolveNameFor(uid, bOpt) : (aOpt ? resolveNameFor(uid, null) : aRes);
  if (bRes.error) { await interaction.reply({ content: bRes.error, ephemeral: true }).catch(() => {}); return null; }
  if (bRes.payload) { await interaction.reply({ ...bRes.payload, ephemeral: true }).catch(() => {}); return null; }
  if (normName(aRes.rsn) === normName(bRes.rsn)) {
    await interaction.reply({ content: 'Pick two different players to compare.', ephemeral: true }).catch(() => {});
    return null;
  }
  const gate = ownAccountGate(uid, aRes.rsn) || ownAccountGate(uid, bRes.rsn);
  if (gate) { await interaction.reply({ ...gate, ephemeral: true }).catch(() => {}); return null; }
  return { a: aRes.rsn, b: bRes.rsn };
}

const commands = [
  {
    data: new SlashCommandBuilder()
      .setName('kc')
      .setDescription("Show a player's boss kill count card")
      .addStringOption((o) => o.setName('activity').setDescription('Which boss or activity').setRequired(true).setAutocomplete(true))
      .addStringOption((o) => o.setName('player').setDescription('RuneScape name (blank = you)')),
    run: async (interaction) => {
      const { rsn, error, payload } = resolveNameFor(interaction.user.id, interaction.options.getString('player'));
      if (error) { await interaction.reply({ content: error, ephemeral: true }).catch(() => {}); return; }
      if (payload) { await interaction.reply({ ...payload, ephemeral: true }).catch(() => {}); return; }
      if (await slashCooldown(interaction, 'player')) return;
      await slashReply(interaction, kcPayload(interaction.options.getString('activity'), rsn, interaction.user.id));
    },
  },
  {
    data: new SlashCommandBuilder()
      .setName('clog')
      .setDescription("Show a player's collection log card")
      .addStringOption((o) => o.setName('activity').setDescription('Which page, or the whole log').setRequired(true).setAutocomplete(true))
      .addStringOption((o) => o.setName('player').setDescription('RuneScape name (blank = you)')),
    run: async (interaction) => {
      const { rsn, error, payload } = resolveNameFor(interaction.user.id, interaction.options.getString('player'));
      if (error) { await interaction.reply({ content: error, ephemeral: true }).catch(() => {}); return; }
      if (payload) { await interaction.reply({ ...payload, ephemeral: true }).catch(() => {}); return; }
      if (await slashCooldown(interaction, 'player')) return;
      await slashReply(interaction, clogPayload(interaction.options.getString('activity'), rsn, interaction.user.id));
    },
  },
  {
    data: new SlashCommandBuilder()
      .setName('profile')
      .setDescription("Show a player's profile card")
      .addStringOption((o) => o.setName('player').setDescription('RuneScape name (blank = you)')),
    run: async (interaction) => {
      const { rsn, error, payload } = resolveNameFor(interaction.user.id, interaction.options.getString('player'));
      if (error) { await interaction.reply({ content: error, ephemeral: true }).catch(() => {}); return; }
      if (payload) { await interaction.reply({ ...payload, ephemeral: true }).catch(() => {}); return; }
      if (await slashCooldown(interaction, 'player')) return;
      await slashReply(interaction, profilePayload(rsn, interaction.user.id));
    },
  },
  {
    data: new SlashCommandBuilder()
      .setName('compare')
      .setDescription('Compare two players overall')
      .addStringOption((o) => o.setName('player_a').setDescription('First player (blank = you)'))
      .addStringOption((o) => o.setName('player_b').setDescription('Second player (blank = you)')),
    run: async (interaction) => {
      const pair = await resolveComparePair(interaction);
      if (!pair) return;
      if (await slashCooldown(interaction, 'player_b')) return;
      await slashReply(interaction, compareOverallPayload(pair.a, pair.b, interaction.user.id));
    },
  },
  {
    data: new SlashCommandBuilder()
      .setName('skills')
      .setDescription("Show a player's skill levels card")
      .addStringOption((o) => o.setName('player').setDescription('RuneScape name (blank = you)'))
      .addStringOption((o) => o.setName('skill').setDescription('One skill on its own card (blank = all skills)').setAutocomplete(true)),
    run: async (interaction) => {
      const { rsn, error, payload } = resolveNameFor(interaction.user.id, interaction.options.getString('player'));
      if (error) { await interaction.reply({ content: error, ephemeral: true }).catch(() => {}); return; }
      if (payload) { await interaction.reply({ ...payload, ephemeral: true }).catch(() => {}); return; }
      if (await slashCooldown(interaction, 'skill')) return;
      const skFold = String(interaction.options.getString('skill') || '').toLowerCase().replace(/[^a-z]/g, '');
      const skill = skFold ? (SKILL_ALIASES[skFold] || (SKILL_ORDER.includes(skFold) ? skFold : null)) : null;
      await slashReply(interaction, skill
        ? skillPayload(rsn, skill, interaction.user.id)
        : skillsPayload(rsn, interaction.user.id));
    },
  },
  {
    data: new SlashCommandBuilder()
      .setName('pb')
      .setDescription("Show a player's personal best times from the clan plugin")
      .addStringOption((o) => o.setName('activity').setDescription('One boss (leave empty for all of them)').setAutocomplete(true))
      .addStringOption((o) => o.setName('player').setDescription('RuneScape name (blank = you)')),
    run: async (interaction) => {
      const { rsn, error, payload } = resolveNameFor(interaction.user.id, interaction.options.getString('player'));
      if (error) { await interaction.reply({ content: error, ephemeral: true }).catch(() => {}); return; }
      if (payload) { await interaction.reply({ ...payload, ephemeral: true }).catch(() => {}); return; }
      if (await slashCooldown(interaction, 'player')) return;
      await slashReply(interaction, pbPayload(interaction.options.getString('activity'), rsn, interaction.user.id));
    },
  },
  {
    data: new SlashCommandBuilder()
      .setName('gains')
      .setDescription("Show a player's XP and KC gains")
      .addStringOption((o) => o.setName('player').setDescription('RuneScape name (blank = you)'))
      .addStringOption((o) => o.setName('period').setDescription('How far back to compare')
        .addChoices(
          { name: 'Last day', value: 'day' },
          { name: 'Last week', value: 'week' },
          { name: 'Last month', value: 'month' },
          { name: 'Last year', value: 'year' })),
    run: async (interaction) => {
      const { rsn, error, payload } = resolveNameFor(interaction.user.id, interaction.options.getString('player'));
      if (error) { await interaction.reply({ content: error, ephemeral: true }).catch(() => {}); return; }
      if (payload) { await interaction.reply({ ...payload, ephemeral: true }).catch(() => {}); return; }
      if (await slashCooldown(interaction, 'period')) return;
      await slashReply(interaction, gainsPayload(rsn, interaction.options.getString('period') || 'week', interaction.user.id));
    },
  },
  {
    data: new SlashCommandBuilder()
      .setName('dry')
      .setDescription("Check a player's drop luck on one boss")
      .addStringOption((o) => o.setName('activity').setDescription('Boss to check').setAutocomplete(true).setRequired(true))
      .addStringOption((o) => o.setName('player').setDescription('RuneScape name (blank = you)')),
    run: async (interaction) => {
      const { rsn, error, payload } = resolveNameFor(interaction.user.id, interaction.options.getString('player'));
      if (error) { await interaction.reply({ content: error, ephemeral: true }).catch(() => {}); return; }
      if (payload) { await interaction.reply({ ...payload, ephemeral: true }).catch(() => {}); return; }
      if (await slashCooldown(interaction, 'player')) return;
      await slashReply(interaction, dryPayload(interaction.options.getString('activity'), rsn, interaction.user.id));
    },
  },
  {
    data: new SlashCommandBuilder()
      .setName('tfa')
      .setDescription("Show a player's Fractured Archive card")
      .addStringOption((o) => o.setName('player').setDescription('RuneScape name (blank = you)')),
    run: async (interaction) => {
      const { rsn, error, payload } = resolveNameFor(interaction.user.id, interaction.options.getString('player'));
      if (error) { await interaction.reply({ content: error, ephemeral: true }).catch(() => {}); return; }
      if (payload) { await interaction.reply({ ...payload, ephemeral: true }).catch(() => {}); return; }
      if (await slashCooldown(interaction, 'player')) return;
      await slashReply(interaction, kcPayload('tfa', rsn, interaction.user.id));
    },
  },
  {
    data: new SlashCommandBuilder()
      .setName('leaderboard')
      .setDescription('Clan leaderboards: total XP, boss KC, skills, collection log, gains')
      .addStringOption((o) => o.setName('board')
        .setDescription('Jump straight to a board: a boss, skill, or collection log page')
        .setAutocomplete(true)
        .setRequired(false)),
    run: async (interaction) => {
      if (await slashCooldown(interaction, 'board')) return;
      await slashReply(interaction, leaderboardPayload(interaction.user.id,
        interaction.options.getString('board')));
    },
  },
];

// Daily Wise Old Man sync (Nov 2, 2026): ask WOM to refresh
// every ranked player's snapshot from the hiscores, then warm
// all four gains periods into the file cache. The refresh also
// seeds the stats cache, so every WOM-fed card gets fresher
// numbers. Failures are counted and logged, never swallowed;
// a player WOM rejects keeps their last snapshot and totals.
async function syncWomGains() {
  const names = await rankedNames();
  let updated = 0;
  let failed = 0;
  let warmed = 0;
  for (const rsn of names) {
    if (await updatePlayer(rsn)) updated += 1; else failed += 1;
    for (const p of GAINS_PERIODS) {
      if (await getPlayerGains(rsn, p)) warmed += 1;
    }
  }
  console.log(`WOM gains sync: ${updated}/${names.length} players updated, ${warmed} period totals warmed${failed ? `, ${failed} updates failed` : ''}.`);
}

module.exports = { handleKcCommand, handleClogCommand, handleProfileCommand, handleLeaderboardCommand, handleTfaCommand, handlePbCommand, handleSkillsCommand, handleCompareCommand, handleDryCommand, handleGainsCommand, handleGainsButton, handleBridgeButton, syncWomGains, commands, kcPayload, clogPayload, profilePayload, leaderboardPayload, pbPayload, skillsPayload, dryPayload, gainsPayload, compareOverallPayload, compareSkillsPayload, compareBossPayload, compareBossBasePayload, compareClogsPayload, handleCompareButton, handleCompareBossSelect, handleCompareSkillSelect, handleCompareClogSelect, handleCompareSwapButton, handleCompareSwapModal, handleCompareAltButton, handleCompareMineButton, handleLeaderboardButton, handleLeaderboardSelect, handleLbSwapButton, handleLbBackButton, checkCooldown, noteUse, COOLDOWN_MS, takeActivity, progressBar, prettyMetric, clogPageForCommand, unlinkedPayload, refreshProfileLuck, handleAutocomplete, kcAutocompleteChoices, clogAutocompleteChoices, dryAutocompleteChoices, dryScoredKeys, KC_KEYS, CLOG_PAGES, kcEntry };
