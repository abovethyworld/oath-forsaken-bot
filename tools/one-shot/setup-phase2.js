// WARNING: historical one-shot setup script (Oct 2026 restructure, already run).
// It rewrites config.json wholesale and creates roles/channels via REST.
// Do NOT run against the live server without reviewing every line first.
// Phase 2: create community channels + game-mode/region/member roles, update config.
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
  { name: 'Member', color: 0x7f8c8d },
  { name: 'Ironman', color: 0x8d6e63 },
  { name: 'Hardcore Ironman', color: 0xd32f2f },
  { name: 'Ultimate Ironman', color: 0x1976d2 },
  { name: 'Group Ironman', color: 0x388e3c },
  { name: 'NA East', color: 0x26a69a },
  { name: 'NA Central', color: 0x26a69a },
  { name: 'NA West', color: 0x26a69a },
  { name: 'EU', color: 0x5c6bc0 },
  { name: 'OCE', color: 0xab47bc },
];

const CHANNELS = [
  'introduce-yourself',
  'event-announcements',
  'events-chat',
  'event-photos',
  'polls',
  'osrs-general',
  'pvm',
  'find-a-team',
  'goals-and-achievements',
  'applications',
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
      const r = await api(`/guilds/${GUILD}/roles`, 'POST', { name: def.name, color: def.color });
      console.log(`role created: ${def.name}`);
      roleIds[def.name] = r.id;
    }
  }
  // also grab previously created roles
  for (const r of existingRoles) roleIds[r.name] = r.id;

  const staffIds = [roleIds['Admin'], roleIds['Moderator']].filter(Boolean);
  const staffOnly = [
    { id: GUILD, type: 0, allow: '0', deny: '1024' },
    ...staffIds.map((id) => ({ id, type: 0, allow: '1024', deny: '0' })),
  ];

  const existingChannels = await api(`/guilds/${GUILD}/channels`);
  const chanByName = Object.fromEntries(existingChannels.map((c) => [c.name, c]));
  const chanIds = {};
  for (const name of CHANNELS) {
    const staffLocked = name === 'applications' || name === 'event-announcements';
    if (chanByName[name]) {
      console.log(`channel exists: #${name}`);
      chanIds[name] = chanByName[name].id;
    } else {
      const c = await api(`/guilds/${GUILD}/channels`, 'POST', {
        name,
        type: 0,
        ...(staffLocked ? { permission_overwrites: staffOnly } : {}),
      });
      console.log(`channel created: #${name}`);
      chanIds[name] = c.id;
    }
  }
  for (const c of existingChannels) chanIds[c.name] = c.id;

  // ---- update config.json ----
  const cfg = JSON.parse(fs.readFileSync('config.json', 'utf8'));
  cfg.rolePanels = [
    ...cfg.rolePanels,
    {
      title: 'GAME MODE',
      color: 16766720,
      banner: '',
      description: 'What kind of account do you play? Pick yours.',
      buttons: [
        { label: 'Ironman', emoji: '🛡️', roleId: roleIds['Ironman'], style: 'Secondary' },
        { label: 'Hardcore', emoji: '❤️‍🔥', roleId: roleIds['Hardcore Ironman'], style: 'Secondary' },
        { label: 'Ultimate', emoji: '🎒', roleId: roleIds['Ultimate Ironman'], style: 'Secondary' },
        { label: 'Group Iron', emoji: '👥', roleId: roleIds['Group Ironman'], style: 'Secondary' },
      ],
    },
    {
      title: 'REGION',
      color: 16766720,
      banner: '',
      description: 'Where do you play from? Helps with event timing.',
      buttons: [
        { label: 'NA East', emoji: '🗽', roleId: roleIds['NA East'], style: 'Secondary' },
        { label: 'NA Central', emoji: '🤠', roleId: roleIds['NA Central'], style: 'Secondary' },
        { label: 'NA West', emoji: '🌉', roleId: roleIds['NA West'], style: 'Secondary' },
        { label: 'EU', emoji: '🏰', roleId: roleIds['EU'], style: 'Secondary' },
        { label: 'OCE', emoji: '🏄', roleId: roleIds['OCE'], style: 'Secondary' },
      ],
    },
  ];
  cfg.calendar.eventsChannelId = chanIds['event-announcements'];
  cfg.recruit = {
    applicationsChannelId: chanIds['applications'],
    memberRoleId: roleIds['Member'],
    minAccountAgeDays: 30,
    questions: [
      { id: 'rsn', label: 'OSRS username (RSN)', style: 'short', required: true },
      { id: 'nickname', label: 'What should we call you?', style: 'short', required: true },
      { id: 'heard', label: 'How did you hear about us?', style: 'paragraph', required: true },
    ],
  };
  fs.writeFileSync('config.json', JSON.stringify(cfg));
  console.log('\nconfig.json updated: GAME MODE + REGION panels, recruit section, calendar -> #event-announcements');
})().catch((e) => {
  console.error('FAILED:', e.message);
  process.exit(1);
});
