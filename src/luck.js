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

// Luck tuning knobs (Nov 4, 2026): the team-rate
// factors, the pet exemptions, and the unscored list
// live in data/luck-tuning.json (source of truth:
// deploy/luck-tuning.json in the repo) so a number
// tweak is a file edit and a restart, not an image
// rebuild. The file is read once at load. A missing,
// unreadable, or malformed file (or field) falls back
// to the built-in defaults below, which are the shipped
// values, with a logged warning: bad tuning can never
// take the bot down or change the math silently.
const TUNING_FILE = path.join(__dirname, '..', 'data', 'luck-tuning.json');
const DEFAULT_TUNING = {
  rateScale: { yama: 0.8, the_hueycoatl: 1 / 3 },
  rateScalePets: [30888, 30152],
  unscoredItems: [33382, 30637, 33133],
};
function loadTuning() {
  let parsed = null;
  try {
    parsed = JSON.parse(fs.readFileSync(TUNING_FILE, 'utf8'));
  } catch (e) {
    console.error(`[luck] luck-tuning.json unreadable (${e.message}); using built-in tuning defaults`);
    return DEFAULT_TUNING;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    console.error('[luck] luck-tuning.json is not an object; using built-in tuning defaults');
    return DEFAULT_TUNING;
  }
  const bad = (field) => console.error(
    `[luck] luck-tuning.json field "${field}" is malformed; using its built-in default`);
  const out = {
    rateScale: { ...DEFAULT_TUNING.rateScale },
    rateScalePets: DEFAULT_TUNING.rateScalePets,
    unscoredItems: DEFAULT_TUNING.unscoredItems,
  };
  if (parsed.rateScale !== undefined) {
    if (parsed.rateScale && typeof parsed.rateScale === 'object'
      && !Array.isArray(parsed.rateScale)) {
      for (const [c, f] of Object.entries(parsed.rateScale)) {
        if (typeof f === 'number' && Number.isFinite(f) && f > 0 && f <= 1) {
          out.rateScale[c] = f;
        } else bad(`rateScale.${c}`);
      }
    } else bad('rateScale');
  }
  for (const field of ['rateScalePets', 'unscoredItems']) {
    if (parsed[field] !== undefined) {
      if (Array.isArray(parsed[field])
        && parsed[field].every((v) => Number.isInteger(v))) {
        out[field] = parsed[field];
      } else bad(field);
    }
  }
  return out;
}
const TUNING = loadTuning();

// Contribution-scaled bosses (Nov 4, 2026): Yama and the
// Hueycoatl scale their unique rates by each player's
// damage share, so the published table (a solo table)
// overstates the dryness of anyone who teams them. They
// are scored at the team strength the clan actually runs:
// Yama as a duo (rates x 0.8, Jagex's published figure for
// an even split), the Hueycoatl as a 3-man (rates x 1/3,
// the even-share rate). Pets roll flat per player at both
// bosses and keep their listed rates. The factors live
// in the tuning file, not in the table, so re-extracting
// luck-data.json keeps them.
const RATE_SCALE = TUNING.rateScale;
const RATE_SCALE_PETS = new Set(TUNING.rateScalePets); // Yami, Huberte
// Items dropped from scoring entirely, applied at load so
// re-extracting the table cannot bring them back. 33382
// (Immaculate mole skin) was added to the Giant Mole with
// the gem sack content, long after lifetime mole KC
// existed: scoring it charges kills that never had a
// chance to drop it, and its dryness is fake. 30637
// (Giantsoul amulet (uncharged)) is excluded on the
// clan's call: it is not treated as a dry chase. 33133
// (Pristine spider silk) was added to Sarachnis long
// after lifetime Sarachnis KC existed, the same disease
// as the mole skin: its dryness is fake.
const UNSCORED_ITEMS = new Set(TUNING.unscoredItems);
function scaledSources(sources, keepListed) {
  return (sources || []).map((s) => {
    const f = keepListed ? 1 : (RATE_SCALE[s.c] || 1);
    return f === 1 ? s : { ...s, rate: s.rate * f };
  });
}
const TABLE = {};
for (const [id, t] of Object.entries(LUCK_DATA.items || {})) {
  if (UNSCORED_ITEMS.has(Number(id))) continue;
  TABLE[id] = {
    ...t,
    sources: scaledSources(t.sources, RATE_SCALE_PETS.has(Number(id))),
  };
}

// Sets: dupe-protected groups score as one unit. mode
// "pieces" counts distinct pieces owned; mode "total"
// counts the summed quantity across the group.
const SETS = Object.values(LUCK_DATA.sets || {})
  .map((s) => ({ ...s, sources: scaledSources(s.sources, false) }));
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

// Unit classes for the dry views: a
// unit is "legit" when it is the item the hunt is for (a
// table entry can opt out with "legit": false: spent keys,
// shared materials, numbered components, slayer-helm heads
// other than the KQ head). Clue units are their own view.
// Units fed only by the Barrows chest or Moons chest
// counters are hidden from the headline view: the pool is
// wide, and the Moons counter is shared across three
// bosses a player may not all hunt. Views: 'uniques'
// (legit, non-clue, non-hidden), 'clues', 'full'.
const HIDDEN_COUNTERS = new Set(['barrows_chests', 'lunar_chests']);
function classify(entry, sources) {
  const cs = (sources || []).map((s) => s.c);
  return {
    legit: !entry || entry.legit !== false,
    clue: cs.length > 0 && cs.every((c) => String(c).startsWith('clue_scrolls_')),
    hidden: cs.length > 0 && cs.every((c) => HIDDEN_COUNTERS.has(c)),
  };
}
function inDryView(cls, view) {
  if (!cls) return view === 'full';
  if (view === 'uniques') return cls.legit && !cls.clue && !cls.hidden;
  if (view === 'clues') return cls.clue;
  return true;
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
          setMode: s.mode, pieceCount: s.pieces.length,
          cls: classify(s, s.sources || []),
          ...sc,
        });
      }
      continue;
    }
    const t = TABLE[String(id)];
    if (!t) continue;
    const sc = scoreEntry(t, counters, qtyOfItem(it));
    if (sc) units.push({ id, name: t.name, has: qtyOfItem(it) > 0, sources: t.sources || [], cls: classify(t, t.sources || []), ...sc });
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
      const text = `${u.name} (${Math.round(u.dryness * 100)}% would have this by now)`;
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

// The family a counter belongs to by name: the kings
// (dagannoth_rex, dagannoth_prime, dagannoth_supreme)
// share a stem, and so do the clue tiers (clue_scrolls_easy
// and up). A counter with no underscore is its own stem.
function counterStem(counter) {
  const c = String(counter);
  const i = c.lastIndexOf('_');
  return i >= 0 ? c.slice(0, i) : c;
}

// A unit's source counters split into display groups: pool
// families first, then counters sharing a name stem, then
// every other counter alone. Each counter counted once, in
// source order.
function sourceGroups(u) {
  const order = [];
  for (const s of u.sources || []) {
    if (!order.includes(s.c)) order.push(s.c);
  }
  const groups = [];
  const used = new Set();
  for (const f of POOL_FAMILIES) {
    const members = order.filter((c) => f.counters.includes(c));
    if (members.length) {
      groups.push(members);
      for (const c of members) used.add(c);
    }
  }
  const byStem = new Map();
  for (const c of order) {
    if (used.has(c)) continue;
    const stem = counterStem(c);
    if (!byStem.has(stem)) byStem.set(stem, []);
    byStem.get(stem).push(c);
  }
  for (const g of byStem.values()) groups.push(g);
  return groups;
}

// The source group a dry row's printed KC and rate are
// measured against: the pool family the row is labelled by
// when one matches, a pool family the unit draws from in
// full (the Dragon axe's kings, with Wintertodt tagged on
// as a side source), otherwise the group with the most
// attempts. Ties go to the earliest group in source order.
function mainSourceGroup(u, counters) {
  const groups = sourceGroups(u);
  if (!groups.length) return [];
  const have = new Set((u.sources || []).map((s) => s.c));
  const labelled = poolLabelFor(u);
  if (labelled) {
    for (const f of POOL_FAMILIES) {
      if (f.label === labelled) return f.counters.filter((c) => have.has(c));
    }
  }
  for (const f of POOL_FAMILIES) {
    if (f.counters.length && f.counters.every((c) => have.has(c))) {
      return f.counters.filter((c) => have.has(c));
    }
  }
  const attempts = (group) => group.reduce(
    (a, c) => a + (counters && typeof counters[c] === 'number' ? counters[c] : 0), 0);
  let best = groups[0];
  let bestAttempts = attempts(best);
  for (const group of groups.slice(1)) {
    const a = attempts(group);
    if (a > bestAttempts) {
      best = group;
      bestAttempts = a;
    }
  }
  return best;
}

// What sits behind a scored unit, for display: the activity
// count and drop rate its row prints. The luck score pools
// every source (so does the plugin), but the printed
// numbers do not: KC and rate come from the unit's main
// source group only, so a Dragon axe reads as its Dagannoth
// Kings count at the kings' rate, not a pool of kings plus
// Wintertodt games at a blended rate no drop table quotes.
// Within the group, when every attempted source shares one
// rate, that rate shows per counter counted (boss rolls
// folded in, clue rates as quoted); mixed rates print no
// rate at all. A pieces-mode set scores any piece, so its
// rate scales by the piece count first.
function unitDropInfo(u, counters) {
  const main = new Set(mainSourceGroup(u, counters));
  const srcs = (u.sources || []).filter((s) => main.has(s.c));
  const keys = [...new Set(srcs.map((s) => s.c))];
  const kc = keys.reduce(
    (a, c) => a + (counters && typeof counters[c] === 'number' ? counters[c] : 0), 0);
  if (u.isSet && u.setMode !== 'pieces') return { kc: kc > 0 ? kc : null, rate: null };
  const attempted = srcs
    .map((s) => ({
      c: s.c,
      n: counters && typeof counters[s.c] === 'number' ? counters[s.c] : 0,
      rate: typeof s.rate === 'number' ? s.rate : 0,
      rolls: s.rolls || 1,
    }))
    .filter((s) => s.n > 0 && s.rate > 0)
    .map((s) => (u.isSet
      ? { ...s, rate: Math.min(1, s.rate * (u.pieceCount || 1)) } : s));
  if (!attempted.length) return { kc: kc > 0 ? kc : null, rate: null };
  // One rate behind every attempted source: show it as the
  // drop tables quote it, per counter counted. Boss counters
  // count kills and a kill can roll the drop more than once
  // (Zulrah rolls twice, a godsword shard can fall from the
  // general or a bodyguard), so boss rates fold their rolls
  // into a per-kill figure. Clue rates stay per roll, the
  // way their tables quote them.
  const distinct = [...new Set(attempted.map((s) => s.rate))];
  if (distinct.length === 1) {
    const rollSet = [...new Set(attempted.map((s) => s.rolls))];
    const clueOnly = attempted.every((s) => String(s.c).startsWith('clue_scrolls_'));
    if (rollSet.length === 1 && !clueOnly) {
      return { kc: kc > 0 ? kc : null, rate: 1 - Math.pow(1 - distinct[0], rollSet[0]) };
    }
    return { kc: kc > 0 ? kc : null, rate: distinct[0] };
  }
  return { kc: kc > 0 ? kc : null, rate: null };
}

// Drops pooled across a whole boss family name the family
// on the driest list, not the one boss page they were read
// from: godsword shards fall at all four generals, Virtus
// and the ingot at all four DT2 bosses, the Dragon axe at
// all three kings. A unit drawing on a whole family also
// has its printed KC and rate measured against that family
// alone (see mainSourceGroup).
const POOL_FAMILIES = [
  { counters: ['commander_zilyana', 'general_graardor', 'kreearra', 'kril_tsutsaroth'], label: 'GWD' },
  { counters: ['duke_sucellus', 'the_leviathan', 'the_whisperer', 'vardorvis'], label: 'Forgotten Four' },
  { counters: ['dagannoth_prime', 'dagannoth_rex', 'dagannoth_supreme'], label: 'Dagannoth Kings' },
];

function poolLabelFor(u) {
  const have = [...new Set((u.sources || []).map((s) => s.c))].sort();
  for (const f of POOL_FAMILIES) {
    const want = [...f.counters].sort();
    if (have.length === want.length && have.every((c, i) => c === want[i])) return f.label;
  }
  return null;
}

// !dry breakdown: every scored unit on the page with its
// percentile, missing driest first, obtained luckiest
// first, plus the page verdict. The view filters the
// missing list ('full' is every scored unit); obtained and
// the verdict always cover the whole page.
function dryReport(counters, pageItems, view = 'full') {
  if (!counters || !Array.isArray(pageItems)) return null;
  const units = pageUnits(counters, pageItems);
  if (!units.length) return null;
  const missing = units.filter((u) => !u.has && inDryView(u.cls, view))
    .map((u) => ({
      id: u.id, name: u.name, score: u.score, pieces: u.pieces || undefined,
      pool: poolLabelFor(u) || undefined, cls: u.cls,
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
  scoredIds, scoreEntry, pluginCountersFor, inDryView,
};
