// One-off discovery via Discord REST API (no gateway WebSocket needed).
// Prints guilds, channels, and roles as JSON. Never prints the token.
require('dotenv').config();

const TOKEN = process.env.DISCORD_TOKEN;
const BASE = 'https://discord.com/api/v10';

async function api(path) {
  const res = await fetch(`${BASE}${path}`, {
    headers: { Authorization: `Bot ${TOKEN}` },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`${path} -> ${res.status} ${body.slice(0, 200)}`);
  }
  return res.json();
}

(async () => {
  const me = await api('/users/@me');
  console.log(JSON.stringify({ bot: me.username }, null, 2));

  const guilds = await api('/users/@me/guilds');
  console.log(JSON.stringify({ guilds: guilds.map((g) => ({ id: g.id, name: g.name })) }, null, 2));

  for (const g of guilds) {
    const channels = await api(`/guilds/${g.id}/channels`);
    const roles = await api(`/guilds/${g.id}/roles`);
    const typeName = { 0: 'Text', 2: 'Voice', 4: 'Category', 5: 'News', 13: 'Stage', 15: 'Forum' };
    const chanOut = channels
      .filter((c) => [0, 2, 4, 5, 13, 15].includes(c.type))
      .map((c) => ({ id: c.id, name: c.name, type: typeName[c.type] || c.type, parent_id: c.parent_id || null }))
      .sort((a, b) => a.name.localeCompare(b.name));
    const parentName = Object.fromEntries(channels.filter((c) => c.type === 4).map((c) => [c.id, c.name]));
    for (const c of chanOut) c.parent = c.parent_id ? parentName[c.parent_id] || c.parent_id : null;
    const roleOut = roles
      .filter((r) => r.name !== '@everyone')
      .map((r) => ({ id: r.id, name: r.name, position: r.position, managed: r.managed }))
      .sort((a, b) => b.position - a.position);
    console.log(JSON.stringify({ guild: g.name, channels: chanOut, roles: roleOut }, null, 2));
  }
})().catch((e) => {
  console.error('FAILED:', e.message);
  process.exit(1);
});
