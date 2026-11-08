'use strict';

// Fixture data for tools/smoke-cards.js, used by CI.
//
// The smoke suite derives its test accounts from whatever data
// files sit in data/ (see pickFixtures in the suite). Production
// data can never be committed, so this generator writes a fully
// fake data set in the same shapes the bot writes at runtime:
// invented display names, invented Discord ids, invented numbers.
// The only real values are game facts (item ids, item names, boss
// metrics) read out of src/luck-data.json, which is source data,
// not member data.
//
// Run before the suite:  node tools/smoke-fixtures.js
// Every timestamp is stamped at generation time so cache
// freshness checks behave the same in CI as they do live.

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DATA = path.join(ROOT, 'data');
const NOW = Date.now();

const LUCK = require(path.join(ROOT, 'src', 'luck-data.json'));

// ── Fake people ─────────────────────────────────────────────
// One owner with two stated accounts (the suite's primary + alt),
// a second stated user (compare partner), one linked account with
// no stated type (the account-type gate case), and three more
// stated accounts so boards and standings have rows to draw.
const USERS = [
  { id: '111111111111111111', accounts: [
    { rsn: 'Fixture Main', badge: 'ironman', mult: 1.0 },
    { rsn: 'FixtureAlt', badge: 'hc', mult: 0.6 },
  ] },
  { id: '222222222222222222', accounts: [
    { rsn: 'Fixture Pal', badge: 'ironman', mult: 0.8 },
  ] },
  { id: '333333333333333333', accounts: [
    { rsn: 'Fixture New', badge: null, mult: 0.3 },
  ] },
  { id: '444444444444444444', accounts: [
    { rsn: 'Fixture Four', badge: 'main', mult: 0.9 },
  ] },
  { id: '555555555555555555', accounts: [
    { rsn: 'Fixture Five', badge: 'gim', mult: 0.7 },
  ] },
  { id: '666666666666666666', accounts: [
    { rsn: 'Fixture Six', badge: 'ult', mult: 0.5 },
  ] },
];

const WOM_TYPE = {
  ironman: 'ironman', hc: 'hardcore', ult: 'ultimate',
  gim: 'regular', main: 'regular',
};

// ── Skills ──────────────────────────────────────────────────
const SKILL_BASE = {
  attack: 92, strength: 95, defence: 90, ranged: 94, prayer: 77,
  magic: 93, hitpoints: 94, cooking: 85, woodcutting: 88,
  fletching: 80, fishing: 91, firemaking: 86, crafting: 78,
  smithing: 75, mining: 84, herblore: 82, agility: 83,
  thieving: 89, slayer: 90, farming: 87, runecrafting: 76,
  hunter: 81, construction: 79,
};

function xpForLevel(level) {
  let points = 0;
  for (let lv = 1; lv < level; lv++) points += Math.floor(lv + 300 * Math.pow(2, lv / 7));
  return Math.floor(points / 4);
}

function combatLevel(s) {
  const base = 0.25 * (s.defence + s.hitpoints + Math.floor(s.prayer / 2));
  const melee = 0.325 * (s.attack + s.strength);
  const ranged = 0.325 * (Math.floor(s.ranged / 2) + s.ranged);
  const magic = 0.325 * (Math.floor(s.magic / 2) + s.magic);
  return Math.floor(base + Math.max(melee, ranged, magic));
}

// ── Kill counts / scores (Wise Old Man metric keys) ─────────
const KC_BASE = {
  zulrah: 512, cerberus: 210, abyssal_sire: 300,
  commander_zilyana: 124, general_graardor: 230, kril_tsutsaroth: 318,
  kreearra: 140, alchemical_hydra: 180, kraken: 250,
  thermonuclear_smoke_devil: 160, sarachnis: 90, skotizo: 45,
  phantom_muspah: 75, nex: 55, corporeal_beast: 65, hespori: 70,
  kalphite_queen: 300, king_black_dragon: 300, giant_mole: 200,
  the_whisperer: 100, duke_sucellus: 100, the_leviathan: 100,
  vardorvis: 100, yama: 120, the_hueycoatl: 62,
  tombs_of_amascut: 45, tombs_of_amascut_expert: 12,
  chambers_of_xeric: 30, chambers_of_xeric_challenge_mode: 8,
  theatre_of_blood: 20, theatre_of_blood_hard_mode: 5,
  the_gauntlet: 60, the_corrupted_gauntlet: 25,
  dagannoth_rex: 90, dagannoth_prime: 85, dagannoth_supreme: 88,
  the_nightmare: 40, phosanis_nightmare: 10,
  artio: 33, callisto: 21, spindel: 44, venenatis: 19,
  calvarion: 27, vetion: 15,
  bounty_hunter_hunter: 50, bounty_hunter_rogue: 12,
  barrows_chests: 500, lunar_chests: 300,
  clue_scrolls_beginner: 20, clue_scrolls_easy: 35,
  clue_scrolls_medium: 60, clue_scrolls_hard: 100,
  clue_scrolls_elite: 40, clue_scrolls_master: 50,
  clue_scrolls_all: 305,
  wintertodt: 400, tempoross: 150,
  league_points: 1200, last_man_standing: 30, soul_wars_zeal: 400,
};

function scaleKc(mult) {
  const out = {};
  for (const [k, v] of Object.entries(KC_BASE)) {
    out[k] = Math.max(1, Math.round(v * mult));
  }
  return out;
}

// ── Collection log pages ────────────────────────────────────
// Item lists come from the luck table itself: every scored item
// whose drop source is one of the page's counters. Quantities
// follow a fixed pattern per account so every page has some
// items obtained and some missing (the missing ones are what
// the dry checks score).
function itemsForCounters(counters) {
  const byId = new Map();
  for (const [id, it] of Object.entries(LUCK.items || {})) {
    if ((it.sources || []).some((s) => counters.includes(s.c))) {
      byId.set(+id, { id: +id, name: it.name });
    }
  }
  for (const set of Object.values(LUCK.sets || {})) {
    if (!(set.sources || []).some((s) => counters.includes(s.c))) continue;
    for (const pid of set.pieces || []) {
      const it = (LUCK.items || {})[String(pid)];
      if (it) byId.set(+pid, { id: +pid, name: it.name });
    }
  }
  return [...byId.values()].sort((a, b) => a.id - b.id);
}

function petItems() {
  const out = [];
  for (const [id, it] of Object.entries(LUCK.items || {})) {
    if (it.kind === 'pet') out.push({ id: +id, name: it.name });
  }
  return out.sort((a, b) => a.id - b.id);
}

const CLUE_COUNTERS = ['clue_scrolls_beginner', 'clue_scrolls_easy',
  'clue_scrolls_medium', 'clue_scrolls_hard', 'clue_scrolls_elite',
  'clue_scrolls_master'];

const PAGES = [
  ['Bosses', 'Zulrah', ['zulrah']],
  ['Bosses', 'Abyssal Sire', ['abyssal_sire']],
  ['Bosses', 'Cerberus', ['cerberus']],
  ['Bosses', 'Commander Zilyana', ['commander_zilyana']],
  ['Bosses', 'General Graardor', ['general_graardor']],
  ['Bosses', "K'ril Tsutsaroth", ['kril_tsutsaroth']],
  ['Bosses', "Kree'arra", ['kreearra']],
  ['Bosses', 'Alchemical Hydra', ['alchemical_hydra']],
  ['Bosses', 'Kalphite Queen', ['kalphite_queen']],
  ['Bosses', 'King Black Dragon', ['king_black_dragon']],
  ['Bosses', 'Giant Mole', ['giant_mole']],
  ['Bosses', 'Barrows Chests', ['barrows_chests']],
  ['Bosses', 'The Whisperer', ['the_whisperer']],
  ['Bosses', 'Duke Sucellus', ['duke_sucellus']],
  ['Bosses', 'The Leviathan', ['the_leviathan']],
  ['Bosses', 'Vardorvis', ['vardorvis']],
  ['Bosses', 'Yama', ['yama']],
  ['Bosses', 'The Hueycoatl', ['the_hueycoatl']],
  ['Bosses', 'Dagannoth Kings', ['dagannoth_rex', 'dagannoth_prime', 'dagannoth_supreme']],
  ['Bosses', 'The Nightmare', ['the_nightmare', 'phosanis_nightmare']],
  ['Bosses', 'Callisto and Artio', ['callisto', 'artio']],
  ['Raids', 'Tombs of Amascut', ['tombs_of_amascut', 'tombs_of_amascut_expert']],
  ['Raids', 'Chambers of Xeric', ['chambers_of_xeric', 'chambers_of_xeric_challenge_mode']],
  ['Raids', 'Theatre of Blood', ['theatre_of_blood', 'theatre_of_blood_hard_mode']],
  ['Clues', 'Beginner Treasure Trails', ['clue_scrolls_beginner']],
  ['Clues', 'Easy Treasure Trails', ['clue_scrolls_easy']],
  ['Clues', 'Medium Treasure Trails', ['clue_scrolls_medium']],
  ['Clues', 'Hard Treasure Trails', ['clue_scrolls_hard']],
  ['Clues', 'Elite Treasure Trails', ['clue_scrolls_elite']],
  ['Clues', 'Master Treasure Trails', ['clue_scrolls_master']],
  ['Clues', 'Shared Treasure Trail Rewards', CLUE_COUNTERS],
  ['Minigames', 'Wintertodt', ['wintertodt']],
  ['Minigames', 'Tempoross', ['tempoross']],
  ['Other', 'All Pets', null], // filled from petItems()
];

function buildPages(acctIndex) {
  const pages = [];
  for (const [tab, title, counters] of PAGES) {
    const base = counters ? itemsForCounters(counters) : petItems();
    if (!base.length) continue;
    const items = base.map((it, i) => ({
      id: it.id,
      name: it.name,
      quantity: (i + acctIndex) % 3 === 0 ? 0 : 1 + ((i * 7 + acctIndex) % 3),
    }));
    pages.push({ tab, title, items });
  }
  return pages;
}

// ── Per-account records ─────────────────────────────────────
function buildAccount(acct, acctIndex) {
  const rsn = acct.rsn;
  const lower = rsn.toLowerCase();
  const levels = {};
  const skills = {};
  for (const [name, base] of Object.entries(SKILL_BASE)) {
    const lvl = Math.max(1, Math.min(99, base - ((acctIndex * 3 + name.length) % 9)));
    levels[name] = lvl;
    skills[name] = { level: lvl, xp: xpForLevel(lvl) + acctIndex * 12345 };
  }
  const kc = scaleKc(acct.mult);
  const totalLevel = Object.values(levels).reduce((a, b) => a + b, 0);
  const totalXp = Object.values(skills).reduce((a, s) => a + s.xp, 0);
  skills.overall = { level: totalLevel, xp: totalXp };
  const stats = {
    combat: combatLevel(levels),
    ...levels,
    kc,
    accountType: WOM_TYPE[acct.badge] || 'regular',
    skills,
    username: lower,
    displayName: rsn,
  };

  const gainsData = (factor) => {
    const gSkills = ['slayer', 'fishing', 'woodcutting', 'agility', 'thieving']
      .map((s, i) => ({
        skill: s,
        name: s[0].toUpperCase() + s.slice(1),
        xp: Math.round((42000 - i * 6100) * acct.mult * factor),
      }))
      .filter((s) => s.xp > 0);
    const gBosses = [
      { metric: 'zulrah', name: 'Zulrah', kc: Math.max(1, Math.round(14 * acct.mult * factor)) },
      { metric: 'cerberus', name: 'Cerberus', kc: Math.max(1, Math.round(6 * acct.mult * factor)) },
    ];
    return {
      totalXp: gSkills.reduce((a, s) => a + s.xp, 0),
      totalKc: gBosses.reduce((a, b) => a + b.kc, 0),
      skills: gSkills,
      bosses: gBosses,
      startsAt: new Date(NOW - 86400000).toISOString(),
      endsAt: new Date(NOW).toISOString(),
    };
  };
  const gains = {
    day: { at: NOW, data: gainsData(0.2) },
    week: { at: NOW, data: gainsData(1) },
    month: { at: NOW, data: gainsData(3.5) },
    year: { at: NOW, data: gainsData(30) },
  };

  // RuneProfile cache entries.
  const pages = buildPages(acctIndex);
  const rp = {};
  let obtSum = 0;
  let totSum = 0;
  const tabAgg = {};
  const pagesMap = {};
  for (const p of pages) {
    const obtained = p.items.filter((i) => i.quantity > 0).length;
    rp[`clog:${lower}:${p.tab}:${p.title}`] = {
      fetchedAt: NOW, obtained, total: p.items.length, items: p.items,
    };
    pagesMap[p.title] = {
      tab: p.tab, obtained, total: p.items.length,
      items: p.items.filter((i) => i.quantity > 0).map((i) => ({ id: i.id, name: i.name })),
    };
    obtSum += obtained;
    totSum += p.items.length;
    if (!tabAgg[p.tab]) tabAgg[p.tab] = { name: p.tab, obtained: 0, total: 0 };
    tabAgg[p.tab].obtained += obtained;
    tabAgg[p.tab].total += p.items.length;
  }
  const headlineTotal = totSum + 400;
  const headlineObtained = Math.min(obtSum, headlineTotal);
  rp[`total:${lower}`] = { fetchedAt: NOW, obtained: headlineObtained, total: headlineTotal };
  rp[`clogsummary:${lower}`] = {
    fetchedAt: NOW, obtained: headlineObtained, total: headlineTotal,
    tabs: Object.values(tabAgg),
  };
  rp[`clogpages:${lower}`] = { fetchedAt: NOW, pages: pagesMap };
  rp[`profile:${lower}:account`] = {
    fetchedAt: NOW,
    data: { username: rsn, accountType: stats.accountType },
  };
  rp[`profile:${lower}:skills`] = { fetchedAt: NOW, data: { levels } };
  rp[`profile:${lower}:ca`] = { fetchedAt: NOW, data: { done: 120 + acctIndex * 17, total: 492 } };
  rp[`profile:${lower}:diaries`] = { fetchedAt: NOW, data: { done: 30 + acctIndex * 2, total: 48 } };

  const slug = lower.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const pluginRecord = {
    rsn,
    counters: {},
    personalBests: {
      zulrah: { boss: 'Zulrah', seconds: 95.4 + acctIndex * 3, killCount: kc.zulrah, at: NOW },
      the_gauntlet: { boss: 'The Gauntlet', seconds: 402.1 + acctIndex * 9, killCount: kc.the_gauntlet, at: NOW },
      tombs_of_amascut: { boss: 'Tombs of Amascut', seconds: 1087.5 + acctIndex * 21, killCount: kc.tombs_of_amascut, at: NOW },
    },
  };

  return { rsn, lower, stats, gains, rp, pluginRecord, slug };
}

// ── Assemble and write ──────────────────────────────────────
function main() {
  fs.mkdirSync(path.join(DATA, 'plugin-sync', 'members'), { recursive: true });

  const links = {};
  const badges = { users: {} };
  const womCache = {};
  const vault = {};
  const gainsFile = {};
  const rpCache = {};
  const luckOut = {};
  const luckUnits = {};
  const group = [];

  let acctIndex = 0;
  for (const user of USERS) {
    links[user.id] = {
      rsns: user.accounts.map((a) => a.rsn),
      active: user.accounts[0].rsn,
      verified: [],
      womIds: {},
    };
    for (const acct of user.accounts) {
      const built = buildAccount(acct, acctIndex);
      if (acct.badge) {
        if (!badges.users[user.id]) {
          badges.users[user.id] = { accounts: {}, granted: [], pendingRoles: false };
        }
        badges.users[user.id].accounts[`r:${built.lower}`] = acct.badge;
      }
      womCache[built.lower] = { fetchedAt: NOW, stats: built.stats };
      vault[built.lower] = { fetchedAt: NOW, stats: built.stats };
      gainsFile[built.lower] = built.gains;
      Object.assign(rpCache, built.rp);
      const score = 5 + ((acctIndex * 7) % 30);
      luckUnits[built.lower] = { name: 'Tanzanite fang', id: 12922, score, dryness: 100 - 2 * score };
      luckOut[built.lower] = `Tanzanite fang (${100 - 2 * score}% luckier than you)`;
      group.push({ rsn: built.rsn });
      fs.writeFileSync(
        path.join(DATA, 'plugin-sync', 'members', `${built.slug}.json`),
        JSON.stringify(built.pluginRecord, null, 2));
      acctIndex++;
    }
  }

  const write = (name, obj) => {
    fs.writeFileSync(path.join(DATA, name), JSON.stringify(obj, null, 2));
    console.log('fixture:', name);
  };

  write('rsn-links.json', links);
  write('badges.json', badges);
  write('wom-cache-v3.json', womCache);
  write('player-vault.json', vault);
  write('wom-gains.json', gainsFile);
  write('rp-cache-v2.json', rpCache);
  write('profile-luck.json', luckOut);
  write('profile-luck-units.json', luckUnits);
  write('wom-group.json', group);
  write('lb-extras.json', { members: ['Fixture Main', 'Fixture Pal'], friends: ['Fixture Five'] });
  write('tenure.json', { users: {}, seededAt: NOW });
  write('membership.json', {});
  write('seniority-holds.json', {});
  write('rank-holders.json', {});
  write('friends.json', []);
  write('join-dates.json', {});
  write('application-stats.json', {});
  write('rosters.json', {});
  write('user-defaults.json', {});
  write('polls.json', {});
  write('strikes.json', {});
  write('tickets.json', {});
  write('reminders.json', {});
  write('teams.json', {});

  // Luck tuning: the deploy copy is the source of truth (see
  // src/luck.js), so mirror it rather than inventing values.
  const tuningSrc = path.join(ROOT, 'deploy', 'luck-tuning.json');
  if (fs.existsSync(tuningSrc)) {
    fs.copyFileSync(tuningSrc, path.join(DATA, 'luck-tuning.json'));
    console.log('fixture: luck-tuning.json (copied from deploy/)');
  }

  // Item icons: card builders load an icon file for every item
  // on a collection log page and fetch any that are missing over
  // the network, one at a time. Stage a placeholder icon for
  // every scored item so no card build ever waits on a fetch.
  const iconDir = path.join(DATA, 'item-icons');
  fs.mkdirSync(iconDir, { recursive: true });
  const TINY_PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
    'base64');
  let iconCount = 0;
  for (const id of Object.keys(LUCK.items || {})) {
    fs.writeFileSync(path.join(iconDir, `${id}.png`), TINY_PNG);
    iconCount++;
  }
  console.log(`fixture: item-icons/ (${iconCount} placeholder icons)`);

  console.log(`fixtures written for ${acctIndex} accounts, ${USERS.length} users`);
}

main();
