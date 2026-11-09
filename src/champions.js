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
const { totalGainedOf } = require('./competitions');

const CHAMPIONS_FILE = path.join(__dirname, '..', 'data', 'champions.json');

function loadChampions() {
  try {
    const list = JSON.parse(fs.readFileSync(CHAMPIONS_FILE, 'utf8'));
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function nameOf(p) {
  const pl = (p && p.player) || {};
  return pl.displayName || pl.username || p.username || null;
}

// Top 3 finishers of a finished comp, by the same gained rule the live
// standings use: a multi-metric comp ranks on its "total" delta entry,
// a single-metric comp may only carry the progress block. A comp whose
// participations carry neither shape yields no winners here, and the
// caller leaves it unrecorded for a later sweep instead of archiving
// an empty card it can never fix.
function winnersOf(participations) {
  return (participations || [])
    .map((p) => ({ rsn: nameOf(p), gained: totalGainedOf(p) }))
    .filter((p) => p.rsn && p.gained > 0)
    .sort((a, b) => b.gained - a.gained)
    .slice(0, 3);
}

async function syncChampions() {
  try {
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
      const winners = winnersOf(full.participations);
      if (!winners.length) continue;
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
    } else if (!fs.existsSync(CHAMPIONS_FILE)) {
      // Create the store on the first clean sweep so the archive is a
      // real file the site exporter (and a human checking) can find,
      // not a file that only appears after the first comp ends.
      atomicWrite(CHAMPIONS_FILE, recorded);
    }
    return added;
  } catch (err) {
    console.error('Champions sync failed:', err.message);
    return 0;
  }
}

module.exports = { syncChampions, winnersOf };
