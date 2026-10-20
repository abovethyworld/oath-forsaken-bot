// RuneProfile API client for collection-log data.
// Good-citizen rules (per RuneProfile docs): paced requests, identifying
// user agent, 24h cache, never poll. Works keyless at 30 req/min; set
// RUNEPROFILE_API_KEY in .env later to raise it to 120/min.
// Data only exists for players running the RuneProfile RuneLite plugin.
const fs = require('fs');
const path = require('path');

const BASE = 'https://api.runeprofile.com/v1';
const USER_AGENT = 'OathForsaken-Bot/1.0 (https://oathforsaken.cc)';
const CACHE_FILE = path.join(__dirname, '..', 'data', 'rp-cache-v1.json');
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
  fs.writeFileSync(CACHE_FILE, JSON.stringify(cache));
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

function parseClogTotal(accountJson) {
  const clog = accountJson && accountJson.collectionLog;
  if (!clog || typeof clog.obtained !== 'number' || typeof clog.total !== 'number') return null;
  return { obtained: clog.obtained, total: clog.total };
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
async function getClogPage(username, tab, page) {
  const key = clogCacheKey(username, tab, page);
  const cached = loadCache()[key];
  if (cached && Date.now() - cached.fetchedAt < CACHE_MS) {
    return cached.notFound ? { notFound: true } : { obtained: cached.obtained, total: cached.total };
  }
  const u = encodeURIComponent(String(username).trim());
  return fetchInto(key, `/accounts/${u}/collection-log/${encodeURIComponent(tab)}/${encodeURIComponent(page)}`, parseClogPage)
    .catch((err) => {
      console.warn(`RuneProfile clog lookup failed for ${username}: ${err.message}`);
      return null;
    });
}

// Total collection log: { obtained, total } | { notFound: true } | null.
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

module.exports = {
  getClogPage,
  getClogTotal,
  getCachedClogPage,
  parseClogPage,
  parseClogTotal,
  clogCacheKey,
  CACHE_MS,
};
