// Keeps the About the Forsaken thread in Apply-Here from
// auto-archiving. Discord archives it after 7 days without a post,
// which buries the thread the Apply-Here pointer links new joiners
// to. A daily un-archive keeps it listed. It never posts anything,
// so members never see it move.
const ABOUT_THREAD_ID = require('./config').channels?.aboutThreadId;

async function keepThreadAwake(client) {
  const ch = await client.channels.fetch(ABOUT_THREAD_ID).catch(() => null);
  if (ch && ch.isThread() && ch.archived) {
    await ch.setArchived(false, 'Daily keep-awake for the About the Forsaken thread');
    console.log('[thread-keepawake] Un-archived the About the Forsaken thread.');
  }
}

module.exports = { keepThreadAwake };
