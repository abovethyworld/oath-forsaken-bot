// !-prefixed show-off commands: !kc <activity> [name], !clog <activity|total> [name],
// !profile [name], !leaderboard. Needs the Message Content privileged intent
// (code + portal toggle).
const { AttachmentBuilder, SlashCommandBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder } = require('discord.js');
const { getStats, combatLevel, kcStandings } = require('./wom');
const { getClogPageWithItems, getClogTotal, getClogSummary, getProfile, getCachedClogTotal } = require('./runeprofile');
const { ACTIVITIES, kcColumnsForTeam, getRsn, clogPageForActivity, loadRsnLinks, rsnLinkRow } = require('./teams');
const { renderProfileCard, renderClogLeaderboard, renderClogCard, renderClogSummaryCard, renderKcCard, getBossIcon, decodePng } = require('./party-board');
const { getItemIcon } = require('./item-icons');
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
function kcCardBody(rsn, entry, st, clog) {
  const primary = entry.cols[0];
  const myKc = st.kc ? st.kc[primary.metric] : null;
  const standings = kcStandings(primary.metric);
  const rankIdx = typeof myKc === 'number'
    ? standings.findIndex((r) => r.name === rsn.toLowerCase())
    : -1;
  return {
    rsn,
    boss: entry.name,
    metric: primary.metric,
    entries: entry.cols.map((c) => {
      const n = st.kc ? st.kc[c.metric] : null;
      return {
        label: c.label || (entry.cols.length === 1 ? 'Kill count' : prettyMetric(c.metric)),
        value: typeof n === 'number' ? n.toLocaleString('en-US') : '-',
      };
    }),
    kcValue: typeof myKc === 'number' ? myKc : null,
    rank: rankIdx >= 0 ? rankIdx + 1 : null,
    rankOf: standings.length,
    clanTotal: standings.length ? standings.reduce((s, r) => s + r.kc, 0) : null,
    members: standings.length,
    clog: clog || null,
  };
}

// Load a clog page's obtained items with their icons (decoded for the
// in-bot renderer, base64 for the website card). Icons fetch in
// parallel through the paced item-icon queue.
async function loadClogItems(res) {
  const obtained = (res.items || []).filter((it) => it.quantity > 0);
  return Promise.all(obtained.slice(0, 49).map(async (it) => {
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
    return { icon, qty: it.quantity, iconB64 };
  }));
}

// The clog strip for a KC card, or null when the boss has no log page
// or the player has no RuneProfile. Never throws: a missing strip
// must not cost the KC card.
async function clogStripFor(rsn, activity) {
  const page = CLOG_PAGES[activity] || clogPageForActivity(activity);
  if (!page) return null;
  try {
    const res = await getClogPageWithItems(rsn, page[0], page[1]);
    if (!res || res.notFound) return null;
    const drawn = await loadClogItems(res);
    return {
      obtained: res.obtained,
      total: res.total,
      items: drawn.map((d) => ({ qty: d.qty, icon: d.iconB64 })),
    };
  } catch {
    return null;
  }
}

async function kcPayload(activity, rsn, userId) {
  const entry = activity ? kcEntry(activity) : null;
  if (!entry) {
    return { content: `Pick an activity: \`!kc <activity> [name]\`\nActivities: ${Object.keys(KC_KEYS).join(', ')}` };
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
  if (!entry.cols.length) return { content: `No kill count is tracked for ${entry.name}.` };
  const entries = entry.cols.map((c) => ({
    icon: getBossIcon(c.icon || c.metric),
    label: c.label || prettyMetric(c.metric),
    value: fmtKc(st.kc ? st.kc[c.metric] : null),
  }));
  // Website card first: same numbers, share-card style, plus the
  // player's standing on this boss and its collection log strip.
  const clog = await clogStripFor(rsn, activity);
  const card = await fetchCard('/kc', kcCardBody(rsn, entry, st, clog));
  if (card) return { files: [new AttachmentBuilder(card, { name: 'kc.png' })] };
  const buf = renderKcCard({ title: `${rsn}: ${entry.name}`, entries });
  return { files: [new AttachmentBuilder(buf, { name: 'kc.png' })] };
}

async function handleKcCommand(message, args) {
  const cd = checkCooldown(message.author.id);
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

const RP_GUIDE = 'No RuneProfile profile found for that name. Run the RuneProfile plugin ([runeprofile.com/info/guide](https://runeprofile.com/info/guide)) and it syncs on its own.';

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
  clues_hard_rare: ['Clues', 'Hard Treasure Trails (Rare)'],
  clues_elite_rare: ['Clues', 'Elite Treasure Trails (Rare)'],
  clues_master_rare: ['Clues', 'Master Treasure Trails (Rare)'],
  clues_shared: ['Clues', 'Shared Treasure Trail Rewards'],
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
async function clogPayload(key, rsn, userId) {
  if (!key) return { content: 'Usage: `!clog <activity|total> [name]`' };
  if (key === 'total') {
    if (userId) noteUse(userId); // a real lookup fires: start the cooldown
    const res = await getClogSummary(rsn).catch(() => null);
    if (!res) return { content: 'Could not reach the collection log service right now. Try again in a bit.' };
    if (res.notFound) return { content: RP_GUIDE };
    const card = await fetchCard('/clog-total', {
      rsn, obtained: res.obtained, total: res.total, tabs: res.tabs,
    });
    if (card) return { files: [new AttachmentBuilder(card, { name: 'clog.png' })] };
    const buf = renderClogSummaryCard({ name: rsn, obtained: res.obtained, total: res.total, tabs: res.tabs });
    return { files: [new AttachmentBuilder(buf, { name: 'clog.png' })] };
  }
  const page = clogPageForCommand(key);
  if (!page) {
    const wag = key === 'wag';
    return { content: wag
      ? 'Wilderness Agility has no collection log page to show.'
      : `No collection log page for \`${key}\`. Every boss, raid, clue, minigame, and other page works: try the boss or page name, or \`total\` for the whole log.` };
  }
  if (userId) noteUse(userId); // a real lookup fires: start the cooldown
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
      const strip = {
        obtained: res.obtained,
        total: res.total,
        items: drawn.map((d) => ({ qty: d.qty, icon: d.iconB64 })),
      };
      const combined = await fetchCard('/kc', kcCardBody(rsn, kcEnt, st, strip));
      if (combined) return { files: [new AttachmentBuilder(combined, { name: 'clog.png' })] };
    }
  }
  const card = await fetchCard('/clog-page', {
    rsn,
    page: page[1],
    obtained: res.obtained,
    total: res.total,
    items: drawn.map((d) => ({ qty: d.qty, icon: d.iconB64 })),
  });
  if (card) return { files: [new AttachmentBuilder(card, { name: 'clog.png' })] };
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

async function profilePayload(rsn, userId) {
  if (userId) noteUse(userId); // a real lookup fires: start the cooldown
  const site = await siteCardPayload(rsn);
  if (site) return site;
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
  const { rsn, error, payload } = resolveName(args, message.author.id);
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
  const card = await fetchCard('/leaderboard', { rows });
  if (card) return { files: [new AttachmentBuilder(card, { name: 'leaderboard.png' })] };
  const buf = renderClogLeaderboard(rows);
  return { files: [new AttachmentBuilder(buf, { name: 'leaderboard.png' })] };
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
  const record = pluginRecord(rsn);
  const pbs = (record && record.personalBests) || {};
  const all = Object.entries(pbs).filter(([, e]) => e && typeof e === 'object');
  if (!all.length) {
    return { content: `No personal bests synced for **${rsn}** yet. They land here once the clan plugin's PB sync is on and a PB kill happens in game.` };
  }
  if (userId) noteUse(userId);
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
      mode: 'single', rsn, boss, time: pbTime(e),
      killCount: e.killCount || null, at: e.at || null,
    });
    if (card) return { files: [new AttachmentBuilder(card, { name: 'pb.png' })] };
    return { content: `**${rsn}** - ${boss} personal best: **${pbTime(e)}**${e.killCount ? ` at ${Number(e.killCount).toLocaleString('en-US')} KC` : ''}. Member-reported.` };
  }
  const rows = all
    .map(([key, e]) => ({ boss: e.boss || key, time: pbTime(e) }))
    .sort((a, b) => a.boss.localeCompare(b.boss));
  const card = await fetchCard('/pb', { mode: 'list', rsn, rows });
  if (card) return { files: [new AttachmentBuilder(card, { name: 'pb.png' })] };
  const lines = rows.map((r) => `${r.boss}: **${r.time}**`);
  return { content: `**${rsn}** personal bests (member-reported):\n${lines.join('\n')}` };
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
  if (userId) noteUse(userId); // a real lookup fires: start the cooldown
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
  const card = await fetchCard('/skills', {
    rsn, combat: st.combat, totalLevel, totalXp, skills, skillingBosses,
  });
  if (card) return { files: [new AttachmentBuilder(card, { name: 'skills.png' })] };
  return { content: `**${rsn}** - Total level ${totalLevel.toLocaleString('en-US')}, total XP ${totalXp.toLocaleString('en-US')}, combat ${st.combat}. The full grid card is down right now.` };
}

async function handleSkillsCommand(message, args) {
  const cd = checkCooldown(message.author.id);
  if (cd.wait) { if (cd.notify) await message.reply(cooldownText(cd.wait)).catch(() => {}); return; }
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

async function compareOverallPayload(aName, bName, userId) {
  if (userId) noteUse(userId);
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
  const card = await fetchCard('/compare', { a: { rsn: aName }, b: { rsn: bName }, rows, tally });
  if (card) return { files: [new AttachmentBuilder(card, { name: 'compare.png' })], components: compareComponents('overall', aName, bName, null) };
  return { content: `**${aName}** vs **${bName}** - ${tally.charAt(0) + tally.slice(1).toLowerCase()}. The card service is down right now.` };
}

async function compareSkillsPayload(aName, bName, userId) {
  if (userId) noteUse(userId);
  const [sa, sb] = await Promise.all([compareSnapshot(aName), compareSnapshot(bName)]).catch(() => [null, null]);
  if (!sa || !sb) return { content: 'Could not reach the stats service right now. Try again in a bit.' };
  if (!sa.st) return { content: `Could not find the RuneScape name **${aName}**.` };
  if (!sb.st) return { content: `Could not find the RuneScape name **${bName}**.` };
  const led = skillsLed(sa.skills, sb.skills);
  const tied = 24 - led.a - led.b;
  const summary = `Skills led: ${aName} ${led.a} - ${led.b} ${bName}${tied ? ` · ${tied} tied` : ''}`;
  const card = await fetchCard('/compare-skills', {
    a: { rsn: aName }, b: { rsn: bName }, summary, cells: led.cells,
  });
  if (card) return { files: [new AttachmentBuilder(card, { name: 'compare-skills.png' })], components: compareComponents('skills', aName, bName, null) };
  return { content: summary };
}

async function compareBossPayload(key, aName, bName, userId) {
  if (userId) noteUse(userId);
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
  const card = await fetchCard('/compare-boss', {
    boss: bossName, metric,
    a: { rsn: aName, kc: kcA, rank: rankOf(aName) },
    b: { rsn: bName, kc: kcB, rank: rankOf(bName) },
    leader, note,
  });
  if (card) return { files: [new AttachmentBuilder(card, { name: 'compare-boss.png' })], components: compareComponents('boss', aName, bName, key) };
  return { content: `**${bossName}** - ${aName}: ${kcA == null ? '-' : fmt(kcA)} · ${bName}: ${kcB == null ? '-' : fmt(kcB)}${note ? ` (${note})` : ''}` };
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
    return { a: first.rsn, b: second.rsn };
  }
  const linked = resolveNameFor(userId, null);
  if (linked.error || linked.payload) return linked;
  return { a: first.rsn, b: linked.rsn };
}

async function handleCompareCommand(message, args) {
  const cd = checkCooldown(message.author.id);
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
  const cd = checkCooldown(message.author.id);
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
  const cd = checkCooldown(message.author.id);
  if (cd.wait) { if (cd.notify) await message.reply(cooldownText(cd.wait)).catch(() => {}); return; }
  const { rsn, error, payload } = resolveName(args, message.author.id);
  if (error) { await message.reply(error).catch(() => {}); return; }
  if (payload) { await message.reply(payload).catch(() => {}); return; }
  await message.reply(await kcPayload('tfa', rsn, message.author.id)).catch(() => {});
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
async function slashCooldown(interaction) {
  const cd = checkCooldown(interaction.user.id);
  if (!cd.wait) return false;
  await interaction.reply({ content: cooldownText(cd.wait), ephemeral: true }).catch(() => {});
  return true;
}

// Slash activity options use autocomplete, not fixed choices: the full
// kc and clog lists are far past Discord's 25-choice cap. Choices are
// { name, value } pairs filtered by what the member has typed.
function kcAutocompleteChoices(focused) {
  const q = String(focused || '').toLowerCase();
  const all = Object.entries(KC_KEYS).map(([value, a]) => ({ name: a.name, value }));
  return all.filter((c) => !q || c.name.toLowerCase().includes(q) || c.value.includes(q)).slice(0, 25);
}

function clogAutocompleteChoices(focused) {
  const q = String(focused || '').toLowerCase();
  const seen = new Set();
  const all = [{ name: 'Total (whole log)', value: 'total' }];
  for (const [value, page] of Object.entries(CLOG_PAGES)) {
    if (seen.has(page[1])) continue; // aliases share one dropdown row
    seen.add(page[1]);
    all.push({ name: page[1], value });
  }
  return all.filter((c) => !q || c.name.toLowerCase().includes(q) || c.value.includes(q)).slice(0, 25);
}

async function handleAutocomplete(interaction) {
  const focused = interaction.options.getFocused();
  const choices = interaction.commandName === 'kc' || interaction.commandName === 'pb' || interaction.commandName === 'compare-boss'
    ? kcAutocompleteChoices(focused)
    : interaction.commandName === 'clog'
      ? clogAutocompleteChoices(focused)
      : [];
  await interaction.respond(choices).catch(() => {});
}

// ---- Compare card components: view buttons + boss picker ----
// The pair travels inside the component ids (base64url of "a\nb"), so
// the buttons keep working without any server-side state.

function encodePair(a, b) {
  return Buffer.from(`${a}\n${b}`, 'utf8').toString('base64url');
}

function decodePair(enc) {
  try {
    const parts = Buffer.from(String(enc || ''), 'base64url').toString('utf8').split('\n');
    return parts.length === 2 && parts[0] && parts[1] ? { a: parts[0], b: parts[1] } : null;
  } catch {
    return null;
  }
}

let bossMenuCache = { at: 0, options: [] };
function bossMenuOptions() {
  if (bossMenuCache.options.length && Date.now() - bossMenuCache.at < 10 * 60 * 1000) {
    return bossMenuCache.options;
  }
  const byMetric = new Map();
  for (const [key, entry] of Object.entries(KC_KEYS)) {
    const variantKey = key === 'cg' || /(_expert|_cm|_hard)$/.test(key);
    const col = entry.cols.length > 1 && variantKey
      ? entry.cols[entry.cols.length - 1] : entry.cols[0];
    if (byMetric.has(col.metric)) continue;
    let total = 0;
    try { for (const row of kcStandings(col.metric)) total += row.kc; } catch { /* cache only */ }
    byMetric.set(col.metric, { key, name: entry.name, total });
  }
  const options = [...byMetric.values()]
    .filter((o) => o.total > 0)
    .sort((x, y) => y.total - x.total)
    .slice(0, 25)
    .map((o) => ({ label: String(o.name).slice(0, 100), value: o.key }));
  bossMenuCache = { at: Date.now(), options };
  return options;
}

function compareComponents(view, a, b, bossKey) {
  const enc = encodePair(a, b);
  const viewBtn = (v, label) => new ButtonBuilder()
    .setCustomId(`cmp:${v}:${enc}`)
    .setLabel(label)
    .setStyle(view === v ? ButtonStyle.Danger : ButtonStyle.Secondary)
    .setDisabled(view === v);
  const rows = [new ActionRowBuilder().addComponents(
    viewBtn('overall', 'Overall'), viewBtn('skills', 'Skills'))];
  const options = bossMenuOptions();
  if (options.length) {
    rows.push(new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(`cmpboss:${enc}`)
        .setPlaceholder('Pick a boss...')
        .addOptions(options)));
  }
  return rows;
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

async function handleCompareButton(interaction) {
  const [, view, enc] = interaction.customId.split(':');
  const pair = decodePair(enc);
  if (!pair || (view !== 'overall' && view !== 'skills')) {
    await interaction.reply({ content: 'That compare card has expired. Run the command again.', ephemeral: true }).catch(() => {});
    return;
  }
  await interaction.deferUpdate().catch(() => {});
  const payload = view === 'skills'
    ? await compareSkillsPayload(pair.a, pair.b, null)
    : await compareOverallPayload(pair.a, pair.b, null);
  await editCompareMessage(interaction, payload);
}

async function handleCompareBossSelect(interaction) {
  const pair = decodePair(interaction.customId.slice('cmpboss:'.length));
  if (!pair) {
    await interaction.reply({ content: 'That compare card has expired. Run the command again.', ephemeral: true }).catch(() => {});
    return;
  }
  const key = interaction.values && interaction.values[0];
  if (!key || !KC_KEYS[key]) return;
  await interaction.deferUpdate().catch(() => {});
  await editCompareMessage(interaction, await compareBossPayload(key, pair.a, pair.b, null));
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
  return { a: aRes.rsn, b: bRes.rsn };
}

const commands = [
  {
    data: new SlashCommandBuilder()
      .setName('kc')
      .setDescription("Show a player's boss kill count card")
      .addStringOption((o) => o.setName('activity').setDescription('Which boss or activity').setRequired(true).setAutocomplete(true))
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
      .addStringOption((o) => o.setName('activity').setDescription('Which page, or the whole log').setRequired(true).setAutocomplete(true))
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
      .setDescription("Show a player's profile card")
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
      .setName('compare')
      .setDescription('Compare two players overall')
      .addStringOption((o) => o.setName('player_a').setDescription('First RuneScape name (defaults to your linked RSN)'))
      .addStringOption((o) => o.setName('player_b').setDescription('Second RuneScape name (defaults to your linked RSN)')),
    run: async (interaction) => {
      const pair = await resolveComparePair(interaction);
      if (!pair) return;
      if (await slashCooldown(interaction)) return;
      await slashReply(interaction, compareOverallPayload(pair.a, pair.b, interaction.user.id));
    },
  },
  {
    data: new SlashCommandBuilder()
      .setName('compare-skills')
      .setDescription('Compare two players skill by skill')
      .addStringOption((o) => o.setName('player_a').setDescription('First RuneScape name (defaults to your linked RSN)'))
      .addStringOption((o) => o.setName('player_b').setDescription('Second RuneScape name (defaults to your linked RSN)')),
    run: async (interaction) => {
      const pair = await resolveComparePair(interaction);
      if (!pair) return;
      if (await slashCooldown(interaction)) return;
      await slashReply(interaction, compareSkillsPayload(pair.a, pair.b, interaction.user.id));
    },
  },
  {
    data: new SlashCommandBuilder()
      .setName('compare-boss')
      .setDescription('Compare two players on one boss')
      .addStringOption((o) => o.setName('boss').setDescription('Boss or activity').setRequired(true).setAutocomplete(true))
      .addStringOption((o) => o.setName('player_a').setDescription('First RuneScape name (defaults to your linked RSN)'))
      .addStringOption((o) => o.setName('player_b').setDescription('Second RuneScape name (defaults to your linked RSN)')),
    run: async (interaction) => {
      const bossStr = interaction.options.getString('boss');
      const bossKey = bossStr ? bossStr.trim().toLowerCase().replace(/\s+/g, '_') : null;
      if (!bossKey || !KC_KEYS[bossKey]) {
        await interaction.reply({ content: 'Pick a boss or activity from the list.', ephemeral: true }).catch(() => {});
        return;
      }
      const pair = await resolveComparePair(interaction);
      if (!pair) return;
      if (await slashCooldown(interaction)) return;
      await slashReply(interaction, compareBossPayload(bossKey, pair.a, pair.b, interaction.user.id));
    },
  },
  {
    data: new SlashCommandBuilder()
      .setName('skills')
      .setDescription("Show a player's skill levels card")
      .addStringOption((o) => o.setName('player').setDescription('RuneScape name (defaults to your linked RSN)')),
    run: async (interaction) => {
      const { rsn, error, payload } = resolveNameFor(interaction.user.id, interaction.options.getString('player'));
      if (error) { await interaction.reply({ content: error, ephemeral: true }).catch(() => {}); return; }
      if (payload) { await interaction.reply({ ...payload, ephemeral: true }).catch(() => {}); return; }
      if (await slashCooldown(interaction)) return;
      await slashReply(interaction, skillsPayload(rsn, interaction.user.id));
    },
  },
  {
    data: new SlashCommandBuilder()
      .setName('pb')
      .setDescription("Show a player's personal best times from the clan plugin")
      .addStringOption((o) => o.setName('activity').setDescription('One boss (leave empty for all of them)').setAutocomplete(true))
      .addStringOption((o) => o.setName('player').setDescription('RuneScape name (defaults to your linked RSN)')),
    run: async (interaction) => {
      const { rsn, error, payload } = resolveNameFor(interaction.user.id, interaction.options.getString('player'));
      if (error) { await interaction.reply({ content: error, ephemeral: true }).catch(() => {}); return; }
      if (payload) { await interaction.reply({ ...payload, ephemeral: true }).catch(() => {}); return; }
      if (await slashCooldown(interaction)) return;
      await slashReply(interaction, pbPayload(interaction.options.getString('activity'), rsn, interaction.user.id));
    },
  },
  {
    data: new SlashCommandBuilder()
      .setName('tfa')
      .setDescription("Show a player's Fractured Archive card")
      .addStringOption((o) => o.setName('player').setDescription('RuneScape name (defaults to your linked RSN)')),
    run: async (interaction) => {
      const { rsn, error, payload } = resolveNameFor(interaction.user.id, interaction.options.getString('player'));
      if (error) { await interaction.reply({ content: error, ephemeral: true }).catch(() => {}); return; }
      if (payload) { await interaction.reply({ ...payload, ephemeral: true }).catch(() => {}); return; }
      if (await slashCooldown(interaction)) return;
      await slashReply(interaction, kcPayload('tfa', rsn, interaction.user.id));
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

module.exports = { handleKcCommand, handleClogCommand, handleProfileCommand, handleLeaderboardCommand, handleTfaCommand, handlePbCommand, handleSkillsCommand, handleCompareCommand, commands, kcPayload, clogPayload, profilePayload, leaderboardPayload, pbPayload, skillsPayload, compareOverallPayload, compareSkillsPayload, compareBossPayload, handleCompareButton, handleCompareBossSelect, checkCooldown, noteUse, COOLDOWN_MS, takeActivity, progressBar, prettyMetric, clogPageForCommand, leaderboardRows, unlinkedPayload, handleAutocomplete, kcAutocompleteChoices, clogAutocompleteChoices, KC_KEYS, CLOG_PAGES };
