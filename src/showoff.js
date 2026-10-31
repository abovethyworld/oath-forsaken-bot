// !-prefixed show-off commands: !kc <activity> [name], !clog <activity|total> [name],
// !profile [name], !leaderboard. Needs the Message Content privileged intent
// (code + portal toggle).
const { AttachmentBuilder, SlashCommandBuilder } = require('discord.js');
const { getStats, combatLevel, kcStandings } = require('./wom');
const { getClogPageWithItems, getClogTotal, getClogSummary, getProfile, getCachedClogTotal } = require('./runeprofile');
const { ACTIVITIES, kcColumnsForTeam, getRsn, clogPageForActivity, loadRsnLinks, rsnLinkRow } = require('./teams');
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
  const choices = interaction.commandName === 'kc'
    ? kcAutocompleteChoices(focused)
    : interaction.commandName === 'clog'
      ? clogAutocompleteChoices(focused)
      : [];
  await interaction.respond(choices).catch(() => {});
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
      .setName('leaderboard')
      .setDescription('Collection log leaderboard for linked clan members'),
    run: async (interaction) => {
      if (await slashCooldown(interaction)) return;
      await slashReply(interaction, leaderboardPayload(interaction.user.id));
    },
  },
];

module.exports = { handleKcCommand, handleClogCommand, handleProfileCommand, handleLeaderboardCommand, commands, kcPayload, clogPayload, profilePayload, leaderboardPayload, checkCooldown, noteUse, COOLDOWN_MS, takeActivity, progressBar, prettyMetric, clogPageForCommand, leaderboardRows, unlinkedPayload, handleAutocomplete, kcAutocompleteChoices, clogAutocompleteChoices, KC_KEYS, CLOG_PAGES };
