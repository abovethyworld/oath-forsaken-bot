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
    fs.writeFileSync(iconPath(id), buf);
    return iconPath(id);
  }
  return null;
}

// Local path to the icon, downloading it first when missing.
async function getItemIcon(id, name) {
  const p = iconPath(id);
  if (fs.existsSync(p)) return p;
  return fetchIcon(id, name);
}

module.exports = { getItemIcon, iconPath };
