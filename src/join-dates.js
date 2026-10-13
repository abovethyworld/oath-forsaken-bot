// Original join date tracking for seniority.
// Discord's member.joinedAt resets when someone leaves and rejoins.
// This module persists each user's FIRST-EVER join date so seniority
// ranks survive leave/rejoin cycles.
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DATA_FILE = path.join(DATA_DIR, 'join-dates.json');

let cache = null;

function load() {
  if (cache) return cache;
  try {
    if (fs.existsSync(DATA_FILE)) {
      cache = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    } else {
      cache = {};
    }
  } catch {
    cache = {};
  }
  return cache;
}

function save() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(DATA_FILE, JSON.stringify(cache, null, 2));
  } catch (err) {
    console.error('Join dates save failed:', err.message);
  }
}

// Record a join. Only the FIRST join date is kept — rejoins don't overwrite.
function recordJoin(userId, joinedAt) {
  const dates = load();
  if (!dates[userId] && joinedAt) {
    dates[userId] = new Date(joinedAt).toISOString();
    save();
    return true; // newly recorded
  }
  return false; // already known
}

// Get the original join date, or null if never recorded.
function getOriginalJoinDate(userId) {
  const dates = load();
  const iso = dates[userId];
  return iso ? new Date(iso) : null;
}

// Backfill all current members. Only fills gaps — never overwrites.
async function backfill(guild) {
  const dates = load();
  let added = 0;
  try {
    const members = await guild.members.fetch().catch(() => null);
    if (!members) return added;
    for (const m of members.values()) {
      if (m.user.bot || !m.joinedAt) continue;
      if (!dates[m.id]) {
        dates[m.id] = m.joinedAt.toISOString();
        added++;
      }
    }
    if (added) save();
  } catch (err) {
    console.error('Join dates backfill failed:', err.message);
  }
  return added;
}

module.exports = { recordJoin, getOriginalJoinDate, backfill };
