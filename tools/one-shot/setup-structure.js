// WARNING: historical one-shot setup script (Oct 2026 restructure, already run).
// It rewrites config.json wholesale and creates roles/channels via REST.
// Do NOT run against the live server without reviewing every line first.
// One-off: create the clan's starter roles + channels via REST, then write config.json.
// Safe to re-run: skips anything that already exists by name.
require('dotenv').config();
const fs = require('fs');

const TOKEN = process.env.DISCORD_TOKEN;
const BASE = 'https://discord.com/api/v10';
const GUILD = '1558390769746845718';

async function api(path, method = 'GET', body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { Authorization: `Bot ${TOKEN}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${(await res.text()).slice(0, 200)}`);
  if (res.status === 204) return null;
  return res.json();
}

const ROLES = [
  { name: 'Admin', color: 0xe74c3c, hoist: true },
  { name: 'Moderator', color: 0x3498db, hoist: true },
  { name: 'Event Pings', color: 0xf1c40f, mentionable: true },
  { name: 'General Events', color: 0x9b59b6, mentionable: true },
  { name: 'Boss of the Week', color: 0xe67e22, mentionable: true },
  { name: 'Skill of the Week', color: 0x2ecc71, mentionable: true },
  { name: 'PvM', color: 0xff4757, mentionable: true },
  { name: 'Giveaways', color: 0x1abc9c, mentionable: true },
  { name: 'Raids', color: 0xe91e63, mentionable: true },
  { name: 'Slayer', color: 0x795548, mentionable: true },
  { name: 'Clue Scrolls', color: 0x00bcd4, mentionable: true },
];

(async () => {
  const existingRoles = await api(`/guilds/${GUILD}/roles`);
  const roleByName = Object.fromEntries(existingRoles.map((r) => [r.name, r]));
  const roleIds = {};
  for (const def of ROLES) {
    if (roleByName[def.name]) {
      console.log(`role exists: ${def.name}`);
      roleIds[def.name] = roleByName[def.name].id;
    } else {
      const r = await api(`/guilds/${GUILD}/roles`, 'POST', {
        name: def.name,
        color: def.color,
        hoist: !!def.hoist,
        mentionable: !!def.mentionable,
      });
      console.log(`role created: ${def.name} (${r.id})`);
      roleIds[def.name] = r.id;
    }
  }

  const staffIds = [roleIds['Admin'], roleIds['Moderator']];
  const staffOnly = [
    { id: GUILD, type: 0, allow: '0', deny: '1024' },
    ...staffIds.map((id) => ({ id, type: 0, allow: '1024', deny: '0' })),
  ];

  const existingChannels = await api(`/guilds/${GUILD}/channels`);
  const chanByName = Object.fromEntries(existingChannels.map((c) => [c.name, c]));
  const chanIds = {};
  async function ensureChannel(name, opts) {
    if (chanByName[name]) {
      console.log(`channel exists: ${name}`);
      chanIds[name] = chanByName[name].id;
    } else {
      const c = await api(`/guilds/${GUILD}/channels`, 'POST', { name, ...opts });
      console.log(`channel created: ${name} (${c.id})`);
      chanIds[name] = c.id;
    }
  }

  await ensureChannel('Tickets', { type: 4 });
  await ensureChannel('roles', { type: 0 });
  await ensureChannel('welcome', { type: 0 });
  await ensureChannel('mod-log', { type: 0, permission_overwrites: staffOnly });
  await ensureChannel('tickets', { type: 0 });
  await ensureChannel('ticket-log', { type: 0, permission_overwrites: staffOnly });
  await ensureChannel('events', { type: 0 });

  // ---- write config.json ----
  const cfg = JSON.parse(fs.readFileSync('config.json', 'utf8'));
  cfg.guildId = GUILD;
  cfg.channels = {
    roles: chanIds['roles'],
    rules: '1558393177726259241', // existing #rules
    welcome: chanIds['welcome'],
    modLog: chanIds['mod-log'],
  };
  const btnRole = (label) => roleIds[label];
  cfg.rolePanels = [
    {
      title: 'GENERAL',
      color: 16766720,
      banner: '',
      description: 'Click a button below to opt in or out of pings for that category.',
      buttons: [
        { label: 'General Events', emoji: '🎉', roleId: btnRole('General Events'), style: 'Primary' },
        { label: 'Boss of the Week', emoji: '💀', roleId: btnRole('Boss of the Week'), style: 'Primary' },
        { label: 'Skill of the Week', emoji: '⛏️', roleId: btnRole('Skill of the Week'), style: 'Primary' },
        { label: 'PvM', emoji: '⚔️', roleId: btnRole('PvM'), style: 'Primary' },
        { label: 'Giveaways', emoji: '🎁', roleId: btnRole('Giveaways'), style: 'Secondary' },
      ],
    },
    {
      title: 'PVM / MINIGAME / SKILLING',
      color: 16766720,
      banner: '',
      description: 'Opt into pings for the activities you actually do.',
      buttons: [
        { label: 'Raids', emoji: '🏰', roleId: btnRole('Raids'), style: 'Success' },
        { label: 'Slayer', emoji: '🗡️', roleId: btnRole('Slayer'), style: 'Success' },
        { label: 'Clue Scrolls', emoji: '🗺️', roleId: btnRole('Clue Scrolls'), style: 'Success' },
      ],
    },
  ];
  cfg.tickets = {
    panelChannelId: chanIds['tickets'],
    categoryId: chanIds['Tickets'],
    logChannelId: chanIds['ticket-log'],
    staffRoleIds: staffIds,
    title: 'Need help? 🎫',
    color: 5793266,
    banner: '',
    description: 'Click the button below to open a private ticket with staff.\n\nOne ticket per person — if you already have one open, use that instead.',
    buttonLabel: 'Open a Ticket',
    introMessage: 'Staff will be with you shortly. Describe your issue below and please be patient.',
  };
  cfg.calendar = {
    timezone: 'America/Chicago',
    eventsChannelId: chanIds['events'],
    pingRoleId: roleIds['Event Pings'],
    reminders: [60, 15],
  };
  fs.writeFileSync('config.json', JSON.stringify(cfg));
  console.log('\nconfig.json written with real IDs');
})().catch((e) => {
  console.error('FAILED:', e.message);
  process.exit(1);
});
