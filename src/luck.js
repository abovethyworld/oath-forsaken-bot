// Drop luck, mirroring the Collection Log Luck plugin
// (by peanubnutter, BSD 2-Clause - see
// LICENSES/collection-log-luck.txt; the rate table in
// src/luck-data.json is adapted from its data).
//
// Each scored drop gets a luck percentile, the plugin's
// "overall luck": luck = P(X < yourCount), the share of
// players drier than you; dryness = P(X > yourCount), the
// share luckier than you; overall = (luck - dryness + 1) / 2.
// 100 is spooned, 50 average, 0 the driest possible. A
// missing item can never score above 50.
//
// Only items the plugin tracks get a score. Dupe-protected
// sets (pyromancer outfit, bludgeon pieces, Moons armour)
// score as one unit: any-piece rate, distinct pieces owned,
// and every piece shows the set's score.

const LUCK_DATA = require('./luck-data.json') || {};
const TABLE = LUCK_DATA.items || {};
const SETS_BY_METRIC = {};
const SET_ITEM_IDS = new Set();
const SET_BY_PIECE = {};
for (const s of Object.values(LUCK_DATA.sets || {})) {
  (SETS_BY_METRIC[s.metric] = SETS_BY_METRIC[s.metric] || []).push(s);
  for (const id of s.pieces) {
    SET_ITEM_IDS.add(id);
    SET_BY_PIECE[id] = s;
  }
}

// P(X <= m) for X ~ Bin(n, p), by PMF recurrence from P(0).
function binomCdfLE(n, p, m) {
  if (m < 0) return 0;
  if (m >= n) return 1;
  let term = Math.exp(n * Math.log1p(-p));
  let sum = term;
  const ratio = p / (1 - p);
  for (let i = 0; i < m; i++) {
    term *= ((n - i) / (i + 1)) * ratio;
    sum += term;
    if (sum > 0.999999999) return 1;
  }
  return Math.min(1, sum);
}

// The plugin percentile for one scored unit: n trials at
// rate p, with qty obtained. Returns { score, luck, dryness }
// with score an integer 0-100 and the shares as fractions.
function scoreFor(n, p, qty) {
  const q = Math.max(0, qty || 0);
  const luck = q <= 0 ? 0 : binomCdfLE(n, p, Math.min(q - 1, 100));
  const dryness = q <= 0
    ? -Math.expm1(n * Math.log1p(-p)) // P(X >= 1)
    : 1 - binomCdfLE(n, p, Math.min(q, 100));
  const overall = (luck - dryness + 1) / 2;
  return { score: Math.round(overall * 100), luck, dryness };
}

const qtyOfItem = (it) => (it.qty != null ? it.qty : (it.quantity || 0));

// scoreForSet(kc, set, qtyOf): the set scored as one unit.
function scoreForSet(kc, s, qtyOf) {
  const n = kc * (s.rolls || 1);
  const p = s.rate * s.pieces.length; // any-piece rate
  const owned = s.pieces.filter((id) => (qtyOf.get(id) || 0) > 0).length;
  return { ...scoreFor(n, p, owned), owned };
}

// Per-item luck scores for a clog page: { itemId: score }.
// Set pieces carry their set's score. Unscored items are
// absent from the map.
function itemLuckScores(kc, metric, pageItems) {
  const out = {};
  if (!kc || kc <= 0 || !metric || !Array.isArray(pageItems)) return out;
  const qtyOf = new Map(pageItems.map((it) => [Number(it.id), qtyOfItem(it)]));
  const seenSets = new Set();
  for (const it of pageItems) {
    const id = Number(it.id);
    const s = SET_BY_PIECE[id];
    if (s && s.metric === metric) {
      if (!seenSets.has(s.name)) {
        seenSets.add(s.name);
        const sc = scoreForSet(kc, s, qtyOf);
        for (const pid of s.pieces) out[pid] = sc.score;
      }
      continue;
    }
    const t = TABLE[String(id)];
    if (!t || t.metric !== metric) continue;
    out[id] = scoreFor(kc * (t.rolls || 1), t.rate, qtyOfItem(it)).score;
  }
  return out;
}

// luckForPage(kc, metric, pageItems): the page verdict.
// Returns { word, dry } or null when nothing on the page is
// scored or the player has no KC. dry names the single
// driest missing drop in the plugin's phrasing, shown when
// at least half of players would be luckier by now.
function luckForPage(kc, metric, pageItems) {
  if (!kc || kc <= 0 || !metric || !Array.isArray(pageItems)) return null;
  const qtyOf = new Map(pageItems.map((it) => [Number(it.id), qtyOfItem(it)]));
  let scored = 0;
  let driest = null;
  let luckiest = null;
  for (const s of SETS_BY_METRIC[metric] || []) {
    scored++;
    const sc = scoreForSet(kc, s, qtyOf);
    if (sc.owned >= s.pieces.length) {
      if (!luckiest || sc.luck > luckiest.pct) luckiest = { name: s.name, pct: sc.luck };
    } else {
      const text = `${s.name} (${Math.round(sc.dryness * 100)}% luckier than you)`;
      if (!driest || sc.dryness > driest.pct) driest = { pct: sc.dryness, text };
    }
  }
  for (const it of pageItems) {
    if (SET_ITEM_IDS.has(Number(it.id))) continue; // scored as a set
    const t = TABLE[String(it.id)];
    if (!t || t.metric !== metric) continue;
    scored++;
    const sc = scoreFor(kc * (t.rolls || 1), t.rate, qtyOfItem(it));
    if (qtyOfItem(it) > 0) {
      if (!luckiest || sc.luck > luckiest.pct) luckiest = { name: t.name, pct: sc.luck };
    } else {
      const text = `${t.name} (${Math.round(sc.dryness * 100)}% luckier than you)`;
      if (!driest || sc.dryness > driest.pct) driest = { pct: sc.dryness, text };
    }
  }
  if (!scored) return null;
  let word = 'on pace';
  if (driest && driest.pct >= 0.9) word = 'unlucky';
  else if (driest && driest.pct >= 0.75) word = 'dry';
  else if (luckiest && luckiest.pct >= 0.9 && (!driest || driest.pct < 0.5)) word = 'lucky';
  const dry = driest && driest.pct >= 0.5 ? driest.text : null;
  return { word, dry };
}

// Full per-item breakdown for the !dry card: every scored
// drop on the page with its luck percentile, missing sorted
// driest first (lowest score), obtained luckiest first
// (highest score), plus the page verdict. Sets appear once
// each with the set's first piece id for icon purposes.
function dryReport(kc, metric, pageItems) {
  if (!kc || kc <= 0 || !metric || !Array.isArray(pageItems)) return null;
  const qtyOf = new Map(pageItems.map((it) => [Number(it.id), qtyOfItem(it)]));
  const missing = [];
  const obtained = [];
  let scored = 0;
  for (const s of SETS_BY_METRIC[metric] || []) {
    scored++;
    const sc = scoreForSet(kc, s, qtyOf);
    const entry = { id: s.pieces[0], name: s.name, score: sc.score };
    if (sc.owned >= s.pieces.length) obtained.push(entry);
    else missing.push({ ...entry, pieces: `${sc.owned}/${s.pieces.length}` });
  }
  for (const it of pageItems) {
    if (SET_ITEM_IDS.has(Number(it.id))) continue; // scored as a set
    const t = TABLE[String(it.id)];
    if (!t || t.metric !== metric) continue;
    scored++;
    const sc = scoreFor(kc * (t.rolls || 1), t.rate, qtyOfItem(it));
    const entry = { id: Number(it.id), name: t.name, score: sc.score };
    if (qtyOfItem(it) > 0) obtained.push(entry);
    else missing.push(entry);
  }
  if (!scored) return null;
  missing.sort((x, y) => x.score - y.score);
  obtained.sort((x, y) => y.score - x.score);
  const verdict = luckForPage(kc, metric, pageItems);
  return { word: verdict ? verdict.word : 'on pace', missing, obtained };
}

// The set of WOM metrics that carry any luck scoring (items or
// sets). Used by !dry to list the bosses it can score.
function scoredMetricSet() {
  const out = new Set();
  for (const t of Object.values(TABLE)) out.add(t.metric);
  for (const m of Object.keys(SETS_BY_METRIC)) out.add(m);
  return out;
}

// The scored item ids for one metric (exporter parity checks, tests).
function scoredIdsForMetric(metric) {
  return Object.entries(TABLE)
    .filter(([, t]) => t.metric === metric)
    .map(([id]) => Number(id));
}

module.exports = {
  luckForPage, binomCdfLE, scoredIdsForMetric, dryReport, scoredMetricSet,
  itemLuckScores, scoreFor,
};
