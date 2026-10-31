// Friends of the Clan for the website. The clan site gives Friend of the
// Clan role holders their own roster rows, separate from members. The bot
// is the only side that can see Discord roles, so it publishes the list to
// data/friends.json for the site exporter: role holders with a linked RSN,
// under their active name. Refreshed on the startup sweep and daily, from
// the guild cache, so it costs no extra Discord calls.
const path = require('path');
const config = require('./config');
const { atomicWrite } = require('./store');
const { getMembers } = require('./guild-cache');
const { getRsnEntry } = require('./teams');

const FRIENDS_FILE = path.join(__dirname, '..', 'data', 'friends.json');
const FRIEND_ROLE_ID = (config.seniority || {}).friendOfClanRoleId;

async function syncFriends(client) {
  if (!FRIEND_ROLE_ID) return 0;
  const guild = client.guilds.cache.get(config.guildId);
  if (!guild) return 0;
  const members = await getMembers(guild);
  if (!members) return 0;
  const friends = [];
  for (const member of members.values()) {
    if (!member.roles.cache.has(FRIEND_ROLE_ID)) continue;
    const entry = getRsnEntry(member.id);
    if (!entry.active) continue; // a roster row needs a linked RSN
    friends.push({ discordId: member.id, rsn: entry.active, rsns: entry.rsns });
  }
  friends.sort((a, b) => a.rsn.toLowerCase().localeCompare(b.rsn.toLowerCase()));
  atomicWrite(FRIENDS_FILE, friends);
  return friends.length;
}

module.exports = { syncFriends };
