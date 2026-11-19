// Bounty pool sync: reads the public CSV export of the bounty sheet Master
// tab and swaps data/bounty-pool.json when it validates. On any failure the
// existing pool is left untouched and staff are told in the health channel.
const fs = require('fs');
const path = require('path');
const config = require('./config');
const { atomicWrite } = require('./store');

const POOL_FILE = path.join(__dirname, '..', 'data', 'bounty-pool.json');
const TIERS = ['Easy', 'Medium', 'Hard', 'Extreme'];
const LANES = ['PvM', 'Skilling'];
const GENERATED_FROM = 'bounty sheet Master tab';

// Minimal RFC 4180 parser: quoted fields may hold commas, quotes ("") and newlines.
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      field = '';
      rows.push(row);
      row = [];
    } else field += ch;
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function readCurrentPool() {
  try {
    return JSON.parse(fs.readFileSync(POOL_FILE, 'utf8'));
  } catch {
    try {
      return require('./bounty-pool.json');
    } catch {
      return { generatedFrom: GENERATED_FROM, contracts: [] };
    }
  }
}

// Pet set comes from the bundled pool: pet=true names without the word pet/pets.
const WORD_PET = /\bpets?\b/i;
let petNames = null;
function getPetNames() {
  if (!petNames) {
    petNames = new Set();
    try {
      for (const c of require('./bounty-pool.json').contracts || []) {
        if (c.pet && !WORD_PET.test(c.name)) petNames.add(String(c.name).toLowerCase());
      }
    } catch {}
  }
  return petNames;
}
function isPet(name) {
  return getPetNames().has(name.toLowerCase()) || WORD_PET.test(name);
}

const clean = (v) => (v == null ? '' : String(v).trim());

// Returns { contracts } or { error }.
function buildContracts(rows) {
  const contracts = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const name = clean(r[1]);
    if (!name) continue;
    const line = i + 1;
    const idRaw = clean(r[0]);
    const id = Number(idRaw);
    if (!/^\d+$/.test(idRaw) || !Number.isSafeInteger(id) || id < 1) return { error: `row ${line}: bad id "${idRaw}"` };
    const tier = clean(r[3]);
    if (!TIERS.includes(tier)) return { error: `row ${line}: bad tier "${tier}"` };
    const lane = clean(r[10]) || 'PvM';
    if (!LANES.includes(lane)) return { error: `row ${line}: bad lane "${lane}"` };
    const winRaw = clean(r[11]) || '1';
    const winners = Number(winRaw);
    if (!/^\d+$/.test(winRaw) || !Number.isSafeInteger(winners) || winners < 1) return { error: `row ${line}: bad winners "${winRaw}"` };
    contracts.push({
      id,
      name,
      content: clean(r[2]),
      tier,
      thumbnail: clean(r[4]) || null,
      lane,
      winners,
      pet: isPet(name),
      blurb: clean(r[12]) || null,
      winLine: clean(r[13]) || null,
    });
  }
  return { contracts };
}

async function fetchCsv() {
  const cfg = config.bounty || {};
  if (!cfg.sheetId || !cfg.masterGid) throw new Error('bounty sheet keys missing in config');
  const url = `https://docs.google.com/spreadsheets/d/${encodeURIComponent(cfg.sheetId)}/export?format=csv&gid=${encodeURIComponent(cfg.masterGid)}`;
  const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(15000) });
  if (res.status !== 200) throw new Error(`sheet export answered HTTP ${res.status}`);
  return res.text();
}

async function syncBountyPool(client) {
  const fail = async (error) => {
    console.error(`Bounty pool sync failed: ${error}`);
    if (client) {
      try {
        const { alertHealth } = require('./bot-health');
        await alertHealth(client, 'bounty-sync', `Bounty pool sync failed: ${error}. The current pool is unchanged.`);
      } catch {}
    }
    return { ok: false, error };
  };
  try {
    const text = await fetchCsv();
    const built = buildContracts(parseCsv(text));
    if (built.error) return await fail(built.error);
    const current = readCurrentPool();
    const currentCount = (current.contracts || []).length;
    if (built.contracts.length < currentCount / 2) {
      return await fail(`export has ${built.contracts.length} contracts against ${currentCount} in the pool (looks truncated)`);
    }
    const next = { generatedFrom: current.generatedFrom || GENERATED_FROM, contracts: built.contracts };
    if (JSON.stringify(next) !== JSON.stringify(current)) {
      atomicWrite(POOL_FILE, next);
      console.log(`Bounty pool synced: ${built.contracts.length} contracts`);
    }
    return { ok: true, count: built.contracts.length };
  } catch (e) {
    return await fail(e.message || String(e));
  }
}

module.exports = { syncBountyPool, parseCsv, buildContracts };
