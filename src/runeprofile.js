// RuneProfile API client for collection-log data.
// Good-citizen rules (per RuneProfile docs): paced requests, identifying
// user agent, 24h cache, never poll. Works keyless at 30 req/min; set
// RUNEPROFILE_API_KEY in .env later to raise it to 120/min.
// Data only exists for players running the RuneProfile RuneLite plugin.
const fs = require('fs');
const path = require('path');
const { atomicWrite } = require('./store');

const BASE = 'https://api.runeprofile.com/v1';
const USER_AGENT = 'OathForsaken-Bot/1.0 (https://oathforsaken.cc)';
const CACHE_FILE = path.join(__dirname, '..', 'data', 'rp-cache-v2.json');
const CACHE_MS = 24 * 3600 * 1000;
const MIN_GAP_MS = 2500; // keyless tier is 30 req/min; pace well under it

function loadCache() {
  try {
    return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function saveCache(cache) {
  // Prune expired entries so the file doesn't grow forever.
  const cutoff = Date.now() - CACHE_MS;
  for (const [key, entry] of Object.entries(cache)) {
    if (!entry || typeof entry.fetchedAt !== 'number' || entry.fetchedAt < cutoff) delete cache[key];
  }
  fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
  atomicWrite(CACHE_FILE, cache);
}

// Serialized, paced request queue. All RuneProfile traffic goes through here.
let queueTail = Promise.resolve();
let lastRequestAt = 0;

function paced(fn) {
  const run = queueTail.then(async () => {
    const wait = MIN_GAP_MS - (Date.now() - lastRequestAt);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastRequestAt = Date.now();
    return fn();
  });
  queueTail = run.catch(() => {});
  return run;
}

const FETCH_TIMEOUT_MS = 15000;

async function rpFetch(endpoint) {
  const headers = { 'User-Agent': USER_AGENT };
  if (process.env.RUNEPROFILE_API_KEY) headers['X-API-Key'] = process.env.RUNEPROFILE_API_KEY;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(`${BASE}${endpoint}`, { headers, signal: ctrl.signal });
  } catch (err) {
    if (err.name === 'AbortError') throw new Error(`RuneProfile request timed out after ${FETCH_TIMEOUT_MS / 1000}s`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
  if (res.status === 404 || res.status === 400) return { notFound: true };
  if (res.status === 429) {
    const err = new Error('RuneProfile rate limited');
    err.rateLimited = true;
    throw err;
  }
  if (!res.ok) throw new Error(`RuneProfile lookup failed: ${res.status}`);
  return { json: await res.json() };
}

function clogCacheKey(username, tab, page) {
  return `clog:${String(username).toLowerCase().trim()}:${tab}:${page}`;
}

function totalCacheKey(username) {
  return `total:${String(username).toLowerCase().trim()}`;
}

function parseClogPage(json) {
  if (!json || typeof json.obtained !== 'number' || typeof json.total !== 'number') return null;
  return { obtained: json.obtained, total: json.total };
}

// Full page parse including the item list for the !clog card.
function parseClogPageItems(json) {
  const base = parseClogPage(json);
  if (!base) return null;
  const items = Array.isArray(json.items) ? json.items : [];
  return { ...base, items: items.filter((it) => it && typeof it.id === 'number' && typeof it.name === 'string') };
}

// Parse the profile bundle pieces into the shapes the card needs.
function parseSkills(data) {
  const arr = data && data.data;
  if (!Array.isArray(arr)) return null;
  const levels = {};
  for (const s of arr) {
    if (s && s.name && typeof s.level === 'number') levels[String(s.name).toLowerCase()] = s.level;
  }
  return { levels };
}

function sumTiers(groups, tierKey) {
  let done = 0, total = 0;
  for (const g of groups || []) {
    const tiers = g && g[tierKey];
    if (!Array.isArray(tiers)) continue;
    for (const t of tiers) {
      if (t && typeof t.completed === 'number' && typeof t.total === 'number') {
        done += t.completed; total += t.total;
      }
    }
  }
  return { done, total };
}

function parseCombatAchievements(json) {
  const arr = json && json.data;
  if (!Array.isArray(arr)) return null;
  return sumTiers([{ tiers: arr }], 'tiers');
}

function parseDiaries(json) {
  const arr = json && json.data;
  if (!Array.isArray(arr)) return null;
  return sumTiers(arr, 'tiers');
}

function parseClogTotal(accountJson) {
  const clog = accountJson && accountJson.collectionLog;
  if (!clog || typeof clog.obtained !== 'number' || typeof clog.total !== 'number') return null;
  return { obtained: clog.obtained, total: clog.total };
}

// The account collection-log index lists EVERY clog item (game-wide),
// deduped by item id. Used by the icon warmer to know the full set.
function parseClogIndex(json) {
  if (!json || !Array.isArray(json.tabs)) return null;
  const seen = new Map();
  for (const tab of json.tabs) {
    for (const page of (tab.pages || [])) {
      for (const it of (page.items || [])) {
        if (it && typeof it.id === 'number' && typeof it.name === 'string' && !seen.has(it.id)) {
          seen.set(it.id, { id: it.id, name: it.name });
        }
      }
    }
  }
  if (!seen.size) return null;
  return { items: [...seen.values()] };
}

// { items: [{id, name}] } | { notFound: true } | null. Cached 24h.
async function getClogIndex(username) {
  const key = `clogindex:${String(username).toLowerCase().trim()}`;
  const cached = loadCache()[key];
  if (cached && Date.now() - cached.fetchedAt < CACHE_MS && Array.isArray(cached.items)) {
    return { items: cached.items };
  }
  if (cached && cached.notFound && Date.now() - cached.fetchedAt < CACHE_MS) return { notFound: true };
  const u = encodeURIComponent(String(username).trim());
  return fetchInto(key, `/accounts/${u}/collection-log`, parseClogIndex)
    .catch((err) => {
      console.warn(`RuneProfile index lookup failed for ${username}: ${err.message}`);
      return null;
    });
}

async function fetchInto(key, endpoint, parse) {
  return paced(async () => {
    const res = await rpFetch(endpoint);
    if (res.notFound) {
      const cache = loadCache();
      cache[key] = { fetchedAt: Date.now(), notFound: true };
      saveCache(cache);
      return { notFound: true };
    }
    const parsed = parse(res.json);
    if (!parsed) throw new Error('RuneProfile returned an unexpected shape');
    const cache = loadCache();
    cache[key] = { fetchedAt: Date.now(), ...parsed };
    saveCache(cache);
    return parsed;
  });
}

// Returns { obtained, total } | { notFound: true } | null on error.
// The cache entry also carries the item list for the !clog card.
async function getClogPage(username, tab, page) {
  const full = await getClogPageWithItems(username, tab, page);
  if (!full || full.notFound) return full;
  return { obtained: full.obtained, total: full.total };
}

// Returns { obtained, total, items } | { notFound: true } | null on error.
async function getClogPageWithItems(username, tab, page) {
  const key = clogCacheKey(username, tab, page);
  const cached = loadCache()[key];
  if (cached && Date.now() - cached.fetchedAt < CACHE_MS) {
    if (cached.notFound) return { notFound: true };
    return { obtained: cached.obtained, total: cached.total, items: cached.items || [] };
  }
  const u = encodeURIComponent(String(username).trim());
  return fetchInto(key, `/accounts/${u}/collection-log/${encodeURIComponent(tab)}/${encodeURIComponent(page)}`, parseClogPageItems)
    .catch((err) => {
      console.warn(`RuneProfile clog lookup failed for ${username}: ${err.message}`);
      return null;
    });
}

// Total collection log: { obtained, total } | { notFound: true } | null.
// Sync read of the cached clog total: { obtained, total, fresh } |
// { notFound, fresh } | null. Used by the leaderboard (instant render).
function getCachedClogTotal(username) {
  const entry = loadCache()[totalCacheKey(username)];
  if (!entry) return null;
  const fresh = Date.now() - entry.fetchedAt < CACHE_MS;
  if (entry.notFound) return { notFound: true, fresh };
  return { obtained: entry.obtained, total: entry.total, fresh };
}

async function getClogTotal(username) {
  const key = totalCacheKey(username);
  const cached = loadCache()[key];
  if (cached && Date.now() - cached.fetchedAt < CACHE_MS) {
    return cached.notFound ? { notFound: true } : { obtained: cached.obtained, total: cached.total };
  }
  const u = encodeURIComponent(String(username).trim());
  return fetchInto(key, `/accounts/${u}`, parseClogTotal)
    .catch((err) => {
      console.warn(`RuneProfile total lookup failed for ${username}: ${err.message}`);
      return null;
    });
}

// Synchronous cache read for board rendering (stale-while-revalidate).
// { obtained, total, fresh } | { notFound: true, fresh } | null when uncached.
function getCachedClogPage(username, tab, page) {
  const hit = loadCache()[clogCacheKey(username, tab, page)];
  if (!hit || typeof hit.fetchedAt !== 'number') return null;
  const fresh = Date.now() - hit.fetchedAt < CACHE_MS;
  if (hit.notFound) return { notFound: true, fresh };
  return { obtained: hit.obtained, total: hit.total, fresh };
}

// Profile bundle: account summary + skills + combat achievements + diaries.
// Returns { account, skills, ca, diaries } | { notFound: true } | null.
async function getProfile(username) {
  const u = encodeURIComponent(String(username).trim());
  const jobs = [
    ['profile:account', `/accounts/${u}`, (j) => (j && j.username ? j : null)],
    ['profile:skills', `/accounts/${u}/skills`, parseSkills],
    ['profile:ca', `/accounts/${u}/combat-achievements`, parseCombatAchievements],
    ['profile:diaries', `/accounts/${u}/achievement-diaries`, parseDiaries],
  ];
  const out = {};
  for (const [tag, endpoint, parse] of jobs) {
    const key = `profile:${String(username).toLowerCase().trim()}:${tag.split(':')[1]}`;
    const cached = loadCache()[key];
    if (cached && Date.now() - cached.fetchedAt < CACHE_MS) {
      if (cached.notFound) return { notFound: true };
      out[tag.split(':')[1]] = cached.data;
      continue;
    }
    const res = await paced(() => rpFetch(endpoint)).catch((err) => {
      console.warn(`RuneProfile ${tag} lookup failed for ${username}: ${err.message}`);
      return null;
    });
    if (!res) return null;
    if (res.notFound) {
      const cache = loadCache();
      cache[key] = { fetchedAt: Date.now(), notFound: true };
      saveCache(cache);
      return { notFound: true };
    }
    const parsed = parse(res.json);
    if (!parsed) return null;
    const cache = loadCache();
    cache[key] = { fetchedAt: Date.now(), data: parsed };
    saveCache(cache);
    out[tag.split(':')[1]] = parsed;
  }
  return { account: out.account, skills: out.skills, ca: out.ca, diaries: out.diaries };
}

module.exports = {
  getClogPage,
  getClogIndex,
  parseClogIndex,
  getClogPageWithItems,
  getClogTotal,
  getCachedClogPage,
  getCachedClogTotal,
  getProfile,
  parseClogPage,
  parseClogPageItems,
  parseClogTotal,
  parseSkills,
  parseCombatAchievements,
  parseDiaries,
  clogCacheKey,
  CACHE_MS,
};
