// Settled cases for the membership sync alerts (src/wom-sync-alerts.js
// and src/role-watch.js): people and RSNs staff have ruled as known
// good, so the daily sweep stops flagging them. The file is edited
// by hand, data/sync-settled.json:
//   { "userIds": ["<discord id>", ...], "rsns": ["<rsn>", ...] }
//
// userIds settle a person's staff-call flags: their role norecord /
// demotion lines and their WOM missing alerts. rsns settle
// individual names: a settled RSN missing from the Wise Old Man
// group is not drift (an alt kept out on purpose), and a settled
// name in the group that matches no member is not a rename mystery.
//
// Settling never mutes a removal - a departed member whose RSNs are
// still in the group always alerts - and never blocks a promotion
// repair. A missing or corrupt file reads as "nothing settled".
const fs = require('fs');
const path = require('path');
const { normName } = require('./membership');

const SETTLED_FILE = path.join(__dirname, '..', 'data', 'sync-settled.json');

function loadSettled() {
  const out = { userIds: new Set(), rsns: new Set() };
  try {
    const raw = JSON.parse(fs.readFileSync(SETTLED_FILE, 'utf8'));
    if (raw && typeof raw === 'object') {
      for (const id of Array.isArray(raw.userIds) ? raw.userIds : []) {
        if (typeof id === 'string' && id) out.userIds.add(id);
      }
      for (const rsn of Array.isArray(raw.rsns) ? raw.rsns : []) {
        const key = normName(rsn);
        if (key) out.rsns.add(key);
      }
    }
  } catch { /* no settled file yet: nothing is settled */ }
  return out;
}

function isUserSettled(settled, userId) {
  return !!(settled && settled.userIds && settled.userIds.has(String(userId)));
}

function isRsnSettled(settled, rsn) {
  return !!(settled && settled.rsns && settled.rsns.has(normName(rsn)));
}

module.exports = { SETTLED_FILE, loadSettled, isUserSettled, isRsnSettled };
