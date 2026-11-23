// Bump tool: three times a day (config.bumpTool.times, New York time)
// this posts the recruitment bump text into the staff Bump Tool
// thread and pings the owner, so the forum thread gets bumped on
// schedule without anyone watching the clock. The forum rule is one
// bump at least 2 hours after the last message in the thread; the
// slots sit 5-6 hours apart, and the ping line carries the hold-off
// warning for when a reply landed inside the window. A slot only
// posts if the check runs within 30 minutes after it, so a bot
// restart late in the day never fires a stale bump into the next
// slot's window. State lives in data/bump-tool.json. The bump text
// itself lives in data/bump-tool-text.txt (runtime data, read fresh
// at every post) because it names the clan chat, which the repo
// guard keeps out of committed files.
const fs = require('node:fs');
const path = require('node:path');
const { DateTime } = require('luxon');
const config = require('./config');
const { atomicWrite } = require('./store');

const ZONE = 'America/New_York';
const STATE_FILE = path.join(__dirname, '..', 'data', 'bump-tool.json');
const TEXT_FILE = path.join(__dirname, '..', 'data', 'bump-tool-text.txt');
const CATCH_UP_MINUTES = 30;

function settings() {
  return config.bumpTool || {};
}

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function saveState(state) {
  atomicWrite(STATE_FILE, JSON.stringify(state, null, 2));
}

function introText() {
  const s = settings();
  return [
    '**Bump tool.** At 9am, 2pm and 8pm ET the bump text lands here, ready to copy into the recruitment thread.',
    'One bump per slot, and only if the thread has had no message in the last 2 hours.',
    `Forum thread: ${s.forumThreadUrl}`,
  ].join('\n');
}

async function fetchThread(client) {
  const s = settings();
  if (!s.threadId) return null;
  return client.channels.fetch(s.threadId).catch(() => null);
}

// First run: drop the explainer into the thread once.
async function ensureBumpTool(client) {
  const thread = await fetchThread(client);
  if (!thread) return;
  const state = loadState();
  if (state.introPosted) return;
  await thread.send(introText());
  state.introPosted = true;
  saveState(state);
  console.log('Bump tool: intro posted.');
}

// Called on an interval. Posts at most one due slot per call.
async function checkBumpTool(client) {
  const s = settings();
  if (!s.threadId || !Array.isArray(s.times)) return;
  let text;
  try {
    text = fs.readFileSync(TEXT_FILE, 'utf8').trim();
  } catch {
    return;
  }
  if (!text) return;
  const now = DateTime.now().setZone(ZONE);
  const state = loadState();
  for (const time of s.times) {
    const slot = DateTime.fromISO(`${now.toISODate()}T${time}`, { zone: ZONE });
    const slotKey = `${now.toISODate()} ${time}`;
    if (state.lastPostedSlot === slotKey) continue;
    const lateMinutes = now.diff(slot, 'minutes').minutes;
    if (lateMinutes < 0 || lateMinutes > CATCH_UP_MINUTES) continue;
    const thread = await fetchThread(client);
    if (!thread) return;
    const pingId = process.env.BUMP_TOOL_PING_USER_ID;
    const ping = pingId ? `<@${pingId}> ` : '';
    await thread.send(`${ping}**Bump time.** If the thread has had any message in the last 2 hours, hold off - the forum clock runs from the last message.`);
    await thread.send(text);
    state.lastPostedSlot = slotKey;
    saveState(state);
    console.log(`Bump tool: posted the ${time} slot.`);
    return;
  }
}

module.exports = { ensureBumpTool, checkBumpTool };
