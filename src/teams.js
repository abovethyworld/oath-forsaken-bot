// Team finder: button panel -> activity picker -> per-activity form ->
// listing embed with Join/Leave or role-claim buttons. Organizer gets
// Close Team (organizer or staff).
// State lives in data/teams.json, same pattern as bounties.
const {
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  PermissionFlagsBits,
  AttachmentBuilder,
} = require('discord.js');
const fs = require('fs');
const path = require('path');
const config = require('./config');
const { isStaff, ZAMORAK_RED, DAY_MS } = require('./utils');
const { getStats } = require('./wom');
const { renderPartyBoard, MAX_ROWS } = require('./party-board');

const STATE_FILE = path.join(__dirname, '..', 'data', 'teams.json');
const EXPIRE_MS = 24 * 3600 * 1000; // unfilled teams and closed listings die after 24h

// ─── Activity templates ─────────────────────────────────────────────
// size: null = open/mass (no cap, never fills). {min,max} = organizer
// picks a number via buttons. {fixed:n} = fixed headcount, no input needed.
// roles: exclusive claim slots (ToB, BA) or pick-style (Yama: each
// player picks Mage or Melee, both can pick the same).
// pre: button step shown before the step flow (mode toggles).
const ACTIVITIES = {
  toa: {
    name: 'Tombs of Amascut Normal', short: 'Tombs of Amascut Normal', category: 'raids',
    size: { min: 1, max: 8 }, fillPing: true, partyHub: true,
  },
  toa_expert: {
    name: 'Tombs of Amascut Expert', short: 'Tombs of Amascut Expert', category: 'raids',
    size: { min: 1, max: 8 }, fillPing: true, partyHub: true,
  },
  cox: {
    name: 'Chambers of Xeric', short: 'CoX', category: 'raids',
    fillPing: true, partyHub: true,
  },
  cox_cm: {
    name: 'Chambers of Xeric CM', short: 'CoX CM', category: 'raids',
    fillPing: true, partyHub: true,
  },
  tob: {
    name: 'Theatre of Blood', short: 'ToB', category: 'raids',
    fillPing: true, partyHub: true, pre: 'tobScale',
    roleMode: 'exclusive',
    rolesByPre: {
      '4s': ['Mage', 'North FZ', 'RDPS', 'MDPS'],
      '5s': ['Mage', 'North FZ', 'RDPS', 'MDPS 1', 'MDPS 2'],
    },
  },
  tob_hard: {
    name: 'Hard Mode Theatre of Blood', short: 'ToB Hard Mode', category: 'raids',
    fillPing: true, partyHub: true, pre: 'tobScale',
    roleMode: 'exclusive',
    rolesByPre: {
      '4s': ['Mage', 'North FZ', 'RDPS', 'MDPS'],
      '5s': ['Mage', 'North FZ', 'RDPS', 'MDPS 1', 'MDPS 2'],
    },
  },
  wintertodt: {
    name: 'Wintertodt', category: 'skilling',
    size: null, fillPing: false, partyHub: false,
  },
  gotr: {
    name: 'Guardians of the Rift', category: 'skilling',
    size: null, fillPing: false, partyHub: false,
  },
  tempoross: {
    name: 'Tempoross', category: 'skilling',
    size: null, fillPing: false, partyHub: false,
  },
  zalcano: {
    name: 'Zalcano', category: 'skilling',
    size: null, fillPing: false, partyHub: true,
  },
  ba: {
    name: 'Barbarian Assault', category: 'skilling',
    size: { fixed: 5 }, fillPing: true, partyHub: true,
    roleMode: 'exclusive',
    roles: ['Attacker', 'Defender', 'Collector', 'Healer', 'Flex'],
  },
  nex: {
    name: 'Nex', category: 'bosses',
    size: { min: 1, max: 100 }, fillPing: true, partyHub: true,
  },
  yama: {
    name: 'Yama', category: 'bosses',
    size: { fixed: 2 }, fillPing: false, partyHub: true,
    roleMode: 'pick',
    roles: ['Mage', 'Melee'],
  },
  huey: {
    name: 'The Hueycoatl', category: 'bosses',
    size: { min: 1, max: 20 }, fillPing: false, partyHub: true, pre: 'hueyInstance',
  },
  royals: {
    name: 'Royal Titans', category: 'bosses',
    size: { fixed: 2 }, fillPing: false, partyHub: true,
  },
  venenatis: {
    name: 'Venenatis', category: 'bosses',
    size: { min: 1, max: 100, allowMass: true }, fillPing: false, partyHub: true,
  },
  callisto: {
    name: 'Callisto', category: 'bosses',
    size: { min: 1, max: 100, allowMass: true }, fillPing: false, partyHub: true,
  },
  vetion: {
    name: "Vet'ion", category: 'bosses',
    size: { min: 1, max: 100, allowMass: true }, fillPing: false, partyHub: true,
  },
  nm: {
    name: 'Nightmare', category: 'bosses',
    size: { min: 1, max: 5 }, partyHub: true, pre: 'nmMode',
  },
  wag: {
    name: 'Wilderness Agility', category: 'skilling',
    size: null, fillPing: false, partyHub: false, pre: 'wagWorld',
  },
};

const CATEGORIES = [
  { id: 'raids', label: 'Raids', emoji: '⚔️' },
  { id: 'skilling', label: 'Skilling Minigames', emoji: '⛏️' },
  { id: 'bosses', label: 'Group Bosses', emoji: '💀' },
];

// Custom emojis matching the #roles panel buttons.
const ACTIVITY_EMOJI = {
  toa: '<:toa:1558470672986939634>',
  toa_expert: '<:toa:1558470672986939634>',
  cox: '<:cox:1561158969379004510>',
  cox_cm: '<:cox:1561158969379004510>',
  tob: '<:tob:1561159051147223100>',
  tob_hard: '<:tob:1561159051147223100>',
  wintertodt: '<:wintertodt:1558470813584465960>',
  gotr: '<:gotr:1558470845918220318>',
  tempoross: '<:tempoross:1558470796752457779>',
  zalcano: '<:zalcano:1558470781946568724>',
  ba: '<:barbarianassault:1558470749919125557>',
  nex: '<:nex:1558470907956170923>',
  yama: '<:yama:1558470765639372800>',
  huey: '<:hueycoatl:1558470719078146068>',
  royals: '<:royaltitans:1558470734227972227>',
  venenatis: '<:venenatis:1558470861126897767>',
  callisto: '<:callisto:1558470876075270145>',
  vetion: '<:vetion:1558470891049062400>',
  nm: '<:nightmare:1558470923273637949>',
  wag: '<:wildyagility:1558470829187006547>',
};

// For select menus: { id, name } pairs.
const ACTIVITY_EMOJI_OBJ = {
  toa: { id: '1558470672986939634', name: 'toa' },
  toa_expert: { id: '1558470672986939634', name: 'toa' },
  cox: { id: '1561158969379004510', name: 'cox' },
  cox_cm: { id: '1561158969379004510', name: 'cox' },
  tob: { id: '1561159051147223100', name: 'tob' },
  tob_hard: { id: '1561159051147223100', name: 'tob' },
  wintertodt: { id: '1558470813584465960', name: 'wintertodt' },
  gotr: { id: '1558470845918220318', name: 'gotr' },
  tempoross: { id: '1558470796752457779', name: 'tempoross' },
  zalcano: { id: '1558470781946568724', name: 'zalcano' },
  ba: { id: '1558470749919125557', name: 'barbarianassault' },
  nex: { id: '1558470907956170923', name: 'nex' },
  yama: { id: '1558470765639372800', name: 'yama' },
  huey: { id: '1558470719078146068', name: 'hueycoatl' },
  royals: { id: '1558470734227972227', name: 'royaltitans' },
  venenatis: { id: '1558470861126897767', name: 'venenatis' },
  callisto: { id: '1558470876075270145', name: 'callisto' },
  vetion: { id: '1558470891049062400', name: 'vetion' },
  nm: { id: '1558470923273637949', name: 'nightmare' },
  wag: { id: '1558470829187006547', name: 'wildyagility' },
};

// Pre-modal button steps. Label shown on the listing too.
const PRE_CHOICES = {
  tobScale: {
    prompt: 'ToB scale',
    options: [
      { id: '4s', label: '4s' },
      { id: '5s', label: '5s' },
    ],
  },
  nmMode: {
    prompt: 'Nightmare team or mass',
    options: [
      { id: 'team', label: 'Team of 5' },
      { id: 'mass', label: 'Mass' },
    ],
  },
  hueyInstance: {
    prompt: 'Hueycoatl instance',
    options: [
      { id: 'public', label: 'Public' },
      { id: 'private', label: 'Private' },
    ],
  },
  wagWorld: {
    prompt: 'Wilderness Agility world type',
    options: [
      { id: 'mass', label: 'Mass world' },
      { id: 'quiet', label: 'Quiet world' },
    ],
  },
};

function preLabel(activityKey, preId) {
  if (!preId) return null;
  const found = (PRE_CHOICES[ACTIVITIES[activityKey]?.pre]?.options || []).find((o) => o.id === preId);
  return found ? found.label : preId;
}

function teamsChannelId() {
  return config.teams && config.teams.channelId;
}

function teamListingsChannelId() {
  // Listings post to #open-teams; falls back to the panel channel.
  return (config.teams && config.teams.listingsChannelId) || teamsChannelId();
}

// Split raid modes ping the same 3 raid roles.
const PING_ROLE_ALIAS = { toa_expert: 'toa', cox_cm: 'cox', tob_hard: 'tob' };
function activityRoleId(activityKey) {
  const roles = config.teams && config.teams.activityRoles;
  if (!roles) return null;
  return roles[activityKey] || roles[PING_ROLE_ALIAS[activityKey]] || null;
}

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return { teams: {} };
  }
}

function saveState(state) {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

// ─── Serialized state mutations ─────────────────────────────────────
// Every teams.json read-modify-write goes through this queue. Node is
// single-threaded but awaits interleave, so without this two taps can
// read the same state and the last write wins (lost joins, overfills).
let stateQueue = Promise.resolve();
function mutateTeams(fn) {
  const run = stateQueue.then(() => {
    const state = loadState();
    const result = fn(state);
    saveState(state);
    return result;
  });
  // A failure must not break the chain for later mutations.
  stateQueue = run.catch(() => {});
  return run;
}

// ─── RSN links (Discord user -> RuneScape name, for the party board) ──
const RSN_FILE = path.join(__dirname, '..', 'data', 'rsn-links.json');

function loadRsnLinks() {
  try {
    return JSON.parse(fs.readFileSync(RSN_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function saveRsnLinks(links) {
  fs.mkdirSync(path.dirname(RSN_FILE), { recursive: true });
  fs.writeFileSync(RSN_FILE, JSON.stringify(links, null, 2));
}

function getRsn(userId) {
  const entry = normalizeRsnEntry(loadRsnLinks()[userId]);
  return entry ? entry.active : null;
}

// RSN links support alts: {userId: {rsns: [...], active}}. Old single-RSN
// shape {rsn} is normalized on read.
function normalizeRsnEntry(entry) {
  if (!entry || typeof entry !== 'object') return null;
  if (Array.isArray(entry.rsns)) {
    const rsns = entry.rsns.filter((r) => typeof r === 'string' && r);
    if (!rsns.length) return null;
    return { rsns, active: rsns.includes(entry.active) ? entry.active : rsns[0] };
  }
  if (typeof entry.rsn === 'string' && entry.rsn) return { rsns: [entry.rsn], active: entry.rsn };
  return null;
}

function getRsnEntry(userId) {
  return normalizeRsnEntry(loadRsnLinks()[userId]) || { rsns: [], active: null };
}

function addRsn(userId, rsn) {
  const links = loadRsnLinks();
  const entry = normalizeRsnEntry(links[userId]) || { rsns: [], active: null };
  if (!entry.rsns.includes(rsn)) entry.rsns.push(rsn);
  entry.active = rsn;
  links[userId] = entry;
  saveRsnLinks(links);
  return entry;
}

function setActiveRsn(userId, rsn) {
  const links = loadRsnLinks();
  const entry = normalizeRsnEntry(links[userId]);
  if (!entry || !entry.rsns.includes(rsn)) return false;
  links[userId] = { rsns: entry.rsns, active: rsn };
  saveRsnLinks(links);
  return true;
}

// ─── Spec weapons (special-attack weapons members own) ──
const SPECS = [
  { id: 'bgs', label: 'BGS', name: 'Bandos godsword', cat: 'def' },
  { id: 'dwh', label: 'DWH', name: 'Dragon warhammer', cat: 'def' },
  { id: 'eldermaul', label: 'Elder maul', name: 'Elder maul', cat: 'def' },
  { id: 'tonalztics', label: 'Tonalztics', name: 'Tonalztics of Ralos', cat: 'def' },
  { id: 'accursed', label: 'Accursed', name: 'Accursed sceptre', cat: 'def' },
  { id: 'bonedagger', label: 'Bone dagger', name: 'Bone dagger', cat: 'def' },
  { id: 'emberlight', label: 'Emberlight', name: 'Emberlight', cat: 'def' },
  { id: 'eyeofayak', label: 'Eye of Ayak', name: 'Eye of Ayak', cat: 'def' },
  { id: 'soulflame', label: 'Soulflame', name: 'Soulflame horn', cat: 'off' },
  { id: 'zcb', label: 'ZCB', name: 'Zaryte crossbow', cat: 'off' },
  { id: 'voidwaker', label: 'Voidwaker', name: 'Voidwaker', cat: 'off' },
  { id: 'dragonclaws', label: 'D claws', name: 'Dragon claws', cat: 'off' },
  { id: 'burningclaws', label: 'Burning claws', name: 'Burning claws', cat: 'off' },
  { id: 'webweaver', label: 'Webweaver', name: 'Webweaver bow', cat: 'off' },
  { id: 'crimsonkisten', label: 'Kisten', name: 'Crimson kisten', cat: 'off' },
  { id: 'sgs', label: 'SGS', name: 'Saradomin godsword', cat: 'util' },
  { id: 'zgs', label: 'ZGS', name: 'Zamorak godsword', cat: 'util' },
  { id: 'dinhs', label: "Dinh's", name: "Dinh's bulwark", cat: 'util' },
];
const SPEC_CATS = [
  { id: 'def', label: 'Defense Lowering' },
  { id: 'off', label: 'Offensive' },
  { id: 'util', label: 'Utility' },
];
// Which spec icons can show per activity (wiki strategy pages, 2026-10-18).
const SPEC_DISPLAY = {
  toa: ['bgs', 'dwh', 'eldermaul', 'soulflame', 'zcb', 'voidwaker', 'dragonclaws', 'burningclaws', 'bonedagger', 'eyeofayak'],
  toa_expert: ['bgs', 'dwh', 'eldermaul', 'soulflame', 'zcb', 'voidwaker', 'dragonclaws', 'burningclaws', 'bonedagger', 'eyeofayak'],
  cox: ['bgs', 'dwh', 'eldermaul', 'tonalztics', 'zcb', 'voidwaker', 'dragonclaws', 'bonedagger', 'zgs'],
  cox_cm: ['bgs', 'dwh', 'eldermaul', 'tonalztics', 'zcb', 'voidwaker', 'dragonclaws', 'bonedagger', 'zgs'],
  tob: ['bgs', 'dwh', 'eldermaul', 'tonalztics', 'zcb', 'voidwaker', 'dragonclaws', 'burningclaws'],
  tob_hard: ['bgs', 'dwh', 'eldermaul', 'tonalztics', 'zcb', 'voidwaker', 'dragonclaws', 'burningclaws'],
  yama: ['bgs', 'dwh', 'eldermaul', 'accursed', 'soulflame', 'zcb', 'voidwaker', 'dragonclaws', 'burningclaws', 'sgs', 'emberlight', 'eyeofayak'],
  nex: ['zcb', 'voidwaker', 'burningclaws'],
  huey: ['dragonclaws', 'burningclaws', 'crimsonkisten'],
  royals: ['zcb', 'voidwaker', 'dragonclaws', 'burningclaws'],
  venenatis: ['dwh', 'eldermaul', 'webweaver', 'dinhs'],
  callisto: ['dwh', 'accursed', 'zcb', 'webweaver'],
  vetion: ['eldermaul'],
  nm: ['bgs', 'dwh', 'eldermaul', 'voidwaker', 'dragonclaws', 'crimsonkisten', 'sgs'],
  ba: ['dinhs', 'dragonclaws'],
};
function specsForActivity(activity) {
  return SPEC_DISPLAY[activity] || [];
}

const SPECS_FILE = path.join(__dirname, '..', 'data', 'specs.json');

function loadSpecs() {
  try {
    const raw = JSON.parse(fs.readFileSync(SPECS_FILE, 'utf8'));
    return raw && typeof raw === 'object' ? raw : {};
  } catch {
    return {};
  }
}

function saveSpecs(specs) {
  fs.mkdirSync(path.dirname(SPECS_FILE), { recursive: true });
  fs.writeFileSync(SPECS_FILE, JSON.stringify(specs, null, 2));
}

function validSpecId(id) {
  return SPECS.some((s) => s.id === id);
}

// Entry shape: { owned: [specId], show: { activity: [specId] } }.
// Migrates the old flat { userId: [specId] } shape on read.
function getSpecEntry(userId) {
  const specs = loadSpecs();
  let entry = specs[userId];
  if (Array.isArray(entry)) entry = { owned: entry, show: {} };
  if (!entry || typeof entry !== 'object') entry = { owned: [], show: {} };
  if (!Array.isArray(entry.owned)) entry.owned = [];
  if (!entry.show || typeof entry.show !== 'object') entry.show = {};
  return { specs, entry };
}

function getOwnedSpecs(userId) {
  const { entry } = getSpecEntry(userId);
  return entry.owned.filter(validSpecId);
}

function toggleOwnedSpec(userId, specId) {
  if (!validSpecId(specId)) return getOwnedSpecs(userId);
  const { specs, entry } = getSpecEntry(userId);
  const list = getOwnedSpecs(userId);
  const i = list.indexOf(specId);
  if (i >= 0) list.splice(i, 1);
  else list.push(specId);
  entry.owned = list;
  // Dropping ownership also drops it from every per-boss selection.
  for (const act of Object.keys(entry.show)) {
    entry.show[act] = (entry.show[act] || []).filter((id) => list.includes(id));
  }
  specs[userId] = entry;
  saveSpecs(specs);
  return list;
}

// Specs a member shows for an activity: their per-boss pick, defaulting
// to everything they own that is relevant there.
function getShownSpecs(userId, activity) {
  const { entry } = getSpecEntry(userId);
  const ownedRelevant = getOwnedSpecs(userId).filter((id) => specsForActivity(activity).includes(id));
  const sel = entry.show[activity];
  if (!Array.isArray(sel)) return ownedRelevant;
  return sel.filter((id) => ownedRelevant.includes(id));
}

function toggleShownSpec(userId, activity, specId) {
  const ownedRelevant = getOwnedSpecs(userId).filter((id) => specsForActivity(activity).includes(id));
  if (!ownedRelevant.includes(specId)) return getShownSpecs(userId, activity);
  const { specs, entry } = getSpecEntry(userId);
  const sel = getShownSpecs(userId, activity).slice();
  const i = sel.indexOf(specId);
  if (i >= 0) sel.splice(i, 1);
  else sel.push(specId);
  entry.show[activity] = sel;
  specs[userId] = entry;
  saveSpecs(specs);
  return sel;
}

// The board renders on every PvM team (headcount and role-claim).
// Skilling minigames keep text.
function boardApplies(team) {
  const act = ACTIVITIES[team.activity];
  return !!act && act.category !== 'skilling';
}

// WOM boss metric key for a team's KC column. Raids use the mode the
// team picked; other bosses use their WOM key (overridden where the
// activity id doesn't match).
const KC_METRIC_OVERRIDE = {
  nm: 'nightmare',
  huey: 'the_hueycoatl',
  royals: 'the_royal_titans',
};
// KC columns for the board, left to right. Dual columns show normal + hard
// (raids), nm + phosani (nightmare), or solo + group (wildy bosses).
// Each entry: { metric } plus { icon } for a WOM boss icon or { label }
// for a text header.
function kcColumnsForTeam(team) {
  const a = team.activity;
  if (a === 'toa' || a === 'toa_expert') return [
    { metric: 'tombs_of_amascut', icon: 'tombs_of_amascut' },
    { metric: 'tombs_of_amascut_expert', icon: 'tombs_of_amascut_expert' },
  ];
  if (a === 'cox' || a === 'cox_cm') return [
    { metric: 'chambers_of_xeric', icon: 'chambers_of_xeric' },
    { metric: 'chambers_of_xeric_challenge_mode', icon: 'chambers_of_xeric_challenge_mode' },
  ];
  if (a === 'tob' || a === 'tob_hard') return [
    { metric: 'theatre_of_blood', icon: 'theatre_of_blood' },
    { metric: 'theatre_of_blood_hard_mode', icon: 'theatre_of_blood_hard_mode' },
  ];
  if (a === 'nm') return [
    { metric: 'nightmare', icon: 'nightmare' },
    { metric: 'phosanis_nightmare', icon: 'phosanis_nightmare' },
  ];
  if (a === 'callisto') return [
    { metric: 'artio', label: 'Artio' },
    { metric: 'callisto', label: 'Callisto' },
  ];
  if (a === 'venenatis') return [
    { metric: 'spindel', label: 'Spindel' },
    { metric: 'venenatis', label: 'Venenatis' },
  ];
  if (a === 'vetion') return [
    { metric: 'calvarion', label: 'Calvarion' },
    { metric: 'vetion', label: "Vet'tion" },
  ];
  const metric = KC_METRIC_OVERRIDE[a] || a;
  return [{ metric, icon: metric }];
}

// Builds the party-board image for a team, or null when it shouldn't show
// (not a board team, or nobody has linked an RSN yet).
async function partyBoardFile(team, client) {
  if (!boardApplies(team)) return null;
  const ids = Object.keys(team.members || {});
  if (!ids.length) return null;
  const links = loadRsnLinks();
  const statsList = await Promise.all(
    ids.map((id) => {
      const rsnEntry = normalizeRsnEntry(links[id]);
      const rsn = rsnEntry ? rsnEntry.active : null;
      return rsn ? getStats(rsn).catch(() => null) : Promise.resolve(null);
    })
  );
  // Guild members for role-based badge fallback. Only fetched when needed.
  let membersById = null;
  const needRoles = ids.some((id, i) => {
    const st = statsList[i];
    return !getManualBadge(id) && !(st && !st.notFound && WOM_BADGE[st.accountType]);
  });
  if (needRoles && client) {
    try {
      const guild = client.guilds.cache.get(config.guildId) || await client.guilds.fetch(config.guildId).catch(() => null);
      if (guild) {
        const fetched = await guild.members.fetch({ user: ids }).catch(() => null);
        if (fetched) {
          membersById = {};
          for (const [mid, m] of fetched) membersById[mid] = m;
        }
      }
    } catch {
      // role fallback unavailable; badges just won't show for these members
    }
  }
  const kcCols = kcColumnsForTeam(team);
  const rows = ids.map((id, i) => {
    const st = statsList[i];
    const stats = st && !st.notFound
      ? [st.combat, st.attack, st.strength, st.ranged, st.magic, st.defence, st.hitpoints, st.prayer]
      : null;
    const rsnEntry = normalizeRsnEntry(links[id]);
    const rsn = rsnEntry ? rsnEntry.active : null;
    const specs = getShownSpecs(id, team.activity);
    const kc = kcCols.map((c) => {
      const kills = st && !st.notFound && st.kc ? st.kc[c.metric] : null;
      return typeof kills === 'number' ? kills : null;
    });
    const badge = getBadge(id, membersById && membersById[id], st && !st.notFound ? st : null);
    return { name: rsn || (team.memberNames || {})[id] || 'member', stats, specs, kc, badge };
  });
  if (!rows.some((r) => r.stats)) return null;
  const compact = getUserDefaults(team.organizerId).boardMode === 'compact';
  const buf = renderPartyBoard(rows, Math.max(0, rows.length - MAX_ROWS), { kcColumns: kcCols, compact });
  return new AttachmentBuilder(buf, { name: 'party-board.png' });
}

// ─── Pure helpers (unit-tested) ─────────────────────────────────────

// ToA raid level -> mode, per the OSRS wiki.
function toaModeForLevel(n) {
  if (n < 150) return 'Entry';
  if (n < 300) return 'Normal';
  if (n < 350) return 'Expert';
  return 'High Invo';
}

// "3+2" -> { raiders: 3, scalers: 2 }. "5" -> { raiders: 5, scalers: 0 }.
function parseCoxScale(str) {
  const m = /^\s*(\d{1,3})\s*(?:\+\s*(\d{1,3})\s*)?$/.exec(str || '');
  if (!m) return null;
  const raiders = parseInt(m[1], 10);
  const scalers = m[2] ? parseInt(m[2], 10) : 0;
  if (raiders < 1 || raiders > 100 || scalers < 0 || scalers > 99) return null;
  return { raiders, scalers };
}

function validateWorld(str) {
  return /^\d{3}$/.test((str || '').trim());
}

// Returns { size } where size is a number or null (open/mass),
// or { error } when the input is invalid.
function parseSizeInput(activityKey, str) {
  const act = ACTIVITIES[activityKey];
  const sizeCfg = act && act.size;
  if (!sizeCfg) return { size: null };
  if (sizeCfg.fixed) return { size: sizeCfg.fixed };
  const t = (str || '').trim().toLowerCase();
  if (sizeCfg.allowMass && t === 'mass') return { size: null };
  if (!/^\d{1,3}$/.test(t)) return { error: 'Team size must be a number.' };
  const n = parseInt(t, 10);
  if (n < sizeCfg.min || n > sizeCfg.max) {
    return { error: `Team size must be between ${sizeCfg.min} and ${sizeCfg.max}.` };
  }
  return { size: n };
}

function parseRaidLevel(str) {
  const t = (str || '').trim();
  if (!/^\d{1,4}$/.test(t)) return null;
  return parseInt(t, 10);
}

function rolesFor(activityKey, preId) {
  const act = ACTIVITIES[activityKey];
  if (!act || !act.roleMode) return null;
  if (act.rolesByPre) return act.rolesByPre[preId] || null;
  return act.roles || null;
}

function roleModeFor(activityKey) {
  const act = ACTIVITIES[activityKey];
  return (act && act.roleMode) || null;
}

// Nightmare: team mode fills at 5 with a ping, mass mode is open.
function nmSizeAndPing(preId) {
  if (preId === 'mass') return { size: null, fillPing: false };
  return { size: 5, fillPing: true };
}

function memberCount(team) {
  return Object.keys(team.members || {}).length;
}

function isTeamFull(team) {
  if (team.status !== 'open') return false;
  const mode = team.roleMode;
  if (mode === 'exclusive') {
    return (team.roles || []).every((r) => Object.values(team.members || {}).includes(r));
  }
  if (team.size == null) return false;
  return memberCount(team) >= team.size;
}

// ─── Pure state transitions (unit-tested, no Discord needed) ────────

function applyJoin(team, userId) {
  if (team.status !== 'open') return { ok: false, error: 'This team is no longer open.' };
  if (team.roleMode) return { ok: false, error: 'Pick a role button to join this team.' };
  if (team.members[userId]) return { ok: false, error: 'You are already in.' };
  if (team.size != null && memberCount(team) >= team.size) return { ok: false, error: 'Team is full.' };
  team.members[userId] = true;
  return { ok: true, filled: isTeamFull(team) };
}

function applyLeave(team, userId) {
  if (team.status !== 'open') return { ok: false, error: 'This team is no longer open.' };
  if (!team.members[userId]) return { ok: false, error: 'You are not in this team.' };
  delete team.members[userId];
  if (team.memberNames) delete team.memberNames[userId];
  return { ok: true };
}

// Exclusive (ToB, BA): one player per role, tap again to release, tap
// another role to switch. Pick (Yama): each player picks a style, tap
// again to leave.
function applyRoleClaim(team, userId, roleIdx) {
  if (team.status !== 'open') return { ok: false, error: 'This team is no longer open.' };
  const roles = team.roles || [];
  const role = roles[roleIdx];
  if (!role) return { ok: false, error: 'That role does not exist.' };
  const mode = team.roleMode;
  const current = team.members[userId];
  if (current === role) {
    delete team.members[userId];
    return { ok: true, action: 'released', filled: false };
  }
  if (mode === 'exclusive') {
    const taken = Object.entries(team.members).some(([id, r]) => id !== userId && r === role);
    if (taken) return { ok: false, error: 'That role is taken.' };
    team.members[userId] = role;
    return { ok: true, action: 'claimed', filled: isTeamFull(team) };
  }
  // pick mode
  if (!current && team.size != null && memberCount(team) >= team.size) {
    return { ok: false, error: 'Team is full.' };
  }
  team.members[userId] = role;
  return { ok: true, action: 'claimed', filled: isTeamFull(team) };
}

// ─── Embed + components (pure, unit-tested) ─────────────────────────

function teamTitle(team) {
  const act = ACTIVITIES[team.activity] || {};
  const emoji = ACTIVITY_EMOJI[team.activity] ? `${ACTIVITY_EMOJI[team.activity]} ` : '';
  const base = `${act.short || act.name || 'Team'} - Find a Team`;
  const pre = preLabel(team.activity, team.pre);
  if (team.status === 'closed') return `${emoji}${base} (Closed)`;
  return pre ? `${emoji}${base} (${pre})` : `${emoji}${base}`;
}

function buildTeamEmbed(team, opts) {
  const act = ACTIVITIES[team.activity] || {};
  const lines = [];
  const hideSignedUp = !!(opts && opts.hideSignedUp);

  if (team.activity === 'toa_expert' && team.raidLevel) {
    const tierLabels = { 'Expert': 'Expert (300-349)', 'High Invo': 'High Invo (350+)' };
    lines.push(`Raid level: ${tierLabels[team.raidLevel] || team.raidLevel}`);
  }
  if ((team.activity === 'cox' || team.activity === 'cox_cm') && team.scale) {
    const s = team.scale;
    lines.push(`Scale ${s.raiders}${s.scalers ? `+${s.scalers}` : ''}`);
  }
  if (team.activity === 'cox' && team.layout) {
    lines.push(`Layout: ${team.layout}`);
  }
  if (team.contract) lines.push(`Contract: ${team.contract}`);

  // Roles / members block
  const names = team.memberNames || {};
  if (team.roleMode === 'exclusive') {
    for (const role of team.roles || []) {
      const holder = Object.entries(team.members || {}).find(([, r]) => r === role);
      lines.push(`**${role}:** ${holder ? names[holder[0]] || 'claimed' : 'open'}`);
    }
  } else if (team.roleMode === 'pick') {
    for (const style of team.roles || []) {
      const holders = Object.entries(team.members || {})
        .filter(([, r]) => r === style)
        .map(([id]) => names[id] || 'claimed');
      lines.push(`**${style}:** ${holders.length ? holders.join(', ') : 'open'}`);
    }
  } else if (!hideSignedUp) {
    const memberIds = Object.keys(team.members || {});
    lines.push(`**Signed up:** ${memberIds.length ? memberIds.map((id) => names[id] || 'claimed').join(', ') : 'no one yet'}`);
  }

  lines.push('');
  if (team.world && team.region) lines.push(`🌍 **World:** ${team.world} (${team.region})`);
  else if (team.world) lines.push(`🌍 **World:** ${team.world}`);
  else if (team.region) lines.push(`🌍 **Region:** ${team.region}`);
  if (team.hub) lines.push(`👥 **Party hub:** ${team.hub}`);
  if (team.note) lines.push(`📝 **Note:** ${team.note}`);

  const count = memberCount(team);
  const denom = team.size != null ? team.size : (team.roleMode === 'exclusive' ? (team.roles || []).length : null);
  const sizeStr = team.mass ? 'Mass' : (denom ? `${count}/${denom}` : null);
  lines.push('');
  lines.push(sizeStr ? `Posted by ${names[team.organizerId] || 'organizer'} · ${sizeStr}` : `Posted by ${names[team.organizerId] || 'organizer'}`);
  if (team.status === 'closed') lines.push('**Closed.**');

  return new EmbedBuilder().setColor(ZAMORAK_RED).setTitle(teamTitle(team)).setDescription(lines.join('\n')).setTimestamp();
}

function shortName(name, max = 24) {
  return name.length > max ? `${name.slice(0, max - 1)}…` : name;
}

function buildListingComponents(team) {
  const rows = [];
  if (team.status === 'closed') return rows;
  const messageId = team.messageId;

  if (team.roleMode) {
    const names = team.memberNames || {};
    const roleRow = new ActionRowBuilder();
    (team.roles || []).forEach((role, idx) => {
      const holder = Object.entries(team.members || {}).find(([, r]) => r === role);
      const label = holder ? `${role}: ${shortName(names[holder[0]] || 'taken')}` : role;
      roleRow.addComponents(
        new ButtonBuilder().setCustomId(`team:role:${messageId}:${idx}`).setLabel(label.slice(0, 80)).setStyle(ButtonStyle.Danger)
      );
    });
    // Discord allows max 5 buttons per row; BA/ToB-5s have exactly 5.
    rows.push(roleRow);
  } else {
    rows.push(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`team:join:${messageId}`).setLabel('Join').setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId(`team:leave:${messageId}`).setLabel('Leave').setStyle(ButtonStyle.Danger)
      )
    );
  }

  const closeRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`team:close:${messageId}`).setLabel('Close Team').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`team:delete:${messageId}`).setLabel('Delete').setStyle(ButtonStyle.Danger)
  );
  if (specsForActivity(team.activity).length) {
    closeRow.addComponents(
      new ButtonBuilder().setCustomId(`team:specshow:${messageId}`).setLabel('Show Specs').setStyle(ButtonStyle.Danger).setEmoji('<:myspecs:1561409712426328297>')
    );
  }
  rows.push(closeRow);
  // Organizer/staff management row. Permission is checked on tap.
  const manageRow = new ActionRowBuilder();
  if (sizeOptionsFor(team.activity)) {
    manageRow.addComponents(
      new ButtonBuilder().setCustomId(`team:teamsize:${messageId}`).setLabel('Set Size').setStyle(ButtonStyle.Secondary)
    );
  }
  manageRow.addComponents(
    new ButtonBuilder().setCustomId(`team:teamworld:${messageId}`).setLabel('Set World').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`team:teamregion:${messageId}`).setLabel('Set Region').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`team:teamhub:${messageId}`).setLabel('Set Hub').setStyle(ButtonStyle.Secondary)
  );
  rows.push(manageRow);
  return rows;
}

// Size-lock options per activity for the post-creation Size button.
// Null means size is fixed or not applicable (no button).
function sizeOptionsFor(activity) {
  if (activity === 'toa' || activity === 'toa_expert') {
    return [...numOptions(2, 8), { id: 'any', label: 'Any size' }];
  }
  if (activity === 'nex') {
    return [
      { id: '2', label: '2' }, { id: '3', label: '3' }, { id: '5', label: '5' },
      { id: '8', label: '8' }, { id: 'mass', label: 'Mass (10+)' }, { id: 'any', label: 'Any size' },
    ];
  }
  if (activity === 'huey') {
    return [
      ...numOptions(3, 5), { id: 'mass', label: 'Mass' }, { id: 'any', label: 'Any size' },
    ];
  }
  if (['venenatis', 'callisto', 'vetion'].includes(activity)) {
    return [{ id: 'mass', label: 'Mass' }, { id: 'any', label: 'Any size' }];
  }
  return null;
}

function teamPanelPayload() {
  return {
    embeds: [
      new EmbedBuilder()
        .setColor(ZAMORAK_RED)
        .setTitle('⛧ Find a Team ⛧')
        .setDescription(
          'Need a group? Pick an activity, set it up, post it. Teams show up in #open-teams.\n\n' +
          '⛧ Link RSN ⛧\n' +
          'Link your RuneScape name once. Your stats show on the team board, pulled from Wise Old Man.\n\n' +
          '⛧ My Spec Weapons ⛧\n' +
          'Tap the spec weapons you own, so you can show what you have.\n\n' +
          '⛧ Settings ⛧\n' +
          'Your defaults: region, party hub, world, board style.'
        ),
    ],
    components: [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('team:create').setLabel('Create Team').setStyle(ButtonStyle.Danger).setEmoji('<:teamparty:1561409571220750398>'),
        new ButtonBuilder().setCustomId('team:rsn').setLabel('Link RSN').setStyle(ButtonStyle.Danger).setEmoji('<:rsnlink:1561409641399853117>'),
        new ButtonBuilder().setCustomId('team:specs').setLabel('My Spec Weapons').setStyle(ButtonStyle.Danger).setEmoji('<:myspecs:1561409712426328297>'),
        new ButtonBuilder().setCustomId('team:settings').setLabel('Settings').setStyle(ButtonStyle.Danger).setEmoji('<:teamsettings:1561560405594345533>'),
        new ButtonBuilder().setCustomId('team:myteams').setLabel('My Teams').setStyle(ButtonStyle.Secondary).setEmoji('📋')
      ),
    ],
  };
}

// ─── Settings popup: per-user defaults (region, hub, world, board style) ──
function settingsPanelPayload(userId, isStaffUser = false) {
  const d = getUserDefaults(userId);
  const regionLabel = (REGIONS.find((r) => r.id === d.region) || {}).label || 'not set';
  const boardLabel = d.boardMode === 'compact' ? 'Compact' : 'Complex';
  const rsnEntry = getRsnEntry(userId);
  const altCount = Math.max(0, rsnEntry.rsns.length - 1);
  const rsnLabel = rsnEntry.active ? rsnEntry.active + (altCount ? ` (+${altCount} alt${altCount > 1 ? 's' : ''})` : '') : 'not set';
  return {
    embeds: [
      new EmbedBuilder()
        .setColor(ZAMORAK_RED)
        .setTitle('⛧ Team Settings ⛧')
        .setDescription(
          'Your defaults. New teams you post use these.\n\n' +
          `🌍 Region: ${regionLabel}\n` +
          `👥 Party Hub: ${d.partyHub || 'not set'}\n` +
          `🌐 World: ${d.world || 'not set'}\n` +
          `📊 Board: ${boardLabel}\n` +
          `⚔️ RSN: ${rsnLabel}`
        ),
    ],
    components: [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('team:defregion').setLabel('Set Region').setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId('team:defhub').setLabel('Party Hub').setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId('team:defworld').setLabel('Set World').setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId('team:boardmode').setLabel(`Board: ${boardLabel}`).setStyle(ButtonStyle.Danger)
      ),
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('team:rsnswitch').setLabel('Switch RSN').setStyle(ButtonStyle.Danger).setEmoji('⚔️'),
        ...(isStaffUser ? [new ButtonBuilder().setCustomId('team:clearall').setLabel('Clear All Teams').setStyle(ButtonStyle.Danger).setEmoji('🗑️')] : [])
      ),
    ],
  };
}

// ─── RSN switching: link alts, pick the active name for team boards ──
function rsnSwitchPayload(userId) {
  const entry = getRsnEntry(userId);
  const rows = [];
  let row = new ActionRowBuilder();
  for (const rsn of entry.rsns) {
    if (row.components.length >= 5) {
      rows.push(row);
      row = new ActionRowBuilder();
    }
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(`team:rsnset:${encodeURIComponent(rsn)}`)
        .setLabel(rsn === entry.active ? `✓ ${rsn}` : rsn)
        .setStyle(ButtonStyle.Danger)
    );
  }
  if (row.components.length >= 5) {
    rows.push(row);
    row = new ActionRowBuilder();
  }
  row.addComponents(
    new ButtonBuilder().setCustomId('team:rsnadd').setLabel('Link new').setStyle(ButtonStyle.Danger).setEmoji('➕')
  );
  rows.push(row);
  return {
    content: entry.rsns.length
      ? 'Tap a name to show it on team boards.'
      : 'No names linked yet. Link one to show your stats on team boards.',
    components: rows,
    ephemeral: true,
  };
}

async function handleRsnSwitchButton(interaction) {
  await interaction.reply(rsnSwitchPayload(interaction.user.id)).catch((err) => console.warn('RSN switch failed:', err.message));
}

async function handleRsnSet(interaction, rsn) {
  const name = decodeURIComponent(rsn || '');
  if (!setActiveRsn(interaction.user.id, name)) return;
  const payload = rsnSwitchPayload(interaction.user.id);
  delete payload.ephemeral;
  await interaction.update(payload).catch((err) => console.warn('RSN set failed:', err.message));
  await refreshUserTeams(interaction.client, interaction.user.id);
}

async function handleRsnAddButton(interaction) {
  const modal = new ModalBuilder()
    .setCustomId('team:rsnaddmodal')
    .setTitle('Link another RuneScape name')
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('team:rsnvalue')
          .setLabel('RuneScape name')
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(12)
          .setPlaceholder('Zezima')
      )
    );
  await interaction.showModal(modal).catch((err) => console.warn('RSN add modal failed:', err.message));
}

async function readRsnFromModal(interaction) {
  await interaction.deferReply({ ephemeral: true }).catch(() => {});
  let rsn;
  try {
    rsn = interaction.fields.getTextInputValue('team:rsnvalue').trim().replace(/\s+/g, ' ');
  } catch {
    rsn = '';
  }
  if (!/^[A-Za-z0-9 ]{1,12}$/.test(rsn)) return { error: 'That name has characters RuneScape does not allow. Try again.' };
  const stats = await getStats(rsn).catch(() => null);
  if (stats && stats.notFound) return { error: 'Could not find that RuneScape name. Check the spelling and try again.' };
  if (!stats) return { error: 'Could not reach the stats service right now. Your name was not linked, try again in a bit.' };
  return { rsn, stats };
}

async function handleRsnAddModal(interaction) {
  const res = await readRsnFromModal(interaction);
  if (res.error) {
    await interaction.editReply(res.error).catch(() => {});
    return;
  }
  addRsn(interaction.user.id, res.rsn);
  await interaction
    .editReply({ content: `Linked **${res.rsn}** (combat ${res.stats.combat}). Now showing on team boards.`, components: [] })
    .catch((err) => console.warn('RSN add confirm failed:', err.message));
  await refreshUserTeams(interaction.client, interaction.user.id);
}

async function handleSettingsButton(interaction) {
  await interaction.reply({ ...settingsPanelPayload(interaction.user.id, isStaff(interaction)), ephemeral: true }).catch((err) => console.warn('Settings popup failed:', err.message));
}

async function handleClearAllTeams(interaction) {
  if (!isStaff(interaction)) {
    await interaction.reply({ content: 'Staff only.', ephemeral: true }).catch(() => {});
    return;
  }
  const res = await mutateTeams((state) => {
    const teams = Object.values(state.teams || {}).filter((t) => t.status === 'open');
    const ids = teams.map((t) => ({ messageId: t.messageId, channelId: t.channelId }));
    state.teams = {};
    return { ok: true, ids };
  }).catch(() => ({ ok: false }));
  if (!res.ok) {
    await interaction.reply({ content: 'Something went wrong.', ephemeral: true }).catch(() => {});
    return;
  }
  // Delete the listing messages.
  for (const { messageId, channelId } of res.ids) {
    try {
      const channel = await interaction.client.channels.fetch(channelId).catch(() => null);
      if (channel) await channel.messages.delete(messageId).catch(() => {});
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  await interaction.reply({ content: `Cleared ${res.ids.length} team${res.ids.length === 1 ? '' : 's'}.`, ephemeral: true }).catch(() => {});
}

async function handleMyTeamsButton(interaction) {
  const userId = interaction.user.id;
  const state = loadState();
  const mine = Object.values(state.teams || {}).filter(
    (t) => t.status === 'open' && (t.organizerId === userId || (t.members || {})[userId])
  );
  if (!mine.length) {
    await interaction.reply({ content: 'You have no open teams. Hit Create Team to start one.', ephemeral: true }).catch(() => {});
    return;
  }
  const lines = mine.map((t) => {
    const act = (ACTIVITIES[t.activity] || {}).name || t.activity;
    const url = `https://discord.com/channels/${config.guildId}/${t.channelId}/${t.messageId}`;
    const role = t.organizerId === userId ? 'organizer' : 'member';
    return `• [${act}](${url}) — ${role}`;
  });
  await interaction.reply({
    content: `⛧ Your Teams ⛧\n${lines.join('\n')}`,
    ephemeral: true,
  }).catch((err) => console.warn('My teams popup failed:', err.message));
}

async function handleBoardModeToggle(interaction) {
  const next = getUserDefaults(interaction.user.id).boardMode === 'compact' ? 'complex' : 'compact';
  setUserDefault(interaction.user.id, 'boardMode', next);
  await interaction.update(settingsPanelPayload(interaction.user.id, isStaff(interaction))).catch((err) => console.warn('Board mode toggle failed:', err.message));
}

async function handleDefWorldButton(interaction) {
  const current = getUserDefaults(interaction.user.id).world;
  const modal = new ModalBuilder()
    .setCustomId('team:defworldmodal')
    .setTitle('Default world')
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('team:defworldvalue')
          .setLabel('World number')
          .setStyle(TextInputStyle.Short)
          .setRequired(false)
          .setMaxLength(3)
          .setPlaceholder('302')
          .setValue(current ? String(current) : '')
      )
    );
  await interaction.showModal(modal).catch((err) => console.warn('Default world modal failed:', err.message));
}

async function handleDefWorldModal(interaction) {
  let world;
  try {
    world = interaction.fields.getTextInputValue('team:defworldvalue').trim();
  } catch {
    world = '';
  }
  const worldNum = validateWorld(world) ? parseInt(world, 10) : null;
  if (world && !worldNum) {
    await interaction.reply({ content: 'World must be a 3-digit number.', ephemeral: true })
      .catch((err) => console.warn('Default world reply failed:', err.message));
    return;
  }
  setUserDefault(interaction.user.id, 'world', worldNum);
  await interaction
    .reply({
      content: worldNum ? `Your default world is **${worldNum}**. New teams you post use it.` : 'Default world cleared.',
      ephemeral: true,
    })
    .catch((err) => console.warn('Default world confirm failed:', err.message));
}

function badgeRows(userId) {
  const current = getManualBadge(userId);
  const rows = [];
  let row = new ActionRowBuilder();
  for (const b of BADGES) {
    if (row.components.length >= 5) {
      rows.push(row);
      row = new ActionRowBuilder();
    }
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(`team:badgeset:${b.id}`)
        .setLabel(b.id === current ? `✓ ${b.label}` : b.label)
        .setStyle(b.id === current ? ButtonStyle.Danger : ButtonStyle.Secondary)
    );
  }
  if (row.components.length) rows.push(row);
  // Clear row.
  rows.push(
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('team:badgeset:none')
        .setLabel(current ? 'clear (use AUTO)' : 'AUTO')
        .setStyle(ButtonStyle.Secondary)
    )
  );
  return rows;
}

async function handleBadgeButton(interaction) {
  await interaction
    .reply({
      content: 'AUTO reads your linked RuneScape name and picks your account type for you. Tap one below to override it. (GIM can\'t be detected automatically, pick yours by hand.)',
      components: badgeRows(interaction.user.id),
      ephemeral: true,
    })
    .catch(() => {});
}

async function handleBadgeSet(interaction, badgeId) {
  const picked = badgeId === 'none' ? null : badgeId;
  setManualBadge(interaction.user.id, picked);
  const label = picked ? (BADGES.find((b) => b.id === picked) || {}).label || picked : 'AUTO';
  await interaction
    .update({
      content: `Account type set to **${label}**.\nAUTO reads your linked RuneScape name and picks your account type for you. Tap one below to override it. (GIM can't be detected automatically, pick yours by hand.)`,
      components: badgeRows(interaction.user.id),
    })
    .catch(() => {});
  // Refresh open teams so the board picks up the badge now.
  await refreshUserTeams(interaction.client, interaction.user.id, boardApplies);
}

// Refresh every open team a user is in, optionally filtered (e.g. only
// teams where the board or specs apply). Serial, so it paces itself.
async function refreshUserTeams(client, userId, filter) {
  const state = loadState();
  for (const team of Object.values(state.teams)) {
    if (team.status !== 'open' || !team.members || !team.members[userId]) continue;
    if (filter && !filter(team)) continue;
    await refreshListing(client, team).catch((err) => console.warn('User team refresh failed:', err.message));
  }
}

// ─── Creation flow ──────────────────────────────────────────────────

function categorySelectRow(catId) {
  const options = Object.entries(ACTIVITIES)
    .filter(([, a]) => a.category === catId)
    .map(([key, a]) => {
      const opt = { label: a.name, value: key };
      if (ACTIVITY_EMOJI_OBJ[key]) opt.emoji = ACTIVITY_EMOJI_OBJ[key];
      return opt;
    });
  return [
    new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder().setCustomId('team:pick').setPlaceholder('Pick an activity').addOptions(options)
    ),
  ];
}

function preChoiceRow(activityKey) {
  const act = ACTIVITIES[activityKey];
  const pre = PRE_CHOICES[act.pre];
  const row = new ActionRowBuilder();
  for (const o of pre.options) {
    row.addComponents(
      new ButtonBuilder().setCustomId(`team:pre:${activityKey}:${o.id}`).setLabel(o.label).setStyle(ButtonStyle.Danger)
    );
  }
  return { content: `**${act.name}:** ${pre.prompt}`, components: [row] };
}

const REGIONS = [
  { id: 'US-East', label: 'US East', emoji: '🇺🇸' },
  { id: 'US-West', label: 'US West', emoji: '🇺🇸' },
  { id: 'UK', label: 'United Kingdom', emoji: '🇬🇧' },
  { id: 'DE', label: 'Germany', emoji: '🇩🇪' },
  { id: 'AU', label: 'Australia', emoji: '🇦🇺' },
  { id: 'SG', label: 'Singapore', emoji: '🇸🇬' },
  { id: 'JP', label: 'Japan', emoji: '🇯🇵' },
];

// Step-by-step creation state. userId -> { activity, pre, steps, idx, data, expiresAt }.
const CREATION_EXPIRE_MS = 5 * 60 * 1000;
const pendingCreations = new Map();

function getCreation(userId) {
  const c = pendingCreations.get(userId);
  if (!c) return null;
  if (Date.now() > c.expiresAt) {
    pendingCreations.delete(userId);
    return null;
  }
  return c;
}

function numOptions(min, max) {
  const opts = [];
  for (let i = min; i <= max; i++) opts.push({ id: String(i), label: String(i) });
  return opts;
}

// Ordered step list for an activity (after any pre-choice). Each step:
// { id, kind: 'buttons'|'select'|'optionalText', prompt, ... }
function creationStepsFor(activityKey, preId) {
  const act = ACTIVITIES[activityKey];
  const steps = [];

  // Size, world, region, and hub are post-creation now (listing buttons
  // + panel defaults). Creation only asks activity-specific questions.
  if (activityKey === 'toa_expert') {
    steps.push({
      id: 'invo', kind: 'buttons', prompt: 'What invocation level?', options: [
        { id: 'Expert', label: 'Expert (300-349)' },
        { id: 'High Invo', label: 'High Invo (350+)' },
      ],
    });
  } else if (activityKey === 'cox') {
    steps.push({ id: 'raiders', kind: 'buttons', prompt: 'How many raiders?', options: numOptions(1, 10) });
    steps.push({
      id: 'scalers', kind: 'buttons', prompt: 'How many scaler alts?', options: [
        { id: '0', label: 'None' }, ...numOptions(1, 5),
      ],
    });
    steps.push({
      id: 'layout', kind: 'buttons', prompt: 'Which raid layout?', options: [
        { id: 'Normal', label: 'Normal' },
        { id: 'Large', label: 'Large' },
        { id: 'Full', label: 'Full' },
      ],
    });
  } else if (activityKey === 'cox_cm') {
    steps.push({ id: 'raiders', kind: 'buttons', prompt: 'How many raiders?', options: numOptions(1, 10) });
    steps.push({
      id: 'scalers', kind: 'buttons', prompt: 'How many scaler alts?', options: [
        { id: '0', label: 'None' }, ...numOptions(1, 5),
      ],
    });
  }
  // BA (5), Yama (2), Royal Titans (2) are fixed. ToB size comes from
  // roles. Everything else starts open; the organizer locks size after.
  // Wintertodt, GotR, Tempoross: mass world or small team?
  if (['wintertodt', 'gotr', 'tempoross'].includes(activityKey)) {
    steps.push({
      id: 'worldType', kind: 'buttons', prompt: 'Mass world or small team?',
      options: [{ id: 'mass', label: 'Mass world' }, { id: 'team', label: 'Small team' }],
    });
  }

  if (activityKey === 'yama') {
    steps.push({
      id: 'contract', kind: 'optionalText', prompt: 'Add a contract?',
      typeLabel: 'contract', modalTitle: 'Contract', modalLabel: 'Contract',
      modalPlaceholder: 'None',
    });
  }
  // Skilling minigames and Zalcano skip the note.
  if (!['wintertodt', 'gotr', 'tempoross', 'zalcano'].includes(activityKey)) {
    steps.push({
      id: 'note', kind: 'optionalText', prompt: 'Add a note?',
      typeLabel: 'note', modalTitle: 'Note', modalLabel: 'Note',
      modalPlaceholder: 'Learners welcome', paragraph: true,
    });
  }

  return steps;
}

function stepButtonsRows(stepId, options) {
  const rows = [];
  let row = new ActionRowBuilder();
  for (const o of options) {
    if (row.components.length >= 5) {
      rows.push(row);
      row = new ActionRowBuilder();
    }
    const btn = new ButtonBuilder()
      .setCustomId(`team:mk:${stepId}:${o.id}`)
      .setLabel(o.label)
      .setStyle(ButtonStyle.Danger);
    if (o.emoji) btn.setEmoji(o.emoji);
    row.addComponents(btn);
  }
  if (row.components.length) rows.push(row);
  return rows;
}

function renderCreationStep(creation) {
  const step = creation.steps[creation.idx];
  const act = ACTIVITIES[creation.activity];
  const title = `${ACTIVITY_EMOJI[creation.activity] || ''} ${act.name}`.trim();
  const content = `**${title}** (${creation.idx + 1}/${creation.steps.length})\n${step.prompt}`;
  let components;
  if (step.kind === 'buttons') {
    components = stepButtonsRows(step.id, step.options);
  } else if (step.kind === 'select') {
    components = [
      new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(`team:mksel:${step.id}`)
          .setPlaceholder(step.placeholder || 'Pick one')
          .addOptions(step.options.map((o) => ({ label: o.label, value: o.id })))
      ),
    ];
  } else {
    components = [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`team:mktype:${step.id}`).setLabel(`Type ${step.typeLabel}`).setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId(`team:mkskip:${step.id}`).setLabel('Skip').setStyle(ButtonStyle.Danger)
      ),
    ];
  }
  return { content, components };
}

async function startCreation(interaction, activityKey, preId) {
  const steps = creationStepsFor(activityKey, preId);
  const creation = {
    activity: activityKey,
    pre: preId || null,
    steps,
    idx: 0,
    data: {},
    expiresAt: Date.now() + CREATION_EXPIRE_MS,
  };
  pendingCreations.set(interaction.user.id, creation);
  const { content, components } = renderCreationStep(creation);
  await interaction.update({ content, components }).catch(() => {});
}

async function advanceCreation(interaction, creation) {
  creation.idx += 1;
  creation.expiresAt = Date.now() + CREATION_EXPIRE_MS;
  if (creation.idx >= creation.steps.length) {
    await finalizeCreation(interaction, creation);
    return;
  }
  const { content, components } = renderCreationStep(creation);
  await interaction.update({ content, components }).catch(() => {});
}

function buildTeamFromData(activityKey, preId, data, organizer) {
  // Returns { team } or { error }. Pure.
  const act = ACTIVITIES[activityKey];
  if (!act) return { error: 'Unknown activity.' };

  // Region, hub, and world come from the organizer's settings.
  // Size is set after posting via the listing buttons.
  // Skilling activities with world-type choices (mass/quiet) don't take a numeric world.
  const defaults = getUserDefaults(organizer.id);
  const takesWorld = !['wintertodt', 'gotr', 'tempoross', 'wag'].includes(activityKey);
  const team = {
    activity: activityKey,
    organizerId: organizer.id,
    memberNames: { [organizer.id]: organizer.displayName },
    members: {},
    roles: rolesFor(activityKey, preId),
    roleMode: roleModeFor(activityKey),
    pre: preId || null,
    world: takesWorld ? defaults.world || null : null,
    region: defaults.region || null,
    hub: defaults.partyHub || null,
    note: data.note || null,
    contract: null,
    scale: null,
    raidLevel: null,
    layout: null,
    size: null,
    mass: false,
    fillPing: !!act.fillPing,
    fillPingMsgId: null,
    status: 'open',
    createdAt: Date.now(),
    closedAt: null,
    messageId: null,
    channelId: null,
  };

  // Organizer is in from the start on headcount teams. Role-based teams
  // (ToB, BA, Yama) join by claiming a role button instead.
  if (!team.roleMode) team.members[organizer.id] = true;

  // Size: fixed sizes and NM modes are set here; everything else starts
  // open and the organizer locks it from the listing.
  if (activityKey === 'nm') {
    const nmCfg = nmSizeAndPing(preId);
    team.fillPing = nmCfg.fillPing;
    if (preId === 'mass') {
      team.mass = true;
    } else if (preId === 'team') {
      team.size = 5;
    }
  } else if (act.size && act.size.fixed) {
    team.size = act.size.fixed;
  }

  if (activityKey === 'toa_expert') {
    if (!data.invo) return { error: 'Pick an invocation level.' };
    team.raidLevel = data.invo;
  }
  if (activityKey === 'cox' || activityKey === 'cox_cm') {
    if (!data.raiders) return { error: 'Pick how many raiders.' };
    team.scale = { raiders: data.raiders, scalers: data.scalers || 0 };
    team.size = data.raiders;
  }
  if (activityKey === 'cox') team.layout = data.layout || null;
  if ((activityKey === 'tob' || activityKey === 'tob_hard') && !team.roles) {
    return { error: 'Pick 4s or 5s first.' };
  }
  if (activityKey === 'yama') team.contract = data.contract || null;

  return { team };
}

async function finalizeCreation(interaction, creation) {
  pendingCreations.delete(interaction.user.id);
  const { team, error } = buildTeamFromData(creation.activity, creation.pre, creation.data, interaction.user);
  if (error || !team) {
    await interaction.update({ content: error || 'Could not build that team.', components: [] }).catch(() => {});
    return;
  }

  const channelId = teamListingsChannelId();
  if (!channelId) {
    await interaction.update({ content: 'Team finder is not set up yet. Tell staff.', components: [] }).catch(() => {});
    return;
  }
  const channel = await interaction.client.channels.fetch(channelId).catch(() => null);
  if (!channel || !channel.isTextBased()) {
    await interaction.update({ content: 'Could not find the team listings channel. Tell staff.', components: [] }).catch(() => {});
    return;
  }

  await interaction.update({ content: 'Posting your team...', components: [] }).catch(() => {});

  const roleId = activityRoleId(creation.activity);
  const content = roleId ? `<@&${roleId}>` : null;
  let msg;
  try {
    team.channelId = channel.id;
    const file = await partyBoardFile(team, interaction.client).catch(() => null);
    const embed = buildTeamEmbed(team, { hideSignedUp: !!file });
    if (file) embed.setImage('attachment://party-board.png');
    msg = await channel.send({
      content,
      embeds: [embed],
      components: buildListingComponents({ ...team, messageId: 'pending' }),
      files: file ? [file] : [],
    });
  } catch (err) {
    console.error('Team post failed:', err.message);
    await interaction.followUp({ content: 'Could not post that team. Tell staff.', ephemeral: true }).catch(() => {});
    return;
  }

  team.messageId = msg.id;
  const state = loadState();
  state.teams[msg.id] = team;
  saveState(state);

  // Patch the buttons with the real message id now that we have it.
  await msg.edit({ components: buildListingComponents(team) }).catch((err) => console.warn('Team button patch failed:', err.message));

  await interaction.followUp({ content: 'Team posted.', ephemeral: true }).catch(() => {});
  await maybeNudgeRsn(interaction, interaction.user.id);
}

// ─── Step interaction handlers ──────────────────────────────────────

async function handleStepButton(interaction, stepId, value) {
  const creation = getCreation(interaction.user.id);
  if (!creation) {
    await interaction.reply({ content: 'That creation expired. Start over with Create Team.', ephemeral: true }).catch(() => {});
    return;
  }
  const step = creation.steps[creation.idx];
  if (!step || step.id !== stepId || step.kind !== 'buttons') {
    await interaction.reply({ content: 'Out of sync. Start over with Create Team.', ephemeral: true }).catch(() => {});
    return;
  }
  const valid = (step.options || []).some((o) => o.id === value);
  if (!valid) {
    await interaction.reply({ content: 'That is not a valid choice.', ephemeral: true }).catch(() => {});
    return;
  }
  // Store numbers as numbers, keep ids like 'mass' as strings.
  creation.data[stepId] = /^\d+$/.test(value) ? parseInt(value, 10) : value;
  await advanceCreation(interaction, creation);
}

async function handleStepSelect(interaction) {
  // customId 'team:mksel:<stepId>', values[0] = choice
  const stepId = interaction.customId.split(':')[2];
  const value = interaction.values && interaction.values[0];
  const creation = getCreation(interaction.user.id);
  if (!creation) {
    await interaction.reply({ content: 'That creation expired. Start over with Create Team.', ephemeral: true }).catch(() => {});
    return;
  }
  const step = creation.steps[creation.idx];
  if (!step || step.id !== stepId || step.kind !== 'select' || !value) {
    await interaction.reply({ content: 'Out of sync. Start over with Create Team.', ephemeral: true }).catch(() => {});
    return;
  }
  const valid = (step.options || []).some((o) => o.id === value);
  if (!valid) {
    await interaction.reply({ content: 'That is not a valid choice.', ephemeral: true }).catch(() => {});
    return;
  }
  creation.data[stepId] = /^\d+$/.test(value) ? parseInt(value, 10) : value;
  await advanceCreation(interaction, creation);
}

async function handleStepTypeOpen(interaction, stepId) {
  const creation = getCreation(interaction.user.id);
  if (!creation) {
    await interaction.reply({ content: 'That creation expired. Start over with Create Team.', ephemeral: true }).catch(() => {});
    return;
  }
  const step = creation.steps[creation.idx];
  if (!step || step.id !== stepId || step.kind !== 'optionalText') {
    await interaction.reply({ content: 'Out of sync. Start over with Create Team.', ephemeral: true }).catch(() => {});
    return;
  }
  const modal = new ModalBuilder()
    .setCustomId(`team:mkmodal:${stepId}`)
    .setTitle((step.modalTitle || 'Details').slice(0, 45))
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('team:mkvalue')
          .setLabel((step.modalLabel || 'Value').slice(0, 45))
          .setStyle(step.paragraph ? TextInputStyle.Paragraph : TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(stepId === 'note' ? 200 : 50)
          .setPlaceholder(step.modalPlaceholder || '')
      )
    );
  await interaction.showModal(modal).catch(() => {});
}

async function handleStepSkip(interaction, stepId) {
  const creation = getCreation(interaction.user.id);
  if (!creation) {
    await interaction.reply({ content: 'That creation expired. Start over with Create Team.', ephemeral: true }).catch(() => {});
    return;
  }
  const step = creation.steps[creation.idx];
  if (!step || step.id !== stepId || step.kind !== 'optionalText') {
    await interaction.reply({ content: 'Out of sync. Start over with Create Team.', ephemeral: true }).catch(() => {});
    return;
  }
  creation.data[stepId] = null;
  await advanceCreation(interaction, creation);
}

async function handleStepModal(interaction) {
  // customId 'team:mkmodal:<stepId>'
  const stepId = interaction.customId.split(':')[2];
  const creation = getCreation(interaction.user.id);
  if (!creation) {
    await interaction.reply({ content: 'That creation expired. Start over with Create Team.', ephemeral: true }).catch(() => {});
    return;
  }
  const step = creation.steps[creation.idx];
  if (!step || step.id !== stepId || step.kind !== 'optionalText') {
    await interaction.reply({ content: 'Out of sync. Start over with Create Team.', ephemeral: true }).catch(() => {});
    return;
  }
  let value;
  try {
    value = interaction.fields.getTextInputValue('team:mkvalue').trim();
  } catch {
    value = '';
  }
  if (!value) {
    await interaction.reply({ content: 'That was blank. Try again or hit Skip.', ephemeral: true }).catch(() => {});
    return;
  }
  if (stepId === 'world' && !validateWorld(value)) {
    await interaction.reply({ content: 'World must be a 3-digit number.', ephemeral: true }).catch(() => {});
    return;
  }
  creation.data[stepId] = value;
  await advanceCreation(interaction, creation);
}

// ─── RSN linking (party board) ──────────────────────────────────────

function rsnLinkRow() {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('team:rsn').setLabel('Link RSN').setStyle(ButtonStyle.Danger).setEmoji('🔗')
    ),
  ];
}

async function handleRsnButton(interaction) {
  const modal = new ModalBuilder()
    .setCustomId('team:rsnmodal')
    .setTitle('Link your RuneScape name')
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('team:rsnvalue')
          .setLabel('RuneScape name')
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(12)
          .setPlaceholder('MyRSN')
      )
    );
  await interaction.showModal(modal).catch(() => {});
}

// ─── Account badges: manual pick overrides WOM type, else Discord role ──
const BADGES_FILE = path.join(__dirname, '..', 'data', 'badges.json');
// Badge ids match assets/party-board/badge-icons/<id>.png.
const BADGES = [
  { id: 'ironman', label: 'IM' },
  { id: 'hc', label: 'HCIM' },
  { id: 'ult', label: 'UIM' },
  { id: 'gim', label: 'GIM' },
  { id: 'hcgim', label: 'HCGIM' },
  { id: 'main', label: 'MAIN' },
];
const IRON_SWORN_ROLE = '1558540424048803860';
const UNBOUND_ROLE = '1558540434652008569';

function loadBadges() {
  try {
    const raw = JSON.parse(fs.readFileSync(BADGES_FILE, 'utf8'));
    return raw && typeof raw === 'object' ? raw : {};
  } catch {
    return {};
  }
}

function saveBadges(badges) {
  fs.mkdirSync(path.dirname(BADGES_FILE), { recursive: true });
  fs.writeFileSync(BADGES_FILE, JSON.stringify(badges, null, 2));
}

function getManualBadge(userId) {
  const id = loadBadges()[userId];
  return BADGES.some((b) => b.id === id) ? id : null;
}

function setManualBadge(userId, badgeId) {
  const badges = loadBadges();
  if (badgeId && BADGES.some((b) => b.id === badgeId)) badges[userId] = badgeId;
  else delete badges[userId];
  saveBadges(badges);
}

// WOM account types -> badge ids. Regular covers mains AND group irons
// (WOM can't tell them apart), so regular maps to the main badge and
// group badges are manual-only.
const WOM_BADGE = { ironman: 'ironman', hardcore: 'hc', ultimate: 'ult', regular: 'main' };

function getBadge(userId, member, stats) {
  const manual = getManualBadge(userId);
  if (manual) return manual;
  if (stats && WOM_BADGE[stats.accountType]) return WOM_BADGE[stats.accountType];
  const roles = (member && member.roles && member.roles.cache) || null;
  if (roles) {
    if (roles.has(IRON_SWORN_ROLE)) return 'ironsworn';
    if (roles.has(UNBOUND_ROLE)) return 'main';
  }
  return null;
}

// ─── User defaults: region + party hub, set from the panel ──
const DEFAULTS_FILE = path.join(__dirname, '..', 'data', 'user-defaults.json');

function loadDefaults() {
  try {
    const raw = JSON.parse(fs.readFileSync(DEFAULTS_FILE, 'utf8'));
    return raw && typeof raw === 'object' ? raw : {};
  } catch {
    return {};
  }
}

function saveDefaults(defaults) {
  fs.mkdirSync(path.dirname(DEFAULTS_FILE), { recursive: true });
  fs.writeFileSync(DEFAULTS_FILE, JSON.stringify(defaults, null, 2));
}

function getUserDefaults(userId) {
  const d = loadDefaults()[userId];
  if (!d || typeof d !== 'object') return {};
  return {
    region: d.region || null,
    partyHub: d.partyHub || null,
    world: d.world || null,
    boardMode: d.boardMode === 'compact' ? 'compact' : 'complex',
  };
}

function setUserDefault(userId, key, value) {
  const defaults = loadDefaults();
  const entry = (defaults[userId] && typeof defaults[userId] === 'object') ? defaults[userId] : {};
  if (value) entry[key] = value;
  else delete entry[key];
  defaults[userId] = entry;
  saveDefaults(defaults);
  return getUserDefaults(userId);
}

// ─── My Spec Weapons: one-time toggle of owned spec weapons ──
function mySpecsRows(userId) {
  const owned = getOwnedSpecs(userId);
  const rows = [];
  for (const cat of SPEC_CATS) {
    let row = new ActionRowBuilder();
    for (const spec of SPECS.filter((s) => s.cat === cat.id)) {
      if (row.components.length >= 5) {
        rows.push(row);
        row = new ActionRowBuilder();
      }
      const has = owned.includes(spec.id);
      row.addComponents(
        new ButtonBuilder()
          .setCustomId(`team:spectoggle:${spec.id}`)
          .setLabel(has ? `✓ ${spec.label}` : spec.label)
          .setStyle(has ? ButtonStyle.Danger : ButtonStyle.Secondary)
      );
    }
    if (row.components.length) rows.push(row);
  }
  return rows;
}

function mySpecsText(userId) {
  const owned = getOwnedSpecs(userId);
  const names = owned.map((id) => SPECS.find((s) => s.id === id).label);
  const line = names.length ? `Your spec weapons: **${names.join(', ')}**.` : 'You have no spec weapons set.';
  return `${line}\nDefense lowering first, then offensive, then utility.\nTap to add or remove. They show on team boards where they're useful.`;
}

async function handleMySpecsButton(interaction) {
  await interaction
    .reply({
      content: mySpecsText(interaction.user.id),
      components: mySpecsRows(interaction.user.id),
      ephemeral: true,
    })
    .catch(() => {});
}

async function handleMySpecsToggle(interaction, specId) {
  toggleOwnedSpec(interaction.user.id, specId);
  await interaction
    .update({
      content: mySpecsText(interaction.user.id),
      components: mySpecsRows(interaction.user.id),
    })
    .catch(() => {});
  // Refresh open raid teams so the board picks up the change now.
  await refreshUserTeams(interaction.client, interaction.user.id, (team) => specsForActivity(team.activity).length > 0);
}

// ─── Per-team Specs button: pick which owned specs show for that boss ──
function teamSpecsRows(userId, team, messageId) {
  const showing = getShownSpecs(userId, team.activity);
  const owned = getOwnedSpecs(userId).filter((id) => specsForActivity(team.activity).includes(id));
  const rows = [];
  let row = new ActionRowBuilder();
  for (const spec of SPECS.filter((s) => owned.includes(s.id))) {
    if (row.components.length >= 5) {
      rows.push(row);
      row = new ActionRowBuilder();
    }
    const on = showing.includes(spec.id);
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(`team:specshowtoggle:${messageId}:${spec.id}`)
        .setLabel(on ? `✓ ${spec.label}` : spec.label)
        .setStyle(on ? ButtonStyle.Danger : ButtonStyle.Secondary)
    );
  }
  if (row.components.length) rows.push(row);
  return rows;
}

function teamSpecsText(userId, team) {
  const act = ACTIVITIES[team.activity] || {};
  return `Specs you'll show on this ${act.short || act.name || 'team'} team:\nTap to add or remove. Change it anytime.`;
}

function findTeamByMessage(messageId) {
  const state = loadState();
  const team = state.teams[messageId];
  return team && team.status === 'open' ? team : undefined;
}

async function handleTeamSpecsButton(interaction, messageId) {
  const team = findTeamByMessage(messageId);
  if (!team) return;
  const userId = interaction.user.id;
  if (!team.members || !team.members[userId]) {
    await interaction.reply({ content: 'Join the team first.', ephemeral: true }).catch(() => {});
    return;
  }
  const owned = getOwnedSpecs(userId).filter((id) => specsForActivity(team.activity).includes(id));
  if (!owned.length) {
    const act = ACTIVITIES[team.activity] || {};
    await interaction
      .reply({ content: `You don't own any spec weapons useful for ${act.short || act.name || 'this'}. Set them with My Spec Weapons first.`, ephemeral: true })
      .catch(() => {});
    return;
  }
  await interaction
    .reply({
      content: teamSpecsText(userId, team),
      components: teamSpecsRows(userId, team, messageId),
      ephemeral: true,
    })
    .catch(() => {});
}

async function handleTeamSpecsToggle(interaction, messageId, specId) {
  const team = findTeamByMessage(messageId);
  if (!team) return;
  if (!team.members || !team.members[interaction.user.id]) {
    await interaction.reply({ content: 'Join the team first.', ephemeral: true })
      .catch((err) => console.warn('Spec show toggle reply failed:', err.message));
    return;
  }
  toggleShownSpec(interaction.user.id, team.activity, specId);
  await interaction
    .update({
      content: teamSpecsText(interaction.user.id, team),
      components: teamSpecsRows(interaction.user.id, team, messageId),
    })
    .catch(() => {});
  await refreshListing(interaction.client, team).catch(() => {});
}

// ─── Panel defaults: region + party hub ──
function defRegionRows(userId) {
  const current = getUserDefaults(userId).region;
  const rows = [];
  let row = new ActionRowBuilder();
  for (const r of REGIONS) {
    if (row.components.length >= 5) {
      rows.push(row);
      row = new ActionRowBuilder();
    }
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(`team:defregionset:${r.id}`)
        .setLabel(r.id === current ? `✓ ${r.label}` : r.label)
        .setStyle(r.id === current ? ButtonStyle.Danger : ButtonStyle.Secondary)
        .setEmoji(r.emoji)
    );
  }
  if (row.components.length) rows.push(row);
  return rows;
}

function defRegionText(userId) {
  const current = getUserDefaults(userId).region;
  const label = REGIONS.find((r) => r.id === current)?.label;
  return `${label ? `Your default region is **${label}**.` : 'You have no default region set.'}\nNew teams you post use it automatically.`;
}

async function handleDefRegionButton(interaction) {
  await interaction
    .reply({
      content: defRegionText(interaction.user.id),
      components: defRegionRows(interaction.user.id),
      ephemeral: true,
    })
    .catch(() => {});
}

async function handleDefRegionSet(interaction, regionId) {
  if (!REGIONS.some((r) => r.id === regionId)) return;
  setUserDefault(interaction.user.id, 'region', regionId);
  await interaction
    .update({
      content: defRegionText(interaction.user.id),
      components: defRegionRows(interaction.user.id),
    })
    .catch(() => {});
}

async function handleDefHubButton(interaction) {
  const current = getUserDefaults(interaction.user.id).partyHub;
  const modal = new ModalBuilder()
    .setCustomId('team:defhubmodal')
    .setTitle('Default party hub')
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('team:defhubvalue')
          .setLabel('Party hub name (RuneLite Party plugin)')
          .setStyle(TextInputStyle.Short)
          .setRequired(false)
          .setMaxLength(32)
          .setPlaceholder('oath1')
          .setValue(current || '')
      )
    );
  await interaction.showModal(modal).catch(() => {});
}

async function handleDefHubModal(interaction) {
  let hub;
  try {
    hub = interaction.fields.getTextInputValue('team:defhubvalue').trim();
  } catch {
    hub = '';
  }
  setUserDefault(interaction.user.id, 'partyHub', hub || null);
  await interaction
    .reply({
      content: hub ? `Your default party hub is **${hub}**. New teams you post use it.` : 'Default party hub cleared.',
      ephemeral: true,
    })
    .catch(() => {});
}

// ─── Per-listing management: size lock, world, region, hub (organizer/staff) ──
function canManageTeam(interaction, team) {
  return interaction.user.id === team.organizerId || isStaff(interaction);
}

function teamSizeRows(team, messageId) {
  const rows = [];
  let row = new ActionRowBuilder();
  for (const o of sizeOptionsFor(team.activity) || []) {
    if (row.components.length >= 5) {
      rows.push(row);
      row = new ActionRowBuilder();
    }
    const active = (o.id === 'mass' && team.mass) || (o.id !== 'mass' && o.id !== 'any' && team.size === parseInt(o.id, 10)) || (o.id === 'any' && team.size == null && !team.mass);
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(`team:teamsizeset:${messageId}:${o.id}`)
        .setLabel(active ? `✓ ${o.label}` : o.label)
        .setStyle(active ? ButtonStyle.Danger : ButtonStyle.Secondary)
    );
  }
  if (row.components.length) rows.push(row);
  return rows;
}

async function handleTeamSizeButton(interaction, messageId) {
  const team = findTeamByMessage(messageId);
  if (!team) return;
  if (!canManageTeam(interaction, team)) {
    await interaction.reply({ content: 'Only the organizer or staff can change this.', ephemeral: true }).catch(() => {});
    return;
  }
  await interaction
    .reply({
      content: 'Lock this team to a size, or leave it open.',
      components: teamSizeRows(team, messageId),
      ephemeral: true,
    })
    .catch(() => {});
}

async function handleTeamSizeSet(interaction, messageId, value) {
  let team = findTeamByMessage(messageId);
  if (!team || !canManageTeam(interaction, team)) return;
  if (!['any', 'mass'].includes(value) && !/^\d+$/.test(value || '')) return;
  const res = await mutateTeams((state) => {
    const t = state.teams[messageId];
    if (!t || t.status !== 'open') return { error: 'That team is gone.' };
    if (value === 'any') {
      t.size = null;
      t.mass = false;
    } else if (value === 'mass') {
      t.size = null;
      t.mass = true;
    } else {
      t.size = parseInt(value, 10);
      t.mass = false;
    }
    return { ok: true };
  }).catch((err) => {
    console.warn('Team size mutation failed:', err.message);
    return { error: true };
  });
  if (res.error) return;
  await interaction.update({ content: 'Size updated.', components: [] })
    .catch((err) => console.warn('Team size update failed:', err.message));
  team = loadState().teams[messageId];
  if (team) await refreshListing(interaction.client, team).catch((err) => console.warn('Team size refresh failed:', err.message));
}

async function handleTeamWorldButton(interaction, messageId) {
  const team = findTeamByMessage(messageId);
  if (!team) return;
  if (!canManageTeam(interaction, team)) {
    await interaction.reply({ content: 'Only the organizer or staff can change this.', ephemeral: true }).catch(() => {});
    return;
  }
  const modal = new ModalBuilder()
    .setCustomId(`team:teamworldmodal:${messageId}`)
    .setTitle('Team world')
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('team:worldvalue')
          .setLabel('World number (blank to clear)')
          .setStyle(TextInputStyle.Short)
          .setRequired(false)
          .setMaxLength(6)
          .setPlaceholder('420')
          .setValue(team.world ? String(team.world) : '')
      )
    );
  await interaction.showModal(modal).catch(() => {});
}

async function handleTeamWorldModal(interaction, messageId) {
  let team = findTeamByMessage(messageId);
  if (!team || !canManageTeam(interaction, team)) return;
  let world;
  try {
    world = interaction.fields.getTextInputValue('team:worldvalue').trim();
  } catch {
    world = '';
  }
  const worldNum = validateWorld(world) ? parseInt(world, 10) : null;
  if (world && !worldNum) {
    await interaction.reply({ content: 'World must be a 3-digit number.', ephemeral: true })
      .catch((err) => console.warn('Team world reply failed:', err.message));
    return;
  }
  const res = await mutateTeams((state) => {
    const t = state.teams[messageId];
    if (!t || t.status !== 'open') return { error: 'That team is gone.' };
    t.world = worldNum;
    return { ok: true, world: worldNum };
  }).catch((err) => {
    console.warn('Team world mutation failed:', err.message);
    return { error: true };
  });
  if (res.error) return;
  await interaction.reply({ content: res.world ? `World set to ${res.world}.` : 'World cleared.', ephemeral: true })
    .catch((err) => console.warn('Team world reply failed:', err.message));
  team = loadState().teams[messageId];
  if (team) await refreshListing(interaction.client, team).catch((err) => console.warn('Team world refresh failed:', err.message));
}

function teamRegionRows(team, messageId) {
  const rows = [];
  let row = new ActionRowBuilder();
  const opts = [...REGIONS.map((r) => ({ id: r.id, label: r.label, emoji: r.emoji })), { id: 'none', label: 'No region' }];
  for (const o of opts) {
    if (row.components.length >= 4) {
      rows.push(row);
      row = new ActionRowBuilder();
    }
    const active = (o.id === 'none' && !team.region) || team.region === o.id;
    const btn = new ButtonBuilder()
      .setCustomId(`team:teamregionset:${messageId}:${o.id}`)
      .setLabel(active ? `✓ ${o.label}` : o.label)
      .setStyle(active ? ButtonStyle.Danger : ButtonStyle.Secondary);
    if (o.emoji) btn.setEmoji(o.emoji);
    row.addComponents(btn);
  }
  if (row.components.length) rows.push(row);
  return rows;
}

async function handleTeamRegionButton(interaction, messageId) {
  const team = findTeamByMessage(messageId);
  if (!team) return;
  if (!canManageTeam(interaction, team)) {
    await interaction.reply({ content: 'Only the organizer or staff can change this.', ephemeral: true }).catch(() => {});
    return;
  }
  await interaction
    .reply({
      content: 'Region for this team:',
      components: teamRegionRows(team, messageId),
      ephemeral: true,
    })
    .catch(() => {});
}

async function handleTeamRegionSet(interaction, messageId, regionId) {
  let team = findTeamByMessage(messageId);
  if (!team || !canManageTeam(interaction, team)) return;
  const validRegion = regionId === 'none' || REGIONS.some((r) => r.id === regionId);
  if (!validRegion) return;
  const res = await mutateTeams((state) => {
    const t = state.teams[messageId];
    if (!t || t.status !== 'open') return { error: 'That team is gone.' };
    t.region = regionId === 'none' ? null : regionId;
    return { ok: true };
  }).catch((err) => {
    console.warn('Team region mutation failed:', err.message);
    return { error: true };
  });
  if (res.error) return;
  await interaction.update({ content: 'Region updated.', components: [] })
    .catch((err) => console.warn('Team region update failed:', err.message));
  team = loadState().teams[messageId];
  if (team) await refreshListing(interaction.client, team).catch((err) => console.warn('Team region refresh failed:', err.message));
}

async function handleTeamHubButton(interaction, messageId) {
  const team = findTeamByMessage(messageId);
  if (!team) return;
  if (!canManageTeam(interaction, team)) {
    await interaction.reply({ content: 'Only the organizer or staff can change this.', ephemeral: true }).catch(() => {});
    return;
  }
  const modal = new ModalBuilder()
    .setCustomId(`team:teamhubmodal:${messageId}`)
    .setTitle('Party hub')
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('team:hubvalue')
          .setLabel('Hub name (RuneLite Party plugin)')
          .setStyle(TextInputStyle.Short)
          .setRequired(false)
          .setMaxLength(32)
          .setPlaceholder('oath1')
          .setValue(team.hub || '')
      )
    );
  await interaction.showModal(modal).catch(() => {});
}

async function handleTeamHubModal(interaction, messageId) {
  let team = findTeamByMessage(messageId);
  if (!team || !canManageTeam(interaction, team)) return;
  let hub;
  try {
    hub = interaction.fields.getTextInputValue('team:hubvalue').trim();
  } catch {
    hub = '';
  }
  const hubVal = hub || null;
  const res = await mutateTeams((state) => {
    const t = state.teams[messageId];
    if (!t || t.status !== 'open') return { error: 'That team is gone.' };
    t.hub = hubVal;
    return { ok: true };
  }).catch((err) => {
    console.warn('Team hub mutation failed:', err.message);
    return { error: true };
  });
  if (res.error) return;
  await interaction.reply({ content: hubVal ? `Party hub set to ${hubVal}.` : 'Party hub cleared.', ephemeral: true })
    .catch((err) => console.warn('Team hub reply failed:', err.message));
  team = loadState().teams[messageId];
  if (team) await refreshListing(interaction.client, team).catch((err) => console.warn('Team hub refresh failed:', err.message));
}

async function handleRsnModal(interaction) {
  // customId 'team:rsnmodal'
  const res = await readRsnFromModal(interaction);
  if (res.error) {
    await interaction.editReply(res.error).catch(() => {});
    return;
  }
  const { rsn, stats } = res;
  addRsn(interaction.user.id, rsn);
  await interaction
    .editReply({
      content: `Linked **${rsn}** (combat ${stats.combat}). Your stats will show on team boards.`,
      components: [
        new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId('team:badge').setLabel('Account Type').setStyle(ButtonStyle.Danger).setEmoji('<:accounttype:1561578543501025313>')
        ),
      ],
    })
    .catch((err) => console.warn('RSN link confirmation failed:', err.message));
  // Refresh any open teams they're in so the board picks them up now.
  await refreshUserTeams(interaction.client, interaction.user.id);
}

// One-time nudge after joining/creating without a linked RSN. Never blocks.
async function maybeNudgeRsn(interaction, userId) {
  if (getRsn(userId)) return;
  await interaction
    .followUp({
      content: 'Want your combat stats on the team board? Link your RuneScape name.',
      components: rsnLinkRow(),
      ephemeral: true,
    })
    .catch(() => {});
}

async function handleTeamModal(interaction) {
  if (interaction.customId === 'team:rsnmodal') return handleRsnModal(interaction);
  if (interaction.customId === 'team:rsnaddmodal') return handleRsnAddModal(interaction);
  if (interaction.customId === 'team:defhubmodal') return handleDefHubModal(interaction);
  if (interaction.customId === 'team:defworldmodal') return handleDefWorldModal(interaction);
  const parts = interaction.customId.split(':');
  if (parts[0] === 'team' && parts[1] === 'teamhubmodal') return handleTeamHubModal(interaction, parts[2]);
  if (parts[0] === 'team' && parts[1] === 'teamworldmodal') return handleTeamWorldModal(interaction, parts[2]);
  return handleStepModal(interaction);
}

async function handleCreate(interaction) {
  const row = new ActionRowBuilder();
  for (const c of CATEGORIES) {
    row.addComponents(
      new ButtonBuilder().setCustomId(`team:cat:${c.id}`).setLabel(c.label).setStyle(ButtonStyle.Danger).setEmoji(c.emoji)
    );
  }
  await interaction
    .reply({ content: 'Pick a category.', components: [row], ephemeral: true })
    .catch(() => {});
}

async function handleCategory(interaction, catId) {
  await interaction.update({ content: 'Pick an activity.', components: categorySelectRow(catId) }).catch(() => {});
}

async function handleTeamSelect(interaction) {
  // customId 'team:pick', values[0] = activity key
  const activityKey = interaction.values && interaction.values[0];
  const act = ACTIVITIES[activityKey];
  if (!act) {
    await interaction.reply({ content: 'Unknown activity.', ephemeral: true }).catch(() => {});
    return;
  }
  if (act.pre) {
    const { content, components } = preChoiceRow(activityKey);
    await interaction.update({ content, components }).catch(() => {});
    return;
  }
  await startCreation(interaction, activityKey, null);
}

async function handlePreChoice(interaction, activityKey, preId) {
  if (!ACTIVITIES[activityKey] || !PRE_CHOICES[ACTIVITIES[activityKey].pre]) {
    await interaction.reply({ content: 'Unknown activity.', ephemeral: true }).catch(() => {});
    return;
  }
  await startCreation(interaction, activityKey, preId);
}

// ─── Listing interactions ───────────────────────────────────────────

async function refreshListing(client, team) {
  const channel = await client.channels.fetch(team.channelId).catch(() => null);
  const msg = channel && channel.isTextBased() ? await channel.messages.fetch(team.messageId).catch(() => null) : null;
  if (!msg) {
    // Listing was deleted out from under us. Drop the state.
    const state = loadState();
    delete state.teams[team.messageId];
    saveState(state);
    return null;
  }
  const file = await partyBoardFile(team, client).catch((err) => {
    console.warn('Party board failed:', err.message);
    return null;
  });
  const embed = buildTeamEmbed(team, { hideSignedUp: !!file });
  const payload = { embeds: [embed], components: buildListingComponents(team), files: file ? [file] : [] };
  if (file) embed.setImage('attachment://party-board.png');
  await msg.edit(payload).catch((err) => console.warn('Team refresh failed:', err.message));
  return msg;
}

async function sendFillPing(client, team) {
  try {
    const channel = await client.channels.fetch(team.channelId).catch(() => null);
    if (!channel || !channel.isTextBased()) return;
    const mentions = Object.keys(team.members)
      .map((id) => `<@${id}>`)
      .join(' ');
    const where = team.hub ? `World ${team.world}, hub ${team.hub}.` : `World ${team.world}.`;
    const msg = await channel.send(`${mentions} Team's full. ${where}`).catch((err) => {
      console.warn('Fill ping send failed:', err.message);
      return null;
    });
    if (msg) {
      // Store the ping id through the mutex so a concurrent join/leave
      // can't be clobbered by this save.
      await mutateTeams((state) => {
        const t = state.teams[team.messageId];
        if (t) t.fillPingMsgId = msg.id;
      }).catch((err) => console.warn('Fill ping id save failed:', err.message));
    }
  } catch (err) {
    console.warn('Team fill ping failed:', err.message);
  }
}

async function handleJoin(interaction, messageId) {
  const userId = interaction.user.id;
  const res = await mutateTeams((state) => {
    const team = state.teams[messageId];
    if (!team) return { error: 'That team is gone.' };
    const r = applyJoin(team, userId);
    if (!r.ok) return { error: r.error };
    team.memberNames[userId] = interaction.user.displayName;
    return { ok: true, filled: r.filled, fillPing: team.fillPing, messageId: team.messageId };
  }).catch((err) => {
    console.warn('Team join mutation failed:', err.message);
    return { error: 'Something went wrong. Try again.' };
  });
  if (res.error || !res.ok) {
    await interaction.reply({ content: res.error || 'Something went wrong.', ephemeral: true })
      .catch((err) => console.warn('Team join reply failed:', err.message));
    return;
  }
  await interaction.deferUpdate().catch((err) => console.warn('Team join defer failed:', err.message));
  const team = loadState().teams[res.messageId];
  if (team) {
    await refreshListing(interaction.client, team);
    if (res.filled && res.fillPing) await sendFillPing(interaction.client, team);
  }
  await maybeNudgeRsn(interaction, userId);
}

async function handleLeave(interaction, messageId) {
  const userId = interaction.user.id;
  const res = await mutateTeams((state) => {
    const team = state.teams[messageId];
    if (!team) return { error: 'That team is gone.' };
    const r = applyLeave(team, userId);
    if (!r.ok) return { error: r.error };
    return { ok: true, messageId: team.messageId };
  }).catch((err) => {
    console.warn('Team leave mutation failed:', err.message);
    return { error: 'Something went wrong. Try again.' };
  });
  if (res.error || !res.ok) {
    await interaction.reply({ content: res.error || 'Something went wrong.', ephemeral: true })
      .catch((err) => console.warn('Team leave reply failed:', err.message));
    return;
  }
  await interaction.deferUpdate().catch((err) => console.warn('Team leave defer failed:', err.message));
  const team = loadState().teams[res.messageId];
  if (team) await refreshListing(interaction.client, team);
}

async function handleRoleClaim(interaction, messageId, roleIdx) {
  const userId = interaction.user.id;
  const res = await mutateTeams((state) => {
    const team = state.teams[messageId];
    if (!team) return { error: 'That team is gone.' };
    const r = applyRoleClaim(team, userId, roleIdx);
    if (!r.ok) return { error: r.error };
    team.memberNames[userId] = interaction.user.displayName;
    return { ok: true, filled: r.filled, fillPing: team.fillPing, messageId: team.messageId };
  }).catch((err) => {
    console.warn('Team role claim mutation failed:', err.message);
    return { error: 'Something went wrong. Try again.' };
  });
  if (res.error || !res.ok) {
    await interaction.reply({ content: res.error || 'Something went wrong.', ephemeral: true })
      .catch((err) => console.warn('Team role claim reply failed:', err.message));
    return;
  }
  await interaction.deferUpdate().catch((err) => console.warn('Team role claim defer failed:', err.message));
  const team = loadState().teams[res.messageId];
  if (team) {
    await refreshListing(interaction.client, team);
    if (res.filled && res.fillPing) await sendFillPing(interaction.client, team);
  }
  await maybeNudgeRsn(interaction, userId);
}

async function handleClose(interaction, messageId) {
  const res = await mutateTeams((state) => {
    const team = state.teams[messageId];
    if (!team || team.status !== 'open') return { error: 'That team is already closed.' };
    if (interaction.user.id !== team.organizerId && !isStaff(interaction)) {
      return { error: 'Only the organizer or staff can close this.' };
    }
    team.status = 'closed';
    team.closedAt = Date.now();
    return { ok: true, messageId: team.messageId };
  }).catch((err) => {
    console.warn('Team close mutation failed:', err.message);
    return { error: 'Something went wrong. Try again.' };
  });
  if (res.error || !res.ok) {
    await interaction.reply({ content: res.error || 'Something went wrong.', ephemeral: true })
      .catch((err) => console.warn('Team close reply failed:', err.message));
    return;
  }
  await interaction.deferUpdate().catch((err) => console.warn('Team close defer failed:', err.message));
  const team = loadState().teams[res.messageId];
  if (team) await refreshListing(interaction.client, team);
}

async function handleDelete(interaction, messageId) {
  const res = await mutateTeams((state) => {
    const team = state.teams[messageId];
    if (!team) return { error: 'That team is already gone.' };
    if (interaction.user.id !== team.organizerId && !isStaff(interaction)) {
      return { error: 'Only the organizer or staff can delete this.' };
    }
    delete state.teams[messageId];
    return { ok: true, channelId: team.channelId, fillPingMsgId: team.fillPingMsgId };
  }).catch((err) => {
    console.warn('Team delete mutation failed:', err.message);
    return { error: 'Something went wrong. Try again.' };
  });
  if (res.error || !res.ok) {
    await interaction.reply({ content: res.error || 'Something went wrong.', ephemeral: true })
      .catch((err) => console.warn('Team delete reply failed:', err.message));
    return;
  }
  // Delete the listing message and the fill ping if there is one.
  const channel = await interaction.client.channels.fetch(res.channelId).catch(() => null);
  if (channel && channel.isTextBased()) {
    await channel.messages.delete(messageId).catch((err) => console.warn('Team listing delete failed:', err.message));
    if (res.fillPingMsgId) {
      await channel.messages.delete(res.fillPingMsgId).catch((err) => console.warn('Fill ping delete failed:', err.message));
    }
  }
  await interaction.reply({ content: 'Team deleted.', ephemeral: true })
    .catch((err) => console.warn('Team delete reply failed:', err.message));
}

async function handleTeamButton(interaction) {
  // customId: team:create | team:cat:<id> | team:pre:<act>:<pre> |
  // team:mk:<step>:<value> | team:mktype:<step> | team:mkskip:<step> |
  // team:join:<msg> | team:leave:<msg> | team:role:<msg>:<idx> |
  // team:close:<msg> | team:delete:<msg> | team:rsn | team:specs |
  // team:spectoggle:<specId> | team:specshow:<msg> |
  // team:specshowtoggle:<msg>:<specId>
  const parts = interaction.customId.split(':');
  const action = parts[1];
  if (action === 'create') return handleCreate(interaction);
  if (action === 'cat') return handleCategory(interaction, parts[2]);
  if (action === 'pre') return handlePreChoice(interaction, parts[2], parts.slice(3).join(':'));
  if (action === 'mk') return handleStepButton(interaction, parts[2], parts.slice(3).join(':'));
  if (action === 'mktype') return handleStepTypeOpen(interaction, parts[2]);
  if (action === 'mkskip') return handleStepSkip(interaction, parts[2]);
  if (action === 'join') return handleJoin(interaction, parts[2]);
  if (action === 'leave') return handleLeave(interaction, parts[2]);
  if (action === 'role') return handleRoleClaim(interaction, parts[2], parseInt(parts[3], 10));
  if (action === 'close') return handleClose(interaction, parts[2]);
  if (action === 'delete') return handleDelete(interaction, parts[2]);
  if (action === 'rsn') return handleRsnButton(interaction);
  if (action === 'specs') return handleMySpecsButton(interaction);
  if (action === 'spectoggle') return handleMySpecsToggle(interaction, parts[2]);
  if (action === 'specshow') return handleTeamSpecsButton(interaction, parts[2]);
  if (action === 'specshowtoggle') return handleTeamSpecsToggle(interaction, parts[2], parts[3]);
  if (action === 'defregion') return handleDefRegionButton(interaction);
  if (action === 'defregionset') return handleDefRegionSet(interaction, parts[2]);
  if (action === 'defhub') return handleDefHubButton(interaction);
  if (action === 'defworld') return handleDefWorldButton(interaction);
  if (action === 'boardmode') return handleBoardModeToggle(interaction);
  if (action === 'settings') return handleSettingsButton(interaction);
  if (action === 'myteams') return handleMyTeamsButton(interaction);
  if (action === 'clearall') return handleClearAllTeams(interaction);
  if (action === 'rsnswitch') return handleRsnSwitchButton(interaction);
  if (action === 'rsnset') return handleRsnSet(interaction, parts[2]);
  if (action === 'rsnadd') return handleRsnAddButton(interaction);
  if (action === 'badge') return handleBadgeButton(interaction);
  if (action === 'badgeset') return handleBadgeSet(interaction, parts[2]);
  if (action === 'teamsize') return handleTeamSizeButton(interaction, parts[2]);
  if (action === 'teamsizeset') return handleTeamSizeSet(interaction, parts[2], parts[3]);
  if (action === 'teamworld') return handleTeamWorldButton(interaction, parts[2]);
  if (action === 'teamregion') return handleTeamRegionButton(interaction, parts[2]);
  if (action === 'teamregionset') return handleTeamRegionSet(interaction, parts[2], parts[3]);
  if (action === 'teamhub') return handleTeamHubButton(interaction, parts[2]);
  console.warn('Unknown team button action:', interaction.customId);
}

// ─── Expiry sweep ───────────────────────────────────────────────────
// Unfilled open teams expire after 24h. Filled open teams auto-close
// after 24h (no ping). Closed listings are deleted 24h after closing.
// Idempotent across restarts; missing messages just drop their state.
function shouldSweepTeam(team, now) {
  if (team.status === 'closed') {
    return !!(team.closedAt && now - team.closedAt > EXPIRE_MS);
  }
  if (isTeamFull(team)) return false;
  return now - (team.createdAt || 0) > EXPIRE_MS;
}

function shouldAutoClose(team, now) {
  return team.status === 'open' && isTeamFull(team) && now - (team.createdAt || 0) > EXPIRE_MS;
}

// Re-patch any listings whose buttons still have the "pending" placeholder.
// This happens if the bot restarted between posting and the button patch.
async function sweepPendingButtons(client) {
  const state = loadState();
  let fixed = 0;
  for (const [id, team] of Object.entries(state.teams || {})) {
    if (team.status !== 'open' || !team.messageId || !team.channelId) continue;
    try {
      const channel = await client.channels.fetch(team.channelId).catch(() => null);
      if (!channel || !channel.isTextBased()) continue;
      const msg = await channel.messages.fetch(team.messageId).catch(() => null);
      if (!msg) continue;
      const hasPending = msg.components.some((row) =>
        row.components.some((b) => (b.customId || '').includes(':pending:'))
      );
      if (hasPending) {
        await msg.edit({ components: buildListingComponents(team) }).catch(() => {});
        fixed++;
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  if (fixed) console.log(`Fixed ${fixed} listing(s) with pending buttons.`);
}

async function sweepExpiredTeams(client) {
  const now = Date.now();
  // Decide what to sweep first (read-only), then mutate through the queue
  // so a sweep can't clobber a concurrent join.
  const state = loadState();
  const toClose = [];
  const toDelete = [];
  for (const [id, team] of Object.entries(state.teams)) {
    if (shouldAutoClose(team, now)) toClose.push(id);
    else if (shouldSweepTeam(team, now)) toDelete.push(id);
  }
  if (!toClose.length && !toDelete.length) return;
  await mutateTeams((s) => {
    for (const id of toClose) {
      const t = s.teams[id];
      if (t && t.status === 'open') {
        t.status = 'closed';
        t.closedAt = now;
      }
    }
    for (const id of toDelete) delete s.teams[id];
  }).catch((err) => console.warn('Team sweep mutation failed:', err.message));
  const fresh = loadState();
  for (const id of toClose) {
    const team = fresh.teams[id];
    if (team) await refreshListing(client, team).catch((err) => console.warn('Team auto-close refresh failed:', err.message));
  }
  for (const id of toDelete) {
    const team = state.teams[id];
    if (!team) continue;
    try {
      const channel = await client.channels.fetch(team.channelId).catch(() => null);
      const msg = channel && channel.isTextBased() ? await channel.messages.fetch(id).catch(() => null) : null;
      if (msg) await msg.delete().catch((err) => console.warn('Team sweep delete failed:', err.message));
    } catch (err) {
      console.warn('Team sweep delete failed:', err.message);
    }
  }
}

// ─── Admin: post the panel ──────────────────────────────────────────

async function postTeamPanel(interaction) {
  await interaction.deferReply({ ephemeral: true });
  const channelId = teamsChannelId();
  if (!channelId) {
    await interaction.editReply('Team finder channel is not set. Add config.teams.channelId.');
    return;
  }
  const channel = interaction.guild.channels.cache.get(channelId);
  if (!channel) {
    await interaction.editReply('Team finder channel not found. Check config.teams.channelId.');
    return;
  }
  await channel.send(teamPanelPayload());
  await interaction.editReply(`Team panel posted in ${channel}.`);
}

const commands = [
  {
    data: new SlashCommandBuilder()
      .setName('post-team-panel')
      .setDescription('Post the team finder panel (Admin only)')
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
    run: postTeamPanel,
  },
];

module.exports = {
  ACTIVITIES,
  CATEGORIES,
  PRE_CHOICES,
  toaModeForLevel,
  parseCoxScale,
  parseSizeInput,
  parseRaidLevel,
  validateWorld,
  rolesFor,
  roleModeFor,
  nmSizeAndPing,
  memberCount,
  isTeamFull,
  applyJoin,
  applyLeave,
  applyRoleClaim,
  mutateTeams,
  buildTeamFromData,
  creationStepsFor,
  activityRoleId,
  REGIONS,
  buildTeamEmbed,
  buildListingComponents,
  teamPanelPayload,
  settingsPanelPayload,
  rsnSwitchPayload,
  normalizeRsnEntry,
  getRsnEntry,
  addRsn,
  setActiveRsn,
  handleTeamButton,
  handleTeamSelect,
  handleStepSelect,
  handleTeamStepSelect: handleStepSelect,
  handleTeamModal,
  boardApplies,
  loadRsnLinks,
  getRsn,
  SPECS,
  SPEC_CATS,
  specsForActivity,
  loadSpecs,
  getOwnedSpecs,
  toggleOwnedSpec,
  getShownSpecs,
  toggleShownSpec,
  kcColumnsForTeam,
  getUserDefaults,
  setUserDefault,
  sizeOptionsFor,
  getBadge,
  getManualBadge,
  setManualBadge,
  BADGES,
  shouldSweepTeam,
  shouldAutoClose,
  sweepExpiredTeams,
  sweepPendingButtons,
  commands,
};
