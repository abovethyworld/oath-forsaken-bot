// Panel message store: setup/post commands refresh their panel in
// place instead of dropping a second copy on a re-run. Records live
// in data/panel-messages.json, keyed by panel name:
//   { "<key>": { channelId, messageId } }            single message
//   { "<key>": { channelId, messageIds: [...] } }    multi message
// A stored message that no longer exists (deleted by hand) falls
// back to a fresh post, and the record is rewritten.
const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'data', 'panel-messages.json');

function loadAll() {
  try {
    return JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch {
    return {};
  }
}

function saveAll(all) {
  try {
    fs.writeFileSync(FILE, JSON.stringify(all, null, 2));
  } catch (e) {
    console.error('[panel-store] save failed:', e.message);
  }
}

// Send a single-message panel, or edit the recorded one in place.
// The record only counts when it points at this channel, so a panel
// can never be refreshed into the wrong place.
async function postOrEdit(channel, key, payload) {
  const all = loadAll();
  const rec = all[key];
  if (rec && rec.channelId === channel.id && rec.messageId) {
    const msg = await channel.messages.fetch(rec.messageId).catch(() => null);
    if (msg) {
      await msg.edit(payload);
      return msg;
    }
  }
  const msg = await channel.send(payload);
  all[key] = { channelId: channel.id, messageId: msg.id };
  saveAll(all);
  return msg;
}

// Multi-message variant (role panels): edits each recorded message
// in order, posts any that are missing, and drops records for
// messages beyond the current payload count.
async function postOrEditMany(channel, key, payloads) {
  const all = loadAll();
  const rec = all[key];
  const oldIds = rec && rec.channelId === channel.id && Array.isArray(rec.messageIds) ? rec.messageIds : [];
  const ids = [];
  for (let i = 0; i < payloads.length; i++) {
    let msg = null;
    if (oldIds[i]) msg = await channel.messages.fetch(oldIds[i]).catch(() => null);
    if (msg) await msg.edit(payloads[i]);
    else msg = await channel.send(payloads[i]);
    ids.push(msg.id);
  }
  all[key] = { channelId: channel.id, messageIds: ids };
  saveAll(all);
  return ids.length;
}

module.exports = { postOrEdit, postOrEditMany };
