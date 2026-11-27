// Bump tool: a small working panel in the staff Bump Tool thread for
// the OSRS forum recruitment thread. The forum rule is one bump at
// least 2 hours after the last message in the thread.
//
// What it does:
// - A pinned panel shows the last bump and when the next one is due
//   (Discord timestamps, so they render live) and carries an
//   "I bumped" button for bumps made between slots.
// - The bump text sits pinned in the thread, ready to copy. It is
//   never reposted.
// - When a bump comes due, one short reminder lands: a ping and
//   "Bump time." with the "I bumped" button. Only one reminder is
//   ever live. Tapping "I bumped" records the bump, deletes the
//   reminder, updates the panel, and answers with when the next
//   bump is due.
// - The clock runs from the last logged bump. A reminder fires 2
//   hours after a logged bump, or at a 9am, 2pm or 8pm New York
//   slot when the last bump is already 2+ hours old (or none is
//   logged). A slot never fires while a reminder is live or inside
//   the 2 hours after a bump, so the same window never pings twice.
//   Reminders only fire between 8am and midnight New York time; one
//   that comes due overnight fires at 8am.
//
// A slot only posts if the check runs within 30 minutes after it,
// so a bot restart late in the day never fires a stale bump into
// the next slot's window. State lives in data/bump-tool.json. The
// bump text itself lives in data/bump-tool-text.txt (runtime data,
// read fresh when the pinned copy is posted) because it names the
// clan chat, which the repo guard keeps out of committed files.
const fs = require('node:fs');
const path = require('node:path');
const { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } = require('discord.js');
const { DateTime } = require('luxon');
const config = require('./config');
const { atomicWrite } = require('./store');
const { isStaff } = require('./utils');

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
  } catch (err) {
    if (err && err.code === 'ENOENT') return {};
    throw err;
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
    'One short ping lands here when the next bump is due. Tap **I bumped** after you post one and the ping deletes itself. The bump text is pinned in this thread.',
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


// ─── Public panel ─────────────────────────────────────────────────
// A second home for the same bump state: a public channel where
// members and Friends of the Clan can log bumps. No reminders and
// no pings ever post here; the pinned panel just re-renders when a
// bump is logged or when the ready window flips. Bump counts are
// shared with the staff thread - one forum thread, one truth.
function topBumpers(state) {
  const counts = state.counts || {};
  return Object.entries(counts)
    .filter(([, n]) => Number.isFinite(n) && n > 0)
    .sort((a, b) => b[1] - a[1]);
}

function publicPanelEmbed(state) {
  const s = settings();
  const lines = [
    `Forum thread: ${s.forumThreadUrl}`,
  ];
  if (state.lastBumpedAt) {
    const last = Math.floor(DateTime.fromISO(state.lastBumpedAt).toSeconds());
    const due = last + BUMP_GAP_HOURS * 3600;
    lines.push(`Last bump: <t:${last}:f>${state.lastBumpedBy ? ` by <@${state.lastBumpedBy}>` : ''}`);
    if (Math.floor(DateTime.now().toSeconds()) >= due) {
      lines.push('Status: **Ready to bump**');
    } else {
      lines.push(`Status: Next bump ready at <t:${due}:t>`);
    }
  } else {
    lines.push('Status: **Ready to bump**');
  }
  const top = topBumpers(state);
  if (top.length) {
    const medals = ['\u{1F947}', '\u{1F948}', '\u{1F949}'];
    lines.push('', '**Top bumpers**');
    top.forEach(([uid, n], i) => {
      lines.push(`${medals[i] || `${i + 1}.`} <@${uid}>${i === 0 ? ' \u2605' : ''} - ${n}`);
    });
  }
  return new EmbedBuilder()
    .setColor(0xA31621)
    .setTitle('Bump')
    .setDescription(lines.join('\n'));
}

async function fetchPublicChannel(client) {
  const s = settings();
  if (!s.publicChannelId) return null;
  return client.channels.fetch(s.publicChannelId).catch(() => null);
}

// Re-render the public panel only when what it shows has changed,
// so the 10-minute tick stays silent unless the status flipped.
async function refreshPublicPanel(client, state) {
  if (!state.publicPanelMessageId) return;
  const channel = await fetchPublicChannel(client);
  if (!channel) return;
  const embed = publicPanelEmbed(state);
  const render = JSON.stringify(embed.toJSON());
  if (state.lastPublicRender === render) return;
  const msg = await channel.messages.fetch(state.publicPanelMessageId).catch(() => null);
  if (!msg) return;
  await msg.edit({ content: '', embeds: [embed], components: [bumpButton()] }).catch(() => {});
  const fresh = loadState();
  fresh.lastPublicRender = render;
  saveState(fresh);
}

// First run in the public channel: pin the bump text and the panel.
// Adopts messages already there if the state file was lost.
async function ensurePublicPanel(client, state) {
  const channel = await fetchPublicChannel(client);
  if (!channel) return;
  if (!state.publicPanelMessageId) {
    const recent = await channel.messages.fetch({ limit: 10 }).catch(() => null);
    if (recent) {
      for (const msg of recent.values()) {
        if (!msg.author.bot) continue;
        if (!state.publicPanelMessageId && (msg.content.startsWith('**Bump**') || msg.embeds.some((e) => e.title === 'Bump'))) {
          state.publicPanelMessageId = msg.id;
        }
      }
      saveState(state);
    }
  }
  if (!state.publicPanelMessageId) {
    const panel = await channel.send({ embeds: [publicPanelEmbed(state)], components: [bumpButton()] });
    await panel.pin().catch(() => {});
    state.publicPanelMessageId = panel.id;
    state.lastPublicRender = JSON.stringify(publicPanelEmbed(state).toJSON());
    saveState(state);
    console.log('Bump tool: public panel posted and pinned.');
  }
  await refreshPublicPanel(client, loadState());
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

// Post the one live reminder and remember it, so no second reminder
// goes out for the same window and the bump tap can delete it.
async function postReminder(client, state) {
  const thread = await fetchThread(client);
  if (!thread) return false;
  const pingId = process.env.BUMP_TOOL_PING_USER_ID;
  const ping = pingId ? `<@${pingId}> ` : '';
  const msg = await thread.send({
    content: `${ping}**Bump time.**`,
    components: [bumpButton()],
  });
  state.reminderMessageId = msg.id;
  saveState(state);
  return true;
}

// Delete the live reminder, if there is one. Used when a bump is
// logged from the panel while a reminder is still sitting there.
async function deleteReminder(client, state) {
  if (!state.reminderMessageId) return;
  const thread = await fetchThread(client);
  if (thread) {
    const msg = await thread.messages.fetch(state.reminderMessageId).catch(() => null);
    if (msg) await msg.delete().catch(() => {});
  }
  state.reminderMessageId = null;
  saveState(state);
}

// First run: explain the thread once, pin the panel, and pin the
// bump text. If the state file was lost, adopt the messages already
// in the thread instead of posting duplicates.
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
      '**Bump tool.** One short ping lands here when the next bump is due - tap **I bumped** after you post one and the ping deletes itself.',
      'The bump text is pinned in this thread, ready to copy into the recruitment thread. One bump per slot, and only if the thread has had no message in the last 2 hours.',
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
  if (!state.textMessageId) {
    const text = readText();
    if (text) {
      const msg = await thread.send(text);
      await msg.pin().catch(() => {});
      state.textMessageId = msg.id;
      saveState(state);
      console.log('Bump tool: bump text posted and pinned.');
    }
  }
  // Keep the panel text current across restarts (status line, times).
  await refreshPanel(client, state);
  await ensurePublicPanel(client, loadState());
}

// Called on an interval. Posts at most one reminder per call, and
// never while one is already live.
async function checkBumpTool(client) {
  await refreshPublicPanel(client, loadState()).catch(() => {});
  const s = settings();
  if (!s.threadId || !Array.isArray(s.times)) return;
  const now = DateTime.now().setZone(ZONE);
  if (now.hour < 8) return;
  const state = loadState();
  if (state.reminderMessageId) return;

  const lastBump = state.lastBumpedAt ? DateTime.fromISO(state.lastBumpedAt).setZone(ZONE) : null;
  const dueAt = lastBump ? lastBump.plus({ hours: BUMP_GAP_HOURS }) : null;

  // Due ping: 2 hours after a logged bump.
  if (lastBump && state.duePingFor !== state.lastBumpedAt && now >= dueAt) {
    if (await postReminder(client, state)) {
      const fresh = loadState();
      fresh.duePingFor = fresh.lastBumpedAt;
      saveState(fresh);
      console.log('Bump tool: posted the 2-hour due reminder.');
    }
    return;
  }

  // Slot post: only when the last bump is already 2+ hours old (or
  // none is logged), so a slot landing inside a fresh bump's window
  // or right after a due reminder never pings a second time.
  for (const time of s.times) {
    const slot = DateTime.fromISO(`${now.toISODate()}T${time}`, { zone: ZONE });
    const slotKey = `${now.toISODate()} ${time}`;
    if (state.lastPostedSlot === slotKey) continue;
    const lateMinutes = now.diff(slot, 'minutes').minutes;
    if (lateMinutes < 0 || lateMinutes > CATCH_UP_MINUTES) continue;
    if (dueAt && dueAt > slot) continue;
    if (await postReminder(client, state)) {
      const fresh = loadState();
      fresh.lastPostedSlot = slotKey;
      // A slot reminder after a logged bump covers that bump's due ping.
      if (fresh.lastBumpedAt) fresh.duePingFor = fresh.lastBumpedAt;
      saveState(fresh);
      console.log(`Bump tool: posted the ${time} slot reminder.`);
    }
    return;
  }
}

// "I bumped" - records the bump, deletes the reminder (the tapped
// one, or the live one when the tap came from the panel), refreshes
// the panel, and tells the tapper when the next bump is due.
async function handleBumpButton(interaction) {
  const s = settings();
  const pingUserId = process.env.BUMP_TOOL_PING_USER_ID;
  const inPublic = Boolean(s.publicChannelId) && interaction.channelId === s.publicChannelId;
  if (inPublic) {
    const roleIds = Array.isArray(s.publicRoleIds) ? s.publicRoleIds : [];
    const hasRole = Boolean(interaction.member && interaction.member.roles
      && interaction.member.roles.cache.some((r) => roleIds.includes(r.id)));
    if (!isStaff(interaction) && !hasRole) {
      await interaction.reply({ content: 'Only members and Friends of the Clan can log a bump.', ephemeral: true }).catch(() => {});
      return;
    }
  } else if (!isStaff(interaction) && !(pingUserId && interaction.user.id === pingUserId)) {
    await interaction.reply({ content: 'Only staff can log a bump.', ephemeral: true }).catch(() => {});
    return;
  }
  const state = loadState();
  state.lastBumpedAt = DateTime.now().setZone(ZONE).toISO();
  state.lastBumpedBy = interaction.user.id;
  state.counts = state.counts || {};
  state.counts[interaction.user.id] = (state.counts[interaction.user.id] || 0) + 1;
  state.names = state.names || {};
  const display = (interaction.member && interaction.member.displayName) || interaction.user.username;
  if (display) state.names[interaction.user.id] = display;
  saveState(state);
  const due = Math.floor(DateTime.fromISO(state.lastBumpedAt).toSeconds()) + BUMP_GAP_HOURS * 3600;
  const tappedId = interaction.message?.id;
  if (tappedId && tappedId === state.reminderMessageId) {
    state.reminderMessageId = null;
    saveState(state);
    await interaction.message.delete().catch(() => {});
  } else if (tappedId && tappedId === state.publicPanelMessageId) {
    // Public panel tap: clear the live staff reminder if one is sitting there.
    await deleteReminder(interaction.client, loadState()).catch(() => {});
  } else if (tappedId && tappedId !== state.panelMessageId) {
    // A reminder left over from before this build: it carried the
    // button too, so a bump tap clears it the same way.
    await interaction.message.delete().catch(() => {});
  } else {
    // Panel tap: clear the live reminder if one is sitting there.
    await deleteReminder(interaction.client, loadState()).catch(() => {});
  }
  await refreshPanel(interaction.client, loadState()).catch(() => {});
  await refreshPublicPanel(interaction.client, loadState()).catch(() => {});
  if (inPublic) {
    await interaction.reply({ content: `Logged. Next bump ready <t:${due}:R>.`, ephemeral: true });
  } else {
    await interaction.reply({ content: `Logged. Next bump due <t:${due}:R> - I will ping you here then.`, ephemeral: true });
  }
}

module.exports = { ensureBumpTool, checkBumpTool, handleBumpButton, publicPanelEmbed, topBumpers };
