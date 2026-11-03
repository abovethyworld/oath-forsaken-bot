// Drop luck, mirroring the Collection Log Luck plugin
// (by peanubnutter, BSD 2-Clause - see
// LICENSES/collection-log-luck.txt; the rate table in
// src/luck-data.json is extracted from its data).
//
// Coverage mirrors the plugin: an item gets a luck
// percentile only when the plugin tracks it. Raids and the
// six wilderness pair bosses are excluded by house rule.
// An item's trials pool every source it drops from (boss
// KCs, clue completions, chest counts), each at its own
// rate, exactly like the plugin's combined distributions.
//
// The percentile is the plugin's "overall luck":
// luck = P(X < yourCount), the share of players drier than
// you; dryness = P(X > yourCount), the share luckier than
// you; overall = (luck - dryness + 1) / 2. 100 is spooned,
// 50 average, 0 the driest possible.
//
// Counters come from the player's stats (WOM boss and
// activity counts). A few counters exist only in the game
// client's collection log headers (rift searches, gambles,
// spoils and similar); those arrive through the clan
// plugin's sync and are keyed "plugin:<name>". An item
// whose counters are all missing or zero is not scored.

const fs = require('fs');
const path = require('path');
const LUCK_DATA = require('./luck-data.json') || {};
const TABLE = LUCK_DATA.items || {};

// Sets: dupe-protected groups score as one unit. mode
// "pieces" counts distinct pieces owned; mode "total"
// counts the summed quantity across the group.
const SETS = Object.values(LUCK_DATA.sets || {});
const SET_BY_PIECE = {};
for (const s of SETS) {
  for (const id of s.pieces) SET_BY_PIECE[id] = s;
}

const CDF_CAP = 250;

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

// Trial groups for a source list at a player's counters:
// [{ n, p }] with equal rates pooled (the plugin's plain
// binomial drops pool all their sources at one rate).
function groupsFor(sources, counters) {
  const byRate = new Map();
  for (const s of sources || []) {
    const c = counters ? counters[s.c] : 0;
    const n = (typeof c === 'number' ? c : 0) * (s.rolls || 1);
    if (n > 0) byRate.set(s.rate, (byRate.get(s.rate) || 0) + n);
  }
  return [...byRate.entries()].map(([p, n]) => ({ n, p }));
}

// P(X <= k) for X = sum of independent Bin(n_i, p_i), by
// truncated PMF convolution. k is capped; callers that need
// tail behaviour past the cap use the normal fallback in
// scoreGroups.
function pooledCdfLE(groups, k) {
  if (k < 0) return 0;
  const totalN = groups.reduce((a, g) => a + g.n, 0);
  if (k >= totalN) return 1;
  let pmf = [1];
  for (const g of groups) {
    const up = Math.min(g.n, k);
    const gp = [Math.exp(g.n * Math.log1p(-g.p))];
    const ratio = g.p / (1 - g.p);
    for (let i = 1; i <= up; i++) {
      gp.push(gp[i - 1] * ((g.n - i + 1) / i) * ratio);
    }
    const next = new Array(Math.min(k, pmf.length - 1 + up) + 1).fill(0);
    for (let i = 0; i < pmf.length; i++) {
      if (!pmf[i]) continue;
      for (let j = 0; j < gp.length && i + j <= k; j++) {
        next[i + j] += pmf[i] * gp[j];
      }
    }
    pmf = next;
  }
  return Math.min(1, pmf.reduce((a, v) => a + v, 0));
}

function normCdf(z) {
  // Standard normal CDF (Abramowitz & Stegun 26.2.17);
  // plenty for the large-count fallback.
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const poly = t * (0.319381530 + t * (-0.356563782 + t * (1.781477937
    + t * (-1.821255978 + t * 1.330274429))));
  const tail = Math.exp(-(z * z) / 2) / Math.sqrt(2 * Math.PI) * poly;
  return z >= 0 ? 1 - tail : tail;
}

// Score one entry for a player. entry: a table item or a
// set (sets pass their effective quantity). Returns
// { score, luck, dryness } or null when no counter has any
// trials.
function scoreEntry(entry, counters, qty) {
  const groups = groupsFor(entry.sources, counters);
  if (!groups.length) return null;
  const q = Math.max(0, qty || 0);
  const kind = entry.kind || 'normal';
  const totalN = groups.reduce((a, g) => a + g.n, 0);
  const mean = groups.reduce((a, g) => a + g.n * g.p, 0);
  const variance = groups.reduce((a, g) => a + g.n * g.p * (1 - g.p), 0);

  const cdf = (k) => {
    if (k < 0) return 0;
    if (k >= totalN) return 1;
    if (k <= CDF_CAP) return pooledCdfLE(groups, k);
    // Large counts: normal approximation with continuity
    // correction.
    const sd = Math.sqrt(variance) || 1;
    return Math.min(1, Math.max(0, normCdf((k + 0.5 - mean) / sd)));
  };
  const finish = (luck, dryness) => ({
    score: Math.round(((luck - dryness + 1) / 2) * 100), luck, dryness,
  });

  if (kind === 'shards') {
    const s = entry.shards || 1;
    const succ = q * s;
    const luck = succ <= 0 ? 0 : cdf(succ - 1);
    const dryness = 1 - cdf((q + 1) * s - 1);
    return finish(luck, dryness);
  }
  if (kind === 'stack') return scoreStack(entry, groups, counters, q, finish);
  if (kind === 'guaranteed' || kind === 'pity') {
    const rawK = (entry.sources || []).reduce(
      (a, s) => a + (counters && typeof counters[s.c] === 'number' ? counters[s.c] : 0), 0);
    if (rawK >= (entry.guarantee || Infinity)) {
      if (kind === 'pity') return finish(0, 0);
      // Guaranteed once: the plugin removes the guaranteed
      // kill and one success, then scores the rest.
      const trimmed = groups.map((g) => ({ ...g }));
      let biggest = 0;
      for (let i = 1; i < trimmed.length; i++) {
        if (trimmed[i].n > trimmed[biggest].n) biggest = i;
      }
      trimmed[biggest].n = Math.max(0, trimmed[biggest].n - 1);
      const g2 = trimmed.filter((g) => g.n > 0);
      if (!g2.length) return finish(0, q > 1 ? 0 : 1);
      const eq = Math.max(0, q - 1);
      const luck2 = eq <= 0 ? 0 : pooledCdfLE(g2, Math.min(eq - 1, CDF_CAP));
      const dry2 = 1 - pooledCdfLE(g2, Math.min(eq, CDF_CAP));
      return finish(luck2, dry2);
    }
    // Before the guarantee point a pity drop behaves as a
    // finite drop capped at one.
    if (kind === 'pity') {
      const luck = q <= 0 ? 0 : cdf(q - 1);
      const dryness = q >= 1 ? 0 : 1 - cdf(0);
      return finish(luck, dryness);
    }
  }
  const luck = q <= 0 ? 0 : cdf(q - 1);
  let dryness;
  if (q <= 0) dryness = 1 - cdf(0);
  else dryness = 1 - cdf(q);
  if (kind === 'finite' && q >= (entry.max || Infinity)) dryness = 0;
  return finish(luck, dryness);
}

// Stack drops: the log quantity is a total of items handed
// out in stacks per success (teleports, pearls, seeds).
function scoreStack(entry, groups, counters, q, finish) {
  if (entry.stack_type === 'BinomialUniformSumDrop') {
    const lo = entry.stack_min || 1;
    const hi = entry.stack_max || lo;
    const eu = (lo + hi) / 2;
    const vu = ((hi - lo + 1) ** 2 - 1) / 12;
    let mean = 0, variance = 0;
    for (const g of groups) {
      mean += g.n * g.p * eu;
      variance += g.n * (g.p * vu + g.p * (1 - g.p) * eu * eu);
    }
    const sd = Math.sqrt(variance) || 1;
    const luck = q <= 0 ? 0 : normCdf((q - 0.5 - mean) / sd);
    const dryness = q <= 0 ? 1 - normCdf((0.5 - mean) / sd)
      : 1 - normCdf((q + 0.5 - mean) / sd);
    return finish(Math.min(1, Math.max(0, luck)), Math.min(1, Math.max(0, dryness)));
  }
  // Fixed stack size: items = successes * size, scored on
  // the success count like the plugin.
  const size = entry.stack || 1;
  if (size <= 1) {
    const luck = q <= 0 ? 0 : pooledCdfLE(groups, Math.min(q - 1, CDF_CAP));
    const dryness = q <= 0 ? 1 - pooledCdfLE(groups, 0)
      : 1 - pooledCdfLE(groups, Math.min(q, CDF_CAP));
    return finish(luck, dryness);
  }
  const luck = q <= 0 ? 0
    : pooledCdfLE(groups, Math.min(Math.ceil(q / size) - 1, CDF_CAP));
  const dryness = 1 - pooledCdfLE(groups, Math.min(Math.floor(q / size), CDF_CAP));
  return finish(luck, dryness);
}

const qtyOfItem = (it) => (it.qty != null ? it.qty : (it.quantity || 0));

// Score a set as one unit; returns {score, luck, dryness,
// effectiveQty, complete} or null.
function scoreSet(s, counters, qtyOf) {
  let effQty;
  if (s.mode === 'total') {
    effQty = s.pieces.reduce((a, id) => a + (qtyOf.get(id) || 0), 0);
  } else {
    effQty = s.pieces.filter((id) => (qtyOf.get(id) || 0) > 0).length;
  }
  const fake = { sources: (s.sources || []).map((src) => ({
    ...src,
    rate: src.rate * (s.mode === 'total' ? 1 : s.pieces.length),
  })), kind: 'normal' };
  // Pieces mode: the drop rate is per piece and any piece
  // counts, so the unit rate is rate * pieces (as in v1/v2).
  const sc = scoreEntry(fake, counters, effQty);
  if (!sc) return null;
  return {
    ...sc, effectiveQty: effQty,
    complete: s.mode === 'total' ? effQty > 0 : effQty >= s.pieces.length,
  };
}

// Per-item luck scores for a page: { itemId: score }. Set
// pieces carry their set's score. Items whose counters are
// all zero are absent.
function itemLuckScores(counters, pageItems) {
  const out = {};
  if (!counters || !Array.isArray(pageItems)) return out;
  const qtyOf = new Map(pageItems.map((it) => [Number(it.id), qtyOfItem(it)]));
  const seenSets = new Set();
  for (const it of pageItems) {
    const id = Number(it.id);
    const s = SET_BY_PIECE[id];
    if (s) {
      if (!seenSets.has(s.name)) {
        seenSets.add(s.name);
        const sc = scoreSet(s, counters, qtyOf);
        if (sc) for (const pid of s.pieces) out[pid] = sc.score;
      }
      continue;
    }
    const t = TABLE[String(id)];
    if (!t) continue;
    const sc = scoreEntry(t, counters, qtyOfItem(it));
    if (sc) out[id] = sc.score;
  }
  return out;
}

// The scored units on a page (sets collapsed), each with
// its score detail and whether the player has it.
function pageUnits(counters, pageItems) {
  const qtyOf = new Map(pageItems.map((it) => [Number(it.id), qtyOfItem(it)]));
  const units = [];
  const seenSets = new Set();
  for (const it of pageItems) {
    const id = Number(it.id);
    const s = SET_BY_PIECE[id];
    if (s) {
      if (seenSets.has(s.name)) continue;
      seenSets.add(s.name);
      const sc = scoreSet(s, counters, qtyOf);
      if (sc) {
        units.push({
          id: s.pieces[0], name: s.name, has: sc.complete,
          pieces: s.mode === 'pieces'
            ? `${sc.effectiveQty}/${s.pieces.length}` : null,
          sources: s.sources || [], isSet: true,
          ...sc,
        });
      }
      continue;
    }
    const t = TABLE[String(id)];
    if (!t) continue;
    const sc = scoreEntry(t, counters, qtyOfItem(it));
    if (sc) units.push({ id, name: t.name, has: qtyOfItem(it) > 0, sources: t.sources || [], ...sc });
  }
  return units;
}

// luckForPage(counters, pageItems): the page verdict,
// { word, dry } or null when nothing on the page scores.
// dry names the driest missing drop in the plugin's
// phrasing, shown when at least half of players would be
// luckier by now.
function luckForPage(counters, pageItems) {
  if (!counters || !Array.isArray(pageItems) || !pageItems.length) return null;
  const units = pageUnits(counters, pageItems);
  if (!units.length) return null;
  let driest = null;
  let luckiest = null;
  for (const u of units) {
    if (u.has) {
      if (!luckiest || u.luck > luckiest.pct) luckiest = { name: u.name, pct: u.luck };
    } else {
      const text = `${u.name} (${Math.round(u.dryness * 100)}% luckier than you)`;
      if (!driest || u.dryness > driest.pct) driest = { pct: u.dryness, text };
    }
  }
  let word = 'on pace';
  if (driest && driest.pct >= 0.9) word = 'unlucky';
  else if (driest && driest.pct >= 0.75) word = 'dry';
  else if (luckiest && luckiest.pct >= 0.9 && (!driest || driest.pct < 0.5)) word = 'lucky';
  const dry = driest && driest.pct >= 0.5 ? driest.text : null;
  return { word, dry };
}

// What sits behind a scored unit, for display: the activity
// count its score is measured against (the counters of its
// sources, each counted once) and its drop rate when every
// source shares a single one. Sets carry no single rate: their
// pieces drop at their own rates.
function unitDropInfo(u, counters) {
  const srcs = u.sources || [];
  const keys = [...new Set(srcs.map((s) => s.c))];
  const kc = keys.reduce(
    (a, c) => a + (counters && typeof counters[c] === 'number' ? counters[c] : 0), 0);
  const rates = [...new Set(srcs.map((s) => s.rate)
    .filter((r) => typeof r === 'number' && r > 0))];
  return { kc: kc > 0 ? kc : null, rate: !u.isSet && rates.length === 1 ? rates[0] : null };
}

// !dry breakdown: every scored unit on the page with its
// percentile, missing driest first, obtained luckiest
// first, plus the page verdict.
function dryReport(counters, pageItems) {
  if (!counters || !Array.isArray(pageItems)) return null;
  const units = pageUnits(counters, pageItems);
  if (!units.length) return null;
  const missing = units.filter((u) => !u.has)
    .map((u) => ({
      id: u.id, name: u.name, score: u.score, pieces: u.pieces || undefined,
      ...unitDropInfo(u, counters),
    }));
  const obtained = units.filter((u) => u.has)
    .map((u) => ({ id: u.id, name: u.name, score: u.score }));
  missing.sort((x, y) => x.score - y.score);
  obtained.sort((x, y) => y.score - x.score);
  const verdict = luckForPage(counters, pageItems);
  return { word: verdict ? verdict.word : 'on pace', missing, obtained };
}

// Counters that feed any scoring (for the !dry boss list).
function scoredCounters() {
  const out = new Set();
  for (const t of Object.values(TABLE)) {
    for (const s of t.sources || []) out.add(s.c);
  }
  for (const s of SETS) {
    for (const src of s.sources || []) out.add(src.c);
  }
  return out;
}

function scoredIds() {
  return new Set([...Object.keys(TABLE).map(Number),
    ...SETS.flatMap((s) => s.pieces)]);
}

// Plugin-synced counters for a player (collection log
// header counts the game alone carries), from their member
// record. {} until the plugin syncs them.
function pluginCountersFor(rsn, dataDir) {
  try {
    const slug = String(rsn).toLowerCase()
      .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    const file = path.join(dataDir || 'data', 'plugin-sync', 'members', `${slug}.json`);
    const rec = JSON.parse(fs.readFileSync(file, 'utf8'));
    const counters = (rec && rec.counters) || {};
    const out = {};
    for (const [k, v] of Object.entries(counters)) {
      if (typeof v === 'number' && v >= 0) out[`plugin:${k}`] = v;
    }
    return out;
  } catch {
    return {};
  }
}

module.exports = {
  luckForPage, binomCdfLE, dryReport, itemLuckScores, scoredCounters,
  scoredIds, scoreEntry, pluginCountersFor,
};
