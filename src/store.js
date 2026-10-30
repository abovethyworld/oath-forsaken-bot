// Tiny JSON-file store for strikes. No database needed for a clan-sized bot.
// Data lives in data/strikes.json: { guildId: { userId: [ {reason, modId, at} ] } }
const fs = require('node:fs');
const path = require('node:path');

const FILE = path.join(__dirname, '..', 'data', 'strikes.json');
const TICKETS_FILE = path.join(__dirname, '..', 'data', 'tickets.json');
const REMINDERS_FILE = path.join(__dirname, '..', 'data', 'reminders.json');
const APPS_FILE = path.join(__dirname, '..', 'data', 'applications.json');
const APP_STATS_FILE = path.join(__dirname, '..', 'data', 'application-stats.json');
const POLLS_FILE = path.join(__dirname, '..', 'data', 'polls.json');
const ROSTERS_FILE = path.join(__dirname, '..', 'data', 'rosters.json');
const HOLDS_FILE = path.join(__dirname, '..', 'data', 'seniority-holds.json');

const STRIKE_EXPIRY_DAYS = 90;

function load() {
  try {
    return JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    console.error(`store: failed to parse ${FILE} (${err.message}); moving it aside and starting empty`);
    try {
      fs.renameSync(FILE, `${FILE}.corrupt-${Date.now()}`);
    } catch {}
    return {};
  }
}

// Atomic write: temp file + rename so a crash mid-write never corrupts the data file.
function atomicWrite(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  // Flush the temp file to disk before the rename, so an OS/power crash
  // cannot leave a renamed-but-unflushed file behind.
  const fd = fs.openSync(tmp, 'r');
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
}

function save(data) {
  atomicWrite(FILE, data);
}

function loadJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    console.error(`store: failed to parse ${file} (${err.message}); moving it aside and starting empty`);
    try {
      fs.renameSync(file, `${file}.corrupt-${Date.now()}`);
    } catch {}
    return {};
  }
}

function saveJson(file, data) {
  atomicWrite(file, data);
}

// Drop dead roster records so rosters.json can't grow forever: orphans whose
// message never posted (messageId still null an hour after creation, e.g. a
// failed send in postRoster) and rosters whose event time has passed.
// Returns true if anything was dropped.
function pruneRosterRecords(all) {
  const now = Date.now();
  let changed = false;
  for (const [rosterId, data] of Object.entries(all)) {
    if (!data || typeof data !== 'object') continue;
    const eventAt = data.eventTime ?? data.startTime ?? data.eventAt;
    const eventTs = eventAt != null ? new Date(eventAt).getTime() : NaN;
    if (
      (data.messageId == null && data.createdAt && now - data.createdAt > 3600 * 1000) ||
      (!Number.isNaN(eventTs) && eventTs < now)
    ) {
      delete all[rosterId];
      changed = true;
    }
  }
  return changed;
}

module.exports = {
  atomicWrite,
  addStrike(guildId, userId, reason, modId) {
    const data = load();
    data[guildId] ??= {};
    data[guildId][userId] ??= [];
    data[guildId][userId].push({ reason, modId, at: new Date().toISOString() });
    save(data);
    // Match getStrikes: expired strikes don't count toward the total.
    const cutoff = Date.now() - STRIKE_EXPIRY_DAYS * 24 * 3600 * 1000;
    return data[guildId][userId].filter((s) => new Date(s.at).getTime() > cutoff).length;
  },

  getStrikes(guildId, userId) {
    const data = load();
    const all = (data[guildId] && data[guildId][userId]) || [];
    // Strikes expire after 90 days — the system is about recent behavior
    const cutoff = Date.now() - STRIKE_EXPIRY_DAYS * 24 * 3600 * 1000;
    return all.filter((s) => new Date(s.at).getTime() > cutoff);
  },

  clearStrikes(guildId, userId) {
    const data = load();
    if (data[guildId]) delete data[guildId][userId];
    save(data);
  },

  // ---- Tickets: { guildId: { byUser: { userId: channelId }, byChannel: { channelId: userId } } } ----
  // Dual index: forward for "does this user have a ticket", reverse for "who owns this channel".
  // Old format { guildId: { userId: channelId } } migrates automatically on first write.
  _migrateTickets(data) {
    for (const [guildId, guild] of Object.entries(data)) {
      if (guild.byUser) continue; // already new format
      const byUser = {};
      const byChannel = {};
      for (const [userId, channelId] of Object.entries(guild)) {
        byUser[userId] = channelId;
        byChannel[channelId] = userId;
      }
      data[guildId] = { byUser, byChannel };
    }
    return data;
  },
  _loadTickets() {
    return this._migrateTickets(loadJson(TICKETS_FILE));
  },
  getTicket(guildId, userId) {
    const data = this._loadTickets();
    return (data[guildId] && data[guildId].byUser[userId]) || null;
  },
  setTicket(guildId, userId, channelId) {
    const data = this._loadTickets();
    data[guildId] ??= { byUser: {}, byChannel: {} };
    data[guildId].byUser[userId] = channelId;
    data[guildId].byChannel[channelId] = userId;
    saveJson(TICKETS_FILE, data);
  },
  removeTicket(guildId, userId) {
    const data = this._loadTickets();
    if (data[guildId]) {
      const channelId = data[guildId].byUser[userId];
      delete data[guildId].byUser[userId];
      if (channelId) delete data[guildId].byChannel[channelId];
    }
    saveJson(TICKETS_FILE, data);
  },
  getTicketOwner(guildId, channelId) {
    const data = this._loadTickets();
    return (data[guildId] && data[guildId].byChannel[channelId]) || null;
  },

  // ---- Event reminders: { eventId: [minutesAlreadySent] } ----
  wasReminded(eventId, minutes) {
    const data = loadJson(REMINDERS_FILE);
    return (data[eventId] || []).includes(minutes);
  },
  markReminded(eventId, minutes) {
    const data = loadJson(REMINDERS_FILE);
    data[eventId] ??= [];
    if (!data[eventId].includes(minutes)) data[eventId].push(minutes);
    saveJson(REMINDERS_FILE, data);
  },
  clearReminders(eventId) {
    const data = loadJson(REMINDERS_FILE);
    delete data[eventId];
    saveJson(REMINDERS_FILE, data);
  },
  pruneReminders(activeEventIds) {
    const data = loadJson(REMINDERS_FILE);
    let changed = false;
    for (const id of Object.keys(data)) {
      if (!activeEventIds.includes(id)) {
        delete data[id];
        changed = true;
      }
    }
    if (changed) saveJson(REMINDERS_FILE, data);
  },

  // ---- Applications: { guildId: { userId: { channelId, submitted, submittedAt } } } ----
  getApplication(guildId, userId) {
    const data = loadJson(APPS_FILE);
    return (data[guildId] && data[guildId][userId] && data[guildId][userId].channelId) || null;
  },
  getApplicationFull(guildId, userId) {
    const data = loadJson(APPS_FILE);
    return (data[guildId] && data[guildId][userId]) || null;
  },
  setApplication(guildId, userId, channelId) {
    const data = loadJson(APPS_FILE);
    data[guildId] ??= {};
    data[guildId][userId] = { channelId, submitted: false, submittedAt: Date.now() };
    saveJson(APPS_FILE, data);
  },
  setApplicationSubmitted(guildId, userId) {
    const data = loadJson(APPS_FILE);
    if (data[guildId] && data[guildId][userId]) {
      data[guildId][userId].submitted = true;
      saveJson(APPS_FILE, data);
    }
  },
  isApplicationSubmitted(guildId, userId) {
    const data = loadJson(APPS_FILE);
    return !!(data[guildId] && data[guildId][userId] && data[guildId][userId].submitted);
  },
  removeApplication(guildId, userId) {
    const data = loadJson(APPS_FILE);
    if (data[guildId]) delete data[guildId][userId];
    saveJson(APPS_FILE, data);
  },
  setApplicationAnswers(guildId, userId, answers) {
    const data = loadJson(APPS_FILE);
    data[guildId] ??= {};
    data[guildId][userId] ??= { channelId: null, submitted: false };
    data[guildId][userId].answers = answers;
    saveJson(APPS_FILE, data);
  },
  getApplicationAnswers(guildId, userId) {
    const data = loadJson(APPS_FILE);
    return (data[guildId] && data[guildId][userId] && data[guildId][userId].answers) || null;
  },

  // ---- Application stats: { guildId: [ { userId, type, decision, decidedBy, submittedAt, decidedAt } ] } ----
  recordApplicationDecision(guildId, entry) {
    const data = loadJson(APP_STATS_FILE);
    data[guildId] ??= [];
    data[guildId].push({ ...entry, decidedAt: Date.now() });
    // Keep last 500 to bound file size
    if (data[guildId].length > 500) data[guildId] = data[guildId].slice(-500);
    saveJson(APP_STATS_FILE, data);
  },
  getApplicationStats(guildId, sinceMs = 0) {
    const data = loadJson(APP_STATS_FILE);
    return (data[guildId] || []).filter((e) => e.decidedAt >= sinceMs);
  },

  // ---- Seniority holds: { guildId: { userId: true } } ----
  // Staff can hold a member's seniority rank (honorary/exception). Sync skips them.
  isSeniorityHeld(guildId, userId) {
    const data = loadJson(HOLDS_FILE);
    return !!(data[guildId] && data[guildId][userId]);
  },
  getSeniorityHolds(guildId) {
    const data = loadJson(HOLDS_FILE);
    return new Set(Object.keys(data[guildId] || {}));
  },
  setSeniorityHold(guildId, userId, held) {
    const data = loadJson(HOLDS_FILE);
    data[guildId] ??= {};
    if (held) {
      data[guildId][userId] = true;
    } else {
      delete data[guildId][userId];
    }
    saveJson(HOLDS_FILE, data);
  },

  // Physically drop expired strikes (getStrikes only filters on read,
  // so without this the file grows forever).
  pruneStrikes() {
    const data = load();
    const cutoff = Date.now() - STRIKE_EXPIRY_DAYS * 24 * 3600 * 1000;
    let changed = false;
    for (const guildId of Object.keys(data)) {
      const guild = data[guildId];
      if (!guild || typeof guild !== 'object') continue;
      for (const userId of Object.keys(guild)) {
        if (!Array.isArray(guild[userId])) continue;
        const kept = guild[userId].filter((s) => new Date(s.at).getTime() > cutoff);
        if (kept.length !== guild[userId].length) {
          changed = true;
          if (kept.length) guild[userId] = kept;
          else delete guild[userId];
        }
      }
    }
    if (changed) save(data);
  },

  // ---- Polls: { pollId: poll } ----
  savePoll(poll) {
    const data = loadJson(POLLS_FILE);
    data[poll.id] = poll;
    saveJson(POLLS_FILE, data);
  },
  getPoll(pollId) {
    return loadJson(POLLS_FILE)[pollId] || null;
  },
  // Find open polls by author in a channel (for /poll-close)
  findOpenPolls(authorId, channelId) {
    return Object.values(loadJson(POLLS_FILE)).filter(
      (p) => !p.closed && p.authorId === authorId && p.channelId === channelId
    );
  },
  closePoll(pollId) {
    const data = loadJson(POLLS_FILE);
    if (data[pollId]) {
      data[pollId].closed = true;
      saveJson(POLLS_FILE, data);
      return true;
    }
    return false;
  },
  // Delete polls closed more than 30 days ago, or open polls older than 90 days
  prunePolls() {
    const data = loadJson(POLLS_FILE);
    const now = Date.now();
    let changed = false;
    for (const [id, poll] of Object.entries(data)) {
      const age = now - (poll.createdAt || now);
      if ((poll.closed && age > 30 * 24 * 3600 * 1000) || age > 90 * 24 * 3600 * 1000) {
        delete data[id];
        changed = true;
      }
    }
    if (changed) saveJson(POLLS_FILE, data);
  },

  // ---- Rosters: { rosterId: { eventName, roster: { userId: role|null }, channelId, messageId, createdAt } } ----
  saveRoster(rosterId, data) {
    const all = loadJson(ROSTERS_FILE);
    pruneRosterRecords(all);
    all[rosterId] = data;
    saveJson(ROSTERS_FILE, all);
  },
  getRoster(rosterId) {
    const all = loadJson(ROSTERS_FILE);
    if (pruneRosterRecords(all)) saveJson(ROSTERS_FILE, all);
    return all[rosterId] || null;
  },
};
