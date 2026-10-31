// Wise Old Man API client for the party board.
// Good-citizen rules (per WOM docs and the Oct 25, 2026 rate-limit
// announcement): paced requests, identifying user agent, 24h cache,
// never poll, and all live requests gated through the shared limiter in
// wom-limiter.js (keyless 20/min, 500/hr, 3,000/day; keyed 100/min,
// 20,000/day). Cached reads never count against the caps.
const fs = require('fs');
const path = require('path');
const { atomicWrite } = require('./store');
const { createLimiter } = require('./wom-limiter');

const limiter = createLimiter();

const BASE = 'https://api.wiseoldman.net/v2';
const USER_AGENT = 'OathForsaken-Bot/1.0 (https://oathforsaken.cc)';
const CACHE_FILE = path.join(__dirname, '..', 'data', 'wom-cache-v3.json');
const VAULT_FILE = path.join(__dirname, '..', 'data', 'player-vault.json');
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

// The vault is the permanent record next to the cache: every verified
// player ever looked up, never pruned. The cache decides when stats
// are fresh enough to serve without a fetch; the vault is what the
// clan remembers. Entries refresh only when a real lookup fetches
// fresh stats - the vault never polls on its own.
function loadVault() {
  try {
    return JSON.parse(fs.readFileSync(VAULT_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function saveVault(vault) {
  fs.mkdirSync(path.dirname(VAULT_FILE), { recursive: true });
  atomicWrite(VAULT_FILE, vault);
}

function vaultUpsert(key, stats, fetchedAt) {
  if (!key || !stats || stats.notFound || typeof fetchedAt !== 'number') return;
  try {
    const vault = loadVault();
    const held = vault[key];
    if (held && typeof held.fetchedAt === 'number' && held.fetchedAt >= fetchedAt) return;
    vault[key] = { fetchedAt, stats };
    saveVault(vault);
  } catch (err) {
    console.warn('Vault write failed:', err.message);
  }
}

// Every known player: per name, the fresher of the cache and vault
// entries. Standings read this, so a searched player stays counted
// after their cache entry ages out.
function mergedPlayers() {
  const merged = { ...loadVault() };
  for (const [key, entry] of Object.entries(loadCache())) {
    if (!entry || !entry.stats || entry.stats.notFound) continue;
    const held = merged[key];
    if (!held || (entry.fetchedAt || 0) >= (held.fetchedAt || 0)) merged[key] = entry;
  }
  return merged;
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
  // Every live request takes a limiter slot first. Cached reads never
  // reach here, so they never count against WOM's caps.
  await limiter.takeSlot();
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
    // Back off: record the block and do NOT retry this request. The next
    // call re-enters the limiter after the block instead of hammering.
    limiter.noteRateLimited(retryAfter);
    const err = new Error(`WOM rate limited, retry after ${retryAfter}s`);
    // Retry-After can be an HTTP-date, which parses to NaN; only expose a
    // numeric value when it is a finite positive number of seconds.
    if (Number.isFinite(retryAfter) && retryAfter > 0) err.retryAfter = retryAfter;
    err.rateLimited = true;
    throw err;
  }
  // Only a real success clears the consecutive-429 escalation; a 5xx must not.
  if (res.ok) limiter.noteSuccess();
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
  // Full skill picture (added Oct 30, 2026): WOM sends every skill with
  // level and XP in the same snapshot. The party board only reads the
  // subset above, but the website, profile pages, and the ladder need
  // all 24 skills, so keep them all here instead of dropping them.
  const allSkills = {};
  for (const [sk, entry] of Object.entries(skills)) {
    if (!entry || typeof entry.level !== 'number') continue;
    allSkills[sk] = {
      level: entry.level,
      xp: typeof entry.experience === 'number' ? entry.experience : null,
    };
  }
  const accountType = typeof playerJson.type === 'string' ? playerJson.type : null;
  return { combat: combatLevel(levels), ...levels, kc, accountType, skills: allSkills };
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

// Every cached player with KC on one metric, best first:
// [{ name, kc }] with name in cache-key (lowercase) form. Cache-only:
// standings never fire a network lookup.
function kcStandings(metric) {
  const cache = mergedPlayers();
  const rows = [];
  for (const [name, entry] of Object.entries(cache)) {
    const kc = entry && entry.stats && entry.stats.kc ? entry.stats.kc[metric] : null;
    if (typeof kc === 'number' && kc > 0) rows.push({ name, kc });
  }
  rows.sort((a, b) => b.kc - a.kc);
  return rows;
}

// Returns { combat, attack, strength, defence, ranged, prayer, magic, hitpoints }
// or { notFound: true } when WOM has never seen the name, or null on error.
async function getStats(rsn) {
  const key = String(rsn).toLowerCase().trim();
  if (!key) return null;
  const cache = loadCache();
  const hit = cache[key];
  const ttl = hit && hit.stats && hit.stats.notFound ? NOTFOUND_MS : CACHE_MS;
  if (hit && Date.now() - hit.fetchedAt < ttl) {
    vaultUpsert(key, hit.stats, hit.fetchedAt);
    return hit.stats;
  }

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
      vaultUpsert(key, stats, fresh[key].fetchedAt);
      return stats;
    } catch (err) {
      console.warn('WOM lookup failed:', err.message);
      return null;
    }
  });
}

// The clan's WOM group membership, as display names. One paced, limiter-
// gated GET; returns null on any failure so callers keep their last list.
async function getGroupMembers(groupId) {
  if (!groupId) return null;
  return paced(async () => {
    try {
      const res = await womFetch('GET', `/groups/${encodeURIComponent(groupId)}`);
      if (!res.ok) return null;
      const group = await res.json();
      const names = [];
      for (const m of group.memberships || []) {
        const name = m.player && (m.player.displayName || m.player.username);
        if (name) names.push(name);
      }
      return names;
    } catch (err) {
      console.warn('WOM group lookup failed:', err.message);
      return null;
    }
  });
}

// The group's competitions (staff create them on Wise Old Man). Returns
// the raw list, or null on failure so callers keep their last good data.
async function getGroupCompetitions(groupId) {
  if (!groupId) return null;
  return paced(async () => {
    try {
      const res = await womFetch('GET', `/groups/${encodeURIComponent(groupId)}/competitions`);
      if (!res.ok) return null;
      const list = await res.json();
      return Array.isArray(list) ? list : null;
    } catch (err) {
      console.warn('WOM group competitions lookup failed:', err.message);
      return null;
    }
  });
}

async function getCompetition(competitionId) {
  if (competitionId == null) return null;
  return paced(async () => {
    try {
      const res = await womFetch('GET', `/competitions/${encodeURIComponent(competitionId)}`);
      if (!res.ok) return null;
      return await res.json();
    } catch (err) {
      console.warn('WOM competition lookup failed:', err.message);
      return null;
    }
  });
}

module.exports = { getStats, getCachedStats, kcStandings, cacheLookup, combatLevel, parseStats, getGroupMembers, getGroupCompetitions, getCompetition, loadVault, mergedPlayers, vaultUpsert, CACHE_MS, NOTFOUND_MS };
