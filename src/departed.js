// Departed registry for the WOM sync alerts (src/wom-sync-alerts.js):
// a snapshot of who left the server and which RSNs they held, taken
// at the moment they leave (data/departed.json):
//   { "<discord id>": { "name": "...", "rsns": ["..."], "at": <ms> } }
//
// Why: the removal alert ("left, still in the Wise Old Man group")
// used to read only the live membership record and RSN link. The
// leaver cleanup marks the record as left and parks the link, which
// would have silenced the alert and wiped its dedup memory. The
// registry is the durable source: the sweep flags a departed name
// until it is actually gone from the group, whatever later happens
// to the record or the link. An entry clears when the person
// rejoins, or when the sweep finds none of their RSNs in the group
// anymore. Written only by the leave hook, the rejoin hook, and the
// sweep's prune. A missing or corrupt file reads as "nobody
// departed".
const fs = require('fs');
const path = require('path');
const { atomicWrite } = require('./store');

const DEPARTED_FILE = path.join(__dirname, '..', 'data', 'departed.json');

function loadDeparted() {
  try {
    const raw = JSON.parse(fs.readFileSync(DEPARTED_FILE, 'utf8'));
    if (!raw || typeof raw !== 'object') return {};
    const out = {};
    for (const [userId, dep] of Object.entries(raw)) {
      if (!dep || typeof dep !== 'object') continue;
      const rsns = (Array.isArray(dep.rsns) ? dep.rsns : [])
        .filter((r) => typeof r === 'string' && r.trim())
        .map((r) => r.trim());
      out[userId] = {
        name: typeof dep.name === 'string' && dep.name ? dep.name : null,
        rsns,
        at: typeof dep.at === 'number' ? dep.at : 0,
      };
    }
    return out;
  } catch { /* first run or unreadable: nobody departed */ }
  return {};
}

function saveDeparted(map) {
  fs.mkdirSync(path.dirname(DEPARTED_FILE), { recursive: true });
  atomicWrite(DEPARTED_FILE, map && typeof map === 'object' ? map : {});
}

// Snapshot one departure. Called by the leave hook with the member's
// display name and the RSNs their link held at that moment.
function recordDeparture(userId, name, rsns) {
  if (!userId) return;
  const clean = (Array.isArray(rsns) ? rsns : [])
    .filter((r) => typeof r === 'string' && r.trim())
    .map((r) => r.trim());
  if (!clean.length) return;
  const map = loadDeparted();
  map[String(userId)] = {
    name: typeof name === 'string' && name ? name : null,
    rsns: clean,
    at: Date.now(),
  };
  saveDeparted(map);
}

// A rejoin ends the case. No entry, no write.
function clearDeparture(userId) {
  if (!userId) return;
  const map = loadDeparted();
  if (!Object.prototype.hasOwnProperty.call(map, String(userId))) return;
  delete map[String(userId)];
  saveDeparted(map);
}

module.exports = {
  DEPARTED_FILE,
  loadDeparted,
  saveDeparted,
  recordDeparture,
  clearDeparture,
};
