// OSRS item icons, cached under data/item-icons and used by the !clog
// card to draw obtained item icons like the in-game chat.
// Primary source: RuneLite's static item cache, keyed by item ID (the
// same cache the RuneLite client uses). Fallback: the OSRS wiki by item
// name, for brand-new items RuneLite has not cached yet.
const fs = require('fs');
const path = require('path');
const { decodePng } = require('./party-board');

const DIR = path.join(__dirname, '..', 'data', 'item-icons');
const UA = 'DiscordBot (https://oathforsaken.cc, 1.0)';

function iconPath(id) {
  return path.join(DIR, `${id}.png`);
}

async function tryFetch(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10000);
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: ctrl.signal });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 8 || buf.toString('ascii', 1, 4) !== 'PNG') return null;
    decodePng(buf); // throws if the board's decoder can't handle it
    return buf;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// A miss on every source usually means the icon does not exist yet
// (brand-new item RuneLite has not cached, or a name mismatch on both
// wiki forms). Remember it in memory for a while so every card that
// includes the item does not re-run all the fetches.
const MISS_TTL_MS = 60 * 60 * 1000;
const iconMisses = new Map();

async function fetchIcon(id, name) {
  const urls = [`https://static.runelite.net/cache/item/icon/${encodeURIComponent(String(id))}.png`];
  // Wiki fallback by name; stacked items live at <name>_1.png there
  // (e.g. Oathplate_shards_1).
  const base = String(name || '').replace(/ /g, '_');
  if (base) {
    urls.push(`https://oldschool.runescape.wiki/images/${encodeURIComponent(`${base}.png`)}`);
    urls.push(`https://oldschool.runescape.wiki/images/${encodeURIComponent(`${base}_1.png`)}`);
  }
  for (const url of urls) {
    const buf = await tryFetch(url);
    if (!buf) continue;
    fs.mkdirSync(DIR, { recursive: true });
    // Temp file + rename, so a crash mid-write cannot leave a truncated
    // PNG at the real path that existsSync would treat as cached forever.
    const tmp = `${iconPath(id)}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, buf);
    fs.renameSync(tmp, iconPath(id));
    iconMisses.delete(id);
    return iconPath(id);
  }
  iconMisses.set(id, Date.now());
  return null;
}

// Downloads run one at a time with a small gap: a clog card can need
// dozens of first-time icons at once, and the hosts are shared services.
const MIN_GAP_MS = 150;
let iconQueue = Promise.resolve();
let lastIconFetchAt = 0;
function pacedFetchIcon(id, name) {
  const run = iconQueue.then(async () => {
    const wait = MIN_GAP_MS - (Date.now() - lastIconFetchAt);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastIconFetchAt = Date.now();
    return fetchIcon(id, name);
  });
  iconQueue = run.catch(() => {});
  return run;
}

// Local path to the icon, downloading it first when missing.
async function getItemIcon(id, name) {
  if (!Number.isInteger(id) || id <= 0) return null;
  const p = iconPath(id);
  if (fs.existsSync(p)) return p;
  const missedAt = iconMisses.get(id);
  if (missedAt && Date.now() - missedAt < MISS_TTL_MS) return null;
  return pacedFetchIcon(id, name);
}

module.exports = { getItemIcon, iconPath };
