// Competition roster: the names staff trim from when they build a
// competition on Wise Old Man.
// Ruling (Nov 20, 2026): the clan is iron-first. Mains are full members
// and stay in the Wise Old Man group (the website and DropTracker need
// them there), but competitions and bingos are iron-only, so each
// competition's player list is trimmed by hand. This module keeps the
// trimming list current: it rebuilds data/comp-roster.csv and
// data/comp-names.txt on every approval, on staff standing changes,
// once a day, and on demand through /comp-roster.
// Types come from Wise Old Man per RSN, never from the application:
// one member can hold both iron and main accounts.
const fs = require('fs');
const path = require('path');
const config = require('./config');
const jobStatus = require('./job-status');
const { getStats } = require('./wom');

const DATA_DIR = path.join(__dirname, '..', 'data');
const CSV_FILE = path.join(DATA_DIR, 'comp-roster.csv');
const NAMES_FILE = path.join(DATA_DIR, 'comp-names.txt');
const MEMBERSHIP_FILE = path.join(DATA_DIR, 'membership.json');
const LINKS_FILE = path.join(DATA_DIR, 'rsn-links.json');
const GROUP_FILE = path.join(DATA_DIR, 'wom-group.json');
const FRIENDS_FILE = path.join(DATA_DIR, 'friends.json');
const OVERRIDES_FILE = path.join(DATA_DIR, 'comp-roster-overrides.json');
const BADGES_FILE = path.join(DATA_DIR, 'badges.json');

const JOB = 'comp-roster';

// Staff type overrides, data/comp-roster-overrides.json:
// { "<rsn>": "<wise old man type>" }. Wise Old Man cannot see group
// ironmen (their accounts read as regular), so a group ironman's type
// is recorded here by staff, the same fix the website exporter carries
// for its badges. An override wins over the Wise Old Man type.

// The badge an applicant picked for a name at application time
// (data/badges.json, written by the application flow). Wise Old Man
// cannot see group ironmen, but the applicant declared the type when
// they came in, so a badge beats the Wise Old Man type. Only a staff
// override beats a badge.
const BADGE_INFO = {
  main: { label: 'Main', iron: false },
  ironman: { label: 'Ironman', iron: true },
  hc: { label: 'Hardcore ironman', iron: true },
  ult: { label: 'Ultimate ironman', iron: true },
  gim: { label: 'Group ironman', iron: true },
  ugim: { label: 'Group ironman (unranked)', iron: true },
  hcgim: { label: 'Hardcore group ironman', iron: true },
};

// Wise Old Man account type -> roster label and whether the account
// may be entered in a competition.
const TYPE_INFO = {
  regular: { label: 'Main', iron: false },
  ironman: { label: 'Ironman', iron: true },
  hardcore: { label: 'Hardcore ironman', iron: true },
  ultimate: { label: 'Ultimate ironman', iron: true },
  group_ironman: { label: 'Group ironman', iron: true },
  unranked_group_ironman: { label: 'Group ironman (unranked)', iron: true },
  fresh_start_ironman: { label: 'Ironman (fresh start)', iron: true },
  fresh_start_group_ironman: { label: 'Group ironman (fresh start)', iron: true },
};

const LIST_ORDER = ['Comp keep list', 'Untick from comps', 'Check first', 'Not in the WOM group'];

// OSRS names compare loosely: case, underscores, and spacing vary
// between sources. Same rule as src/membership.js.
function normName(name) {
  return String(name || '').toLowerCase().replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
}

// RSNs from one rsn-links entry, current { rsns: [...] } shape or the
// legacy single-name { rsn } shape.
function entryRsns(entry) {
  if (!entry || typeof entry !== 'object') return [];
  if (Array.isArray(entry.rsns)) return entry.rsns.filter((r) => typeof r === 'string' && r);
  if (typeof entry.rsn === 'string' && entry.rsn) return [entry.rsn];
  return [];
}

function readJson(file, fallback) {
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    return data && typeof data === 'object' ? data : fallback;
  } catch {
    return fallback;
  }
}

// Pure row builder: callers pass the data, tests pass fixtures.
// input: {
//   standings: { userId: 'member' | 'guest' },   // recorded standing
//   links:     raw rsn-links.json object,
//   groupNames: [rsn],                            // Wise Old Man group
//   friendRsns: [rsn],                            // Friends of the Clan
//   typeByName: Map normName -> { label, iron } | null,
//   playerLabel: (userId) -> string,              // display label or ''
// }
// Returns rows: { list, rsn, type, inGroup, player, note }.
function buildRows(input) {
  const group = new Map(); // normName -> display rsn
  for (const name of input.groupNames || []) {
    const key = normName(name);
    if (key && !group.has(key)) group.set(key, name);
  }
  const friends = new Set((input.friendRsns || []).map(normName).filter(Boolean));
  const byKey = new Map(); // normName -> row seed
  const seed = (rsn) => {
    const key = normName(rsn);
    if (!key) return null;
    if (!byKey.has(key)) byKey.set(key, { rsn, ownerId: null, friend: false });
    return byKey.get(key);
  };
  for (const [userId, entry] of Object.entries(input.links || {})) {
    if (!input.standings || !(userId in input.standings)) continue;
    for (const rsn of entryRsns(entry)) {
      const row = seed(rsn);
      if (row && !row.ownerId) row.ownerId = userId;
    }
  }
  for (const name of input.groupNames || []) seed(name);
  for (const rsn of input.friendRsns || []) {
    const row = seed(rsn);
    if (row) row.friend = true;
  }

  const rows = [];
  for (const [key, s] of byKey.entries()) {
    const inGroup = group.has(key);
    const info = input.typeByName ? input.typeByName.get(key) : null;
    const type = info ? info.label : 'Unknown';
    let list;
    if (!inGroup) list = 'Not in the WOM group';
    else if (!info) list = 'Check first';
    else if (info.iron) list = 'Comp keep list';
    else list = 'Untick from comps';
    const notes = [];
    if (info && info.override) notes.push('Type marked by staff: Wise Old Man cannot see group ironmen');
    if (info && info.badge) notes.push('Type from their application pick');
    if (inGroup && !info) notes.push('Wise Old Man has no type for this account yet');
    if (inGroup && !s.ownerId) notes.push('In the group, not linked to a Discord account');
    if (s.friend || friends.has(key)) notes.push('Friend of the Clan');
    if (s.ownerId && input.standings && input.standings[s.ownerId] === 'guest') notes.push('Guest');
    rows.push({
      list,
      rsn: group.get(key) || s.rsn,
      type,
      inGroup,
      player: s.ownerId && input.playerLabel ? input.playerLabel(s.ownerId) || '' : '',
      note: notes.join('. '),
    });
  }
  rows.sort((a, b) => LIST_ORDER.indexOf(a.list) - LIST_ORDER.indexOf(b.list)
    || a.rsn.toLowerCase().localeCompare(b.rsn.toLowerCase()));
  return rows;
}

function csvCell(value) {
  const s = String(value == null ? '' : value);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsv(rows) {
  const lines = ['List,RSN,Type,In WOM group,Player,Note'];
  for (const r of rows) {
    lines.push([r.list, r.rsn, r.type, r.inGroup ? 'Yes' : 'No', r.player, r.note].map(csvCell).join(','));
  }
  return lines.join('\n') + '\n';
}

function toNames(rows) {
  return rows.filter((r) => r.list === 'Comp keep list').map((r) => r.rsn).join('\n') + '\n';
}

// Temp file + rename, for the plain-text outputs (store.atomicWrite is
// JSON-only).
function writeTextAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

let refreshing = null;

// Rebuild both roster files from live data. Safe to call any time;
// concurrent calls share one run. Returns the row counts per list.
async function refreshCompRoster(guild) {
  if (refreshing) return refreshing;
  refreshing = (async () => {
    try {
      const membership = readJson(MEMBERSHIP_FILE, {});
      const guildRecords = membership[config.guildId] || {};
      const standings = {};
      for (const [userId, rec] of Object.entries(guildRecords)) {
        if (rec && (rec.standing === 'member' || rec.standing === 'guest')) standings[userId] = rec.standing;
      }
      const links = readJson(LINKS_FILE, {});
      const groupNames = readJson(GROUP_FILE, []).map((e) => e && e.rsn).filter(Boolean);
      const friendRsns = readJson(FRIENDS_FILE, []).map((e) => e && e.rsn).filter(Boolean);

      // Type every RSN the roster might carry, through the bot's
      // cached, paced Wise Old Man lookups.
      const names = new Set(groupNames);
      for (const [userId, entry] of Object.entries(links)) {
        if (!(userId in standings)) continue;
        for (const rsn of entryRsns(entry)) names.add(rsn);
      }
      for (const rsn of friendRsns) names.add(rsn);
      const overrides = readJson(OVERRIDES_FILE, {});
      const overrideByName = new Map();
      for (const [rsn, type] of Object.entries(overrides)) {
        if (TYPE_INFO[type]) overrideByName.set(normName(rsn), { ...TYPE_INFO[type], override: true });
      }
      const badges = readJson(BADGES_FILE, {});
      const badgeByName = new Map();
      for (const rec of Object.values(badges.users || {})) {
        for (const [key, badge] of Object.entries((rec && rec.accounts) || {})) {
          if (!key.startsWith('r:')) continue;
          const info = BADGE_INFO[badge];
          if (info) badgeByName.set(normName(key.slice(2)), { ...info, badge: true });
        }
      }
      const typeByName = new Map();
      for (const rsn of names) {
        const key = normName(rsn);
        if (overrideByName.has(key)) {
          typeByName.set(key, overrideByName.get(key));
          continue;
        }
        if (badgeByName.has(key)) {
          typeByName.set(key, badgeByName.get(key));
          continue;
        }
        const stats = await getStats(rsn).catch(() => null);
        const info = stats && !stats.notFound ? TYPE_INFO[stats.accountType] : null;
        typeByName.set(key, info || null);
      }

      // Player labels from the guild when one is at hand; the files
      // still build without it (labels just stay blank).
      const labels = new Map();
      if (guild) {
        const ownerIds = new Set();
        for (const [userId, entry] of Object.entries(links)) {
          if (userId in standings && entryRsns(entry).length) ownerIds.add(userId);
        }
        for (const userId of ownerIds) {
          try {
            const member = guild.members.cache.get(userId) || (await guild.members.fetch(userId).catch(() => null));
            if (member) labels.set(userId, member.displayName || member.user.username);
          } catch { /* labels are decoration; never fail the roster on them */ }
        }
      }

      const rows = buildRows({
        standings,
        links,
        groupNames,
        friendRsns,
        typeByName,
        playerLabel: (userId) => labels.get(userId) || '',
      });
      writeTextAtomic(CSV_FILE, toCsv(rows));
      writeTextAtomic(NAMES_FILE, toNames(rows));
      jobStatus.recordOk(JOB);
      const counts = {};
      for (const r of rows) counts[r.list] = (counts[r.list] || 0) + 1;
      return counts;
    } catch (err) {
      jobStatus.failed(JOB, err, { label: 'Comp roster refresh failed' });
      throw err;
    } finally {
      refreshing = null;
    }
  })();
  return refreshing;
}

// Approvals and standing changes ask for a rebuild without waiting on
// it; bursts (approval + prelink + panel edits) coalesce into one run.
let refreshTimer = null;
function scheduleRefresh(guild) {
  if (refreshTimer) clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    refreshCompRoster(guild).catch(() => {});
  }, 20000);
  if (refreshTimer.unref) refreshTimer.unref();
}

// /comp-roster: rebuild, then hand staff the current files.
async function compRosterCommand(interaction) {
  await interaction.deferReply({ ephemeral: true });
  let counts;
  try {
    counts = await refreshCompRoster(interaction.guild);
  } catch {
    await interaction.editReply('The roster could not be rebuilt. The last good copy is unchanged.');
    return;
  }
  const { AttachmentBuilder } = require('discord.js');
  const files = [];
  for (const file of [CSV_FILE, NAMES_FILE]) {
    if (fs.existsSync(file)) files.push(new AttachmentBuilder(file));
  }
  const keep = counts['Comp keep list'] || 0;
  const untick = counts['Untick from comps'] || 0;
  await interaction.editReply({
    content: `Comp roster rebuilt. ${keep} iron name(s) on the keep list, ${untick} main name(s) to untick. The spreadsheet has every name; the text file is the keep list on its own.`,
    files,
  });
}

module.exports = { refreshCompRoster, scheduleRefresh, compRosterCommand, buildRows, toCsv, toNames, TYPE_INFO };
