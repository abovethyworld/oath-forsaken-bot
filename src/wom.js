// Wise Old Man API client for the party board.
// Good-citizen rules (per WOM docs): paced requests, identifying user
// agent, 24h cache, never poll. No API key yet (20 req/min is plenty);
// set WOM_API_KEY in .env later to raise it to 100/min.
const fs = require('fs');
const path = require('path');
const { atomicWrite } = require('./store');

const BASE = 'https://api.wiseoldman.net/v2';
const USER_AGENT = 'OathForsaken-Bot/1.0 (https://oathforsaken.cc)';
const CACHE_FILE = path.join(__dirname, '..', 'data', 'wom-cache-v3.json');
const CACHE_MS = 24 * 3600 * 1000;
const NOTFOUND_MS = 6 * 3600 * 1000; // unknown names re-check after 6h, not 24h
const MIN_GAP_MS = 1200; // min time between WOM requests

const SKILLS = ['attack', 'strength', 'defence', 'ranged', 'prayer', 'magic', 'hitpoints'];
// Non-combat skills shown on skilling-minigame boards (level only, no combat math).
const SKILL_LEVELS = ['firemaking', 'runecraft', 'fishing', 'mining', 'agility'];

function loadCache() {
  try {
    return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function saveCache(cache) {
  // Prune expired entries so the file doesn't grow one row per RSN forever.
  const cutoff = Date.now() - CACHE_MS;
  for (const [key, entry] of Object.entries(cache)) {
    if (!entry || typeof entry.fetchedAt !== 'number' || entry.fetchedAt < cutoff) delete cache[key];
  }
  fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
  atomicWrite(CACHE_FILE, cache);
}

// Serialized, paced request queue. All WOM traffic goes through here.
let queueTail = Promise.resolve();
let lastRequestAt = 0;

function paced(fn) {
  const run = queueTail.then(async () => {
    const wait = MIN_GAP_MS - (Date.now() - lastRequestAt);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastRequestAt = Date.now();
    return fn();
  });
  // A failure must not break the chain for later requests.
  queueTail = run.catch(() => {});
  return run;
}

const FETCH_TIMEOUT_MS = 15000;

async function womFetch(method, endpoint, body) {
  const headers = { 'User-Agent': USER_AGENT, 'Content-Type': 'application/json' };
  if (process.env.WOM_API_KEY) headers['x-api-key'] = process.env.WOM_API_KEY;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(`${BASE}${endpoint}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
  } catch (err) {
    if (err.name === 'AbortError') throw new Error(`WOM request timed out after ${FETCH_TIMEOUT_MS / 1000}s`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
  if (res.status === 429) {
    const retryAfter = parseInt(res.headers.get('Retry-After') || '60', 10);
    const err = new Error(`WOM rate limited, retry after ${retryAfter}s`);
    err.retryAfter = retryAfter;
    err.rateLimited = true;
    throw err;
  }
  return res;
}

// OSRS combat level from skill levels.
function combatLevel(s) {
  const base = 0.25 * (s.defence + s.hitpoints + Math.floor(s.prayer / 2));
  const melee = 0.325 * (s.attack + s.strength);
  const ranged = 0.325 * (Math.floor(s.ranged / 2) + s.ranged);
  const magic = 0.325 * (Math.floor(s.magic / 2) + s.magic);
  return Math.floor(base + Math.max(melee, ranged, magic));
}

function parseStats(playerJson) {
  // Defensive: snapshot shape has moved before. Try known locations.
  const snap = playerJson.latestSnapshot || playerJson.snapshot || {};
  const skills = (snap.data && snap.data.skills) || snap.skills || {};
  const levels = {};
  for (const sk of SKILLS) {
    const entry = skills[sk];
    const lvl = entry && typeof entry.level === 'number' ? entry.level : null;
    levels[sk] = lvl == null || lvl < 1 ? 1 : Math.min(lvl, 99);
  }
  const hasAny = SKILLS.some((sk) => {
    const entry = skills[sk];
    return entry && typeof entry.level === 'number';
  });
  if (!hasAny) return null;
  const bosses = (snap.data && snap.data.bosses) || snap.bosses || {};
  const kc = {};
  for (const [key, entry] of Object.entries(bosses)) {
    if (entry && typeof entry.kills === 'number' && entry.kills >= 0) kc[key] = entry.kills;
  }
  // Minigame scores live under activities (score, not kills). WOM marks
  // unranked bosses -1 kills (verified live 2026-10-20), so both maps
  // keep only values >= 0; unranked renders as '-' downstream.
  const activities = (snap.data && snap.data.activities) || snap.activities || {};
  for (const [key, entry] of Object.entries(activities)) {
    if (entry && typeof entry.score === 'number' && entry.score >= 0) kc[key] = entry.score;
  }
  for (const sk of SKILL_LEVELS) {
    const entry = skills[sk];
    const lvl = entry && typeof entry.level === 'number' ? entry.level : null;
    // Missing in WOM's snapshot (their record can be missing a skill
    // entirely) renders as null -> the board shows '-', never a fake 1.
    levels[sk] = lvl == null ? null : Math.min(Math.max(lvl, 1), 99);
  }
  const accountType = typeof playerJson.type === 'string' ? playerJson.type : null;
  return { combat: combatLevel(levels), ...levels, kc, accountType };
}

async function fetchPlayerDetails(username) {
  const res = await womFetch('GET', `/players/${encodeURIComponent(username)}`);
  if (res.status === 404) return { notFound: true };
  if (!res.ok) throw new Error(`WOM lookup failed: ${res.status}`);
  return { player: await res.json() };
}

// Synchronous cache read for stale-while-revalidate rendering.
// Returns { stats, fresh } for a cached name, or null when never cached.
// fresh = fetched within CACHE_MS; stale entries are still returned so a
// board can draw immediately while a background refresh runs.
function cacheLookup(cache, rsn) {
  const key = String(rsn || '').toLowerCase().trim();
  if (!key) return null;
  const hit = cache[key];
  if (!hit || typeof hit.fetchedAt !== 'number') return null;
  const ttl = hit.stats && hit.stats.notFound ? NOTFOUND_MS : CACHE_MS;
  return { stats: hit.stats, fresh: Date.now() - hit.fetchedAt < ttl };
}

function getCachedStats(rsn) {
  return cacheLookup(loadCache(), rsn);
}

// Returns { combat, attack, strength, defence, ranged, prayer, magic, hitpoints }
// or { notFound: true } when WOM has never seen the name, or null on error.
async function getStats(rsn) {
  const key = String(rsn).toLowerCase().trim();
  if (!key) return null;
  const cache = loadCache();
  const hit = cache[key];
  const ttl = hit && hit.stats && hit.stats.notFound ? NOTFOUND_MS : CACHE_MS;
  if (hit && Date.now() - hit.fetchedAt < ttl) return hit.stats;

  // Cache unknown names too (shorter TTL): repeat lookups of a garbage
  // name must not re-run the GET/POST/GET track flow and burn quota.
  const rememberNotFound = () => {
    const freshCache = loadCache();
    freshCache[key] = { fetchedAt: Date.now(), stats: { notFound: true } };
    saveCache(freshCache);
    return { notFound: true };
  };

  return paced(async () => {
    try {
      let details = await fetchPlayerDetails(key);
      if (details.notFound) {
        // Start tracking them (the intended one-time flow), then read back.
        const track = await womFetch('POST', `/players/${encodeURIComponent(key)}`, {});
        if (track.status === 404 || track.status === 400) return rememberNotFound();
        details = await fetchPlayerDetails(key);
        if (details.notFound || !details.player) return rememberNotFound();
      }
      const stats = parseStats(details.player);
      if (!stats) return null;
      const fresh = loadCache();
      fresh[key] = { fetchedAt: Date.now(), stats };
      saveCache(fresh);
      return stats;
    } catch (err) {
      console.warn('WOM lookup failed:', err.message);
      return null;
    }
  });
}

module.exports = { getStats, getCachedStats, cacheLookup, combatLevel, parseStats, CACHE_MS, NOTFOUND_MS };
