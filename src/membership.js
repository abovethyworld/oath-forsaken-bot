// Who is a clan member, for systems that need the answer bot-side.
// Membership rule (set Nov 5, 2026): nobody is a member until they are in the
// clan chat. The clan chat roster is mirrored by the Wise Old Man
// group, whose membership the bot publishes to data/wom-group.json
// (src/friends.js). A Discord account is a member when any RSN linked
// to it (data/rsn-links.json) is on that list. Account-type roles
// (Iron Sworn / Unbound) are labels granted on application approval;
// they say nothing about membership and gate nothing here.
const fs = require('fs');
const path = require('path');
const store = require('./store');

const DATA_DIR = path.join(__dirname, '..', 'data');
const GROUP_FILE = path.join(DATA_DIR, 'wom-group.json');
const LINKS_FILE = path.join(DATA_DIR, 'rsn-links.json');

// OSRS names compare loosely: case, underscores, and spacing vary
// between the WOM group list and the link records.
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

// The set of Discord ids that are clan members, from link records and
// a WOM group name list. Pure: callers pass data, tests pass fixtures.
function computeMemberIds(links, groupNames) {
  const group = new Set((groupNames || []).map(normName).filter(Boolean));
  const out = new Set();
  if (!group.size) return out;
  for (const [userId, entry] of Object.entries(links || {})) {
    if (entryRsns(entry).some((rsn) => group.has(normName(rsn)))) out.add(userId);
  }
  return out;
}

// Normalized RSN -> owning Discord id, first link wins.
function computeOwnerMap(links) {
  const map = new Map();
  for (const [userId, entry] of Object.entries(links || {})) {
    for (const rsn of entryRsns(entry)) {
      const key = normName(rsn);
      if (key && !map.has(key)) map.set(key, userId);
    }
  }
  return map;
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

// Published WOM group names, or null when the file cannot be read, so
// callers can fail closed instead of treating everyone as a non-member.
function loadGroupNames() {
  const raw = readJson(GROUP_FILE);
  if (!Array.isArray(raw)) return null;
  return raw.map((x) => (x && typeof x.rsn === 'string' ? x.rsn : null)).filter(Boolean);
}

function loadLinks() {
  const raw = readJson(LINKS_FILE);
  return raw && typeof raw === 'object' ? raw : {};
}

// Live member set from the published files. Null when the group list
// is unreadable.
function memberIds() {
  const names = loadGroupNames();
  if (names === null) return null;
  return computeMemberIds(loadLinks(), names);
}

function isMember(userId) {
  const ids = memberIds();
  return ids !== null && ids.has(userId);
}

// One-time seed for the recorded-standing file (data/membership.json,
// ruling Nov 6, 2026: approval is the membership decision). Everyone
// the WOM-derived test above already calls a member, plus everyone
// currently holding a seniority rank role (ids passed in by the
// caller, which can see the guild), starts out recorded as a member
// so the recorded system begins from the standing people already
// have. Runs only while the guild has no records at all; an existing
// record set is never overwritten. When the WOM list is unreadable
// the seed falls back to rank holders alone rather than guessing.
function seedBackfill(guildId, rankHolderIds) {
  const existing = store.getMembership(guildId);
  if (Object.keys(existing).length) return 0;
  const ids = new Set(memberIds() || []);
  for (const id of rankHolderIds || []) {
    if (id) ids.add(String(id));
  }
  let seeded = 0;
  for (const id of ids) {
    store.setMembershipStanding(guildId, id, 'member', 'backfill');
    seeded++;
  }
  return seeded;
}

module.exports = {
  normName,
  entryRsns,
  computeMemberIds,
  computeOwnerMap,
  loadGroupNames,
  loadLinks,
  memberIds,
  isMember,
  seedBackfill,
};
