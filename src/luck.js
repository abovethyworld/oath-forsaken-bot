// Drop luck for compare cards, in the Collection Log Luck model:
// for each scored drop on a boss page, the binomial percentile of
// the player's result at their KC. Scored drops are single-source,
// fixed-rate items on one tracked KC counter (src/luck-data.json,
// adapted from Collection Log Luck by peanubnutter, BSD 2-Clause -
// see LICENSES/collection-log-luck.txt). Raids, team bosses, and
// multi-source drops are not in the table, so they get no score.
// Dupe-protected sets (pyromancer outfit, bludgeon pieces, Moons
// armour) score as a set: any-piece rate, distinct pieces owned.
//
// v1 scores ownership (have it / dry on it), not duplicate counts.

const LUCK_DATA = require('./luck-data.json') || {};
const TABLE = LUCK_DATA.items || {};
const SETS_BY_METRIC = {};
const SET_ITEM_IDS = new Set();
for (const s of Object.values(LUCK_DATA.sets || {})) {
  (SETS_BY_METRIC[s.metric] = SETS_BY_METRIC[s.metric] || []).push(s);
  for (const id of s.pieces) SET_ITEM_IDS.add(id);
}

// P(X <= m) for X ~ Bin(n, p), by PMF recurrence from P(0). Only
// used with small m (ownership means m is 0 or a capped quantity).
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

// luckForPage(kc, metric, pageItems): pageItems is the full clog
// page list [{ id, qty }] (qty 0 = not obtained). Returns
// { word, dry } or null when nothing on the page is scored or the
// player has no KC. dry names the single driest missing drop when
// at least half of players would have it by now.
function luckForPage(kc, metric, pageItems) {
  if (!kc || kc <= 0 || !metric || !Array.isArray(pageItems)) return null;
  // Page items arrive as {qty} from some callers and {quantity}
  // (raw RuneProfile shape) from others; accept both.
  const qty = (it) => (it.qty != null ? it.qty : (it.quantity || 0));
  const qtyOf = new Map(pageItems.map((it) => [Number(it.id), qty(it)]));
  let scored = 0;
  let driest = null;
  let luckiest = null;
  const kcText = kc.toLocaleString('en-US');
  // Dupe-protected sets first: one scored unit per set.
  for (const s of SETS_BY_METRIC[metric] || []) {
    scored++;
    const n = kc * (s.rolls || 1);
    const p = s.rate * s.pieces.length; // any-piece rate
    const owned = s.pieces.filter((id) => (qtyOf.get(id) || 0) > 0).length;
    if (owned >= s.pieces.length) {
      const fewer = binomCdfLE(n, p, s.pieces.length - 1);
      if (!luckiest || fewer > luckiest.pct) luckiest = { name: s.name, pct: fewer };
    } else {
      const dry = 1 - binomCdfLE(n, p, owned); // share with more pieces
      const text = owned === 0
        ? `${s.name} (${Math.round(dry * 100)}% of players have it by ${kcText} KC)`
        : `${s.name} (${Math.round(dry * 100)}% of players have more pieces by ${kcText} KC)`;
      if (!driest || dry > driest.pct) driest = { pct: dry, text };
    }
  }
  for (const it of pageItems) {
    if (SET_ITEM_IDS.has(Number(it.id))) continue; // scored as a set
    const t = TABLE[String(it.id)];
    if (!t || t.metric !== metric) continue;
    scored++;
    const n = kc * (t.rolls || 1);
    if (qty(it) > 0) {
      // Ownership scoring: fewer = P(X = 0), the share of players
      // who would still have none of this drop at this KC.
      const fewer = binomCdfLE(n, t.rate, 0);
      if (!luckiest || fewer > luckiest.pct) luckiest = { name: t.name, pct: fewer };
    } else {
      const dry = -Math.expm1(n * Math.log1p(-t.rate)); // P(X >= 1)
      const text = `${t.name} (${Math.round(dry * 100)}% of players have it by ${kcText} KC)`;
      if (!driest || dry > driest.pct) driest = { pct: dry, text };
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

// The scored item ids for one metric (exporter parity checks, tests).
function scoredIdsForMetric(metric) {
  return Object.entries(TABLE)
    .filter(([, t]) => t.metric === metric)
    .map(([id]) => Number(id));
}

module.exports = { luckForPage, binomCdfLE, scoredIdsForMetric };
