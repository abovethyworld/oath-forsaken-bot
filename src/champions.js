// Hall of champions for the website. Comps are created on Wise Old Man
// by staff; the bot archives the results. On the startup sweep and daily,
// any group competition that has ended and is not yet recorded gets its
// top 3 by gained progress written to data/champions.json, which the
// site exporter publishes as the hall of champions. The same sweep also
// writes every participant's final place to data/comp-results.json,
// which the site exporter publishes for the profile Competition history
// table. Recorded entries are never rewritten, so both archives are
// append-only and cost two WOM calls per finished comp, once.
const fs = require('fs');
const path = require('path');
const config = require('./config');
const { atomicWrite } = require('./store');
const { getGroupCompetitions, getCompetition } = require('./wom');
const { totalGainedOf } = require('./competitions');

const CHAMPIONS_FILE = path.join(__dirname, '..', 'data', 'champions.json');
const RESULTS_FILE = path.join(__dirname, '..', 'data', 'comp-results.json');

function loadChampions() {
  try {
    const list = JSON.parse(fs.readFileSync(CHAMPIONS_FILE, 'utf8'));
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function loadResults() {
  try {
    const list = JSON.parse(fs.readFileSync(RESULTS_FILE, 'utf8'));
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

// A participation's gained is readable when it carries one of the three
// shapes totalGainedOf reads. totalGainedOf returns 0 both for a real
// zero gain and for an unreadable shape, so readability is checked here
// directly; a comp with no readable participation at all is left
// unrecorded for a later sweep, same as the winners rule above.
function hasGainedShape(p) {
  const deltas = Array.isArray(p && p.deltas) ? p.deltas : [];
  const total = deltas.find((x) => x && x.metric === 'total');
  if (total && total.values && typeof total.values.gained === 'number') return true;
  if (p && p.progress && typeof p.progress.gained === 'number') return true;
  if (deltas.length === 1 && deltas[0].values && typeof deltas[0].values.gained === 'number') return true;
  return false;
}

// Team links on a team competition, read defensively: the comp detail
// may carry a teams list and each participation a team name, a team
// object, or a team id. Anything unrecognised yields no team data and
// the row simply reads as a solo finish.
function teamNameOf(p, teamsById) {
  if (!p) return null;
  if (typeof p.teamName === 'string' && p.teamName) return p.teamName;
  if (p.team && typeof p.team.name === 'string' && p.team.name) return p.team.name;
  const id = p.teamId != null ? p.teamId : p.team && p.team.id;
  if (id != null && teamsById && teamsById.has(id)) return teamsById.get(id);
  return null;
}

// Every participant's final place in a finished comp, ranked by the
// same gained rule as the standings. Zero-gain members still count:
// they were in the comp, so their place is part of the field. When the
// comp ran in teams and the links resolve, each row also carries the
// team's place and the team count. Returns null when nothing in the
// payload is readable.
function resultsOf(full) {
  const participations = (full && full.participations) || [];
  if (!participations.some(hasGainedShape)) return null;
  const teamsById = new Map();
  for (const t of (full && full.teams) || []) {
    if (t && t.id != null && typeof t.name === 'string') teamsById.set(t.id, t.name);
  }
  const rows = participations
    .map((p) => ({ rsn: nameOf(p), gained: totalGainedOf(p), team: teamNameOf(p, teamsById) }))
    .filter((p) => p.rsn)
    .sort((a, b) => b.gained - a.gained);
  if (!rows.length) return null;
  const teamTotals = new Map();
  for (const r of rows) {
    if (r.team) teamTotals.set(r.team, (teamTotals.get(r.team) || 0) + r.gained);
  }
  const teamRank = new Map(
    [...teamTotals.entries()].sort((a, b) => b[1] - a[1]).map(([name], i) => [name, i + 1]),
  );
  const teamSizes = new Map();
  for (const r of rows) {
    if (r.team) teamSizes.set(r.team, (teamSizes.get(r.team) || 0) + 1);
  }
  return rows.map((r, i) => ({
    rsn: r.rsn,
    place: i + 1,
    gained: r.gained,
    team: r.team || null,
    teamPlace: r.team ? teamRank.get(r.team) : null,
    teamSize: r.team ? teamSizes.get(r.team) : null,
    teams: r.team ? teamRank.size : null,
  }));
}

async function syncChampions() {
  try {
    const recorded = loadChampions();
    const results = loadResults();
    // Create both stores before the first fetch so the archives are
    // real files the site exporter (and a human checking) can find,
    // even when this sweep's WOM calls fail; they only ever gain
    // entries after a successful fetch below.
    if (!fs.existsSync(CHAMPIONS_FILE)) atomicWrite(CHAMPIONS_FILE, recorded);
    if (!fs.existsSync(RESULTS_FILE)) atomicWrite(RESULTS_FILE, results);
    const comps = await getGroupCompetitions(config.womGroupId);
    if (!comps) return 0;
    const known = new Set(recorded.map((c) => c.id));
    const knownResults = new Set(results.map((c) => c.id));
    const now = Date.now();
    let added = 0;
    let resultsAdded = 0;
    for (const comp of comps) {
      if (!comp || comp.id == null) continue;
      const needsChampions = !known.has(comp.id);
      const needsResults = !knownResults.has(comp.id);
      if (!needsChampions && !needsResults) continue;
      if (!comp.endsAt || new Date(comp.endsAt).getTime() > now) continue;
      const full = await getCompetition(comp.id);
      if (!full) continue;
      const base = {
        id: comp.id,
        title: comp.title || full.title || 'Competition',
        metric: comp.metric || full.metric || null,
        metrics: Array.isArray(full.metrics) && full.metrics.length
          ? full.metrics
          : Array.isArray(comp.metrics) && comp.metrics.length
            ? comp.metrics
            : null,
        type: comp.type || full.type || null,
        startsAt: comp.startsAt || full.startsAt || null,
        endsAt: comp.endsAt || full.endsAt || null,
      };
      if (needsChampions) {
        const winners = winnersOf(full.participations);
        if (winners.length) {
          recorded.push({
            id: base.id,
            title: base.title,
            metric: base.metric,
            type: base.type,
            startsAt: base.startsAt,
            endsAt: base.endsAt,
            winners,
          });
          known.add(comp.id);
          added++;
        }
      }
      if (needsResults) {
        const rows = resultsOf(full);
        if (rows) {
          results.push({ ...base, players: rows.length, results: rows });
          knownResults.add(comp.id);
          resultsAdded++;
        }
      }
    }
    if (added) {
      recorded.sort((a, b) => new Date(b.endsAt) - new Date(a.endsAt));
      atomicWrite(CHAMPIONS_FILE, recorded);
    }
    if (resultsAdded) {
      results.sort((a, b) => new Date(b.endsAt) - new Date(a.endsAt));
      atomicWrite(RESULTS_FILE, results);
    }
    return added;
  } catch (err) {
    console.error('Champions sync failed:', err.message);
    return 0;
  }
}

module.exports = { syncChampions, winnersOf, resultsOf };
