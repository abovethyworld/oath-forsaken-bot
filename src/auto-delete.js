// Auto-delete for ephemeral info replies (Nov 2, 2026, from a
// member suggestion): replies that only carry information (the /help
// card, plain notes like the card commands' "expired, run the command
// again" replies) clear themselves after 10 minutes instead of
// sitting on screen until dismissed. Discord only honors deleteReply
// inside the 15-minute interaction token window, so 10 minutes is
// the workable delay. Replies a member still has to act on (pickers,
// gates, cards with buttons, anything with components, embeds or
// files) never come through here: the wrapper in index.js only
// matches plain-text ephemeral notes, and /help is wired explicitly.
const AUTO_DELETE_MS = 10 * 60 * 1000;

function scheduleEphemeralDelete(interaction, delayMs = AUTO_DELETE_MS) {
  const timer = setTimeout(() => {
    interaction.deleteReply().catch(() => {});
  }, delayMs);
  if (typeof timer.unref === 'function') timer.unref();
  return timer;
}

function scheduleMessageDelete(message, delayMs = AUTO_DELETE_MS) {
  const timer = setTimeout(() => {
    if (message && typeof message.delete === 'function') {
      message.delete().catch(() => {});
    }
  }, delayMs);
  if (typeof timer.unref === 'function') timer.unref();
  return timer;
}

// How long a plain note lives, by what it is (tiered Nov 2, 2026):
// spam and cooldown notes are done in seconds, expired-card notes
// just say rerun the command, and the rest are error notes worth a
// few minutes to act on. /help keeps the full 10 (reading material)
// through its own explicit wiring, not this table.
function delayForNote(content) {
  const text = String(content || '');
  if (text.startsWith('Slow down') || text.startsWith('Cooldown:')) return 60 * 1000;
  if (text.includes('expired')) return 2 * 60 * 1000;
  return 5 * 60 * 1000;
}

// A plain ephemeral note: text only, nothing to press, keep or open.
function isPlainEphemeralNote(opts) {
  if (!opts || typeof opts !== 'object') return false;
  if (opts.ephemeral !== true) return false;
  if (typeof opts.content !== 'string' || !opts.content) return false;
  if (opts.components && opts.components.length) return false;
  if (opts.embeds && opts.embeds.length) return false;
  if (opts.files && opts.files.length) return false;
  return true;
}

module.exports = {
  scheduleEphemeralDelete,
  scheduleMessageDelete,
  isPlainEphemeralNote,
  delayForNote,
  AUTO_DELETE_MS,
};
