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

function load() {
  try {
    return JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch {
    return {};
  }
}

// Atomic write: temp file + rename so a crash mid-write never corrupts the data file.
function atomicWrite(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

function save(data) {
  atomicWrite(FILE, data);
}

function loadJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

function saveJson(file, data) {
  atomicWrite(file, data);
}

module.exports = {
  atomicWrite,
  addStrike(guildId, userId, reason, modId) {
    const data = load();
    data[guildId] ??= {};
    data[guildId][userId] ??= [];
    data[guildId][userId].push({ reason, modId, at: new Date().toISOString() });
    save(data);
    return data[guildId][userId].length;
  },

  getStrikes(guildId, userId) {
    const data = load();
    return (data[guildId] && data[guildId][userId]) || [];
  },

  clearStrikes(guildId, userId) {
    const data = load();
    if (data[guildId]) delete data[guildId][userId];
    save(data);
  },

  // ---- Tickets: { guildId: { userId: channelId } } ----
  getTicket(guildId, userId) {
    const data = loadJson(TICKETS_FILE);
    return (data[guildId] && data[guildId][userId]) || null;
  },
  setTicket(guildId, userId, channelId) {
    const data = loadJson(TICKETS_FILE);
    data[guildId] ??= {};
    data[guildId][userId] = channelId;
    saveJson(TICKETS_FILE, data);
  },
  removeTicket(guildId, userId) {
    const data = loadJson(TICKETS_FILE);
    if (data[guildId]) delete data[guildId][userId];
    saveJson(TICKETS_FILE, data);
  },
  getTicketOwner(guildId, channelId) {
    const data = loadJson(TICKETS_FILE);
    const guild = data[guildId] || {};
    for (const [userId, chId] of Object.entries(guild)) {
      if (chId === channelId) return userId;
    }
    return null;
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

  // ---- Polls: { pollId: poll } ----
  savePoll(poll) {
    const data = loadJson(POLLS_FILE);
    data[poll.id] = poll;
    saveJson(POLLS_FILE, data);
  },
  getPoll(pollId) {
    return loadJson(POLLS_FILE)[pollId] || null;
  },

  // ---- Rosters: { rosterId: { eventName, roster: { userId: role|null }, channelId, messageId } } ----
  saveRoster(rosterId, data) {
    const all = loadJson(ROSTERS_FILE);
    all[rosterId] = data;
    saveJson(ROSTERS_FILE, all);
  },
  getRoster(rosterId) {
    return loadJson(ROSTERS_FILE)[rosterId] || null;
  },
};
