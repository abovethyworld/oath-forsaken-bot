// Shared guild data cache — avoids redundant API fetches.
// Multiple startup jobs and periodic syncs need guild members/channels.
// Instead of each fetching independently, they share one cached fetch
// that's invalidated after a TTL.
const { safeFetch } = require('./utils');

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

let membersCache = { data: null, at: 0, guildId: null };
let channelsCache = { data: null, at: 0, guildId: null };
let membersFetch = null; // in-flight member fetch, shared by concurrent callers

async function getMembers(guild, forceRefresh = false) {
  const now = Date.now();
  if (
    !forceRefresh &&
    membersCache.data &&
    membersCache.guildId === guild.id &&
    now - membersCache.at < CACHE_TTL_MS
  ) {
    return membersCache.data;
  }
  if (!membersFetch) {
    membersFetch = (async () => {
      try {
        const members = await safeFetch(guild.members.fetch(), 'guild members fetch');
        if (members) {
          membersCache = { data: members, at: Date.now(), guildId: guild.id };
          return members;
        }
        // Fetch failed: serve the stale copy only while it is within 2x TTL.
        // Beyond that, return null so callers skip instead of acting on
        // membership that may be badly out of date.
        if (
          membersCache.data &&
          membersCache.guildId === guild.id &&
          Date.now() - membersCache.at < CACHE_TTL_MS * 2
        ) {
          return membersCache.data;
        }
        return null;
      } finally {
        membersFetch = null;
      }
    })();
  }
  return membersFetch;
}

async function getChannels(guild, forceRefresh = false) {
  const now = Date.now();
  if (
    !forceRefresh &&
    channelsCache.data &&
    channelsCache.guildId === guild.id &&
    now - channelsCache.at < CACHE_TTL_MS
  ) {
    return channelsCache.data;
  }
  // Channels are already in cache from gateway, no API call needed
  channelsCache = { data: guild.channels.cache, at: now, guildId: guild.id };
  return channelsCache.data;
}

function invalidateCache() {
  membersCache = { data: null, at: 0, guildId: null };
  channelsCache = { data: null, at: 0, guildId: null };
  membersFetch = null;
}

module.exports = { getMembers, getChannels, invalidateCache, CACHE_TTL_MS };
