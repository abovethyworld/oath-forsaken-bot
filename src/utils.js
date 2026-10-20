// Shared utilities — consolidates duplicated helpers from across the codebase.
// Use these instead of copy-pasting. If you need a new shared helper, put it here.
const { PermissionFlagsBits } = require('discord.js');
const config = require('./config');

// ─── Theme ──────────────────────────────────────────────────────────
const ZAMORAK_RED = 0x6b0e0e;

// ─── Time constants ─────────────────────────────────────────────────
const DAY_MS = 24 * 3600 * 1000;
const MONTH_MS = 30.44 * DAY_MS;

// ─── Staff check ────────────────────────────────────────────────────
// Single source of truth. Was duplicated in recruit.js and tickets.js.
function isStaff(interactionOrMember) {
  const member = interactionOrMember.member || interactionOrMember;
  const staffIds = config.tickets?.staffRoleIds || [];
  return (
    member.roles.cache.some((r) => staffIds.includes(r.id)) ||
    member.permissions?.has(PermissionFlagsBits.Administrator)
  );
}

// ─── Role lookup ────────────────────────────────────────────────────
// Find a role by ID from config. Falls back to name lookup with a warning
// (name lookups break silently on rename — prefer IDs).
function getRoleById(guild, roleId, fallbackName) {
  if (roleId) {
    const role = guild.roles.cache.get(roleId);
    if (role) return role;
  }
  if (fallbackName) {
    console.error(`Role ID ${roleId} not found, falling back to name lookup: "${fallbackName}"`);
    return guild.roles.cache.find((r) => r.name === fallbackName) || null;
  }
  return null;
}

// ─── Oath Forsakers ping role ───────────────────────────────────────
// Auto-assigned on join and approval. ID from config, not name.
function getPingRole(guild) {
  const roleId = config.roles?.oathForsakersId;
  return getRoleById(guild, roleId, 'Oath Forsakers');
}

// ─── Initiate welcome message ───────────────────────────────────────
// Single source of truth. Was triple-duplicated in seniority.js,
// recruit.js, and tickets.js.
function buildInitiateWelcome(userId) {
  const introduceId = config.channels?.introduceYourself || '1558428255940378715';
  const rolesId = config.channels?.roles || '1558399101454786670';
  const staffId = config.tickets?.staffRoleIds?.[0] || '1558735997922054225';
  const initiateId = config.seniorityRanks?.find((r) => r.minMonths === 0)?.roleId || '1558452023790276659';

  return (
    `⛧ <@&${initiateId}> ⛧\n` +
    `⛧ ━━━━━━━━━━━━━━━━━━━━━━━━ ⛧\n` +
    `<@${userId}> has joined Oath Forsaken.\n\n` +
    `Welcome to Oath Forsaken! Glad you're here. Take a look around and make yourself at home.\n\n` +
    `• Drop an intro in <#${introduceId}> so we can get to meet you\n` +
    `• Grab your roles in <#${rolesId}>\n` +
    `• Ping <@&${staffId}> when you're ready for a clan chat invite`
  );
}

// ─── Guest welcome message ────────────────────────────────────────
// Single source of truth for the guest welcome posted in #general.
function buildGuestWelcome(userId) {
  const guestId = config.recruit?.guestRoleId || '1558540445611728997';
  const introduceId = config.channels?.introduceYourself || '1558428255940378715';
  const rolesId = config.channels?.roles || '1558399101454786670';
  const staffId = config.tickets?.staffRoleIds?.[0] || '1558735997922054225';
  const contactId = config.recruit?.contactStaffChannelId || '1558399103757717518';

  return (
    `Welcome, <@&${guestId}>\n` +
    `⛧ ━━━━━━━━━━━━━━━━ ⛧\n` +
    `<@${userId}>\n\n` +
    `The door's open. Come see what the forsaken built.\n\n` +
    `• Introduce yourself in <#${introduceId}>\n` +
    `• Grab your roles in <#${rolesId}>\n` +
    `• Ping <@&${staffId}> when you're ready for a clan chat invite\n` +
    `• Like what you see? To become an official member, hit Become a Member in <#${contactId}>`
  );
}
// Wraps role changes with hierarchy check and error logging.
// Returns true on success, false on failure.
async function safeRoleAdd(member, roleId, reason) {
  try {
    const role = member.guild.roles.cache.get(roleId);
    if (!role) {
      console.error(`safeRoleAdd: role ${roleId} not found`);
      return false;
    }
    const botMember = member.guild.members.me;
    if (botMember && role.position >= botMember.roles.highest.position) {
      console.error(`safeRoleAdd: cannot assign ${role.name} — bot role is below it`);
      return false;
    }
    await member.roles.add(roleId, reason);
    return true;
  } catch (err) {
    console.error(`safeRoleAdd failed for ${roleId}:`, err.message);
    return false;
  }
}

async function safeRoleRemove(member, roleId, reason) {
  try {
    await member.roles.remove(roleId, reason);
    return true;
  } catch (err) {
    console.error(`safeRoleRemove failed for ${roleId}:`, err.message);
    return false;
  }
}

// For .fetch() calls where null is a valid "not found" result.
// Logs real errors (rate limits, permissions) but stays quiet on 404s.
async function safeFetch(promise, label) {
  try {
    return await promise;
  } catch (err) {
    // DiscordAPIError 10008 = Unknown Message, 10003 = Unknown Channel
    const notFound = err.code === 10008 || err.code === 10003;
    if (!notFound) {
      console.error(`[safeFetch] ${label}:`, err.message);
    }
    return null;
  }
}

// Discord caps an embed description at 4096 characters; an over-long
// build fails the whole send. Builders clamp through here instead of
// discovering the limit in production.
const EMBED_DESC_MAX = 4096;
function clampDesc(text) {
  if (typeof text !== 'string' || text.length <= EMBED_DESC_MAX) return text;
  return text.slice(0, EMBED_DESC_MAX - 1) + '…';
}

module.exports = {
  clampDesc,
  ZAMORAK_RED,
  DAY_MS,
  MONTH_MS,
  isStaff,
  getRoleById,
  getPingRole,
  buildInitiateWelcome,
  buildGuestWelcome,
  safeRoleAdd,
  safeRoleRemove,
  safeFetch,
};
