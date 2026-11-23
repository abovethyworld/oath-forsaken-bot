// Bump tool: a small working panel in the staff Bump Tool thread for
// the OSRS forum recruitment thread. The forum rule is one bump at
// least 2 hours after the last message in the thread.
//
// What it does:
// - A pinned panel shows the last bump and when the next one is due
//   (Discord timestamps, so they render live) and carries an
//   "I bumped" button for bumps made between slots.
// - At 9am, 2pm and 8pm New York time it posts the bump text into
//   the thread with an "I bumped" button and pings the owner.
// - Tapping "I bumped" records the bump, updates the panel, and
//   answers with when the next bump is due. Two hours later the
//   tool pings again with the bump text, because that is when the
//   next bump becomes legal. Due pings only fire between 8am and
//   midnight New York time; one that comes due overnight fires at
//   8am. A slot post after a logged bump covers that bump's due
//   ping, so he is never pinged twice for the same window.
//
// A slot only posts if the check runs within 30 minutes after it,
// so a bot restart late in the day never fires a stale bump into
// the next slot's window. State lives in data/bump-tool.json. The
// bump text itself lives in data/bump-tool-text.txt (runtime data,
// read fresh at every post) because it names the clan chat, which
// the repo guard keeps out of committed files.
const fs = require('node:fs');
const path = require('node:path');
const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { DateTime } = require('luxon');
const config = require('./config');
const { atomicWrite } = require('./store');

const ZONE = 'America/New_York';
const STATE_FILE = path.join(__dirname, '..', 'data', 'bump-tool.json');
const TEXT_FILE = path.join(__dirname, '..', 'data', 'bump-tool-text.txt');
const CATCH_UP_MINUTES = 30;
const BUMP_GAP_HOURS = 2;

function settings() {
  return config.bumpTool || {};
}

function loadState() {
  try {
    let parsed = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    // Early builds re-encoded the file on every save; unwrap fully.
    while (typeof parsed === 'string') parsed = JSON.parse(parsed);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function saveState(state) {
  atomicWrite(STATE_FILE, state);
}

function readText() {
  try {
    return fs.readFileSync(TEXT_FILE, 'utf8').trim() || null;
  } catch {
    return null;
  }
}

function bumpButton(disabled = false) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('bump:done')
      .setLabel('I bumped')
      .setStyle(ButtonStyle.Success)
      .setDisabled(disabled),
  );
}

function panelContent(state) {
  const s = settings();
  const lines = [
    '**Bump tool**',
    `Forum thread: ${s.forumThreadUrl}`,
    'Bumps land here at 9am, 2pm and 8pm ET. Tap **I bumped** after you post one and it pings you again 2 hours later, when the next bump is due.',
  ];
  if (state.lastBumpedAt) {
    const last = Math.floor(DateTime.fromISO(state.lastBumpedAt).toSeconds());
    const due = last + BUMP_GAP_HOURS * 3600;
    lines.push(`Last bump: <t:${last}:f>`);
    if (Math.floor(DateTime.now().toSeconds()) >= due) {
      lines.push('Status: **Bump available now**');
    } else {
      lines.push(`Status: Next bump due <t:${due}:R>`);
    }
  } else {
    lines.push('No bump logged yet. Status: **Bump available now**');
  }
  return lines.join('\n');
}

async function fetchThread(client) {
  const s = settings();
  if (!s.threadId) return null;
  return client.channels.fetch(s.threadId).catch(() => null);
}

async function refreshPanel(client, state) {
  if (!state.panelMessageId) return;
  const thread = await fetchThread(client);
  if (!thread) return;
  const msg = await thread.messages.fetch(state.panelMessageId).catch(() => null);
  if (msg) await msg.edit({ content: panelContent(state), components: [bumpButton()] }).catch(() => {});
}

// First run: explain the thread once and pin the panel. If the
// state file was lost, adopt the messages already in the thread
// instead of posting duplicates.
async function ensureBumpTool(client) {
  const thread = await fetchThread(client);
  if (!thread) return;
  const state = loadState();
  if (!state.introPosted || !state.panelMessageId) {
    const recent = await thread.messages.fetch({ limit: 10 }).catch(() => null);
    if (recent) {
      for (const msg of recent.values()) {
        if (!msg.author.bot) continue;
        if (!state.introPosted && msg.content.startsWith('**Bump tool.**')) state.introPosted = true;
        if (!state.panelMessageId && msg.content.startsWith('**Bump tool**')) state.panelMessageId = msg.id;
      }
      saveState(state);
    }
  }
  if (!state.introPosted) {
    await thread.send([
      '**Bump tool.** At 9am, 2pm and 8pm ET the bump text lands here, ready to copy into the recruitment thread.',
      'One bump per slot, and only if the thread has had no message in the last 2 hours.',
      `Forum thread: ${settings().forumThreadUrl}`,
    ].join('\n'));
    state.introPosted = true;
    saveState(state);
    console.log('Bump tool: intro posted.');
  }
  if (!state.panelMessageId) {
    const panel = await thread.send({ content: panelContent(state), components: [bumpButton()] });
    await panel.pin().catch(() => {});
    state.panelMessageId = panel.id;
    saveState(state);
    console.log('Bump tool: panel posted and pinned.');
  }
  // Keep the panel text current across restarts (status line, times).
  await refreshPanel(client, state);
}

// Called on an interval. Posts at most one due slot per call.
async function checkBumpTool(client) {
  const s = settings();
  if (!s.threadId || !Array.isArray(s.times)) return;
  const text = readText();
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
    await thread.send({
      content: `${ping}**Bump time.** If the thread has had any message in the last 2 hours, hold off - the forum clock runs from the last message.`,
      components: [bumpButton()],
    });
    await thread.send(text);
    state.lastPostedSlot = slotKey;
    // A slot post after a logged bump covers that bump's due ping.
    if (state.lastBumpedAt) state.duePingFor = state.lastBumpedAt;
    saveState(state);
    console.log(`Bump tool: posted the ${time} slot.`);
    return;
  }

  // Due ping: 2 hours after a logged bump, ping again with the text.
  if (state.lastBumpedAt && state.duePingFor !== state.lastBumpedAt) {
    const due = DateTime.fromISO(state.lastBumpedAt).setZone(ZONE).plus({ hours: BUMP_GAP_HOURS });
    const hour = now.hour;
    if (now >= due && hour >= 8 && hour < 24) {
      const thread = await fetchThread(client);
      if (!thread) return;
      const pingId = process.env.BUMP_TOOL_PING_USER_ID;
      const ping = pingId ? `<@${pingId}> ` : '';
      await thread.send({
        content: `${ping}**Bump time.** Two hours since your last bump, so the next one is open. If the thread has had any message in the last 2 hours, hold off - the forum clock runs from the last message.`,
        components: [bumpButton()],
      });
      await thread.send(text);
      state.duePingFor = state.lastBumpedAt;
      saveState(state);
      console.log('Bump tool: posted the 2-hour due ping.');
    }
  }
}

// "I bumped" - records the bump, refreshes the panel, disables the
// button on the message that was tapped, and tells the tapper when
// the next bump is due.
async function handleBumpButton(interaction) {
  const state = loadState();
  state.lastBumpedAt = DateTime.now().setZone(ZONE).toISO();
  saveState(state);
  const due = Math.floor(DateTime.fromISO(state.lastBumpedAt).toSeconds()) + BUMP_GAP_HOURS * 3600;
  await refreshPanel(interaction.client, state).catch(() => {});
  if (interaction.message && interaction.message.id !== state.panelMessageId) {
    await interaction.message.edit({ components: [bumpButton(true)] }).catch(() => {});
  } else if (interaction.message) {
    await interaction.deferUpdate().catch(() => {});
    return;
  }
  await interaction.reply({ content: `Logged. Next bump due <t:${due}:R> - I will ping you here then.`, ephemeral: true });
}

module.exports = { ensureBumpTool, checkBumpTool, handleBumpButton };
