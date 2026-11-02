// /connect: hands a member the ONE code that links the Oath Forsaken
// RuneLite plugin to their Discord account (identity redesign, Oct 31
// 2026). The code belongs to the person, not an RSN: the plugin reports
// the account being played with every sync, the API files data under
// that RSN, and playing an account is what verifies the link.
// Codes are stored hashed in data/plugin-sync/codes.json, the store the
// site plugin API reads.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const { atomicWrite } = require('./store');
const config = require('./config');
const { getRsnEntry, removeRsn, markVerified } = require('./teams');
const { getPlayerIdentity } = require('./wom');

const SYNC_DIR = path.join(__dirname, '..', 'data', 'plugin-sync');
const CODES_FILE = path.join(SYNC_DIR, 'codes.json');
const MEMBERS_DIR = path.join(SYNC_DIR, 'members');
const HELD_FILE = path.join(SYNC_DIR, 'held.jsonl');
const HELD_STATE_FILE = path.join(__dirname, '..', 'data', 'held-state.json');

function loadCodes() {
  try {
    return JSON.parse(fs.readFileSync(CODES_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function saveCodes(codes) {
  atomicWrite(CODES_FILE, codes);
}

function hashCode(code) {
  return crypto.createHash('sha256').update(code).digest('hex');
}

// One live code per person: issuing a new one kills the old one.
function issueCode(discordId) {
  const code = crypto.randomBytes(24).toString('base64url');
  const codes = loadCodes();
  for (const h of Object.keys(codes)) {
    if (codes[h].discordId === discordId) delete codes[h];
  }
  codes[hashCode(code)] = { discordId, created: new Date().toISOString() };
  saveCodes(codes);
  return code;
}

function revokeCodeFor(discordId) {
  const codes = loadCodes();
  let removed = 0;
  for (const h of Object.keys(codes)) {
    if (codes[h].discordId === discordId) {
      delete codes[h];
      removed++;
    }
  }
  if (removed) saveCodes(codes);
  return removed;
}

// ─── Member records (written by the site plugin API) ─────────────────
function slugOf(rsn) {
  return rsn.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function recordPath(rsn) {
  return path.join(MEMBERS_DIR, `${slugOf(rsn)}.json`);
}

function readRecord(rsn) {
  try {
    return JSON.parse(fs.readFileSync(recordPath(rsn), 'utf8'));
  } catch {
    return null;
  }
}

// Release a record's owner stamp (self-unlink of a verified name, or a
// staff clear). The synced data stays; the next verified sync claims it.
function clearRecordOwner(rsn, discordId) {
  const record = readRecord(rsn);
  if (!record || record.discordId !== discordId) return false;
  record.discordId = null;
  atomicWrite(recordPath(rsn), record);
  return true;
}

// Verified links come from member records now: a record stamped with a
// Discord id means that member played the RSN under their own code.
// Runs at startup so links catch up with whatever the API recorded.
// Also backfills each record's WOM player id (the rename anchor) the
// first time it is seen. Returns how many links changed.
async function reconcileVerifiedLinks() {
  let files = [];
  try {
    files = fs.readdirSync(MEMBERS_DIR).filter((f) => f.endsWith('.json'));
  } catch {
    return 0;
  }
  let changed = 0;
  for (const file of files) {
    let record = null;
    try {
      record = JSON.parse(fs.readFileSync(path.join(MEMBERS_DIR, file), 'utf8'));
    } catch {
      continue;
    }
    if (!record || !record.discordId || !record.rsn) continue;
    let womId = typeof record.womId === 'number' ? record.womId : null;
    if (womId === null) {
      const ident = await getPlayerIdentity(record.rsn).catch(() => null);
      if (ident) {
        womId = ident.id;
        record.womId = womId;
        try {
          atomicWrite(path.join(MEMBERS_DIR, file), record);
        } catch { /* the stamp lands on a later sweep */ }
      }
    }
    if (markVerified(record.discordId, record.rsn, womId)) changed++;
  }
  return changed;
}

// ─── Staff log ────────────────────────────────────────────────────────
async function staffLog(client, text) {
  try {
    const channel = await client.channels.fetch(config.channels.modLog);
    if (channel) await channel.send(text);
  } catch (err) {
    console.warn('Staff log post failed:', err.message);
  }
}

// Held posts: the API refuses a sync for an RSN owned by someone else
// and appends a line to held.jsonl. Surface each new line to the staff
// log once (cursor in data/held-state.json).
async function surfaceHeldPosts(client) {
  let lines = [];
  try {
    lines = fs.readFileSync(HELD_FILE, 'utf8').split('\n').filter(Boolean);
  } catch {
    return 0;
  }
  let reported = 0;
  try {
    reported = JSON.parse(fs.readFileSync(HELD_STATE_FILE, 'utf8')).reported || 0;
  } catch { /* first run */ }
  if (reported > lines.length) reported = lines.length;
  let posted = 0;
  for (const line of lines.slice(reported)) {
    let entry = null;
    try { entry = JSON.parse(line); } catch { continue; }
    await staffLog(client,
      `Plugin sync held: <@${entry.discordId}> synced **${entry.rsn}** (${entry.field}), ` +
      'but that record belongs to another member. Nothing was merged.');
    posted++;
  }
  if (posted) {
    atomicWrite(HELD_STATE_FILE, { reported: lines.length });
  }
  return posted;
}

// ─── Commands ─────────────────────────────────────────────────────────
async function connect(interaction) {
  const action = interaction.options.getString('action') || 'code';
  if (action === 'revoke') {
    const removed = revokeCodeFor(interaction.user.id);
    await interaction.reply({
      content: removed
        ? 'Your plugin code has been revoked. The plugin stops syncing until you get a new one.'
        : 'You have no active plugin code.',
      ephemeral: true,
    });
    return;
  }
  const code = issueCode(interaction.user.id);
  const entry = getRsnEntry(interaction.user.id);
  await interaction.reply({
    content:
      'The clan plugin is not live yet. This code will work when it launches.\n\n' +
      `Your plugin connect code:\n\`${code}\`\n` +
      'Paste it into the Connect Code setting in the Oath Forsaken RuneLite plugin. ' +
      'One code covers every account you play: the plugin reports the account you are ' +
      'logged into, and playing an account links it to you here. ' +
      'Keep it to yourself: anyone with this code can sync as you. ' +
      'Running /connect again replaces it, and the old code stops working.' +
      (entry.rsns.length ? '' : '\nNo RSN linked yet. It links itself the first time the plugin syncs.'),
    ephemeral: true,
  });
}

// Find the stored form of a name on a member's list (case-insensitive).
function storedRsn(entry, wanted) {
  const target = String(wanted || '').toLowerCase();
  return entry.rsns.find((r) => r.toLowerCase() === target) || null;
}

async function unlink(interaction) {
  const wanted = interaction.options.getString('rsn');
  const entry = getRsnEntry(interaction.user.id);
  const rsn = storedRsn(entry, wanted);
  if (!rsn) {
    await interaction.reply({ content: `**${wanted}** is not on your link list.`, ephemeral: true });
    return;
  }
  const wasVerified = entry.verified.includes(rsn);
  removeRsn(interaction.user.id, rsn);
  if (wasVerified) clearRecordOwner(rsn, interaction.user.id);
  await staffLog(interaction.client,
    `<@${interaction.user.id}> unlinked **${rsn}**${wasVerified ? ' (was verified; record owner stamp cleared)' : ''}.`);
  await interaction.reply({
    content: `**${rsn}** is unlinked.` + (wasVerified ? ' Its synced record is released and can be claimed by a new verified sync.' : ''),
    ephemeral: true,
  });
}

async function forceUnlink(interaction) {
  if (!interaction.memberPermissions || !interaction.memberPermissions.has(PermissionFlagsBits.Administrator)) {
    await interaction.reply({ content: 'Staff only.', ephemeral: true });
    return;
  }
  const target = interaction.options.getUser('user');
  const wanted = interaction.options.getString('rsn');
  const entry = getRsnEntry(target.id);
  const rsn = storedRsn(entry, wanted);
  const hadLink = Boolean(rsn);
  if (rsn) removeRsn(target.id, rsn);
  const cleared = clearRecordOwner(wanted, target.id);
  await staffLog(interaction.client,
    `Staff clear by <@${interaction.user.id}>: **${wanted}** unlinked from <@${target.id}>` +
    `${hadLink ? '' : ' (no link found)'}${cleared ? '; record owner stamp cleared' : ''}.`);
  await interaction.reply({
    content: `Cleared **${wanted}** for <@${target.id}>.${hadLink ? '' : ' They had no link under that name.'}${cleared ? ' Record stamp cleared.' : ''}`,
    ephemeral: true,
  });
}

const commands = [
  {
    data: new SlashCommandBuilder()
      .setName('connect')
      .setDescription('Get the code that links the clan RuneLite plugin to your Discord')
      .addStringOption((o) =>
        o
          .setName('action')
          .setDescription('Get a code, or revoke your current one')
          .addChoices({ name: 'Get a code', value: 'code' }, { name: 'Revoke my code', value: 'revoke' })
      ),
    run: connect,
  },
  {
    data: new SlashCommandBuilder()
      .setName('unlink')
      .setDescription('Remove an RSN from your link list')
      .addStringOption((o) => o.setName('rsn').setDescription('The RSN to remove').setRequired(true)),
    run: unlink,
  },
  {
    data: new SlashCommandBuilder()
      .setName('force-unlink')
      .setDescription('Staff: clear an RSN link and record claim for a member')
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
      .addUserOption((o) => o.setName('user').setDescription('The member').setRequired(true))
      .addStringOption((o) => o.setName('rsn').setDescription('The RSN to clear').setRequired(true)),
    run: forceUnlink,
  },
];

module.exports = { commands, issueCode, revokeCodeFor, reconcileVerifiedLinks, surfaceHeldPosts, clearRecordOwner, slugOf, readRecord, recordPath };
