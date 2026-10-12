// One-off: register slash commands (REST) and post all panels.
// Run after setup-structure.js. Safe to re-run (it will post duplicates — delete old ones manually).
require('dotenv').config();
const config = require('./config'); // validates config.json
const { commands } = require('./commands');

const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const BASE = 'https://discord.com/api/v10';

async function api(path, method = 'GET', body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { Authorization: `Bot ${TOKEN}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${(await res.text()).slice(0, 300)}`);
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

const STYLE = { Primary: 1, Secondary: 2, Success: 3, Danger: 4 };

function chunkButtons(buttons) {
  const rows = [];
  for (let i = 0; i < buttons.length; i += 5) {
    rows.push({
      type: 1,
      components: buttons.slice(i, i + 5).map((b) => ({
        type: 2,
        style: STYLE[b.style] || 2,
        label: b.label,
        custom_id: `role:${b.roleId}`,
        ...(b.emoji ? { emoji: { name: b.emoji } } : {}),
      })),
    });
  }
  return rows;
}

function sectionsDesc(intro, sections, footer) {
  let d = intro ? `${intro}\n\n` : '';
  for (const s of sections || []) d += `**${s.heading}**\n${s.body}\n\n`;
  if (footer) d += `*${footer}*`;
  return d.trim();
}

(async () => {
  // 1. Register slash commands
  const payload = commands.map((c) => c.data.toJSON());
  await api(`/applications/${CLIENT_ID}/guilds/${config.guildId}/commands`, 'PUT', payload);
  console.log(`registered ${payload.length} commands: ${payload.map((c) => c.name).join(', ')}`);

  // 2. Role panels
  for (const panel of config.rolePanels) {
    const embed = { title: panel.title, description: panel.description, color: panel.color };
    if (panel.banner) embed.image = { url: panel.banner };
    await api(`/channels/${config.channels.roles}/messages`, 'POST', {
      embeds: [embed],
      components: chunkButtons(panel.buttons),
    });
    console.log(`posted role panel: ${panel.title}`);
  }

  // 3. Rules
  const r = config.rules;
  const rulesEmbed = { title: r.title, description: sectionsDesc(r.intro, r.sections, r.footer), color: r.color };
  if (r.banner) rulesEmbed.image = { url: r.banner };
  await api(`/channels/${config.channels.rules}/messages`, 'POST', { embeds: [rulesEmbed] });
  console.log('posted rules');

  // 4. Strike system
  const s = config.strikeSystem;
  const strikeEmbed = { title: s.title, description: sectionsDesc(s.intro, s.levels, s.footer), color: s.color };
  if (s.banner) strikeEmbed.image = { url: s.banner };
  await api(`/channels/${config.channels.rules}/messages`, 'POST', { embeds: [strikeEmbed] });
  console.log('posted strike system');

  // 5. Ticket panel
  const t = config.tickets;
  const ticketEmbed = { title: t.title, description: t.description, color: t.color };
  if (t.banner) ticketEmbed.image = { url: t.banner };
  await api(`/channels/${t.panelChannelId}/messages`, 'POST', {
    embeds: [ticketEmbed],
    components: [
      {
        type: 1,
        components: [
          { type: 2, style: 1, label: t.buttonLabel, custom_id: 'ticket:create', emoji: { name: '🎫' } },
        ],
      },
    ],
  });
  console.log('posted ticket panel');

  // 6. Welcome channel: drop a note that auto-welcomes are live
  await api(`/channels/${config.channels.welcome}/messages`, 'POST', {
    embeds: [
      {
        title: 'Welcome channel is live ⚔️',
        description: 'New members will be greeted here automatically from now on.',
        color: 5763719,
      },
    ],
  });
  console.log('posted welcome note');
  console.log('\nDONE — check the server.');
})().catch((e) => {
  console.error('FAILED:', e.message);
  process.exit(1);
});
