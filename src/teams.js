// Team finder: button panel -> activity picker -> per-activity form ->
// listing embed with Join/Leave or role-claim buttons. Organizer gets
// Close Party (organizer or staff).
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
    name: 'Tombs of Amascut', short: 'ToA', category: 'raids',
    size: { min: 1, max: 8 }, fillPing: true, partyHub: true,
  },
  cox: {
    name: 'Chambers of Xeric', short: 'CoX', category: 'raids',
    fillPing: true, partyHub: true, pre: 'coxMode',
  },
  tob: {
    name: 'Theatre of Blood', short: 'ToB', category: 'raids',
    fillPing: true, partyHub: true, pre: 'tobScale',
    roleMode: 'exclusive',
    rolesByPre: {
      '4s': ['Mage', 'North FZ', 'RDPS', 'MDPS'],
      '4s-hard': ['Mage', 'North FZ', 'RDPS', 'MDPS'],
      '5s': ['Mage', 'North FZ', 'RDPS', 'MDPS 1', 'MDPS 2'],
      '5s-hard': ['Mage', 'North FZ', 'RDPS', 'MDPS 1', 'MDPS 2'],
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
  cox: '<:cox:1561158969379004510>',
  tob: '<:tob:1561159051147223100>',
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
  cox: { id: '1561158969379004510', name: 'cox' },
  tob: { id: '1561159051147223100', name: 'tob' },
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
      { id: '4s-hard', label: '4s Hard Mode' },
      { id: '5s', label: '5s' },
      { id: '5s-hard', label: '5s Hard Mode' },
    ],
  },
  coxMode: {
    prompt: 'CoX mode',
    options: [
      { id: 'normal', label: 'Normal' },
      { id: 'cm', label: 'Challenge Mode' },
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

function activityRoleId(activityKey) {
  return config.teams && config.teams.activityRoles && config.teams.activityRoles[activityKey];
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
  const links = loadRsnLinks();
  return links[userId] ? links[userId].rsn : null;
}

// ─── Spec weapons (defence-lowering specials members own) ──
const SPECS = [
  { id: 'bgs', label: 'BGS', name: 'Bandos godsword' },
  { id: 'dwh', label: 'DWH', name: 'Dragon warhammer' },
  { id: 'eldermaul', label: 'Elder maul', name: 'Elder maul' },
  { id: 'tonalztics', label: 'Tonalztics', name: 'Tonalztics of Ralos' },
  { id: 'accursed', label: 'Accursed', name: 'Accursed sceptre' },
];
// Which spec icons render per activity. Raids only; the accursed
// sceptre is Yama-only.
const SPEC_DISPLAY = {
  toa: ['bgs', 'dwh', 'eldermaul', 'tonalztics'],
  cox: ['bgs', 'dwh', 'eldermaul', 'tonalztics'],
  tob: ['bgs', 'dwh', 'eldermaul', 'tonalztics'],
  yama: ['bgs', 'dwh', 'eldermaul', 'tonalztics', 'accursed'],
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

function getSpecs(userId) {
  const specs = loadSpecs();
  const list = specs[userId];
  if (!Array.isArray(list)) return [];
  return list.filter((id) => SPECS.some((s) => s.id === id));
}

function toggleSpec(userId, specId) {
  if (!SPECS.some((s) => s.id === specId)) return getSpecs(userId);
  const specs = loadSpecs();
  const list = getSpecs(userId);
  const i = list.indexOf(specId);
  if (i >= 0) list.splice(i, 1);
  else list.push(specId);
  specs[userId] = list;
  saveSpecs(specs);
  return list;
}

// The board renders on every PvM team (headcount and role-claim).
// Skilling minigames keep text.
function boardApplies(team) {
  const act = ACTIVITIES[team.activity];
  return !!act && act.category !== 'skilling';
}

// Builds the party-board image for a team, or null when it shouldn't show
// (not a board team, or nobody has linked an RSN yet).
async function partyBoardFile(team) {
  if (!boardApplies(team)) return null;
  const ids = Object.keys(team.members || {});
  if (!ids.length) return null;
  const links = loadRsnLinks();
  const statsList = await Promise.all(
    ids.map((id) => {
      const rsn = links[id] && links[id].rsn;
      return rsn ? getStats(rsn).catch(() => null) : Promise.resolve(null);
    })
  );
  const specStore = loadSpecs();
  const allowedSpecs = specsForActivity(team.activity);
  const rows = ids.map((id, i) => {
    const st = statsList[i];
    const stats = st && !st.notFound
      ? [st.combat, st.attack, st.strength, st.ranged, st.magic, st.defence, st.hitpoints, st.prayer]
      : null;
    const rsn = links[id] && links[id].rsn;
    const specs = (specStore[id] || []).filter((s) => allowedSpecs.includes(s));
    return { name: rsn || (team.memberNames || {})[id] || 'member', stats, specs };
  });
  if (!rows.some((r) => r.stats)) return null;
  const buf = renderPartyBoard(rows, Math.max(0, rows.length - MAX_ROWS));
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

  if (team.activity === 'toa' && team.raidLevel) {
    const tierLabels = { 'Normal': 'Normal (150-299)', 'Expert': 'Expert (300-349)', 'High Invo': 'High Invo (350+)' };
    lines.push(`Raid level: ${tierLabels[team.raidLevel] || team.raidLevel}`);
  }
  if (team.activity === 'cox' && team.scale) {
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
  const msgId = team.messageId;

  if (team.roleMode) {
    const names = team.memberNames || {};
    const roleRow = new ActionRowBuilder();
    (team.roles || []).forEach((role, idx) => {
      const holder = Object.entries(team.members || {}).find(([, r]) => r === role);
      const label = holder ? `${role}: ${shortName(names[holder[0]] || 'taken')}` : role;
      roleRow.addComponents(
        new ButtonBuilder().setCustomId(`team:role:${msgId}:${idx}`).setLabel(label.slice(0, 80)).setStyle(ButtonStyle.Danger)
      );
    });
    // Discord allows max 5 buttons per row; BA/ToB-5s have exactly 5.
    rows.push(roleRow);
  } else {
    rows.push(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`team:join:${msgId}`).setLabel('Join').setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId(`team:leave:${msgId}`).setLabel('Leave').setStyle(ButtonStyle.Danger)
      )
    );
  }

  rows.push(
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`team:close:${msgId}`).setLabel('Close Party').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId(`team:delete:${msgId}`).setLabel('Delete').setStyle(ButtonStyle.Danger)
    )
  );
  return rows;
}

function teamPanelPayload() {
  return {
    embeds: [
      new EmbedBuilder()
        .setColor(ZAMORAK_RED)
        .setTitle('⛧ Find a Team ⛧')
        .setDescription('Need a group? Post a team and fill it.\n\nTap below to get started.'),
    ],
    components: [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('team:create').setLabel('Create Team').setStyle(ButtonStyle.Danger).setEmoji('<:teamparty:1561409571220750398>'),
        new ButtonBuilder().setCustomId('team:rsn').setLabel('Link RSN').setStyle(ButtonStyle.Danger).setEmoji('<:rsnlink:1561409641399853117>'),
        new ButtonBuilder().setCustomId('team:specs').setLabel('My Specs').setStyle(ButtonStyle.Danger).setEmoji('<:myspecs:1561409712426328297>')
      ),
    ],
  };
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

  if (activityKey === 'toa') {
    steps.push({
      id: 'sizeChoice', kind: 'buttons', prompt: 'Want a specific team size?',
      options: [{ id: 'specific', label: 'Yes, pick a size' }, { id: 'any', label: 'No, any size' }],
    });
    steps.push({ id: 'size', kind: 'buttons', prompt: 'How many players?', options: numOptions(2, 8) });
    steps.push({
      id: 'tier', kind: 'buttons', prompt: 'What raid level?', options: [
        { id: 'Normal', label: 'Normal (150-299)' },
        { id: 'Expert', label: 'Expert (300-349)' },
        { id: 'High Invo', label: 'High Invo (350+)' },
      ],
    });
  } else if (activityKey === 'cox') {
    steps.push({
      id: 'sizeChoice', kind: 'buttons', prompt: 'Want a specific team size?',
      options: [{ id: 'specific', label: 'Yes, pick a size' }, { id: 'any', label: 'No, any size' }],
    });
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
  } else if (activityKey === 'nex') {
    steps.push({
      id: 'size', kind: 'buttons', prompt: 'How many players?',
      options: [{ id: '2', label: '2' }, { id: '3', label: '3' }, { id: '5', label: '5' }, { id: '8', label: '8' }, { id: 'mass', label: 'Mass (10+)' }],
    });
  } else if (activityKey === 'huey') {
    steps.push({
      id: 'size', kind: 'buttons', prompt: 'How many players? (Mass is 6+)',
      options: [...numOptions(3, 5), { id: 'mass', label: 'Mass' }],
    });
  }
  // BA (5), Yama (2), Royal Titans (2) are fixed. ToB size comes from
  // roles. Skilling, Zalcano, WAG, Venenatis, Callisto, Vet'ion, and
  // NM mass are open. NM team is fixed at 5.

  // Skilling minigames and Zalcano don't need a region. WAG skips world too.
  const noRegion = ['wintertodt', 'gotr', 'tempoross', 'zalcano', 'wag'].includes(activityKey);
  if (!noRegion) {
    steps.push({
      id: 'region', kind: 'buttons', prompt: 'Which region?',
      options: REGIONS.map((r) => ({ id: r.id, label: r.label, emoji: r.emoji })),
    });
  }
  // Wintertodt, GotR, Tempoross: mass world or small team? World question only for small team.
  const skillingChoice = ['wintertodt', 'gotr', 'tempoross'].includes(activityKey);
  if (skillingChoice) {
    steps.push({
      id: 'worldType', kind: 'buttons', prompt: 'Mass world or small team?',
      options: [{ id: 'mass', label: 'Mass world' }, { id: 'team', label: 'Small team' }],
    });
    steps.push({
      id: 'world', kind: 'optionalText', prompt: 'Got a world picked out?',
      typeLabel: 'world number', modalTitle: 'World number', modalLabel: 'World',
      modalPlaceholder: '420',
    });
  }
  if (activityKey !== 'wag' && !skillingChoice) {
    steps.push({
      id: 'world', kind: 'optionalText', prompt: 'Got a world picked out?',
      typeLabel: 'world number', modalTitle: 'World number', modalLabel: 'World',
      modalPlaceholder: '420',
    });
  }

  if (act.partyHub) {
    steps.push({
      id: 'hub', kind: 'optionalText',
      prompt: 'Party hub name? (RuneLite Party plugin)',
      typeLabel: 'hub name', modalTitle: 'Party hub', modalLabel: 'Party hub name',
      modalPlaceholder: 'oath1',
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

  const team = {
    activity: activityKey,
    organizerId: organizer.id,
    memberNames: { [organizer.id]: organizer.displayName },
    members: {},
    roles: rolesFor(activityKey, preId),
    roleMode: roleModeFor(activityKey),
    pre: preId || null,
    world: data.world || null,
    region: data.region || null,
    hub: data.hub || null,
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

  // Size
  if (activityKey === 'nm') {
    const nmCfg = nmSizeAndPing(preId);
    team.fillPing = nmCfg.fillPing;
    if (preId === 'mass') {
      team.size = null;
      team.mass = true;
    } else if (preId === 'team') {
      team.size = 5;
    } else {
      team.size = data.size;
    }
  } else if (act.size && act.size.fixed) {
    team.size = act.size.fixed;
  } else if (activityKey === 'cox') {
    // Set from raiders below.
  } else if (data.size === 'mass') {
    team.size = null;
    team.mass = true;
  } else if (data.size != null) {
    team.size = data.size;
  }

  if (activityKey === 'toa') {
    if (!data.tier) return { error: 'Pick a raid level.' };
    team.raidLevel = data.tier;
  }
  if (activityKey === 'cox') {
    if (data.sizeChoice === 'specific' && !data.raiders) return { error: 'Pick how many raiders.' };
    if (data.raiders) {
      team.scale = { raiders: data.raiders, scalers: data.scalers || 0 };
      team.size = data.raiders;
    }
    team.layout = data.layout || null;
  }
  if (activityKey === 'tob' && !team.roles) return { error: 'Pick 4s or 5s first.' };
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

  const channelId = teamsChannelId();
  if (!channelId) {
    await interaction.update({ content: 'Team finder is not set up yet. Tell staff.', components: [] }).catch(() => {});
    return;
  }
  const channel = await interaction.client.channels.fetch(channelId).catch(() => null);
  if (!channel || !channel.isTextBased()) {
    await interaction.update({ content: 'Could not find the team finder channel. Tell staff.', components: [] }).catch(() => {});
    return;
  }

  await interaction.update({ content: 'Posting your team...', components: [] }).catch(() => {});

  const roleId = activityRoleId(creation.activity);
  const content = roleId ? `<@&${roleId}>` : null;
  let msg;
  try {
    team.channelId = channel.id;
    const file = await partyBoardFile(team).catch(() => null);
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
  // Store numbers as numbers, keep ids like 'mass' or tiers as strings.
  creation.data[stepId] = /^\d+$/.test(value) ? parseInt(value, 10) : value;
  // "Any size" skips the size steps. ToA skips 1 (size), CoX skips 2 (raiders + scalers).
  if (stepId === 'sizeChoice' && value === 'any') {
    creation.idx += creation.activity === 'cox' ? 2 : 1;
  }
  // "Mass world" skips the world number step for skilling.
  if (stepId === 'worldType' && value === 'mass') {
    creation.idx += 1;
  }
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

// ─── My Specs: one-time toggle of owned defence-lowering spec weapons ──
function specToggleRows(userId) {
  const owned = getSpecs(userId);
  const row = new ActionRowBuilder();
  for (const spec of SPECS) {
    const has = owned.includes(spec.id);
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(`team:spectoggle:${spec.id}`)
        .setLabel(has ? `✓ ${spec.label}` : spec.label)
        .setStyle(has ? ButtonStyle.Danger : ButtonStyle.Secondary)
    );
  }
  return [row];
}

function specToggleText(userId) {
  const owned = getSpecs(userId);
  const names = owned.map((id) => SPECS.find((s) => s.id === id).label);
  const line = names.length ? `Your spec weapons: **${names.join(', ')}**.` : 'You have no spec weapons set.';
  return `${line}\nTap to add or remove. They show on raid party boards.`;
}

async function handleSpecsButton(interaction) {
  await interaction
    .reply({
      content: specToggleText(interaction.user.id),
      components: specToggleRows(interaction.user.id),
      ephemeral: true,
    })
    .catch(() => {});
}

async function handleSpecToggle(interaction, specId) {
  toggleSpec(interaction.user.id, specId);
  await interaction
    .update({
      content: specToggleText(interaction.user.id),
      components: specToggleRows(interaction.user.id),
    })
    .catch(() => {});
  // Refresh open raid teams so the board picks up the change now.
  const state = loadState();
  for (const team of Object.values(state.teams)) {
    if (
      team.status === 'open' &&
      team.members &&
      team.members[interaction.user.id] &&
      specsForActivity(team.activity).length
    ) {
      await refreshListing(interaction.client, team).catch(() => {});
    }
  }
}

async function handleRsnModal(interaction) {
  // customId 'team:rsnmodal'
  let rsn;
  try {
    rsn = interaction.fields.getTextInputValue('team:rsnvalue').trim().replace(/\s+/g, ' ');
  } catch {
    rsn = '';
  }
  if (!/^[A-Za-z0-9 ]{1,12}$/.test(rsn)) {
    await interaction.reply({ content: 'That name has characters RuneScape does not allow. Try again.', ephemeral: true }).catch(() => {});
    return;
  }
  await interaction.deferReply({ ephemeral: true }).catch(() => {});
  const stats = await getStats(rsn).catch(() => null);
  if (stats && stats.notFound) {
    await interaction.editReply('Could not find that RuneScape name. Check the spelling and try again.').catch(() => {});
    return;
  }
  if (!stats) {
    await interaction.editReply('Could not reach the stats service right now. Your name was not linked, try again in a bit.').catch(() => {});
    return;
  }
  const links = loadRsnLinks();
  links[interaction.user.id] = { rsn, linkedAt: Date.now() };
  saveRsnLinks(links);
  await interaction.editReply(`Linked **${rsn}** (combat ${stats.combat}). Your stats will show on team boards.`).catch(() => {});
  // Refresh any open teams they're in so the board picks them up now.
  const state = loadState();
  for (const team of Object.values(state.teams)) {
    if (team.status === 'open' && team.members && team.members[interaction.user.id]) {
      await refreshListing(interaction.client, team).catch(() => {});
    }
  }
}

// One-time nudge after joining/creating without a linked RSN. Never blocks.
async function maybeNudgeRsn(interaction, userId) {
  if (getRsn(userId)) return;
  await interaction
    .followUp({
      content: 'Want your combat stats on the party board? Link your RuneScape name (one time).',
      components: rsnLinkRow(),
      ephemeral: true,
    })
    .catch(() => {});
}

async function handleTeamModal(interaction) {
  if (interaction.customId === 'team:rsnmodal') return handleRsnModal(interaction);
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
    .reply({ content: 'What are you putting a team together for?', components: [row], ephemeral: true })
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
  const file = await partyBoardFile(team).catch((err) => {
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
    const msg = await channel.send(`${mentions} Team's full. ${where}`).catch(() => null);
    if (msg) {
      team.fillPingMsgId = msg.id;
      const state = loadState();
      if (state.teams[team.messageId]) {
        state.teams[team.messageId].fillPingMsgId = msg.id;
        saveState(state);
      }
    }
  } catch (err) {
    console.warn('Team fill ping failed:', err.message);
  }
}

async function handleJoin(interaction, msgId) {
  const state = loadState();
  const team = state.teams[msgId];
  if (!team) {
    await interaction.reply({ content: 'That team is gone.', ephemeral: true }).catch(() => {});
    return;
  }
  const res = applyJoin(team, interaction.user.id);
  if (!res.ok) {
    await interaction.reply({ content: res.error, ephemeral: true }).catch(() => {});
    return;
  }
  team.memberNames[interaction.user.id] = interaction.user.displayName;
  saveState(state);
  await interaction.deferUpdate().catch(() => {});
  await refreshListing(interaction.client, team);
  if (res.filled && team.fillPing) await sendFillPing(interaction.client, team);
  await maybeNudgeRsn(interaction, interaction.user.id);
}

async function handleLeave(interaction, msgId) {
  const state = loadState();
  const team = state.teams[msgId];
  if (!team) {
    await interaction.reply({ content: 'That team is gone.', ephemeral: true }).catch(() => {});
    return;
  }
  const res = applyLeave(team, interaction.user.id);
  if (!res.ok) {
    await interaction.reply({ content: res.error, ephemeral: true }).catch(() => {});
    return;
  }
  saveState(state);
  await interaction.deferUpdate().catch(() => {});
  await refreshListing(interaction.client, team);
}

async function handleRoleClaim(interaction, msgId, roleIdx) {
  const state = loadState();
  const team = state.teams[msgId];
  if (!team) {
    await interaction.reply({ content: 'That team is gone.', ephemeral: true }).catch(() => {});
    return;
  }
  const res = applyRoleClaim(team, interaction.user.id, roleIdx);
  if (!res.ok) {
    await interaction.reply({ content: res.error, ephemeral: true }).catch(() => {});
    return;
  }
  team.memberNames[interaction.user.id] = interaction.user.displayName;
  saveState(state);
  await interaction.deferUpdate().catch(() => {});
  await refreshListing(interaction.client, team);
  if (res.filled && team.fillPing) await sendFillPing(interaction.client, team);
  await maybeNudgeRsn(interaction, interaction.user.id);
}

async function handleClose(interaction, msgId) {
  const state = loadState();
  const team = state.teams[msgId];
  if (!team || team.status !== 'open') {
    await interaction.reply({ content: 'That team is already closed.', ephemeral: true }).catch(() => {});
    return;
  }
  if (interaction.user.id !== team.organizerId && !isStaff(interaction)) {
    await interaction.reply({ content: 'Only the organizer or staff can close this.', ephemeral: true }).catch(() => {});
    return;
  }
  team.status = 'closed';
  team.closedAt = Date.now();
  saveState(state);
  await interaction.deferUpdate().catch(() => {});
  await refreshListing(interaction.client, team);
}

async function handleDelete(interaction, msgId) {
  const state = loadState();
  const team = state.teams[msgId];
  if (!team) {
    await interaction.reply({ content: 'That team is already gone.', ephemeral: true }).catch(() => {});
    return;
  }
  if (interaction.user.id !== team.organizerId && !isStaff(interaction)) {
    await interaction.reply({ content: 'Only the organizer or staff can delete this.', ephemeral: true }).catch(() => {});
    return;
  }
  // Delete the listing message, the fill ping if there is one, and drop the state.
  const channel = await interaction.client.channels.fetch(team.channelId).catch(() => null);
  if (channel && channel.isTextBased()) {
    await channel.messages.delete(msgId).catch(() => {});
    if (team.fillPingMsgId) {
      await channel.messages.delete(team.fillPingMsgId).catch(() => {});
    }
  }
  delete state.teams[msgId];
  saveState(state);
  await interaction.reply({ content: 'Team deleted.', ephemeral: true }).catch(() => {});
}

async function handleTeamButton(interaction) {
  // customId: team:create | team:cat:<id> | team:pre:<act>:<pre> |
  // team:mk:<step>:<value> | team:mktype:<step> | team:mkskip:<step> |
  // team:join:<msg> | team:leave:<msg> | team:role:<msg>:<idx> |
  // team:close:<msg> | team:delete:<msg> | team:rsn | team:specs |
  // team:spectoggle:<specId>
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
  if (action === 'specs') return handleSpecsButton(interaction);
  if (action === 'spectoggle') return handleSpecToggle(interaction, parts[2]);
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

async function sweepExpiredTeams(client) {
  const state = loadState();
  const now = Date.now();
  let changed = false;
  for (const [id, team] of Object.entries(state.teams)) {
    // Auto-close filled teams at 24h: mark closed, strip buttons, no ping.
    if (shouldAutoClose(team, now)) {
      team.status = 'closed';
      team.closedAt = now;
      changed = true;
      await refreshListing(client, team).catch((err) => console.warn('Team auto-close refresh failed:', err.message));
      continue;
    }
    if (!shouldSweepTeam(team, now)) continue;
    changed = true;
    try {
      const channel = await client.channels.fetch(team.channelId).catch(() => null);
      const msg = channel && channel.isTextBased() ? await channel.messages.fetch(id).catch(() => null) : null;
      if (msg) await msg.delete().catch(() => {});
    } catch (err) {
      console.warn('Team sweep delete failed:', err.message);
    }
    delete state.teams[id];
  }
  if (changed) saveState(state);
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
  buildTeamFromData,
  creationStepsFor,
  REGIONS,
  buildTeamEmbed,
  buildListingComponents,
  teamPanelPayload,
  handleTeamButton,
  handleTeamSelect,
  handleStepSelect,
  handleTeamStepSelect: handleStepSelect,
  handleTeamModal,
  boardApplies,
  loadRsnLinks,
  getRsn,
  SPECS,
  specsForActivity,
  loadSpecs,
  getSpecs,
  toggleSpec,
  shouldSweepTeam,
  shouldAutoClose,
  sweepExpiredTeams,
  commands,
};
