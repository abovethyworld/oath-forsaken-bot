// "Not in the Clan Yet" marker role (owner ruling, Nov 6, 2026): a
// plain flag meaning this person is in the Discord but not in the clan
// yet, whether or not they have applied. Granted on join beside the
// Oath Forsakers grant, removed on approval, and removed by the
// member-update watch whenever any standing role lands by hand. The
// role itself carries no permissions.
const config = require('./config');

function markerRoleId() {
  return config.roles?.notInClanYetId || null;
}

// Every role that means the person has standing and is no longer
// waiting: the three application-type roles, the seven seniority
// ladder ranks, Friend of the Clan, and the staff roles.
function standingRoleIds() {
  const ids = [
    ...Object.values(config.recruit?.types || {}).map((t) => t.roleId),
    config.recruit?.guestRoleId,
    ...Object.values(config.seniority?.rankIds || {}),
    config.seniority?.friendOfClanRoleId,
    ...(config.tickets?.staffRoleIds || []),
  ];
  return new Set(ids.filter(Boolean));
}

// Pure predicate for the watch. False for bots, false when the marker
// is not held (so the removal itself never re-triggers), and false
// until at least one standing role is present.
function shouldRemoveMarker({ isBot, roleIds }) {
  if (isBot) return false;
  const marker = markerRoleId();
  if (!marker || !roleIds || !roleIds.has(marker)) return false;
  const standing = standingRoleIds();
  for (const id of roleIds) {
    if (standing.has(id)) return true;
  }
  return false;
}

async function handleNotInClanUpdate(newMember) {
  try {
    const roleIds = new Set(newMember.roles.cache.keys());
    if (!shouldRemoveMarker({ isBot: !!newMember.user?.bot, roleIds })) return;
    await newMember.roles.remove(markerRoleId(), 'Standing role gained; no longer waiting');
    console.log(`[not-in-clan] Removed the Not in the Clan Yet marker from ${newMember.user?.tag || newMember.id}.`);
  } catch (e) {
    console.error('[not-in-clan] Marker removal failed:', e.message);
  }
}

module.exports = { markerRoleId, standingRoleIds, shouldRemoveMarker, handleNotInClanUpdate };
