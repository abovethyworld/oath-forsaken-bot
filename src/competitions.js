// Live competition standings for the website competitions page.
// Staff create the comps on Wise Old Man; this sync publishes the ones
// still running (or about to start) to data/competitions.json, which
// the site exporter renders. Ended comps are not this file's job: the
// champions sync archives their winners. Each run also appends a
// standings snapshot to data/comp-history.json (at most one per comp
// per 3 hours) so the site can show recent momentum; snapshots prune
// at 45 days, and 2 days after their comp ends.
const fs = require('fs');
const path = require('path');
const config = require('./config');
const { atomicWrite } = require('./store');
const { getGroupCompetitions, getCompetition } = require('./wom');

const COMPETITIONS_FILE = path.join(__dirname, '..', 'data', 'competitions.json');
const HISTORY_FILE = path.join(__dirname, '..', 'data', 'comp-history.json');

const MAX_DETAIL_FETCHES = 5;
const SNAPSHOT_GAP_MS = 3 * 3600 * 1000;
const SNAPSHOT_KEEP_MS = 45 * 24 * 3600 * 1000;
const ENDED_KEEP_MS = 2 * 24 * 3600 * 1000;

function timeOf(value) {
  const t = value ? new Date(value).getTime() : NaN;
  return Number.isFinite(t) ? t : null;
}

function nameOf(p) {
  const pl = (p && p.player) || {};
  return pl.displayName || pl.username || p.username || null;
}

// A participation's headline gained. Multi-metric comps send one delta
// per metric plus a "total" entry, and that total is the ranked number;
// single-metric comps may only carry deltas, older payloads only the
// (deprecated) progress block, so fall through in that order.
function totalGainedOf(p) {
  const deltas = Array.isArray(p && p.deltas) ? p.deltas : [];
  const total = deltas.find((x) => x && x.metric === 'total');
  if (total && total.values && typeof total.values.gained === 'number') return total.values.gained;
  if (p && p.progress && typeof p.progress.gained === 'number') return p.progress.gained;
  if (deltas.length === 1 && deltas[0].values && typeof deltas[0].values.gained === 'number') {
    return deltas[0].values.gained;
  }
  return 0;
}

function perMetricOf(p) {
  const out = {};
  for (const entry of Array.isArray(p && p.deltas) ? p.deltas : []) {
    if (!entry || !entry.metric || entry.metric === 'total') continue;
    if (entry.values && typeof entry.values.gained === 'number') out[entry.metric] = entry.values.gained;
  }
  return out;
}

function normalizeStandings(full) {
  return (full.participations || [])
    .map((p) => {
      const rsn = nameOf(p);
      if (!rsn) return null;
      return { rsn, gained: totalGainedOf(p), perMetric: perMetricOf(p) };
    })
    .filter(Boolean)
    .sort((a, b) => b.gained - a.gained);
}

function metricKeysOf(src) {
  if (Array.isArray(src.metrics) && src.metrics.length) {
    const keys = src.metrics
      .map((m) => (typeof m === 'string' ? m : m && m.metric))
      .filter(Boolean);
    if (keys.length) return keys;
  }
  return src.metric ? [src.metric] : [];
}

function participantCountOf(comp, src) {
  if (typeof src.participantCount === 'number') return src.participantCount;
  if (typeof comp.participantCount === 'number') return comp.participantCount;
  return null;
}

// comp is the group-list entry, full the detail payload (null when this
// comp fell past the per-run detail cap: it is still listed, with no
// standings until a later run has room for it).
function normalizeCompetition(comp, full) {
  const src = full || comp;
  const participantCount = participantCountOf(comp, src);
  return {
    id: comp.id,
    title: comp.title || src.title || 'Competition',
    metric: comp.metric || src.metric || null,
    metrics: metricKeysOf(src),
    type: comp.type || src.type || null,
    startsAt: comp.startsAt || src.startsAt || null,
    endsAt: comp.endsAt || src.endsAt || null,
    participantCount,
    standings: full ? normalizeStandings(full) : [],
  };
}

function loadHistory() {
  try {
    const parsed = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
    if (parsed && Array.isArray(parsed.snapshots)) return parsed;
  } catch {
    // Missing or unreadable history starts empty; the next snapshot
    // rebuilds it. The competitions file above is the live picture.
  }
  return { snapshots: [] };
}

function pruneSnapshots(snapshots, endedAtByComp, now) {
  return snapshots.filter((s) => {
    if (!s || !s.at) return false;
    const at = timeOf(s.at);
    if (at == null || now - at > SNAPSHOT_KEEP_MS) return false;
    const endedAt = endedAtByComp.get(s.compId);
    if (endedAt != null && now - endedAt > ENDED_KEEP_MS) return false;
    return true;
  });
}

// Append one standings snapshot per started comp, skipping any comp
// whose last snapshot is younger than the gap. Mutates snapshots and
// returns true when it added at least one.
function recordSnapshots(competitions, snapshots, now) {
  let added = false;
  for (const comp of competitions) {
    const starts = timeOf(comp.startsAt);
    if (starts == null || starts > now || !comp.standings.length) continue;
    let lastAt = null;
    for (const s of snapshots) {
      if (s.compId !== comp.id) continue;
      const at = timeOf(s.at);
      if (at != null && (lastAt == null || at > lastAt)) lastAt = at;
    }
    if (lastAt != null && now - lastAt < SNAPSHOT_GAP_MS) continue;
    const ranks = {};
    comp.standings.forEach((row, i) => {
      ranks[row.rsn] = { gained: row.gained, rank: i + 1 };
    });
    snapshots.push({ compId: comp.id, at: new Date(now).toISOString(), ranks });
    added = true;
  }
  return added;
}

async function syncCompetitions() {
  try {
    const comps = await getGroupCompetitions(config.womGroupId);
    if (!comps) return 0;
    const now = Date.now();

    // Ended comps belong to the champions archive; keep their end
    // times only to prune history snapshots shortly after they finish.
    const endedAtByComp = new Map();
    const open = [];
    for (const comp of comps) {
      if (!comp || comp.id == null) continue;
      const ends = timeOf(comp.endsAt);
      if (ends != null && ends <= now) endedAtByComp.set(comp.id, ends);
      else open.push(comp);
    }

    // Detail fetches go to the most relevant comps first: running
    // before upcoming, then the soonest start.
    const ranked = open.slice().sort((a, b) => {
      const aStart = timeOf(a.startsAt);
      const bStart = timeOf(b.startsAt);
      const aRunning = aStart != null && aStart <= now ? 0 : 1;
      const bRunning = bStart != null && bStart <= now ? 0 : 1;
      if (aRunning !== bRunning) return aRunning - bRunning;
      return (aStart || 0) - (bStart || 0);
    });

    const competitions = [];
    for (let i = 0; i < ranked.length; i++) {
      const comp = ranked[i];
      const full = i < MAX_DETAIL_FETCHES ? await getCompetition(comp.id) : null;
      competitions.push(normalizeCompetition(comp, full));
    }
    competitions.sort((a, b) => (timeOf(a.startsAt) || 0) - (timeOf(b.startsAt) || 0));

    atomicWrite(COMPETITIONS_FILE, { updatedAt: new Date(now).toISOString(), competitions });

    const history = loadHistory();
    const snapshots = pruneSnapshots(history.snapshots, endedAtByComp, now);
    const pruned = snapshots.length !== history.snapshots.length;
    const added = recordSnapshots(competitions, snapshots, now);
    // Write on any change, and also when the file does not exist yet,
    // so the site exporter always finds the file after the first run.
    if (added || pruned || !fs.existsSync(HISTORY_FILE)) {
      atomicWrite(HISTORY_FILE, { snapshots });
    }

    return competitions.length;
  } catch (err) {
    console.error('Competitions sync failed:', err.message);
    return 0;
  }
}

module.exports = { syncCompetitions, normalizeCompetition, normalizeStandings, totalGainedOf, perMetricOf, pruneSnapshots };
