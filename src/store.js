// Tiny JSON-file store for strikes. No database needed for a clan-sized bot.
// Data lives in data/strikes.json: { guildId: { userId: [ {reason, modId, at} ] } }
const fs = require('node:fs');
const path = require('node:path');

const FILE = path.join(__dirname, '..', 'data', 'strikes.json');
const TICKETS_FILE = path.join(__dirname, '..', 'data', 'tickets.json');
const REMINDERS_FILE = path.join(__dirname, '..', 'data', 'reminders.json');
const APPS_FILE = path.join(__dirname, '..', 'data', 'applications.json');
const POLLS_FILE = path.join(__dirname, '..', 'data', 'polls.json');

function load() {
  try {
    return JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch {
    return {};
  }
}

function save(data) {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(data, null, 2));
}

function loadJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

function saveJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

module.exports = {
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

  // ---- Applications: { guildId: { userId: { channelId, submitted } } } ----
  getApplication(guildId, userId) {
    const data = loadJson(APPS_FILE);
    return (data[guildId] && data[guildId][userId] && data[guildId][userId].channelId) || null;
  },
  setApplication(guildId, userId, channelId) {
    const data = loadJson(APPS_FILE);
    data[guildId] ??= {};
    data[guildId][userId] = { channelId, submitted: false };
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

  // ---- Polls: { pollId: poll } ----
  savePoll(poll) {
    const data = loadJson(POLLS_FILE);
    data[poll.id] = poll;
    saveJson(POLLS_FILE, data);
  },
  getPoll(pollId) {
    return loadJson(POLLS_FILE)[pollId] || null;
  },
};
