// Website roster inputs. The clan site gives Friend of the Clan role
// holders their own roster rows, separate from members. The bot is the
// only side that can see Discord roles, so it publishes the list to
// data/friends.json for the site exporter: role holders with a linked RSN,
// under their active name. Refreshed on the startup sweep and daily, from
// the guild cache, so it costs no extra Discord calls. The same file also
// publishes the WOM group membership (syncWomGroup below), which the site
// uses as its members list.
const path = require('path');
const config = require('./config');
const { atomicWrite } = require('./store');
const { getMembers } = require('./guild-cache');
const { getRsnEntry } = require('./teams');
const { getGroupMembers } = require('./wom');

const FRIENDS_FILE = path.join(__dirname, '..', 'data', 'friends.json');
const GROUP_FILE = path.join(__dirname, '..', 'data', 'wom-group.json');
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

// The website's members list is the clan's WOM group. Publish its display
// names to data/wom-group.json on the same cadence as the friends list. A
// failed lookup keeps the last good list instead of emptying the roster.
async function syncWomGroup() {
  const names = await getGroupMembers(config.womGroupId);
  if (!names) return 0;
  names.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
  atomicWrite(GROUP_FILE, names.map((rsn) => ({ rsn })));
  return names.length;
}

module.exports = { syncFriends, syncWomGroup };
