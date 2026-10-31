// Daily rename watcher (identity redesign, Oct 31 2026).
//
// A verified RSN is anchored to its WOM player id, which survives
// renames. Each pass asks WOM for the current username of every stored
// id: a different username is a confirmed rename (WOM's record, not a
// member's claim), and the link plus the member record move to the new
// name. A name that now belongs to a different id never matches, so a
// recycled name can never pull the original record along.
const fs = require('fs');
const path = require('path');
const { atomicWrite } = require('./store');
const { loadRsnLinks, normalizeRsnEntry, verifiedOwnerOf, renameLinkedRsn, markVerified } = require('./teams');
const { getPlayerById, getPlayerIdentity } = require('./wom');
const { staffLog, recordPath } = require('./plugin-connect');

const MEMBERS_DIR = path.join(__dirname, '..', 'data', 'plugin-sync', 'members');

// Move the member record file to the new name when it belongs to this
// member. Returns a note for the staff log, or null when there was no
// record to move.
function migrateRecord(userId, oldRsn, newRsn) {
  const oldPath = recordPath(oldRsn);
  const newPath = recordPath(newRsn);
  let record = null;
  try {
    record = JSON.parse(fs.readFileSync(oldPath, 'utf8'));
  } catch {
    return null;
  }
  if (!record || record.discordId !== userId) return null;
  if (fs.existsSync(newPath)) return 'record move skipped: a record already exists under the new name';
  record.rsn = newRsn;
  atomicWrite(newPath, record);
  try {
    fs.unlinkSync(oldPath);
  } catch { /* the copy under the new name is the live one */ }
  return 'member record moved';
}

async function watchRenames(client) {
  const links = loadRsnLinks();
  let moved = 0;
  for (const [userId, raw] of Object.entries(links)) {
    const entry = normalizeRsnEntry(raw);
    if (!entry) continue;
    for (const rsn of entry.verified) {
      let womId = entry.womIds[rsn.toLowerCase()];
      if (typeof womId !== 'number') {
        const ident = await getPlayerIdentity(rsn).catch(() => null);
        if (!ident) continue;
        womId = ident.id;
        markVerified(userId, rsn, womId);
      }
      const current = await getPlayerById(womId).catch(() => null);
      if (!current || !current.username) continue;
      const newName = current.username;
      if (newName.toLowerCase() === rsn.toLowerCase()) continue;
      const owner = verifiedOwnerOf(newName);
      if (owner && owner !== userId) {
        await staffLog(client,
          `Rename check: <@${userId}>'s **${rsn}** now resolves to **${newName}** on WOM, ` +
          'but that name is verified to another member. Nothing was moved; staff call.');
        continue;
      }
      if (!renameLinkedRsn(userId, rsn, newName)) continue;
      const note = migrateRecord(userId, rsn, newName);
      await staffLog(client,
        `Rename confirmed by WOM: <@${userId}>'s **${rsn}** is now **${newName}**. Link updated${note ? `; ${note}` : ''}.`);
      moved++;
    }
  }
  return moved;
}

module.exports = { watchRenames };
