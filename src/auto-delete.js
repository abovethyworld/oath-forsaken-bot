// Auto-delete for ephemeral info replies (Nov 2, 2026, from a
// member suggestion): replies that only carry information (the /help
// card, plain notes) clear themselves after 10 minutes instead of
// sitting on screen until dismissed. Discord only honors deleteReply
// inside the 15-minute interaction token window, so 10 minutes is
// the workable delay. Replies a member still has to act on (pickers,
// gates, buttons with a pending choice) never come through here.
const AUTO_DELETE_MS = 10 * 60 * 1000;

function scheduleEphemeralDelete(interaction, delayMs = AUTO_DELETE_MS) {
  const timer = setTimeout(() => {
    interaction.deleteReply().catch(() => {});
  }, delayMs);
  if (typeof timer.unref === 'function') timer.unref();
  return timer;
}

module.exports = { scheduleEphemeralDelete, AUTO_DELETE_MS };
