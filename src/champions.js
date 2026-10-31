// Hall of champions for the website. Comps are created on Wise Old Man
// by staff; the bot archives the results. On the startup sweep and daily,
// any group competition that has ended and is not yet recorded gets its
// top 3 by gained progress written to data/champions.json, which the
// site exporter publishes as the hall of champions. Recorded entries are
// never rewritten, so the archive is append-only and costs two WOM calls
// per finished comp, once.
const fs = require('fs');
const path = require('path');
const config = require('./config');
const { atomicWrite } = require('./store');
const { getGroupCompetitions, getCompetition } = require('./wom');

const CHAMPIONS_FILE = path.join(__dirname, '..', 'data', 'champions.json');

function loadChampions() {
  try {
    const list = JSON.parse(fs.readFileSync(CHAMPIONS_FILE, 'utf8'));
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function gainedOf(p) {
  const g = p && p.progress && p.progress.gained;
  if (typeof g === 'number') return g;
  if (typeof p.gained === 'number') return p.gained;
  return 0;
}

function nameOf(p) {
  const pl = (p && p.player) || {};
  return pl.displayName || pl.username || p.username || null;
}

async function syncChampions() {
  const comps = await getGroupCompetitions(config.womGroupId);
  if (!comps) return 0;
  const recorded = loadChampions();
  const known = new Set(recorded.map((c) => c.id));
  const now = Date.now();
  let added = 0;
  for (const comp of comps) {
    if (!comp || comp.id == null || known.has(comp.id)) continue;
    if (!comp.endsAt || new Date(comp.endsAt).getTime() > now) continue;
    const full = await getCompetition(comp.id);
    if (!full) continue;
    const winners = (full.participations || [])
      .map((p) => ({ rsn: nameOf(p), gained: gainedOf(p) }))
      .filter((p) => p.rsn && p.gained > 0)
      .sort((a, b) => b.gained - a.gained)
      .slice(0, 3);
    recorded.push({
      id: comp.id,
      title: comp.title || full.title || 'Competition',
      metric: comp.metric || full.metric || null,
      type: comp.type || full.type || null,
      startsAt: comp.startsAt || full.startsAt || null,
      endsAt: comp.endsAt || full.endsAt || null,
      winners,
    });
    known.add(comp.id);
    added++;
  }
  if (added) {
    recorded.sort((a, b) => new Date(b.endsAt) - new Date(a.endsAt));
    atomicWrite(CHAMPIONS_FILE, recorded);
  }
  return added;
}

module.exports = { syncChampions };
