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
} = require('discord.js');
const fs = require('fs');
const path = require('path');
const config = require('./config');
const { isStaff, ZAMORAK_RED, DAY_MS } = require('./utils');

const STATE_FILE = path.join(__dirname, '..', 'data', 'teams.json');
const EXPIRE_MS = 24 * 3600 * 1000; // unfilled teams and closed listings die after 24h
const CREATE_COOLDOWN_MS = 60 * 1000;
const createCooldowns = new Map();

// ─── Activity templates ─────────────────────────────────────────────
// size: null = open/mass (no cap, never fills). {min,max} = organizer
// picks a number. {fixed:n} = fixed headcount, no input needed.
// roles: exclusive claim slots (ToB, BA) or pick-style (Yama: each
// player picks Mage or Melee, both can pick the same).
// fields: modal inputs shown for this activity, in order (max 5).
// pre: button step shown before the modal (Discord modals are text-only).
const ACTIVITIES = {
  toa: {
    name: 'Tombs of Amascut', short: 'ToA', category: 'raids',
    size: { min: 1, max: 8 }, fillPing: true, partyHub: true,
    fields: ['size', 'raidLevel', 'world', 'hub', 'note'],
  },
  cox: {
    name: 'Chambers of Xeric', short: 'CoX', category: 'raids',
    fillPing: true, partyHub: true, pre: 'coxMode',
    fields: ['scale', 'world', 'hub', 'note'],
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
    fields: ['world', 'hub', 'note'],
  },
  wintertodt: {
    name: 'Wintertodt', category: 'skilling',
    size: null, fillPing: false, partyHub: false,
    fields: ['world', 'note'],
  },
  gotr: {
    name: 'Guardians of the Rift', category: 'skilling',
    size: null, fillPing: false, partyHub: false,
    fields: ['world', 'note'],
  },
  tempoross: {
    name: 'Tempoross', category: 'skilling',
    size: null, fillPing: false, partyHub: false,
    fields: ['world', 'note'],
  },
  zalcano: {
    name: 'Zalcano', category: 'skilling',
    size: null, fillPing: false, partyHub: true,
    fields: ['world', 'hub', 'note'],
  },
  ba: {
    name: 'Barbarian Assault', category: 'skilling',
    size: { fixed: 5 }, fillPing: true, partyHub: true,
    roleMode: 'exclusive',
    roles: ['Attacker', 'Defender', 'Collector', 'Healer', 'Flex'],
    fields: ['world', 'hub', 'note'],
  },
  nex: {
    name: 'Nex', category: 'bosses',
    size: { min: 1, max: 100 }, fillPing: true, partyHub: true,
    fields: ['size', 'world', 'hub', 'note'],
  },
  yama: {
    name: 'Yama', category: 'bosses',
    size: { fixed: 2 }, fillPing: false, partyHub: true,
    roleMode: 'pick',
    roles: ['Mage', 'Melee'],
    fields: ['contract', 'world', 'hub', 'note'],
  },
  huey: {
    name: 'The Hueycoatl', category: 'bosses',
    size: { min: 1, max: 20 }, fillPing: false, partyHub: true, pre: 'hueyInstance',
    fields: ['size', 'world', 'hub', 'note'],
  },
  royals: {
    name: 'Royal Titans', category: 'bosses',
    size: { fixed: 2 }, fillPing: false, partyHub: true,
    fields: ['world', 'hub', 'note'],
  },
  venenatis: {
    name: 'Venenatis', category: 'bosses',
    size: { min: 1, max: 100, allowMass: true }, fillPing: false, partyHub: true,
    fields: ['size', 'world', 'hub', 'note'],
  },
  callisto: {
    name: 'Callisto', category: 'bosses',
    size: { min: 1, max: 100, allowMass: true }, fillPing: false, partyHub: true,
    fields: ['size', 'world', 'hub', 'note'],
  },
  vetion: {
    name: "Vet'ion", category: 'bosses',
    size: { min: 1, max: 100, allowMass: true }, fillPing: false, partyHub: true,
    fields: ['size', 'world', 'hub', 'note'],
  },
  nm: {
    name: 'Nightmare', category: 'bosses',
    size: { min: 1, max: 5 }, partyHub: true, pre: 'nmMode',
    fields: ['size', 'world', 'hub', 'note'],
  },
  wag: {
    name: 'Wilderness Agility', category: 'bosses',
    size: null, fillPing: false, partyHub: false, pre: 'wagWorld',
    fields: ['world', 'note'],
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
  cox: '<:cox:1558470688644268187>',
  tob: '<:tob:1558470703899217945>',
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
  cox: { id: '1558470688644268187', name: 'cox' },
  tob: { id: '1558470703899217945', name: 'tob' },
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
    prompt: 'CoX mode and layout',
    options: [
      { id: 'normal', label: 'Normal' },
      { id: 'large', label: 'Normal (Large)' },
      { id: 'cm', label: 'Challenge Mode' },
    ],
  },
  nmMode: {
    prompt: 'Nightmare team or mass',
    options: [
      { id: 'team', label: 'Team (1-5)' },
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

// ─── Pure helpers (unit-tested) ─────────────────────────────────────

// ToA raid level -> entry mode, per the OSRS wiki.
function toaModeForLevel(n) {
  if (n < 150) return 'Entry';
  if (n < 300) return 'Normal';
  return 'Expert';
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

function buildTeamEmbed(team) {
  const act = ACTIVITIES[team.activity] || {};
  const lines = [];

  if (team.activity === 'toa' && team.raidLevel != null) {
    lines.push(`Raid level ${team.raidLevel} (${toaModeForLevel(team.raidLevel)})`);
  }
  if (team.activity === 'cox' && team.scale) {
    const s = team.scale;
    lines.push(`Scale ${s.raiders}${s.scalers ? `+${s.scalers}` : ''}`);
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
  } else {
    const memberIds = Object.keys(team.members || {});
    lines.push(`**Signed up:** ${memberIds.length ? memberIds.map((id) => names[id] || 'claimed').join(', ') : 'no one yet'}`);
  }

  lines.push('');
  if (team.world) lines.push(`🌍 **World:** ${team.world}`);
  if (team.hub) lines.push(`👥 **Party hub:** ${team.hub}`);
  if (team.note) lines.push(`📝 **Note:** ${team.note}`);

  const count = memberCount(team);
  const denom = team.size != null ? team.size : (team.roleMode === 'exclusive' ? (team.roles || []).length : null);
  const sizeStr = denom ? `${count}/${denom}` : `${count} in`;
  lines.push('');
  lines.push(`Posted by ${names[team.organizerId] || 'organizer'} · ${sizeStr}`);
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
      new ButtonBuilder().setCustomId(`team:close:${msgId}`).setLabel('Close Party').setStyle(ButtonStyle.Danger)
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
        new ButtonBuilder().setCustomId('team:create').setLabel('Create Team').setStyle(ButtonStyle.Danger).setEmoji('⚔️')
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

const MODAL_FIELDS = {
  size: { label: 'Team size', placeholder: '4', maxLength: 3 },
  raidLevel: { label: 'Raid level (invocations)', placeholder: '250', maxLength: 4 },
  scale: { label: 'Scale (raiders + scalers)', placeholder: '3+2', maxLength: 7 },
  world: { label: 'World', placeholder: '388', maxLength: 3, required: true },
  hub: {
    label: 'Party hub (RuneLite Party plugin)',
    placeholder: 'Everyone types the same name to share inventories and pings',
    maxLength: 50,
    required: true,
  },
  note: { label: 'Note (optional)', placeholder: 'Learners welcome', style: 'paragraph', maxLength: 200 },
  contract: { label: 'Contract (optional)', placeholder: 'None', maxLength: 100 },
};

function showTeamModal(interaction, activityKey, preId) {
  const act = ACTIVITIES[activityKey];
  const modalId = preId ? `team:modal:${activityKey}:${preId}` : `team:modal:${activityKey}`;
  const modal = new ModalBuilder().setCustomId(modalId).setTitle(`${act.name} team`.slice(0, 45));
  for (const f of act.fields) {
    const def = MODAL_FIELDS[f];
    modal.addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId(`team:${f}`)
          .setLabel(def.label)
          .setStyle(def.style === 'paragraph' ? TextInputStyle.Paragraph : TextInputStyle.Short)
          .setRequired(!!def.required)
          .setMaxLength(def.maxLength)
          .setPlaceholder(def.placeholder || '')
      )
    );
  }
  return interaction.showModal(modal);
}

async function handleCreate(interaction) {
  const last = createCooldowns.get(interaction.user.id) || 0;
  if (Date.now() - last < CREATE_COOLDOWN_MS) {
    await interaction.reply({ content: 'Slow down. One team a minute.', ephemeral: true }).catch(() => {});
    return;
  }
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
  await showTeamModal(interaction, activityKey, null).catch(() => {});
}

async function handlePreChoice(interaction, activityKey, preId) {
  if (!ACTIVITIES[activityKey] || !PRE_CHOICES[ACTIVITIES[activityKey].pre]) {
    await interaction.reply({ content: 'Unknown activity.', ephemeral: true }).catch(() => {});
    return;
  }
  await showTeamModal(interaction, activityKey, preId).catch(() => {});
}

function buildTeamFromModal(activityKey, preId, fields, organizer) {
  // Returns { team } or { error }. Pure apart from reading fields.
  const act = ACTIVITIES[activityKey];
  if (!act) return { error: 'Unknown activity.' };

  const get = (name) => {
    try {
      return fields.getTextInputValue(`team:${name}`).trim();
    } catch {
      return '';
    }
  };

  const world = get('world');
  if (!validateWorld(world)) return { error: 'World must be a 3-digit number.' };

  const hub = act.partyHub ? get('hub') : '';
  if (act.partyHub && !hub) return { error: 'Party hub cannot be blank.' };
  const note = get('note');

  const team = {
    activity: activityKey,
    organizerId: organizer.id,
    memberNames: { [organizer.id]: organizer.displayName },
    members: {},
    roles: rolesFor(activityKey, preId),
    roleMode: roleModeFor(activityKey),
    pre: preId || null,
    world,
    hub: hub || null,
    note: note || null,
    contract: null,
    scale: null,
    raidLevel: null,
    size: null,
    fillPing: !!act.fillPing,
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
    if (nmCfg.size == null) {
      team.size = null; // mass mode is open
    } else {
      const parsed = parseSizeInput(activityKey, get('size'));
      if (parsed.error) return { error: parsed.error };
      team.size = parsed.size;
    }
  } else if (act.size && act.size.fixed) {
    team.size = act.size.fixed;
  } else if (act.size) {
    const parsed = parseSizeInput(activityKey, get('size'));
    if (parsed.error) return { error: parsed.error };
    team.size = parsed.size;
  }

  if (activityKey === 'toa') {
    const lvl = parseRaidLevel(get('raidLevel'));
    if (lvl == null) return { error: 'Raid level must be a number.' };
    team.raidLevel = lvl;
  }
  if (activityKey === 'cox') {
    const scale = parseCoxScale(get('scale'));
    if (!scale) return { error: 'Scale looks like 3+2 (raiders + scalers).' };
    team.scale = scale;
    team.size = scale.raiders;
  }
  if (activityKey === 'tob' && !team.roles) return { error: 'Pick 4s or 5s first.' };
  if (activityKey === 'yama') team.contract = get('contract') || null;

  return { team };
}

async function handleTeamModal(interaction) {
  // customId: 'team:modal:<activity>[:<preId>]'
  const parts = interaction.customId.split(':');
  const activityKey = parts[2];
  const preId = parts.slice(3).join(':') || null;

  const { team, error } = buildTeamFromModal(activityKey, preId, interaction.fields, interaction.user);
  if (error || !team) {
    await interaction.reply({ content: error || 'Could not build that team.', ephemeral: true }).catch(() => {});
    return;
  }

  const channelId = teamsChannelId();
  if (!channelId) {
    await interaction.reply({ content: 'Team finder is not set up yet. Tell staff.', ephemeral: true }).catch(() => {});
    return;
  }
  const channel = await interaction.client.channels.fetch(channelId).catch(() => null);
  if (!channel || !channel.isTextBased()) {
    await interaction.reply({ content: 'Could not find the team finder channel. Tell staff.', ephemeral: true }).catch(() => {});
    return;
  }

  await interaction.deferReply({ ephemeral: true });

  const roleId = activityRoleId(activityKey);
  const content = roleId ? `<@&${roleId}>` : null;
  let msg;
  try {
    team.channelId = channel.id;
    msg = await channel.send({
      content,
      embeds: [buildTeamEmbed(team)],
      components: buildListingComponents({ ...team, messageId: 'pending' }),
    });
  } catch (err) {
    console.error('Team post failed:', err.message);
    await interaction.editReply({ content: 'Could not post that team. Tell staff.' }).catch(() => {});
    return;
  }

  team.messageId = msg.id;
  const state = loadState();
  state.teams[msg.id] = team;
  saveState(state);

  // Patch the buttons with the real message id now that we have it.
  await msg.edit({ components: buildListingComponents(team) }).catch((err) => console.warn('Team button patch failed:', err.message));

  createCooldowns.set(interaction.user.id, Date.now());
  await interaction.editReply({ content: 'Team posted.' }).catch(() => {});
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
  await msg
    .edit({ embeds: [buildTeamEmbed(team)], components: buildListingComponents(team) })
    .catch((err) => console.warn('Team refresh failed:', err.message));
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
    await channel.send(`${mentions} Team's full. ${where}`).catch(() => {});
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

async function handleTeamButton(interaction) {
  // customId: team:create | team:cat:<id> | team:pre:<act>:<pre> |
  // team:join:<msg> | team:leave:<msg> | team:role:<msg>:<idx> |
  // team:close:<msg>
  const parts = interaction.customId.split(':');
  const action = parts[1];
  if (action === 'create') return handleCreate(interaction);
  if (action === 'cat') return handleCategory(interaction, parts[2]);
  if (action === 'pre') return handlePreChoice(interaction, parts[2], parts.slice(3).join(':'));
  if (action === 'join') return handleJoin(interaction, parts[2]);
  if (action === 'leave') return handleLeave(interaction, parts[2]);
  if (action === 'role') return handleRoleClaim(interaction, parts[2], parseInt(parts[3], 10));
  if (action === 'close') return handleClose(interaction, parts[2]);
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
  buildTeamFromModal,
  buildTeamEmbed,
  buildListingComponents,
  teamPanelPayload,
  handleTeamButton,
  handleTeamSelect,
  handleTeamModal,
  shouldSweepTeam,
  shouldAutoClose,
  sweepExpiredTeams,
  commands,
};
