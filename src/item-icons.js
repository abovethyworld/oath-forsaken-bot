// OSRS item icons, fetched from the wiki and cached under data/item-icons.
// Used by the !clog card to draw obtained item icons like the in-game chat.
const fs = require('fs');
const path = require('path');
const { decodePng } = require('./party-board');

const DIR = path.join(__dirname, '..', 'data', 'item-icons');
const UA = 'DiscordBot (https://oathforsaken.cc, 1.0)';

function iconPath(id) {
  return path.join(DIR, `${id}.png`);
}

async function fetchIcon(id, name) {
  const file = encodeURIComponent(String(name).replace(/ /g, '_'));
  const url = `https://oldschool.runescape.wiki/images/${file}.png`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10000);
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: ctrl.signal });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 8 || buf.toString('ascii', 1, 4) !== 'PNG') return null;
    decodePng(buf); // throws if the board's decoder can't handle it
    fs.mkdirSync(DIR, { recursive: true });
    fs.writeFileSync(iconPath(id), buf);
    return iconPath(id);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Local path to the icon, downloading it first when missing.
async function getItemIcon(id, name) {
  const p = iconPath(id);
  if (fs.existsSync(p)) return p;
  return fetchIcon(id, name);
}

module.exports = { getItemIcon, iconPath };
