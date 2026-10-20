// Google Calendar sync for clan events.
// Setup (one time, needs the Google account owner):
//   1. https://console.cloud.google.com -> new project -> enable "Google Calendar API"
//   2. OAuth consent screen -> External -> fill app name/email -> add yourself as test user
//   3. Credentials -> Create Credentials -> OAuth client ID -> Desktop app
//      -> add Authorized redirect URI: http://localhost:53682/callback
//   4. Put the client ID + secret in .env as GCAL_CLIENT_ID / GCAL_CLIENT_SECRET
//   5. Run: node src/gcal-auth.js  (opens the Google approval page, saves tokens)
// After that, every /event-create also lands on the linked Google Calendar.
const fs = require('node:fs');
const path = require('node:path');
const { google } = require('googleapis');
const { atomicWrite } = require('./store');

const TOKENS_FILE = path.join(__dirname, '..', 'data', 'gcal-tokens.json');
const REDIRECT_URI = 'http://localhost:53682/callback';
const SCOPES = ['https://www.googleapis.com/auth/calendar.events'];

function oauthClient() {
  if (!process.env.GCAL_CLIENT_ID || !process.env.GCAL_CLIENT_SECRET) return null;
  return new google.auth.OAuth2(process.env.GCAL_CLIENT_ID, process.env.GCAL_CLIENT_SECRET, REDIRECT_URI);
}

function loadTokens() {
  try {
    return JSON.parse(fs.readFileSync(TOKENS_FILE, 'utf8'));
  } catch {
    return null;
  }
}

function saveTokens(tokens) {
  fs.mkdirSync(path.dirname(TOKENS_FILE), { recursive: true });
  atomicWrite(TOKENS_FILE, tokens);
}

function isConfigured() {
  return !!oauthClient() && !!loadTokens();
}

function getAuthUrl() {
  const client = oauthClient();
  if (!client) throw new Error('GCAL_CLIENT_ID / GCAL_CLIENT_SECRET missing from .env');
  return client.generateAuthUrl({ access_type: 'offline', prompt: 'consent', scope: SCOPES });
}

async function exchangeCode(code) {
  const client = oauthClient();
  const { tokens } = await client.getToken(code);
  saveTokens(tokens);
  return tokens;
}

async function authedCalendar() {
  const client = oauthClient();
  const tokens = loadTokens();
  if (!client || !tokens) return null;
  client.setCredentials(tokens);
  client.on('tokens', (t) => {
    // persist refreshed tokens
    saveTokens({ ...loadTokens(), ...t });
  });
  return google.calendar({ version: 'v3', auth: client });
}

// start/end: JS Dates. Returns the Google event link, or null if not configured.
async function createEvent({ summary, description, start, end, timeZone, calendarId }) {
  const calendar = await authedCalendar();
  if (!calendar) return null;
  const res = await calendar.events.insert({
    calendarId: calendarId || 'primary',
    requestBody: {
      summary,
      description: description || '',
      start: { dateTime: start.toISOString(), timeZone },
      end: { dateTime: end.toISOString(), timeZone },
    },
  });
  return res.data.htmlLink || null;
}

module.exports = { isConfigured, getAuthUrl, exchangeCode, createEvent, REDIRECT_URI };
