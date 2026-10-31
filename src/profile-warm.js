// Daily RuneProfile warm-up for the website's tracked names.
//
// The clan site's profile pages read quest, achievement diary, combat
// achievement, and collection log summaries straight out of this bot's
// RuneProfile cache (data/rp-cache-v2.json). Cache entries otherwise
// only exist for players someone recently ran a command for, so once a
// day this sweep walks the same tracked set the site publishes (WOM
// group members, Friends of the Clan, linked active RSNs) and refreshes
// each profile through the normal cache-first, paced RuneProfile
// layer. On a warm cache the sweep costs no requests at all.
const fs = require('fs');
const path = require('path');
const { getProfile, getClogSummary, getClogPages } = require('./runeprofile');

const DATA_DIR = path.join(__dirname, '..', 'data');

function readJson(name) {
  try {
    return JSON.parse(fs.readFileSync(path.join(DATA_DIR, name), 'utf8'));
  } catch (e) {
    return null;
  }
}

function dedupeNames(rsns) {
  const names = new Map(); // lowercase -> display RSN, first writer wins
  for (const rsn of rsns) {
    if (typeof rsn !== 'string') continue;
    const display = rsn.trim();
    if (display && !names.has(display.toLowerCase())) {
      names.set(display.toLowerCase(), display);
    }
  }
  return [...names.values()];
}

function trackedNames() {
  const rsns = [];
  const group = readJson('wom-group.json');
  if (Array.isArray(group)) {
    for (const m of group) rsns.push(m && m.rsn);
  }
  const friends = readJson('friends.json');
  if (Array.isArray(friends)) {
    for (const f of friends) rsns.push(f && f.rsn);
  }
  const links = readJson('rsn-links.json');
  if (links && typeof links === 'object') {
    for (const entry of Object.values(links)) {
      if (entry) rsns.push(entry.active || entry.rsn);
    }
  }
  return dedupeNames(rsns);
}

async function warmProfiles() {
  const names = trackedNames();
  let warmed = 0;
  for (const rsn of names) {
    try {
      await getProfile(rsn);
      await getClogSummary(rsn);
      await getClogPages(rsn);
      warmed += 1;
    } catch (err) {
      console.warn(`Profile warm failed for ${rsn}: ${err.message}`);
    }
  }
  if (names.length) {
    console.log(`Profile warm: refreshed ${warmed}/${names.length} tracked profile(s) for the website.`);
  }
  return warmed;
}

module.exports = { warmProfiles, trackedNames };
