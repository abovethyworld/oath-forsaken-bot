// Card smoke test: run INSIDE the bot container after every
// deploy (the deploy is not done until this passes):
//   docker cp tools/smoke-cards.js oathbreakers-bot:/app/tools/
//   docker exec oathbreakers-bot node /app/tools/smoke-cards.js
// Exits 1 on any failure. Read-only: it renders payloads and
// simulates button presses against the live caches, and never
// writes data files or posts to Discord.
//
// Coverage: every card payload, the leaderboard boards and
// variant toggles, scoped card swaps and their return buttons,
// malformed button states, the account-type gate, autocomplete
// abuse, the dry views (Uniques / Clues / Full clog), and
// regression checks for the Nov 2, 2026 bugs (compare
// clogs totals crash, clog boss card missing its Leaderboard
// button, compare PvM tab not lighting, profile-luck file).
// The Account Type forged-press fix is NOT covered here: its
// handler runs role sync against the guild, so it stays a
// one-off test with data backups (done 2026-11-02).
const fs = require('fs');
const path = require('path');
const S = require(path.join(__dirname, '..', 'src', 'showoff.js'));
const DATA = path.join(__dirname, '..', 'data');
// Fixtures are derived from the bot's own data files at runtime:
// the smoke runs against live caches, and the repo carries no real
// account names or user IDs. OWNER is a linked user with at least
// two accounts whose types are stated; PRIMARY is the account most
// sections render; ALT is another of the owner's accounts; OTHER is
// a second linked user; PARTNER is that user's account (compare
// partner and name-lookup target); SPACED is an account whose name
// contains a space.
const T = require(path.join(__dirname, '..', 'src', 'teams.js'));
function readDataJson(name) {
  try { return JSON.parse(fs.readFileSync(path.join(DATA, name), 'utf8')); } catch { return null; }
}
const linksFile = readDataJson('rsn-links.json') || {};
const gainsFile = readDataJson('wom-gains.json') || {};
function linkedRsns(uid) {
  try { const e = T.getRsnEntry(uid); return (e && e.rsns) || []; } catch { return []; }
}
function pickFixtures() {
  const uids = Object.keys(linksFile);
  let owner = null;
  for (const uid of uids) {
    const rsns = linkedRsns(uid);
    if (rsns.length < 2) continue;
    const stated = rsns.filter((r) => T.getStatedBadge(uid, r));
    if (stated.length < 2) continue;
    const primary = stated.find((r) => {
      const g = gainsFile[String(r).toLowerCase()];
      return g && g.week && g.year && !S.isCold(r);
    });
    if (!primary) continue;
    owner = { uid, primary, alt: stated.find((r) => r !== primary) };
    break;
  }
  let other = null;
  for (const uid of uids) {
    if (owner && uid === owner.uid) continue;
    const rsns = linkedRsns(uid);
    if (!rsns.length) continue;
    const first = rsns[0];
    if (T.getStatedBadge(uid, first) && !S.isCold(first)) { other = { uid, primary: first }; break; }
  }
  if (!owner || !other) return null;
  const spaced = [owner.alt, other.primary, owner.primary].find((r) => r && r.includes(' ')) || owner.primary;
  return { OWNER_ID: owner.uid, PRIMARY: owner.primary, ALT: owner.alt,
    OTHER_ID: other.uid, PARTNER: other.primary, SPACED: spaced };
}
const FX = pickFixtures();
if (!FX) { console.error('SMOKE FIXTURES: could not derive linked test accounts from the data files'); process.exit(1); }
const OWNER = FX.OWNER_ID;
const OTHER_USER = FX.OTHER_ID;
const PRIMARY = FX.PRIMARY;
const ALT = FX.ALT;
const PARTNER = FX.PARTNER;
const SPACED = FX.SPACED;
let pass = 0, fail = 0;
const fails = [];
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('PASS', name); }
  else { fail++; fails.push(name); console.log('FAIL', name, extra || ''); }
}
function compsOf(payload) {
  return (payload.components || []).map((r) => {
    const j = r.toJSON ? r.toJSON() : r;
    return (j.components || []).map((c) => ({
      id: c.custom_id || '', label: c.label || c.placeholder || '', style: c.style,
    }));
  });
}
function flat(p) { return compsOf(p).flat(); }
function pickOptionCount(payload, prefix) {
  for (const row of (payload && payload.components) || []) {
    const j = row.toJSON ? row.toJSON() : row;
    for (const c of j.components || []) {
      if ((c.custom_id || '').startsWith(prefix)) return (c.options || []).length;
    }
  }
  return 0;
}
// Ground truth for the dry category buttons: a category holds
// units for this account when its Full clog page renders a
// drill-in picker with at least one page on it.
async function dryCatsWithUnits(rsn) {
  const cats = [];
  for (const c of ['Bosses', 'Clues', 'Minigames', 'Other']) {
    const p = await S.dryListPayload(rsn, null, 'full', c);
    if (p && p.files && pickOptionCount(p, 'drypick:') > 0) cats.push(c);
  }
  return cats;
}
function fakeIx(customId, messageComponents, userId) {
  const ix = {
    customId, user: { id: userId || OWNER },
    message: { components: messageComponents || [] },
    last: null, replied: null,
    update: async (msg) => { ix.last = msg; },
    reply: async (msg) => { ix.replied = msg; },
  };
  return ix;
}
const hasFile = (p) => !!(p && p.files && p.files[0]);
const timings = [];
async function t(name, fn, needFile = true) {
  let p = null, threw = null;
  const started = Date.now();
  try { p = await fn(); } catch (e) { threw = e; }
  timings.push({ name, ms: Date.now() - started });
  ok(name, !threw && (needFile ? hasFile(p) : (hasFile(p) || typeof (p && p.content) === 'string')),
    threw ? threw.message : (p && p.content ? String(p.content).slice(0, 100) : 'no file/content'));
  return p;
}

(async () => {
  // ── A. Every card payload renders ────────────────────
  await t('profile card', () => S.profilePayload(PRIMARY, OWNER));
  await t('profile card (alt account)', () => S.profilePayload(ALT, OWNER));
  await t('skills card', () => S.skillsPayload(PRIMARY, OWNER));
  await t('clog total card', () => S.clogPayload('total', PRIMARY, OWNER));
  await t('clog page card (Zulrah)', () => S.clogPayload('zulrah', PRIMARY, OWNER));
  await t('clog clues summary card', () => S.clogPayload('clues', PRIMARY, OWNER));
  await t('clog scrolls summary card', () => S.clogPayload('scrolls', PRIMARY, OWNER));
  await t('dry card (Zulrah)', () => S.dryPayload('zulrah', PRIMARY, OWNER));
  await t('gains card', () => S.gainsPayload(PRIMARY, 'week', OWNER), false);
  await t('pb reply', () => S.pbPayload('', PRIMARY, OWNER), false);
  await t('compare overall', () => S.compareOverallPayload(PRIMARY, PARTNER, OWNER, OWNER));
  await t('compare skills', () => S.compareSkillsPayload(PRIMARY, PARTNER, OWNER, OWNER, {}));
  await t('compare skill inspect (Fishing)', () => S.compareSkillsPayload(PRIMARY, PARTNER, OWNER, OWNER, { skill: 'fishing' }));
  // Regression (Nov 2): the clogs totals branch crashed on an
  // out-of-scope variable after badges were added to compare.
  await t('compare clogs totals', () => S.compareClogsPayload(PRIMARY, PARTNER, OWNER, OWNER, {}));
  await t('compare clogs page (Zulrah)', () => S.compareClogsPayload(PRIMARY, PARTNER, OWNER, OWNER, { page: 'Zulrah' }));
  await t('leaderboard card', () => S.leaderboardPayload(OWNER, 'overall'));
  await t('kc card (name with spaces)', () => S.kcPayload('zulrah', SPACED, OWNER));

  // ── B. Leaderboard boards + variant toggles ──────────
  for (const arg of ['overall', 'boss:zulrah', 'skill:fishing', 'clogtotal', 'gains']) {
    const p = await S.leaderboardPayload(OWNER, arg);
    ok(`board renders: ${arg}`, hasFile(p));
  }
  const bad = await S.leaderboardPayload(OWNER, 'boss:doesnotexist');
  ok('board renders: bogus boss falls back, no crash', hasFile(bad) || typeof bad.content === 'string');
  const expect = {
    toa: ['Total', 'Normal', 'Expert'], cox: ['Total', 'Normal', 'CM'],
    tob: ['Total', 'Regular', 'Hard Mode'], gauntlet: ['Total', 'Gauntlet', 'Corrupted Gauntlet'],
    dks: ['Total', 'Rex', 'Prime', 'Supreme'], nightmare: ['Total', 'Nightmare', "Phosani's"],
    callisto: ['Total', 'Artio', 'Callisto'], venenatis: ['Total', 'Spindel', 'Venenatis'],
    vetion: ['Total', 'Calvarion', "Vet'ion"], bh: ['Total', 'Hunter', 'Rogue'],
    zulrah: null, colosseum: null,
  };
  for (const [key, labels] of Object.entries(expect)) {
    const p = await S.leaderboardPayload(OWNER, `boss:${key}`);
    const varBtns = flat(p).filter((c) => c.id.startsWith('lbvar:'));
    if (labels === null) { ok(`no toggle: ${key}`, varBtns.length === 0); continue; }
    ok(`toggle labels: ${key}`, JSON.stringify(varBtns.map((b) => b.label)) === JSON.stringify(labels),
      JSON.stringify(varBtns.map((b) => b.label)));
  }
  const toaFull = await S.leaderboardPayload(OWNER, 'boss:toa');
  const toaVarBtn = flat(toaFull).find((c) => c.id.startsWith('lbvar:1:'));
  const ixT = fakeIx(toaVarBtn.id, toaFull.components);
  await S.handleLeaderboardButton(ixT);
  ok('variant press updates message', !!ixT.last && hasFile(ixT.last));
  ok('variant board differs from total board',
    Buffer.compare(ixT.last.files[0].attachment, toaFull.files[0].attachment) !== 0);
  for (const sel of ['9', '-1', 'x']) {
    const crafted = toaVarBtn.id.replace('lbvar:1:', `lbvar:${sel}:`);
    const ix = fakeIx(crafted, toaFull.components);
    let threw = false;
    try { await S.handleLeaderboardButton(ix); } catch { threw = true; }
    ok(`lbvar sel=${sel} survives`, !threw && !!ix.last);
  }
  const stale = fakeIx('lbtab:pvm:o|-|0|-|0|-|0|x|7', []);
  let staleThrew = false;
  try { await S.handleLeaderboardButton(stale); } catch { staleThrew = true; }
  ok('stale 9-segment state survives', !staleThrew && !!stale.last);
  const garb = fakeIx('lbtab:pvm:💥💥💥', []);
  let garbThrew = false;
  try { await S.handleLeaderboardButton(garb); } catch { garbThrew = true; }
  ok('garbage state survives', !garbThrew);
  const bb = fakeIx('lbback:junk:whatever', []);
  let bbThrew = false;
  try { await S.handleLbBackButton(bb); } catch { bbThrew = true; }
  ok('bogus lbback survives silently', !bbThrew && !bb.last);

  // ── C. Scoped swaps + the clog/kc button parity ──────
  const kc = await S.kcPayload('gauntlet', PRIMARY, OWNER);
  const swapBtn = flat(kc)[0];
  const ixS = fakeIx(swapBtn.id, kc.components, OTHER_USER);
  await S.handleLbSwapButton(ixS);
  const scopedIds = flat(ixS.last).map((c) => c.id);
  ok('scoped board has no tabs/picker',
    !scopedIds.some((i) => i.startsWith('lbtab:') || i.startsWith('lbpick:')));
  ok('scoped board return label', flat(ixS.last).some((c) => c.label === '← KC card'));
  // Regression (Nov 2): the same combined card posted via /clog
  // must carry the same Leaderboard button /kc posts.
  const clogBoss = await S.clogPayload('zulrah', PRIMARY, OWNER);
  ok('clog boss card carries Leaderboard button',
    flat(clogBoss).some((c) => c.id.startsWith('lbswap:boss:zulrah')));

  // ── D. KC cards across bosses ────────────────────────
  for (const key of ['toa', 'cox', 'tob', 'gauntlet', 'dks', 'nightmare', 'callisto',
    'venenatis', 'vetion', 'bh', 'clues', 'colosseum', 'zulrah']) {
    let p = null, threw = false;
    try { p = await S.kcPayload(key, PRIMARY, OWNER); } catch { threw = true; }
    ok(`kc renders: ${key}`, !threw && (hasFile(p) || typeof p.content === 'string'));
  }

  // ── E. Account-type gate cases ───────────────────────
  const links = JSON.parse(fs.readFileSync(path.join(DATA, 'rsn-links.json'), 'utf8'));
  const badges = JSON.parse(fs.readFileSync(path.join(DATA, 'badges.json'), 'utf8'));
  let unstated = null;
  for (const [uid, raw] of Object.entries(links)) {
    const rsns = raw.rsns || (raw.rsn ? [raw.rsn] : []);
    const rec = badges.users && badges.users[uid];
    const stated = rec ? Object.keys(rec.accounts || {}).length : 0;
    if (rsns.length && !stated) { unstated = { uid, rsn: rsns[0] }; break; }
  }
  ok('found an unstated linked account to test', !!unstated, 'none found');
  if (unstated) {
    const g1 = await S.kcPayload('zulrah', unstated.rsn, unstated.uid);
    ok('gate fires for own unstated account',
      typeof g1.content === 'string' && g1.content.includes('Set the account type'));
    const g2 = await S.kcPayload('zulrah', unstated.rsn.toLowerCase(), unstated.uid);
    ok('gate fires case-insensitively',
      typeof g2.content === 'string' && g2.content.includes('Set the account type'));
    const g3 = await S.kcPayload('zulrah', PRIMARY, unstated.uid);
    ok('no gate on someone else\'s account',
      !(typeof g3.content === 'string' && g3.content.includes('Set the account type')));
  }
  const own = await S.kcPayload('zulrah', PRIMARY.toLowerCase(), OWNER);
  ok('stated owner is not gated', hasFile(own));

  // ── F. Autocomplete abuse ────────────────────────────
  for (const q of ['', 'toa', 'TOA', '🔥'.repeat(40), 'a'.repeat(500), '|', ':', '💥']) {
    let r = null, threw = false;
    try { r = S.kcAutocompleteChoices(q); } catch { threw = true; }
    ok(`kc autocomplete survives query ${JSON.stringify(q.slice(0, 12))}`,
      !threw && Array.isArray(r) && r.length <= 25);
  }
  const toaRows = S.kcAutocompleteChoices('toa').filter((c) => c.name === 'Tombs of Amascut');
  ok('kc autocomplete: exactly one Tombs row', toaRows.length === 1, `got ${toaRows.length}`);
  for (const q of ['', 'clue', '💥'.repeat(30)]) {
    let threw = false;
    try { S.clogAutocompleteChoices(q); S.dryAutocompleteChoices(q); } catch { threw = true; }
    ok(`clog/dry autocomplete survives ${JSON.stringify(q.slice(0, 8))}`, !threw);
  }

  // ── G. Solo skill cards (via the lbback production path) ──
  const skills = ['attack', 'strength', 'defence', 'hitpoints', 'ranged', 'prayer',
    'magic', 'cooking', 'woodcutting', 'fletching', 'fishing', 'firemaking', 'crafting',
    'smithing', 'mining', 'herblore', 'agility', 'thieving', 'slayer', 'farming',
    'runecraft', 'hunter', 'construction', 'sailing'];
  for (const sk of skills) {
    const ix = fakeIx(`lbback:skill:${sk}:${PRIMARY}`, []);
    let threw = false;
    try { await S.handleLbBackButton(ix); } catch { threw = true; }
    ok(`solo skill renders: ${sk}`, !threw && !!ix.last && hasFile(ix.last));
  }
  const ixF = fakeIx('lbback:skill:fishing:' + PRIMARY, []);
  await S.handleLbBackButton(ixF);
  const fishSwap = flat(ixF.last).find((c) => c.id.startsWith('lbswap:'));
  ok('solo fishing card has swap', !!fishSwap);
  if (fishSwap) {
    const ixSf = fakeIx(fishSwap.id, ixF.last.components);
    await S.handleLbSwapButton(ixSf);
    ok('solo skill scoped return label', flat(ixSf.last).some((c) => c.label === '← Fishing card'),
      JSON.stringify(flat(ixSf.last).map((c) => c.label)));
  }

  // ── H. Compare boss: swap, tab light, cross-user gate ──
  const cmp = await S.compareBossPayload('zulrah', PRIMARY, PARTNER, OWNER, OWNER, {});
  ok('compare boss renders', hasFile(cmp));
  // Regression (Nov 2): the PvM tab must light (Danger, style 4)
  // on a boss card, like the other views light theirs.
  const pvmBtn = flat(cmp).find((c) => c.label === 'PvM');
  ok('compare boss PvM tab is lit', !!pvmBtn && pvmBtn.style === 4,
    pvmBtn ? `style=${pvmBtn.style}` : 'missing');
  const cmpSwap = flat(cmp).find((c) => c.id.startsWith('lbswap:'));
  ok('compare swap button present', !!cmpSwap);
  if (cmpSwap) {
    const enc = cmpSwap.id.split(':').pop();
    const dec = Buffer.from(enc, 'base64url').toString('utf8').split('\n');
    ok('compare swap id carries the pair', dec[0] === PRIMARY && dec[1] === PARTNER);
    const ixB = fakeIx(cmpSwap.id, cmp.components);
    await S.handleLbSwapButton(ixB);
    ok('compare scoped return label', flat(ixB.last).some((c) => c.label === '← Compare card'),
      JSON.stringify(flat(ixB.last).map((c) => c.label)));
  }
  const changeBtn = flat(cmp).find((c) => c.id.startsWith('cmpswap'));
  ok('compare Change players button present', !!changeBtn);
  if (changeBtn) {
    const ixC = fakeIx(changeBtn.id, cmp.components, OTHER_USER);
    let threw = false;
    try { await S.handleCompareSwapButton(ixC); } catch { threw = true; }
    const note = (ixC.replied && ixC.replied.content) || (ixC.last && ixC.last.content) || '';
    ok('non-owner Change players gets make-my-own note', !threw && note.includes('make your own'),
      note.slice(0, 120));
  }

  // ── I. Gains: WOM periods (Nov 2, 2026) ──────────────
  for (const per of ['day', 'week', 'month', 'year']) {
    const gp = await S.gainsPayload(PRIMARY, per, OWNER);
    ok(`gains card renders: ${per}`, hasFile(gp), gp && gp.content ? gp.content.slice(0, 80) : '');
  }
  const gw = await S.gainsPayload(PRIMARY, 'week', OWNER);
  const gBtns = flat(gw).filter((c) => c.id.startsWith('gains:'));
  ok('gains card carries 4 period buttons', gBtns.length === 4,
    JSON.stringify(gBtns.map((b) => b.id)));
  let flipped = null;
  await S.handleGainsButton({ customId: 'gains:year:' + PRIMARY, user: { id: OWNER },
    update: async (p) => { flipped = p; }, reply: async (p) => { flipped = p; } });
  ok('gains period flip swaps the card', !!(flipped && flipped.files));
  let wgOk = false;
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(DATA, 'wom-gains.json'), 'utf8'));
    wgOk = !!(raw[PRIMARY.toLowerCase()] && raw[PRIMARY.toLowerCase()].week && raw[PRIMARY.toLowerCase()].year);
  } catch {}
  ok('wom-gains.json holds the fixture week + year', wgOk);
  const gb = await S.leaderboardPayload(OWNER, 'gains');
  const pyBtn = flat(gb).find((c) => c.id.startsWith('lbg:py:'));
  ok('gains board has a Year period button', !!pyBtn);
  if (pyBtn) {
    const ixG = fakeIx(pyBtn.id, gb.components);
    await S.handleLeaderboardButton(ixG);
    ok('gains board year press updates', !!ixG.last && hasFile(ixG.last));
    ok('gains board keeps kind + period rows',
      flat(ixG.last).some((c) => c.id.startsWith('lbg:pm:')));
  }

  // ── K. Bridges, clue dry, per-command cooldown ──────
  const kcZ = await S.kcPayload('zulrah', PRIMARY, OWNER);
  ok('kc card has the Dry bridge', flat(kcZ).some((c) => c.id.startsWith('bridge:dry:zulrah:')));
  const kcT = await S.kcPayload('toa', PRIMARY, OWNER);
  ok('kc card has no Dry bridge for unscored ToA', !flat(kcT).some((c) => c.id.startsWith('bridge:')));
  const dryZ = await S.dryPayload('zulrah', PRIMARY, OWNER);
  ok('dry card has the KC bridge', flat(dryZ).some((c) => c.id.startsWith('bridge:kc:zulrah:')));
  let bridged = null;
  await S.handleBridgeButton({ customId: 'bridge:dry:zulrah:' + PRIMARY, user: { id: OWNER },
    update: async (p) => { bridged = p; }, reply: async (p) => { bridged = p; } });
  ok('bridge press swaps KC into dry', !!(bridged && bridged.files));
  let toClues = null;
  await S.handleBridgeButton({ customId: 'bridge:clues:-:' + PRIMARY, user: { id: OWNER },
    update: async (p) => { toClues = p; }, reply: async (p) => { toClues = p; } });
  // The summary carries its own Profile button now (hub wave);
  // the landing must show that, never the stale bridge row.
  ok('bridge to clues lands with its Profile button, no stale bridge row',
    !!(toClues && toClues.files)
      && flat(toClues).some((c) => c.id.startsWith('prof:clogs:clues:'))
      && !flat(toClues).some((c) => c.id.startsWith('bridge:')));
  const dryHard = await S.dryPayload('clue:hard', PRIMARY, OWNER);
  ok('dry renders for hard clues', hasFile(dryHard),
    dryHard && dryHard.content ? dryHard.content.slice(0, 80) : '');
  ok('clue dry card has the Clues bridge',
    !!(dryHard && dryHard.components) && flat(dryHard).some((c) => c.id.startsWith('bridge:clues:')));
  const dryAll = await S.dryPayload('clue:all', PRIMARY, OWNER);
  ok('dry renders for all clue tiers', hasFile(dryAll),
    dryAll && dryAll.content ? dryAll.content.slice(0, 80) : '');
  ok('all-tiers dry card has the Clues bridge',
    !!(dryAll && dryAll.components) && flat(dryAll).some((c) => c.id.startsWith('bridge:clues:')));
  let toSummary = null;
  await S.handleBridgeButton({ customId: 'bridge:clues:hard:' + PRIMARY, user: { id: OWNER },
    update: async (p) => { toSummary = p; }, reply: async (p) => { toSummary = p; } });
  ok('summary landing from a dry card carries the way back',
    !!(toSummary && toSummary.files)
      && JSON.stringify(toSummary.components || []).includes('bridge:dryc:hard'));
  let backToDry = null;
  await S.handleBridgeButton({ customId: 'bridge:dryc:hard:' + PRIMARY, user: { id: OWNER },
    update: async (p) => { backToDry = p; }, reply: async (p) => { backToDry = p; } });
  ok('way-back press returns the tier dry card', !!(backToDry && backToDry.files));
  let oldLanding = null;
  await S.handleBridgeButton({ customId: 'bridge:clues:-:' + PRIMARY, user: { id: OWNER },
    update: async (p) => { oldLanding = p; }, reply: async (p) => { oldLanding = p; } });
  ok('pre-origin Clues buttons still land clean',
    !!(oldLanding && oldLanding.files)
      && flat(oldLanding).some((c) => c.id.startsWith('prof:clogs:clues:'))
      && !flat(oldLanding).some((c) => c.id.startsWith('bridge:')));
  const u2 = '999000111';
  S.noteUse(u2, 'kc');
  ok('cooldown blocks the same family', S.checkCooldown(u2, 'kc').wait > 0);
  ok('cooldown leaves other families free', S.checkCooldown(u2, 'compare').wait === 0);

  // ── J. Profile-luck file (writer runs at startup + 6h) ──
  let luckOk = false, luckWhy = '';
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(DATA, 'profile-luck.json'), 'utf8'));
    luckOk = raw && typeof raw === 'object' && Object.keys(raw).length >= 5;
    if (!luckOk) luckWhy = `entries=${raw ? Object.keys(raw).length : 0}`;
  } catch (e) { luckWhy = e.message; }
  ok('profile-luck.json exists with entries', luckOk, luckWhy);
  let unitsOk = false, unitsWhy = '';
  try {
    const units = JSON.parse(fs.readFileSync(path.join(DATA, 'profile-luck-units.json'), 'utf8'));
    const sample = Object.values(units)[0];
    unitsOk = units && typeof units === 'object' && Object.keys(units).length >= 5
      && sample && typeof sample.name === 'string' && typeof sample.score === 'number'
      && typeof sample.dryness === 'number';
    if (!unitsOk) unitsWhy = `entries=${units ? Object.keys(units).length : 0}`;
  } catch (e) { unitsWhy = e.message; }
  ok('profile-luck-units.json exists with structured units', unitsOk, unitsWhy);

  // ── K. Cold start: warm names never seed, unknown names are cold ──
  ok('tracked member is warm (no cold sync)', S.isCold(PRIMARY) === false);
  ok('never-checked name is cold', S.isCold('zz no such rsn 42') === true);
  const warmSeed = await S.ensureSynced(PRIMARY, 1000);
  ok('ensureSynced no-ops for a warm name', warmSeed === false);

  // ── L. Dry list + driest board ──
  const dlStarted = Date.now();
  const dl = await S.dryListPayload(PRIMARY, null, 'full', 'all');
  timings.push({ name: 'dry list (section L)', ms: Date.now() - dlStarted });
  ok('dry list renders for the fixture account', !!(dl && dl.files), JSON.stringify(dl && dl.content || ''));
  ok('dry list carries category buttons', !!dl && (dl.components || []).length >= 1);
  const expectedCats = await dryCatsWithUnits(PRIMARY);
  const shownCats = flat(dl).filter((c) => c.id.startsWith('drycat:') && !c.id.startsWith('drycat:all:'))
    .map((c) => c.id.split(':')[1]);
  ok('dry list hides the fixture account\'s empty categories',
    JSON.stringify([...shownCats].sort()) === JSON.stringify([...expectedCats].sort()),
    `shown=${shownCats} expected=${expectedCats}`);
  const dlb = await S.dryListPayload(PRIMARY, null, 'full', 'Bosses');
  ok('dry list Bosses category renders', !!(dlb && dlb.files));
  const drb = await S.leaderboardPayload(null, 'driest');
  ok('driest board renders', !!(drb && drb.files), JSON.stringify(drb && drb.content || ''));

  // ── M. Profile hub: shell, tabs, switcher, branches ──
  function hubIx(customId, messageComponents, userId) {
    const ix = fakeIx(customId, messageComponents, userId);
    ix.deferred = false;
    ix.deferUpdate = async () => { ix.deferred = true; };
    ix.editReply = async (msg) => { ix.last = msg; };
    ix.followUp = async (msg) => { ix.followedUp = msg; };
    ix.showModal = async (modal) => { ix.modal = modal; };
    ix.channel = { send: async (msg) => { ix.sent = msg; return { id: 'x' }; } };
    ix.fields = { getTextInputValue: () => ix._field || '' };
    return ix;
  }
  function selOptions(payload, prefix) {
    for (const row of (payload && payload.components) || []) {
      const j = row.toJSON ? row.toJSON() : row;
      for (const c of j.components || []) {
        if ((c.custom_id || '').startsWith(prefix)) return c.options || [];
      }
    }
    return [];
  }
  const hub = await t('hub overview renders', () => S.hubPayload(PRIMARY, OWNER, {}));
  ok('hub overview has tab + branch rows',
    !!hub && flat(hub).some((c) => c.id.startsWith('hub:tab:skills:'))
      && flat(hub).some((c) => c.id.startsWith('hub:lb:'))
      && flat(hub).some((c) => c.id.startsWith('hub:cmp:'))
      && flat(hub).some((c) => c.id.startsWith('hub:chg:')));
  ok('hub overview within the 5-row cap', !!hub && (hub.components || []).length <= 5,
    hub ? `${hub.components.length} rows` : 'none');
  for (const tab of ['skills', 'pvm', 'clogs', 'dry', 'gains']) {
    const p = await t(`hub tab renders: ${tab}`, () => S.hubPayload(PRIMARY, OWNER, { tab }));
    ok(`hub tab within the 5-row cap: ${tab}`, !!p && (p.components || []).length <= 5,
      p ? `${(p.components || []).length} rows` : 'none');
  }
  const hubPb = await S.hubPayload(PRIMARY, OWNER, { tab: 'pbs' });
  ok('hub PBs tab is the plugin notice',
    !!hubPb && (hasFile(hubPb) || String(hubPb.content || '').includes('clan plugin is live')),
    hubPb && hubPb.content ? hubPb.content.slice(0, 80) : 'no payload');
  ok('hub PBs tab carries only the shell',
    !!hubPb && flat(hubPb).every((c) => /^(hub:tab:|hub:lb:|hub:cmp:|hub:chg:|refresh:hub:)/.test(c.id)),
    JSON.stringify(flat(hubPb || {}).map((c) => c.id)));
  // Tab press swaps the card in place.
  const skillsTabBtn = flat(hub).find((c) => c.id.startsWith('hub:tab:skills:'));
  const ixTab = hubIx(skillsTabBtn.id, hub.components, OWNER);
  await S.handleHubButton(ixTab);
  ok('hub tab press opens Skills with its picker',
    !!ixTab.last && hasFile(ixTab.last)
      && flat(ixTab.last).some((c) => c.id.startsWith('hub:skillpick:')));
  // Solo skill in place, with the named return above the tabs.
  const ixSkill = hubIx(flat(ixTab.last).find((c) => c.id.startsWith('hub:skillpick:')).id,
    ixTab.last.components, OWNER);
  ixSkill.values = ['fishing'];
  await S.handleHubSelect(ixSkill);
  ok('hub skill pick opens the solo card in place',
    !!ixSkill.last && hasFile(ixSkill.last)
      && flat(ixSkill.last).some((c) => c.id.startsWith('hub:skillgrid:') && c.label === '← Skills card'));
  ok('hub solo skill has no Leaderboard button',
    !!ixSkill.last && !flat(ixSkill.last).some((c) => c.id.startsWith('lbswap:')));
  // PvM picker: category + boss selects, then the controls return.
  const hubPvm = await S.hubPayload(PRIMARY, OWNER, { tab: 'pvm' });
  const pickBtn = flat(hubPvm).find((c) => c.id.startsWith('hub:pickboss:'));
  ok('hub PvM tab has Pick a boss', !!pickBtn);
  const ixPick = hubIx(pickBtn.id, hubPvm.components, OWNER);
  await S.handleHubButton(ixPick);
  ok('hub boss picker shows category + boss selects',
    !!ixPick.last && flat(ixPick.last).some((c) => c.id.startsWith('hub:bosscat:'))
      && flat(ixPick.last).some((c) => c.id.startsWith('hub:bosspick:')));
  const bossOpts = selOptions(ixPick.last, 'hub:bosspick:')
    .map((o) => o.value).filter((v) => v && !v.startsWith('page:') && v !== 'none');
  ok('hub boss picker lists bosses', bossOpts.length > 0);
  if (bossOpts.length) {
    const ixBoss = hubIx(flat(ixPick.last).find((c) => c.id.startsWith('hub:bosspick:')).id,
      ixPick.last.components, OWNER);
    ixBoss.values = [bossOpts[0]];
    await S.handleHubSelect(ixBoss);
    ok('hub boss pick returns to the controls row',
      !!ixBoss.last && hasFile(ixBoss.last)
        && flat(ixBoss.last).some((c) => c.id.startsWith('hub:pickboss:')));
  }
  // ToA variant toggles ride the PvM controls row.
  const hubToa = await S.hubPayload(PRIMARY, OWNER, { tab: 'pvm', sub: 'toa' });
  const varBtns = flat(hubToa).filter((c) => c.id.startsWith('hub:var:'));
  ok('hub ToA controls carry variant toggles',
    JSON.stringify(varBtns.map((b) => b.label)) === JSON.stringify(['Total', 'Normal', 'Expert']),
    JSON.stringify(varBtns.map((b) => b.label)));
  // The Expert toggle's state carries an underscored boss key;
  // a later press must decode it back to the same key.
  const expertBtn = varBtns.find((c) => c.id.startsWith('hub:var:1:'));
  if (expertBtn) {
    const ixVar = hubIx(expertBtn.id, hubToa.components, OWNER);
    await S.handleHubButton(ixVar);
    ok('hub variant press renders the variant card',
      !!ixVar.last && hasFile(ixVar.last)
        && flat(ixVar.last).some((c) => c.id.startsWith('hub:pickboss:')));
    const tabBtn2 = flat(ixVar.last || {}).find((c) => c.id.startsWith('hub:tab:pvm:'));
    ok('variant state round-trips the underscored key',
      !!tabBtn2 && tabBtn2.id.includes('toa_expert'), tabBtn2 ? tabBtn2.id : 'missing');
  }
  // Clogs picker: category buttons + page select, page view returns.
  const hubClogs = await S.hubPayload(PRIMARY, OWNER, { tab: 'clogs' });
  const clogPickBtn = flat(hubClogs).find((c) => c.id.startsWith('hub:clogpick:'));
  ok('hub Clogs tab has Pick a page', !!clogPickBtn);
  const ixCP = hubIx(clogPickBtn.id, hubClogs.components, OWNER);
  await S.handleHubButton(ixCP);
  ok('hub clog picker shows categories + pages',
    !!ixCP.last && flat(ixCP.last).filter((c) => c.id.startsWith('hub:clogcat:')).length === 5
      && flat(ixCP.last).some((c) => c.id.startsWith('hub:clogpage:')));
  const pageOpts = selOptions(ixCP.last, 'hub:clogpage:')
    .map((o) => o.value).filter((v) => v && !v.startsWith('pg:'));
  if (pageOpts.length) {
    const ixPage = hubIx(flat(ixCP.last).find((c) => c.id.startsWith('hub:clogpage:')).id,
      ixCP.last.components, OWNER);
    ixPage.values = [pageOpts[0]];
    await S.handleHubSelect(ixPage);
    ok('hub clog page carries the Clogs return, no Leaderboard button',
      !!ixPage.last && hasFile(ixPage.last)
        && flat(ixPage.last).some((c) => c.id.startsWith('hub:clogtotal:') && c.label === '← Clogs card')
        && !flat(ixPage.last).some((c) => c.id.startsWith('lbswap:')));
  }
  // Dry tab: opens on the Uniques view; the Full clog view
  // carries the category buttons, empties hidden. Drill into
  // a page from the Uniques list, return to the list.
  const hubDry = await S.hubPayload(PRIMARY, OWNER, { tab: 'dry' });
  ok('hub Dry tab opens on the Uniques view',
    !!hubDry && flat(hubDry).some((c) => c.id.startsWith('hub:dryview:uniques:')));
  const dryFullBtn = flat(hubDry).find((c) => c.id.startsWith('hub:dryview:full:'));
  if (dryFullBtn) {
    const ixFull = hubIx(dryFullBtn.id, hubDry.components, OWNER);
    await S.handleHubButton(ixFull);
    // Categories with nothing scored hide their button (set
    // Nov 2, 2026); expectedCats was probed in section L.
    const shownHubCats = flat(ixFull.last || {}).filter((c) => c.id.startsWith('hub:drycat:') && !c.id.startsWith('hub:drycat:all:'))
      .map((c) => c.id.split(':')[2]);
    ok('hub Dry tab shows only non-empty categories',
      !!ixFull.last && JSON.stringify([...shownHubCats].sort()) === JSON.stringify([...expectedCats].sort()),
      `shown=${shownHubCats} expected=${expectedCats}`);
  } else {
    ok('hub Dry tab shows only non-empty categories', false, 'no Full clog view button');
  }
  const dryOpts = selOptions(hubDry, 'hub:drypick:').map((o) => o.value).filter(Boolean);
  ok('hub Dry tab has a drill-in picker', dryOpts.length > 0);
  if (dryOpts.length) {
    const ixDrill = hubIx(flat(hubDry).find((c) => c.id.startsWith('hub:drypick:')).id,
      hubDry.components, OWNER);
    ixDrill.values = [dryOpts[0]];
    await S.handleHubSelect(ixDrill);
    ok('hub dry drill-in carries return buttons',
      !!ixDrill.last && hasFile(ixDrill.last)
        && flat(ixDrill.last).some((c) => c.id.startsWith('hub:drylist:')));
    const backBtn = flat(ixDrill.last).find((c) => c.id.startsWith('hub:drylist:'));
    const ixBack = hubIx(backBtn.id, ixDrill.last.components, OWNER);
    await S.handleHubButton(ixBack);
    ok('hub dry return restores the list',
      !!ixBack.last && hasFile(ixBack.last)
        && flat(ixBack.last).some((c) => c.id.startsWith('hub:dryview:')));
  }
  // Gains flips inside the hub.
  const hubGains = await S.hubPayload(PRIMARY, OWNER, { tab: 'gains' });
  const gainBtn = flat(hubGains).find((c) => c.id.startsWith('hub:gain:year:'));
  ok('hub Gains tab has period buttons', !!gainBtn);
  if (gainBtn) {
    const ixGain = hubIx(gainBtn.id, hubGains.components, OWNER);
    await S.handleHubButton(ixGain);
    ok('hub gains flip swaps in place', !!ixGain.last && hasFile(ixGain.last));
  }
  // Switcher: owner opens it, picks an alt; non-owner gets the note.
  const chgBtn = flat(hub).find((c) => c.id.startsWith('hub:chg:'));
  const ixChg = hubIx(chgBtn.id, hub.components, OWNER);
  await S.handleHubButton(ixChg);
  ok('switcher opens with Type a name + clan picker',
    !!ixChg.last && flat(ixChg.last).some((c) => c.id.startsWith('hub:name:'))
      && flat(ixChg.last).some((c) => c.id.startsWith('hub:clanpick:')));
  const altBtn = flat(ixChg.last || {}).find((c) => c.id.startsWith('hub:alt:'));
  ok('switcher lists the opener\'s other accounts', !!altBtn);
  if (altBtn) {
    const ixAlt = hubIx(altBtn.id, ixChg.last.components, OWNER);
    await S.handleHubButton(ixAlt);
    ok('switcher pick reloads the hub and closes',
      !!ixAlt.last && hasFile(ixAlt.last)
        && !flat(ixAlt.last).some((c) => c.id.startsWith('hub:clanpick:')));
  }
  const ixChgX = hubIx(chgBtn.id, hub.components, OTHER_USER);
  await S.handleHubButton(ixChgX);
  ok('non-owner Change player gets the make-my-own note',
    !!ixChgX.replied && String(ixChgX.replied.content || '').includes("can't change the players")
      && flat(ixChgX.replied).some((c) => c.id.startsWith('hubmine:')));
  // Leaderboard branch: matching board + named return, and the
  // return row survives board flips.
  const lbBtn = flat(hubClogs).find((c) => c.id.startsWith('hub:lb:'));
  const ixLb = hubIx(lbBtn.id, hubClogs.components, OWNER);
  await S.handleHubButton(ixLb);
  ok('hub Leaderboard branch opens a board with the hub return',
    !!ixLb.last && hasFile(ixLb.last)
      && flat(ixLb.last).some((c) => c.id.startsWith('hubback:') && c.label === '← Clogs card'));
  const lbTabBtn = flat(ixLb.last).find((c) => c.id.startsWith('lbtab:skills:'));
  const ixLbFlip = hubIx(lbTabBtn.id, ixLb.last.components, OWNER);
  await S.handleLeaderboardButton(ixLbFlip);
  ok('hub return row survives board flips',
    !!ixLbFlip.last && flat(ixLbFlip.last).some((c) => c.id.startsWith('hubback:')));
  // Open profile: picker on a standalone board, pick opens the hub.
  const board = await S.leaderboardPayload(OWNER, 'overall');
  const profBtn = flat(board).find((c) => c.id.startsWith('lbprof:'));
  ok('standalone board carries Open profile', !!profBtn);
  if (profBtn) {
    const ixOP = hubIx(profBtn.id, board.components, OWNER);
    await S.handleLbProfileButton(ixOP);
    ok('Open profile reveals the player picker',
      !!ixOP.last && flat(ixOP.last).some((c) => c.id.startsWith('lbprofpick:')));
    const names = selOptions(ixOP.last, 'lbprofpick:').map((o) => o.value).filter(Boolean);
    if (names.length) {
      const ixPickP = hubIx(flat(ixOP.last).find((c) => c.id.startsWith('lbprofpick:')).id,
        ixOP.last.components, OWNER);
      ixPickP.values = [names[0]];
      await S.handleLbProfileSelect(ixPickP);
      ok('Open profile pick opens that player\'s hub',
        !!ixPickP.last && hasFile(ixPickP.last)
          && flat(ixPickP.last).some((c) => c.id.startsWith('hub:tab:')));
    }
  }
  // Compare branch: opens at once for another member, and the
  // hub return survives compare view flips.
  const hubC = await S.hubPayload(PRIMARY, OTHER_USER, {});
  const cmpBtn = flat(hubC).find((c) => c.id.startsWith('hub:cmp:'));
  const ixCmp = hubIx(cmpBtn.id, hubC.components, OTHER_USER);
  await S.handleHubButton(ixCmp);
  ok('hub Compare branch opens the matchup with the hub return',
    !!ixCmp.last && hasFile(ixCmp.last)
      && flat(ixCmp.last).some((c) => c.id.startsWith('hubback:') && c.label === '← Profile card'));
  if (ixCmp.last) {
    const viewBtn = flat(ixCmp.last).find((c) => c.id.startsWith('cmp:skills:'));
    if (viewBtn) {
      const ixView = hubIx(viewBtn.id, ixCmp.last.components, OTHER_USER);
      await S.handleCompareButton(ixView);
      ok('hub return survives compare view flips',
        !!ixView.last && flat(ixView.last).some((c) => c.id.startsWith('hubback:')));
    }
  }
  // Profile buttons on the standalone cards.
  const kcP = await S.kcPayload('zulrah', PRIMARY, OWNER);
  ok('kc card carries a Profile button',
    flat(kcP).some((c) => c.id.startsWith('prof:pvm:zulrah:')));
  const skP = await S.skillsPayload(PRIMARY, OWNER);
  ok('skills card carries a Profile button',
    flat(skP).some((c) => c.id.startsWith('prof:skills:')));
  const dlP = await S.dryListPayload(PRIMARY, OWNER, 'all');
  ok('dry list carries a Profile button',
    flat(dlP).some((c) => c.id.startsWith('prof:dry:list:')));
  const ctP = await S.clogPayload('total', PRIMARY, OWNER);
  ok('clog total carries a Profile button',
    flat(ctP).some((c) => c.id.startsWith('prof:clogs:total:')));
  const profBtnKc = flat(kcP).find((c) => c.id.startsWith('prof:'));
  const ixProf = hubIx(profBtnKc.id, kcP.components, OWNER);
  await S.handleProfileButton(ixProf);
  ok('Profile button opens the hub on the boss',
    !!ixProf.last && hasFile(ixProf.last)
      && flat(ixProf.last).some((c) => c.id.startsWith('hub:pickboss:')));
  // Compare autocomplete: linked + clan names first, capped at 25.
  const acIx = {
    commandName: 'compare', user: { id: OWNER }, choices: null,
    options: {
      getFocused: () => ({ name: 'player_a', value: PRIMARY.slice(0, 2).toLowerCase() }),
      getString: () => null,
    },
    respond: async (c) => { acIx.choices = c; },
  };
  await S.handleAutocomplete(acIx);
  ok('compare autocomplete returns linked/clan matches',
    Array.isArray(acIx.choices) && acIx.choices.length > 0 && acIx.choices.length <= 25
      && acIx.choices.some((c) => c.value === PRIMARY),
    JSON.stringify(acIx.choices || []).slice(0, 120));
  const acIx2 = {
    commandName: 'compare', user: { id: OWNER }, choices: null,
    options: {
      getFocused: () => ({ name: 'player_b', value: 'qqqqzz' }),
      getString: () => null,
    },
    respond: async (c) => { acIx2.choices = c; },
  };
  let acThrew = false;
  try { await S.handleAutocomplete(acIx2); } catch { acThrew = true; }
  ok('compare autocomplete survives an unmatched fragment',
    !acThrew && Array.isArray(acIx2.choices));
  // Malformed hub states survive.
  for (const id of ['hub:tab:skills:💥💥', 'hub:lb:garbage', 'hub:chg:x|y', 'prof:pvm::' + PRIMARY, 'hubback:💥']) {
    const ix = hubIx(id, [], OWNER);
    let threw = false;
    try {
      if (id.startsWith('prof:')) await S.handleProfileButton(ix);
      else if (id.startsWith('hubback:')) await S.handleHubBackButton(ix);
      else await S.handleHubButton(ix);
    } catch { threw = true; }
    ok(`malformed hub id survives: ${id.slice(0, 24)}`, !threw);
  }

  // N. Dry list rate/KC fields and the !dry text parse
  // (Nov 2, 2026, late): dryReport missing units carry the
  // activity count and a per-attempt rate, blended across
  // sources; a name after !dry opens the list, a boss opens
  // its card (takeActivity used to eat the name whole).
  const L = require(path.join(__dirname, '..', 'src', 'luck.js'));
  const blud = L.dryReport({ abyssal_sire: 1077 },
    [{ id: 13274, quantity: 0 }, { id: 13275, quantity: 0 }, { id: 13276, quantity: 0 }]);
  const bludRow = blud && blud.missing.find((m) => m.name === 'Abyssal bludgeon');
  ok('dry rate: bludgeon any-piece rate', !!bludRow && bludRow.rate > 0.004 && bludRow.rate < 0.0055,
    bludRow && String(bludRow.rate));
  ok('dry rate: bludgeon kc', !!bludRow && bludRow.kc === 1077);
  const page = L.dryReport({ clue_scrolls_hard: 100, clue_scrolls_master: 50 },
    [{ id: 12624, quantity: 0 }]);
  const pageRow = page && page.missing[0];
  ok('dry rate: clue page blended rate', !!pageRow && pageRow.rate > 0.007 && pageRow.rate < 0.009,
    pageRow && String(pageRow.rate));
  ok('dry rate: clue page kc sums tiers', !!pageRow && pageRow.kc === 150);
  const shard = L.dryReport(
    { commander_zilyana: 124, general_graardor: 23, kril_tsutsaroth: 318, kreearra: 1 },
    [{ id: 11822, quantity: 0 }]);
  const shardRow = shard && shard.missing[0];
  ok('dry rate: shard per-kill rate folds boss and bodyguard rolls', !!shardRow
    && shardRow.rate > 0.0032 && shardRow.rate < 0.0034,
    shardRow && String(shardRow.rate));
  ok('dry pool: shard names GWD with pooled kc', !!shardRow
    && shardRow.pool === 'GWD' && shardRow.kc === 466,
    shardRow && `${shardRow.pool} ${shardRow.kc}`);
  const fang = L.dryReport({ zulrah: 512 }, [{ id: 12922, quantity: 0 }]);
  const fangRow = fang && fang.missing[0];
  ok('dry rate: zulrah fang per-kill rate folds two rolls', !!fangRow
    && Math.abs(fangRow.rate - 0.0019531) < 0.0001 && fangRow.kc === 512 && !fangRow.pool,
    fangRow && String(fangRow.rate));
  const virtus = L.dryReport(
    { the_whisperer: 10, duke_sucellus: 10, the_leviathan: 10, vardorvis: 10 },
    [{ id: 26241, quantity: 0 }]);
  const virtusRow = virtus && virtus.missing[0];
  ok('dry pool: virtus names the Forgotten Four', !!virtusRow && virtusRow.pool === 'Forgotten Four' && virtusRow.kc === 40,
    virtusRow && `${virtusRow.pool} ${virtusRow.kc}`);
  async function fakeDryMsg(userId, args) {
    const replies = [];
    const msg = {
      author: { id: userId },
      reply: async (p) => { replies.push(p); return { edit: async (p2) => { replies.push(p2); } }; },
    };
    await S.handleDryCommand(msg, args);
    return replies;
  }
  const nameList = await fakeDryMsg('drytest-a', [PARTNER]);
  ok('!dry <name> opens the driest list', !!(nameList[0] && nameList[0].files),
    nameList[0] && nameList[0].content);
  const bossCard = await fakeDryMsg('drytest-b', ['zulrah', PARTNER]);
  ok('!dry <boss> <name> opens the boss card', !!(bossCard[0] && bossCard[0].files),
    bossCard[0] && bossCard[0].content);
  // The second user's linked account, not the owner's:
  // earlier sections already spent the owner's per-command
  // dry cooldown in this same process, and a bare !dry is
  // judged by its payload, not by whose list it opens.
  const ownList = await fakeDryMsg(OTHER_USER, []);
  ok('!dry alone opens own list', !!(ownList[0] && ownList[0].files),
    ownList[0] && ownList[0].content);

  // ── O. Dry views (Nov 4, 2026): Uniques / Clues / Full
  // clog. The luck layer stamps every unit with a class;
  // the headline views filter on it, the math never changes.
  {
    const namesIn = (rep) => (rep ? rep.missing.map((m) => m.name) : []);
    const dt2C = { the_whisperer: 100, duke_sucellus: 100, the_leviathan: 100, vardorvis: 100 };
    const dt2Items = [{ id: 28334, quantity: 0 }, { id: 28276, quantity: 0 },
      { id: 28268, quantity: 0 }, { id: 26241, quantity: 0 }];
    const dt2U = namesIn(L.dryReport(dt2C, dt2Items, 'uniques'));
    const dt2F = namesIn(L.dryReport(dt2C, dt2Items, 'full'));
    ok('dry views: orb out of Uniques, in Full clog',
      !dt2U.includes("Awakener's orb") && dt2F.includes("Awakener's orb"));
    ok('dry views: ingot out of Uniques, in Full clog',
      !dt2U.includes('Chromium ingot') && dt2F.includes('Chromium ingot'));
    ok('dry views: quartz out of Uniques, in Full clog',
      !dt2U.includes('Blood quartz') && dt2F.includes('Blood quartz'));
    ok('dry views: Virtus stays in Uniques', dt2U.includes('Virtus mask'));
    const gwdC = { commander_zilyana: 300, general_graardor: 300, kril_tsutsaroth: 300, kreearra: 300 };
    const shardU = namesIn(L.dryReport(gwdC, [{ id: 11818, quantity: 0 }], 'uniques'));
    const shardF = namesIn(L.dryReport(gwdC, [{ id: 11818, quantity: 0 }], 'full'));
    ok('dry views: godsword shard out of Uniques, in Full clog',
      !shardU.includes('Godsword shard 1') && shardF.includes('Godsword shard 1'));
    const clueC = { clue_scrolls_hard: 100 };
    const clueItems = [{ id: 12624, quantity: 0 }];
    ok('dry views: clue drop quarantined to the Clues view',
      !namesIn(L.dryReport(clueC, clueItems, 'uniques')).length
        && namesIn(L.dryReport(clueC, clueItems, 'clues')).includes('Ancient page 4')
        && namesIn(L.dryReport(clueC, clueItems, 'full')).includes('Ancient page 4'));
    const barrU = namesIn(L.dryReport({ barrows_chests: 500 }, [{ id: 4708, quantity: 0 }], 'uniques'));
    const barrF = namesIn(L.dryReport({ barrows_chests: 500 }, [{ id: 4708, quantity: 0 }], 'full'));
    ok('dry views: Barrows hidden from Uniques, in Full clog',
      !barrU.includes("Ahrim's hood") && barrF.includes("Ahrim's hood"));
    const moonItems = [29000, 29004, 29007, 29010].map((id) => ({ id, quantity: 0 }));
    const moonU = namesIn(L.dryReport({ lunar_chests: 300 }, moonItems, 'uniques'));
    const moonF = namesIn(L.dryReport({ lunar_chests: 300 }, moonItems, 'full'));
    ok('dry views: Moons hidden from Uniques, in Full clog',
      !moonU.includes('Eclipse Moon armour') && moonF.includes('Eclipse Moon armour'));
    const kqU = namesIn(L.dryReport({ kalphite_queen: 300 }, [{ id: 7981, quantity: 0 }], 'uniques'));
    ok('dry views: KQ head stays legit', kqU.includes('Kq head'));
    const kbdU = namesIn(L.dryReport({ king_black_dragon: 300 }, [{ id: 7980, quantity: 0 }], 'uniques'));
    const kbdF = namesIn(L.dryReport({ king_black_dragon: 300 }, [{ id: 7980, quantity: 0 }], 'full'));
    ok('dry views: KBD heads out of Uniques, in Full clog',
      !kbdU.includes('Kbd heads') && kbdF.includes('Kbd heads'));
    // Teleports (Nov 4, 2026): drops whose job is getting
    // around score in Full clog but never headline.
    const zulU = namesIn(L.dryReport({ zulrah: 512 }, [{ id: 12938, quantity: 0 }], 'uniques'));
    const zulF = namesIn(L.dryReport({ zulrah: 512 }, [{ id: 12938, quantity: 0 }], 'full'));
    ok('dry views: Zul-andra teleport out of Uniques, in Full clog',
      !zulU.includes('Zul-andra teleport') && zulF.includes('Zul-andra teleport'));
    const cerbU = namesIn(L.dryReport({ cerberus: 512 }, [{ id: 13249, quantity: 0 }], 'uniques'));
    const cerbF = namesIn(L.dryReport({ cerberus: 512 }, [{ id: 13249, quantity: 0 }], 'full'));
    ok('dry views: Key master teleport out of Uniques, in Full clog',
      !cerbU.includes('Key master teleport') && cerbF.includes('Key master teleport'));
    ok('dry views: removed units are not scored at all',
      !L.scoredIds().has(25580) && !L.scoredIds().has(25582) && !L.scoredIds().has(20704)
        && L.dryReport({ 'plugin:reward_permits': 100 }, [{ id: 25580, quantity: 0 }]) === null
        && L.dryReport({ wintertodt: 500 },
          [20704, 20706, 20708, 20710].map((id) => ({ id, quantity: 0 }))) === null);
    // Immaculate mole skin (33382): a late-added drop whose
    // KC base predates it. It is dropped at table load, so
    // it scores in no view even when a refreshed table
    // carries the row; its Giant Mole neighbours still do.
    const moleItems = [{ id: 33382, quantity: 0 }, { id: 12646, quantity: 0 }];
    const moleViews = ['uniques', 'clues', 'full'].map((v) =>
      namesIn(L.dryReport({ giant_mole: 523 }, moleItems, v)));
    ok('dry views: immaculate mole skin is not scored in any view',
      !L.scoredIds().has(33382)
        && moleViews.every((ns) => !ns.includes('Immaculate mole skin')),
      moleViews.map((ns) => ns.join(',')).join(' | '));
    ok('dry views: baby mole still scores beside it',
      moleViews[0].includes('Baby mole') && moleViews[2].includes('Baby mole'));
    ok('dry views: a page of only the mole skin scores nothing',
      L.dryReport({ giant_mole: 523 }, [{ id: 33382, quantity: 0 }]) === null);
    // The list card itself: opens on Uniques with the three
    // view buttons; Full clog keeps its category buttons.
    const listU = await S.dryListPayload(PRIMARY, OWNER);
    ok('dry list opens on Uniques with the three view buttons',
      hasFile(listU)
        && ['Uniques', 'Clues', 'Full clog'].every((l) => flat(listU).some((c) => c.label === l))
        && flat(listU).some((c) => c.id.startsWith('dryview:uniques:')),
      listU && listU.content);
    const listF = await S.dryListPayload(PRIMARY, OWNER, 'full', 'all');
    ok('dry list Full clog keeps the category buttons',
      hasFile(listF) && flat(listF).some((c) => c.id.startsWith('drycat:Bosses:'))
        && flat(listF).some((c) => c.id.startsWith('dryview:full:')),
      listF && listF.content);
    const listC = await S.dryListPayload(PRIMARY, OWNER, 'clues');
    ok('dry list Clues view renders', hasFile(listC)
      && flat(listC).some((c) => c.id.startsWith('dryview:clues:')),
      listC && listC.content);
    const ixView = fakeIx('dryview:full:' + PRIMARY, [], OWNER);
    ixView.deferUpdate = async () => {};
    ixView.editReply = async (msg) => { ixView.last = msg; };
    await S.handleDryViewButton(ixView);
    ok('dry view button swaps the list in place',
      !!(ixView.last && ixView.last.files)
        && flat(ixView.last).some((c) => c.id.startsWith('drycat:')));
    const hubDry2 = await S.hubPayload(PRIMARY, OWNER, { tab: 'dry' });
    ok('hub Dry tab opens on Uniques with the three view buttons',
      hasFile(hubDry2)
        && ['Uniques', 'Clues', 'Full clog'].every((l) => flat(hubDry2).some((c) => c.label === l)),
      hubDry2 && hubDry2.content);
  }

  // ── P. Contribution-scaled boss rates (Nov 4, 2026):
  // Yama and the Hueycoatl scale unique rates by damage
  // share; the luck layer scores them at fixed team
  // strength (Yama duo x0.8, Hueycoatl 3-man x1/3) applied
  // in code over the published solo table. Pets roll flat
  // per player and keep their listed rates.
  {
    const RAW = require(path.join(__dirname, '..', 'src', 'luck-data.json'));
    const rawRate = (id) => RAW.items[String(id)].sources[0].rate;
    const row = (rep, name) => rep && rep.missing.find((m) => m.name === name);
    const helm = row(L.dryReport({ yama: 438 }, [{ id: 30750, quantity: 0 }], 'full'),
      'Oathplate helm');
    ok('scaled rates: Yama piece scores at the duo rate (1/750)',
      !!helm && Math.abs(helm.rate - rawRate(30750) * 0.8) < 1e-12
        && Math.abs(helm.rate - 1 / 750) < 1e-9,
      helm && String(helm.rate));
    const horn = row(L.dryReport({ yama: 438 }, [{ id: 30759, quantity: 0 }], 'full'),
      'Soulflame horn');
    ok('scaled rates: Yama horn scores at the duo rate (1/375)',
      !!horn && Math.abs(horn.rate - 1 / 375) < 1e-9,
      horn && String(horn.rate));
    const oldHornDry = 1 - L.binomCdfLE(438, rawRate(30759), 0);
    const oldHornScore = Math.round((1 - oldHornDry) * 50);
    ok('scaled rates: Yama horn is less dry than the solo table said',
      !!horn && horn.score > oldHornScore,
      horn && `${horn.score} vs solo-table ${oldHornScore}`);
    const yami = row(L.dryReport({ yama: 438 }, [{ id: 30888, quantity: 0 }], 'full'),
      'Yami');
    ok('scaled rates: Yami pet keeps its listed rate',
      !!yami && Math.abs(yami.rate - rawRate(30888)) < 1e-12,
      yami && String(yami.rate));
    const wand = row(L.dryReport({ the_hueycoatl: 62 }, [{ id: 30070, quantity: 0 }], 'full'),
      'Dragon hunter wand');
    ok('scaled rates: Huey wand scores at the 3-man rate (solo / 3)',
      !!wand && Math.abs(wand.rate - rawRate(30070) / 3) < 1e-12,
      wand && String(wand.rate));
    const hub = row(L.dryReport({ the_hueycoatl: 62 }, [{ id: 30152, quantity: 0 }], 'full'),
      'Huberte');
    ok('scaled rates: Huberte pet keeps its listed rate',
      !!hub && Math.abs(hub.rate - rawRate(30152)) < 1e-12,
      hub && String(hub.rate));
  }

  // ── Q. Luck tuning file (Nov 4, 2026): the rate
  // factors, pet exemptions, and unscored list read from
  // data/luck-tuning.json at load. A present file applies
  // (rateScale merges over the defaults); a malformed or
  // absent file falls back to the built-in defaults and
  // never throws. The live file is restored byte-for-byte
  // afterwards.
  {
    const RAW = require(path.join(__dirname, '..', 'src', 'luck-data.json'));
    const rawRate = (id) => RAW.items[String(id)].sources[0].rate;
    const luckPath = path.join(__dirname, '..', 'src', 'luck.js');
    const tunePath = path.join(DATA, 'luck-tuning.json');
    const row = (rep, name) => rep && rep.missing.find((m) => m.name === name);
    const hornOf = (mod) => row(mod.dryReport(
      { yama: 438 }, [{ id: 30759, quantity: 0 }], 'full'), 'Soulflame horn');
    const wandOf = (mod) => row(mod.dryReport(
      { the_hueycoatl: 62 }, [{ id: 30070, quantity: 0 }], 'full'), 'Dragon hunter wand');
    const freshLuck = () => {
      delete require.cache[require.resolve(luckPath)];
      return require(luckPath);
    };
    let saved = null;
    try { saved = fs.readFileSync(tunePath, 'utf8'); } catch { saved = null; }
    try {
      fs.writeFileSync(tunePath, JSON.stringify({ rateScale: { yama: 0.5 } }));
      const applied = freshLuck();
      const aHorn = hornOf(applied);
      const aWand = wandOf(applied);
      ok('tuning file: a present file applies its rate factor',
        !!aHorn && Math.abs(aHorn.rate - rawRate(30759) * 0.5) < 1e-12,
        aHorn && String(aHorn.rate));
      ok('tuning file: rateScale merges over the defaults',
        !!aWand && Math.abs(aWand.rate - rawRate(30070) / 3) < 1e-12
          && !applied.scoredIds().has(33382),
        aWand && String(aWand.rate));
      fs.writeFileSync(tunePath, 'not json{{{');
      let malformed = null; let threw = false;
      try { malformed = freshLuck(); } catch { threw = true; }
      const mHorn = malformed && hornOf(malformed);
      ok('tuning file: a malformed file falls back to defaults, never throws',
        !threw && !!mHorn && Math.abs(mHorn.rate - 1 / 375) < 1e-9
          && !malformed.scoredIds().has(33382),
        threw ? 'threw' : (mHorn && String(mHorn.rate)));
      fs.rmSync(tunePath, { force: true });
      const absent = freshLuck();
      const nHorn = hornOf(absent);
      ok('tuning file: an absent file falls back to defaults',
        !!nHorn && Math.abs(nHorn.rate - 1 / 375) < 1e-9
          && !absent.scoredIds().has(33382),
        nHorn && String(nHorn.rate));
    } finally {
      if (saved === null) fs.rmSync(tunePath, { force: true });
      else fs.writeFileSync(tunePath, saved);
      freshLuck();
    }
  }

  // Application pre-link flow (Nov 5, 2026; reworked Nov 6, 2026):
  // the account type pick before the form, the RSN check at submit,
  // the confirm screen, the RSN-only fix modal, the approval
  // pre-link, and the under-30 join flag. Pure and payload checks
  // only: the live decision matrix (verified-other skip, unchecked
  // retry) writes link data, so it runs in an isolated data sandbox
  // pre-deploy, not against the live caches here.
  {
    const R = require(path.join(__dirname, '..', 'src', 'recruit.js'));
    const U = require(path.join(__dirname, '..', 'src', 'utils.js'));
    const recruitSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'recruit.js'), 'utf8');
    const indexSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.js'), 'utf8');
    const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config.json'), 'utf8'));

    // Age ask is gone: no select step, no config question, no routing.
    ok('prelink: age select step removed', !recruitSrc.includes('showAgeSelect') && !recruitSrc.includes('apply:age:'));
    ok('prelink: index no longer routes apply:age:', !indexSrc.includes('apply:age:') && !indexSrc.includes('handleAgeSelect'));
    const typeQs = Object.values(cfg.recruit.types).map((t) => (t.questions || []).map((q) => q.id));
    ok('prelink: config has no age question', typeQs.every((ids) => !ids.includes('age')), JSON.stringify(typeQs));
    ok('prelink: modal fields are rsn, nickname, heard', typeQs.every((ids) => JSON.stringify(ids) === JSON.stringify(['rsn', 'nickname', 'heard'])), JSON.stringify(typeQs));

    // Staff card: house red always, Link state field present.
    ok('prelink: orange age flip removed', !recruitSrc.includes('0xffa500'));
    ok('prelink: card colour is always house red', recruitSrc.includes('setColor(ZAMORAK_RED)'));
    ok('prelink: link state field on the card', recruitSrc.includes("name: 'Link state'") && recruitSrc.includes('linkStateFieldText'));

    // RSN parser: commas and slashes, dedupe, cap of 5.
    ok('prelink: parser splits commas and slashes', JSON.stringify(R.parseRsnList('A One, B Two / a one')) === JSON.stringify(['A One', 'B Two']));
    ok('prelink: parser caps at 5 names', R.parseRsnList('a,b,c,d,e,f').length === 5);

    // The WOM check with a stubbed lookup: found, missing, partial, error.
    const stub = async (name) => {
      const k = name.toLowerCase();
      if (k === 'found name') return { combat: 80, displayName: 'Found Name', username: 'found name' };
      if (k === 'err name') return null;
      return { notFound: true };
    };
    const cAll = await R.checkApplicationRsns(['found name'], stub);
    ok('prelink: found name carries WOM spelling', cAll.found.length === 1 && cAll.found[0].canonical === 'Found Name');
    const cNone = await R.checkApplicationRsns(['ghost name'], stub);
    ok('prelink: missing name drops as notFound', cNone.found.length === 0 && cNone.dropped[0].reason === 'notFound');
    const nf = R.notFoundPayload('ghost name', 'iron', cNone.dropped);
    ok('prelink: not-found stop uses the approved line', nf.content === 'That name is not on Wise Old Man: **ghost name**\nCheck the spelling. Nothing has been sent to staff.', nf.content);
    ok('prelink: not-found stop carries the fix name button',
      JSON.stringify(nf.components.map((r) => r.toJSON())).includes('apply:fixname'));
    const cInv = await R.checkApplicationRsns(['bad!name'], stub);
    ok('prelink: shape-bad name drops as invalid', cInv.found.length === 0 && cInv.dropped[0].reason === 'invalid');
    const nfInv = R.notFoundPayload('bad!name', 'iron', cInv.dropped);
    ok('prelink: invalid stop uses the approved line', nfInv.content === 'RuneScape names cannot use those characters: **bad!name**\nNothing has been sent to staff.', nfInv.content);
    const cPart = await R.checkApplicationRsns(['found name', 'ghost name'], stub);
    ok('prelink: partial drop state', R.linkStateOf(cPart) === 'partial' && R.linkStateFieldText('partial', 1) === 'Partial: 1 name(s) dropped at check');
    const cErr = await R.checkApplicationRsns(['err name'], stub);
    ok('prelink: WOM error goes forward unchecked', cErr.found.length === 1 && cErr.found[0].verified === false && R.linkStateOf(cErr) === 'unchecked');

    // Confirm screen: the double ask carries its buttons and the
    // approved copy, including the dropped and unchecked variants.
    const cp = R.confirmPayload({ found: cAll.found, dropped: [], linkState: 'verified' });
    const cpJson = JSON.stringify(cp.components.map((r) => r.toJSON()));
    ok('prelink: confirm and fix buttons routed', cpJson.includes('apply:confirm') && cpJson.includes('apply:fixname'));
    ok('prelink: confirm screen shows the name', cp.content.includes('**Found Name**'));
    ok('prelink: confirm screen uses the approved copy', cp.content.includes('Your name, as Wise Old Man spells it:')
      && cp.content.includes('If staff approve you, this name is linked to your Discord. Your account type is set from your pick.'), cp.content);
    ok('prelink: confirm buttons carry emojis', cpJson.includes('✅') && cpJson.includes('✏️'));
    const cpDrop = R.confirmPayload({ found: cAll.found, dropped: cPart.dropped, linkState: 'partial' });
    ok('prelink: confirm screen names dropped names', cpDrop.content.includes('Not going forward: ghost name. You can add them later with Link RSN.'), cpDrop.content);
    const cpUnchecked = R.confirmPayload({ found: cErr.found, dropped: [], linkState: 'unchecked' });
    ok('prelink: unchecked confirm uses the approved line', cpUnchecked.content.includes('Wise Old Man did not answer, so your names go to staff as typed, marked unchecked.')
      && !cpUnchecked.content.includes('Your account type is set from your pick.'), cpUnchecked.content);

    // Account type pick (Nov 6, 2026): buttons before the form. Iron
    // applications get the kind-of-iron screen; guests get the game
    // mode screen first, Ironman before Main. Badge pick ids are the
    // teams BADGES ids.
    ok('prelink: badge ids cover the iron family and main',
      JSON.stringify(T.BADGES.map((b) => b.id)) === JSON.stringify(['ironman', 'hc', 'ult', 'gim', 'ugim', 'hcgim', 'main']),
      JSON.stringify(T.BADGES.map((b) => b.id)));
    const mp = R.modePickPayload();
    const mpJson = JSON.stringify(mp.components.map((r) => r.toJSON()));
    ok('prelink: iron pick screen asks the approved question', mp.content === 'What kind of iron are you?', mp.content);
    const pickLabels = ['"label":"Ironman"', '"label":"Hardcore Ironman"', '"label":"Ultimate Ironman"', '"label":"Group Ironman"', '"label":"Unranked Group Ironman"', '"label":"Hardcore Group Ironman"', '"label":"Not sure"'];
    ok('prelink: iron pick offers full names in order',
      pickLabels.every((s, i) => mpJson.indexOf(s) > -1 && (i === 0 || mpJson.indexOf(s) > mpJson.indexOf(pickLabels[i - 1]))), mpJson);
    ok('prelink: iron pick carries the server mode icons',
      ['1558644677886869604', '1558644444654473256', '1558644481350303874', '1558644518184685628', '1558644555182768259', '1558644592352436344'].every((id) => mpJson.includes(id)), mpJson);
    ok('prelink: iron pick routes every badge id plus auto',
      ['ironman', 'hc', 'ult', 'gim', 'ugim', 'hcgim', 'auto'].every((id) => mpJson.includes(`apply:pick:${id}`)), mpJson);
    const gk = R.guestKindPayload();
    const gkJson = JSON.stringify(gk.components.map((r) => r.toJSON()));
    ok('prelink: guest pick screen asks the approved question', gk.content === 'What game mode do you play?', gk.content);
    ok('prelink: guest pick puts Ironman before Main',
      gkJson.indexOf('apply:pickkind:ironman') > -1 && gkJson.indexOf('apply:pickkind:main') > gkJson.indexOf('apply:pickkind:ironman'), gkJson);
    ok('prelink: guest pick carries the mode emojis', gkJson.includes(cfg.recruit.ironEmojiId) && gkJson.includes(cfg.recruit.mainEmojiId), gkJson);
    ok('prelink: post-form type asks are gone', !recruitSrc.includes('apply:kind:') && !recruitSrc.includes('apply:flavour:') && !recruitSrc.includes('apply:restart:') && !recruitSrc.includes('One more ask'));
    ok('prelink: approved flow copy in place', recruitSrc.includes('You already have an application in. Staff will get to it.')
      && recruitSrc.includes('That step timed out. Start again from the application panel.')
      && recruitSrc.includes('Application sent. Staff will review it.'));

    // The fix modal is RSN-only and prefilled; the form modal keeps
    // its three fields. The record badge honours the up-front pick
    // and never applies one to an unchecked application.
    const fixModal = R.buildFixModal('iron', 'ghost name').toJSON();
    ok('prelink: fix modal is RSN-only', fixModal.components.length === 1 && fixModal.components[0].components.length === 1 && fixModal.components[0].components[0].custom_id === 'rsn', JSON.stringify(fixModal));
    ok('prelink: fix modal prefills the typed name', fixModal.components[0].components[0].value === 'ghost name');
    const formModal = R.buildFormModal('iron').toJSON();
    ok('prelink: form modal keeps rsn, nickname, heard', formModal.components.length === 3 && formModal.custom_id === 'apply:modal:iron:none', String(formModal.custom_id));
    ok('prelink: main records main without a pick', R.recordBadgeFor({ type: 'main', linkState: 'verified', badgePicked: false, badge: null }) === 'main');
    ok('prelink: the up-front pick applies to the record', R.recordBadgeFor({ type: 'iron', linkState: 'verified', badgePicked: true, badge: 'hc' }) === 'hc');
    ok('prelink: Not sure stores no badge', R.recordBadgeFor({ type: 'guest', linkState: 'partial', badgePicked: true, badge: null }) === null);
    ok('prelink: unchecked applies no badge', R.recordBadgeFor({ type: 'iron', linkState: 'unchecked', badgePicked: true, badge: 'hc' }) === null
      && R.recordBadgeFor({ type: 'main', linkState: 'unchecked', badgePicked: false, badge: null }) === null);

    // Emoji dedupe (Nov 6, 2026): bounty buttons use the kept
    // zamoraksymbol; the duplicate zamorak id is gone from source.
    const bountySrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'bounty.js'), 'utf8');
    ok('emoji: bounty buttons use the kept zamoraksymbol', bountySrc.includes("id: '1559104599032594442', name: 'zamoraksymbol'") && !bountySrc.includes('1558477037537329182'));

    // Pre-link decision order in source: the verified-owner check
    // runs before any link write, and failures post to the thread.
    const preStart = recruitSrc.indexOf('async function runApprovalPrelink');
    const preEnd = recruitSrc.indexOf('function approvalDmText');
    const preSrc = recruitSrc.slice(preStart, preEnd);
    ok('prelink: verified owner checked before linking', preSrc.indexOf('verifiedOwnerOf(rsn)') > -1 && preSrc.indexOf('verifiedOwnerOf(rsn)') < preSrc.indexOf('addRsn(userId, rsn)'));
    ok('prelink: failures are logged with the tag', preSrc.includes('[recruit-prelink]'));
    ok('prelink: staff notice goes to the application thread', recruitSrc.includes('Approval still went through.'));
    ok('prelink: first listed name set active after linking', preSrc.includes('setActiveRsn(userId, pre.names[0].name)'));

    // Approval DM variants.
    ok('prelink: DM says linked when all link', R.approvalDmText({ attempted: true, linked: ['Found Name'], failed: [] }).includes('Your names are already linked and their types are set: Found Name.'));
    ok('prelink: DM is honest on failure', R.approvalDmText({ attempted: true, linked: [], failed: [{ rsn: 'Found Name', reason: 'x' }] }).includes('Your link needs a hand for: Found Name.'));
    ok('prelink: legacy DM unchanged without a record', R.approvalDmText({ attempted: false, linked: [], failed: [] }) === '⛧ Welcome to Oath Forsaken ⛧\n\nYour application was approved.');

    // Welcome posts: linked members are not told to link.
    ok('prelink: initiate welcome swaps the link bullet', U.buildInitiateWelcome('111', ['Found Name']).includes('Your names are already linked: Found Name')
      && U.buildInitiateWelcome('111').includes('Hit **Link RSN**'));
    ok('prelink: guest welcome only adds the line when linked', U.buildGuestWelcome('111', ['Found Name']).includes('Your names are already linked: Found Name')
      && !U.buildGuestWelcome('111').includes('already linked'));

    // Join flag age math: 29 days flags, 30 does not.
    const nowMs = Date.UTC(2026, 10, 5);
    const mkUser = (days) => ({ id: '42', tag: 'newbie', createdAt: new Date(nowMs - days * 86400000) });
    ok('prelink: join flag fires at 29 days', !!R.youngAccountFlag(mkUser(29), nowMs));
    ok('prelink: join flag silent at 30 days', R.youngAccountFlag(mkUser(30), nowMs) === null);
    ok('prelink: join flag text', R.youngAccountFlag(mkUser(3), nowMs).text === 'New account flagged: <@42> (newbie). Discord account is 3 days old, under the 30 day mark. Flagged at join.');
    ok('prelink: join flag wired in the join handler', indexSrc.includes('youngAccountFlag(member.user)'));
  }

  // CC checklist Initiate entries (Nov 6, 2026): approvals and
  // seniority first assignments both queue a None -> Initiate
  // entry, so staff set the in-game CC rank for new members too.
  // Wiring checks only: addEntry writes the live checklist file
  // and posts to the checklist thread, so it stays out of this
  // read-only sweep.
  {
    const recruitSrc3 = fs.readFileSync(path.join(__dirname, '..', 'src', 'recruit.js'), 'utf8');
    const senioritySrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'seniority.js'), 'utf8');
    ok('ccinit: recruit imports the checklist addEntry', recruitSrc3.includes("require('./cc-checklist')"));
    // The checklist call must sit in the non-guest tenure block,
    // after the tenure role add.
    const tenureAt = recruitSrc3.indexOf("if (type !== 'guest') {");
    const roleAddAt = recruitSrc3.indexOf("'New member tenure rank'", tenureAt);
    const ccCallAt = recruitSrc3.indexOf("addCcEntry(guild, target.id, 'None', 'Initiate')", tenureAt);
    ok('ccinit: approval queues a None -> Initiate entry after the tenure role add',
      tenureAt >= 0 && roleAddAt > tenureAt && ccCallAt > roleAddAt);
    ok('ccinit: seniority first assignments include Initiate', !senioritySrc.includes("newRankName !== 'Initiate'"));
  }

  // Recorded membership standing (Nov 6, 2026 ruling): approval is
  // the membership decision and gets recorded in data/membership.json;
  // the seniority sync reads that record alongside the WOM group list
  // and never strips or deranks anyone. The store, the backfill seed,
  // and a dry-run sync run here against fixture data files with fake
  // ids and names; every file the fixtures touch is restored byte for
  // byte afterwards, and the module caches are reset so later checks
  // see the real data again.
  {
    const storeM = require(path.join(__dirname, '..', 'src', 'store.js'));
    const membershipM = require(path.join(__dirname, '..', 'src', 'membership.js'));
    const cfgM = require(path.join(__dirname, '..', 'src', 'config.js'));
    const { MONTH_MS } = require(path.join(__dirname, '..', 'src', 'utils.js'));
    const RIDS = cfgM.seniority.rankIds;
    const GID = cfgM.guildId;
    const recruitSrc4 = fs.readFileSync(path.join(__dirname, '..', 'src', 'recruit.js'), 'utf8');
    const senioritySrc4 = fs.readFileSync(path.join(__dirname, '..', 'src', 'seniority.js'), 'utf8');
    const indexSrc4 = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.js'), 'utf8');

    // Wiring: the approval path writes standing once (denials write
    // nothing), after the role grants; the sync has no strip path or
    // grace window left; startup seeds standing before the first sync.
    ok('standing: approval records standing through the store',
      recruitSrc4.includes("store.setMembershipStanding(guild.id, userId, type === 'guest' ? 'guest' : 'member', 'approval')"));
    ok('standing: exactly one standing write in recruit (denials record nothing)',
      (recruitSrc4.match(/setMembershipStanding\(/g) || []).length === 1);
    ok('standing: the standing write sits after the approval role grants',
      recruitSrc4.indexOf('setMembershipStanding(') > recruitSrc4.indexOf("'New member tenure rank'"));
    ok('standing: sync strip path and grace window are gone',
      !senioritySrc4.includes('strip seniority') && !senioritySrc4.includes('GRACE_MS'));
    const seedAt = indexSrc4.indexOf('await seedMembership(client)');
    const firstSyncAt = indexSrc4.indexOf('await syncSeniority(client)');
    ok('standing: startup seeds standing before the first sync', seedAt >= 0 && firstSyncAt > seedAt);

    // Snapshot every data file the fixtures touch.
    const touched = ['wom-group.json', 'rsn-links.json', 'tenure.json', 'membership.json', 'seniority-holds.json'];
    const saved = {};
    for (const name of touched) {
      const p = path.join(DATA, name);
      saved[name] = fs.existsSync(p) ? fs.readFileSync(p) : null;
    }
    const writeFixture = (name, obj) => fs.writeFileSync(path.join(DATA, name), JSON.stringify(obj));
    const restoreAll = () => {
      for (const name of touched) {
        const p = path.join(DATA, name);
        if (saved[name] === null) { try { fs.unlinkSync(p); } catch {} }
        else fs.writeFileSync(p, saved[name]);
      }
    };

    const U = {
      womMember: '990000000000000101',
      rankHolder: '990000000000000102',
      plainGuest: '990000000000000103',
      nonMemberRank: '990000000000000104',
      memberHigh: '990000000000000105',
      memberLow: '990000000000000106',
      memberAsc: '990000000000000107',
      memberFirst: '990000000000000108',
      recordMember: '990000000000000109',
      recordGuest: '990000000000000110',
    };
    try {
      writeFixture('wom-group.json', [
        { rsn: 'Fake Wom' }, { rsn: 'Fake High' }, { rsn: 'Fake Low' },
        { rsn: 'Fake Asc' }, { rsn: 'Fake First' },
      ]);
      writeFixture('rsn-links.json', {
        [U.womMember]: { rsns: ['Fake Wom'] },
        [U.memberHigh]: { rsns: ['Fake High'] },
        [U.memberLow]: { rsns: ['Fake Low'] },
        [U.memberAsc]: { rsns: ['Fake Asc'] },
        [U.memberFirst]: { rsns: ['Fake First'] },
      });
      writeFixture('seniority-holds.json', {});
      writeFixture('membership.json', {});

      // (e) Store round-trip: the exact write the approval path makes,
      // under a throwaway guild so no real record set is disturbed.
      const TG = '990000000000009999';
      ok('standing: unknown guild reads as an empty record set',
        Object.keys(storeM.getMembership(TG)).length === 0);
      storeM.setMembershipStanding(TG, U.womMember, 'member', 'approval');
      storeM.setMembershipStanding(TG, U.plainGuest, 'guest', 'approval');
      const roundTrip = storeM.getMembership(TG);
      ok('standing: member approval writes a member record',
        !!roundTrip[U.womMember] && roundTrip[U.womMember].standing === 'member'
        && roundTrip[U.womMember].via === 'approval' && typeof roundTrip[U.womMember].at === 'number',
        JSON.stringify(roundTrip[U.womMember]));
      ok('standing: guest approval writes a guest record',
        !!roundTrip[U.plainGuest] && roundTrip[U.plainGuest].standing === 'guest'
        && roundTrip[U.plainGuest].via === 'approval');

      // (f) Backfill seed: WOM-derived members and current rank
      // holders become recorded members; a plain guest does not; an
      // existing record set is never overwritten.
      writeFixture('membership.json', {});
      const seededCount = membershipM.seedBackfill(GID, [U.rankHolder]);
      const seededMap = storeM.getMembership(GID);
      ok('standing: backfill seeds the WOM-derived member',
        seededCount >= 2 && !!seededMap[U.womMember] && seededMap[U.womMember].standing === 'member'
        && seededMap[U.womMember].via === 'backfill', JSON.stringify(Object.keys(seededMap)));
      ok('standing: backfill seeds a rank holder who is not on the WOM list',
        !!seededMap[U.rankHolder] && seededMap[U.rankHolder].standing === 'member'
        && seededMap[U.rankHolder].via === 'backfill');
      ok('standing: backfill leaves a plain guest unrecorded', !(U.plainGuest in seededMap));
      writeFixture('membership.json', {
        [GID]: { [U.plainGuest]: { standing: 'guest', at: 1, via: 'approval' } },
      });
      const reseeded = membershipM.seedBackfill(GID, [U.rankHolder]);
      const afterReseed = storeM.getMembership(GID);
      ok('standing: backfill never overwrites an existing record set',
        reseeded === 0 && Object.keys(afterReseed).length === 1
        && afterReseed[U.plainGuest].standing === 'guest');

      // (a)-(d) Dry-run sync over fake guild members. Tenure and
      // seniority are re-required fresh so the tenure module reads
      // the fixture ledger instead of any cached live one.
      writeFixture('membership.json', {
        [GID]: {
          [U.recordMember]: { standing: 'member', at: 1, via: 'approval' },
          [U.recordGuest]: { standing: 'guest', at: 1, via: 'approval' },
        },
      });
      writeFixture('tenure.json', {
        users: {
          [U.memberLow]: { bankedMs: 4 * MONTH_MS, stretchStart: null, stretches: [] },
          [U.recordMember]: { bankedMs: 4 * MONTH_MS, stretchStart: null, stretches: [] },
        },
        seededAt: 'fixture',
      });
      const roleCalls = [];
      const mkMember = (id, heldIds) => {
        const held = new Set(heldIds);
        return {
          id,
          user: { id, bot: false, tag: `fake${id.slice(-3)}` },
          joinedTimestamp: Date.now() - 40 * 86400000,
          roles: {
            cache: { has: (rid) => held.has(rid) },
            add: async (rid) => { roleCalls.push(['add', id, rid]); },
            remove: async (rid) => { roleCalls.push(['remove', id, rid]); },
          },
        };
      };
      const fakeMembers = [
        mkMember(U.womMember, [RIDS.initiate]),
        mkMember(U.rankHolder, [RIDS.devout]),
        mkMember(U.plainGuest, []),
        mkMember(U.nonMemberRank, [RIDS.devout]),
        mkMember(U.memberHigh, [RIDS.devout]),
        mkMember(U.memberLow, [RIDS.initiate]),
        mkMember(U.memberAsc, [RIDS.ascendant]),
        mkMember(U.memberFirst, []),
        mkMember(U.recordMember, [RIDS.initiate]),
        mkMember(U.recordGuest, [RIDS.acolyte]),
      ];
      const fakeGuild = {
        id: GID,
        members: { fetch: async () => new Map(fakeMembers.map((m) => [m.id, m])) },
        channels: { cache: { get: () => null } },
      };
      const fakeClient = { guilds: { cache: { get: (id) => (id === GID ? fakeGuild : null) } } };
      const tenurePath = require.resolve(path.join(__dirname, '..', 'src', 'tenure.js'));
      const seniorityPath = require.resolve(path.join(__dirname, '..', 'src', 'seniority.js'));
      delete require.cache[tenurePath];
      delete require.cache[seniorityPath];
      const SEN = require(seniorityPath);
      require(path.join(__dirname, '..', 'src', 'guild-cache.js')).invalidateCache();
      const changes = await SEN.syncSeniority(fakeClient, { dryRun: true });
      const joined = changes.join('\n');
      const entryFor = (id) => changes.find((c) => c.startsWith(`fake${id.slice(-3)}:`));
      ok('standing: (a) a non-member holding a rank is not stripped',
        !entryFor(U.nonMemberRank) && !joined.includes('strip') && roleCalls.length === 0,
        joined || '(no changes)');
      ok('standing: (b) a member above their tenure rank is left untouched',
        !entryFor(U.memberHigh), joined);
      ok('standing: (c) a member below their tenure rank is swapped up only',
        entryFor(U.memberLow) === `fake${U.memberLow.slice(-3)}: Initiate → Devout`, joined);
      ok('standing: (d) an Ascendant holder is untouched', !entryFor(U.memberAsc), joined);
      ok('standing: a recorded member not on the WOM list still ranks up',
        entryFor(U.recordMember) === `fake${U.recordMember.slice(-3)}: Initiate → Devout`, joined);
      ok('standing: a recorded guest is skipped, rank and all',
        !entryFor(U.recordGuest), joined);
      ok('standing: a member with no rank gets the first assignment',
        entryFor(U.memberFirst) === `fake${U.memberFirst.slice(-3)}: None → Initiate (initial)`, joined);
      // Reset the module caches so later checks bind to the real data.
      delete require.cache[tenurePath];
      delete require.cache[seniorityPath];
      require(seniorityPath);
    } finally {
      restoreAll();
    }
  }

  // Staff RSN link (Nov 6, 2026): the staff-chat repair panel and
  // the website request merge's quiet flag. The check pipeline and
  // the merge run against fixtures and a scratch folder with
  // recording writers: the sweep stays read-only against live data
  // while still proving which writer each path lands on. Fake ids
  // and names throughout, per the repo rule.
  {
    const SL = require(path.join(__dirname, '..', 'src', 'staff-link.js'));
    const LR = require(path.join(__dirname, '..', 'src', 'link-requests.js'));
    const slSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'staff-link.js'), 'utf8');
    const lrSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'link-requests.js'), 'utf8');
    const indexSrc2 = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.js'), 'utf8');
    const buttonsSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'buttons.js'), 'utf8');

    // Panel: one Danger button with the exact label, house red.
    const panel = SL.panelPayload();
    const panelJson = JSON.stringify(panel.components.map((r) => r.toJSON()));
    ok('stafflink: panel button is labelled Link an RSN', panelJson.includes('"label":"Link an RSN"') && panelJson.includes('stafflink:open'), panelJson);
    ok('stafflink: panel button is Danger', panelJson.includes('"style":4'), panelJson);
    ok('stafflink: panel embed is house red', panel.embeds[0].data.color === 0x6b0e0e);
    ok('stafflink: button routed in buttons.js', buttonsSrc.includes("kind === 'stafflink'"));
    ok('stafflink: user select and modal routed in index.js',
      indexSrc2.includes('stafflink:member') && indexSrc2.includes("modalKind === 'stafflink'"));
    ok('stafflink: command registered', SL.commands.some((c) => c.data.name === 'link-rsn-panel'));

    // Wiring rules in source: the gate is the shared staff helper
    // on every surface, and the only link writer named is the
    // quiet one (addRsn must never appear in the module).
    ok('stafflink: staff gate on command, button, select, modal',
      (slSrc.match(/isStaff\(interaction\)/g) || []).length >= 4);
    ok('stafflink: writes only through linkRsnQuiet', slSrc.includes('linkRsnQuiet(targetId, check.rsn)') && !slSrc.includes('addRsn('));
    ok('stafflink: audit line posts to the mod-log', slSrc.includes('config.channels.modLog') && slSrc.includes('Staff link:'));

    // Panel home: the configured thread wins; with no thread
    // configured the panel falls back to the staff chat channel.
    const homeChannels = {
      '333333333': { id: '333333333' },
      '444444444': { id: '444444444' },
    };
    const homeGuild = { channels: { cache: { get: (id) => homeChannels[id] || null } } };
    ok('stafflink: panel home is the thread when one is configured',
      SL.panelHome(homeGuild, { staffLink: { threadId: '444444444' }, ccChecklist: { staffChatId: '333333333' } })?.id === '444444444');
    ok('stafflink: panel home falls back to staff chat with no thread configured',
      SL.panelHome(homeGuild, { ccChecklist: { staffChatId: '333333333' } })?.id === '333333333');

    // Check pipeline with fixtures, in the ruled order.
    const fxLinks = {
      '111111111': { rsns: ['Target Main'], active: 'Target Main', verified: [], womIds: {} },
      '222222222': { rsns: ['Other Name'], active: 'Other Name', verified: ['Claimed Name'], womIds: {} },
    };
    const fxStats = async (name) => {
      const k = name.toLowerCase();
      if (k === 'new name') return { displayName: 'New Name', username: 'new name' };
      if (k === 'err name') return null;
      return { notFound: true };
    };
    const fxVOwner = (rsn) => (rsn.toLowerCase() === 'claimed name' ? '222222222' : null);
    const fxBase = { targetId: '111111111', links: fxLinks, statsFn: fxStats, verifiedOwnerFn: fxVOwner };
    let chk = await SL.checkStaffLink({ ...fxBase, rawRsn: 'bad!name' });
    ok('stafflink: shape-bad name refused', !chk.ok && chk.code === 'shape', JSON.stringify(chk));
    chk = await SL.checkStaffLink({ ...fxBase, rawRsn: 'waytoolongname' });
    ok('stafflink: overlong name refused on shape', !chk.ok && chk.code === 'shape');
    chk = await SL.checkStaffLink({ ...fxBase, rawRsn: 'Claimed Name' });
    ok('stafflink: verified owner refusal', !chk.ok && chk.code === 'verified', JSON.stringify(chk));
    chk = await SL.checkStaffLink({ ...fxBase, rawRsn: 'Other Name' });
    ok('stafflink: name linked to another member refused', !chk.ok && chk.code === 'owned', JSON.stringify(chk));
    chk = await SL.checkStaffLink({ ...fxBase, rawRsn: 'target  main' });
    ok('stafflink: already linked to the target is a no-op', !chk.ok && chk.code === 'already', JSON.stringify(chk));
    chk = await SL.checkStaffLink({ ...fxBase, rawRsn: 'Ghost Name' });
    ok('stafflink: name missing on Wise Old Man refused', !chk.ok && chk.code === 'missing', JSON.stringify(chk));
    chk = await SL.checkStaffLink({ ...fxBase, rawRsn: 'Err Name' });
    ok('stafflink: Wise Old Man unreachable refused, never unchecked', !chk.ok && chk.code === 'unreachable', JSON.stringify(chk));
    chk = await SL.checkStaffLink({ ...fxBase, rawRsn: '  New   Name ' });
    ok('stafflink: found name passes with the Wise Old Man spelling', chk.ok && chk.rsn === 'New Name', JSON.stringify(chk));

    // Check order: shape beats verified, verified beats the WOM
    // lookup (the stub would call the name missing).
    chk = await SL.checkStaffLink({ ...fxBase, rawRsn: 'claimed!' });
    ok('stafflink: shape is checked first', !chk.ok && chk.code === 'shape');
    chk = await SL.checkStaffLink({ ...fxBase, rawRsn: 'Claimed Name', statsFn: async () => ({ notFound: true }) });
    ok('stafflink: verified is checked before Wise Old Man', !chk.ok && chk.code === 'verified');

    // Quiet-flag merge: recording writers prove the routing, and
    // the writers' own source proves the active-name behaviour
    // (quiet never moves an existing active; addRsn sets it).
    const os = require('os');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'smoke-linkreq-'));
    const calls = [];
    const deps = {
      dir,
      addRsn: (did, rsn) => calls.push(['add', did, rsn]),
      linkRsnQuiet: (did, rsn) => calls.push(['quiet', did, rsn]),
      verifiedOwnerOf: (rsn) => (rsn === 'Claimed Name' ? '222222222' : null),
    };
    fs.writeFileSync(path.join(dir, 'a.json'), JSON.stringify({ discordId: '123456789', rsn: 'Quiet Name', quiet: true }));
    fs.writeFileSync(path.join(dir, 'b.json'), JSON.stringify({ discordId: '123456789', rsn: 'Loud Name' }));
    fs.writeFileSync(path.join(dir, 'c.json'), JSON.stringify({ discordId: '123456789', rsn: 'False Name', quiet: false }));
    fs.writeFileSync(path.join(dir, 'd.json'), JSON.stringify({ discordId: '123456789', rsn: 'Claimed Name', quiet: true }));
    const merged = LR.mergeSiteLinkRequests(deps);
    ok('stafflink: merge applied the three valid requests', merged === 3, String(merged));
    ok('stafflink: quiet request applies linkRsnQuiet', JSON.stringify(calls[0]) === JSON.stringify(['quiet', '123456789', 'Quiet Name']), JSON.stringify(calls));
    ok('stafflink: flagless request still applies addRsn', JSON.stringify(calls[1]) === JSON.stringify(['add', '123456789', 'Loud Name']));
    ok('stafflink: quiet false still applies addRsn', JSON.stringify(calls[2]) === JSON.stringify(['add', '123456789', 'False Name']));
    ok('stafflink: verified-to-another request dropped, quiet or not', calls.length === 3 && fs.readdirSync(dir).length === 0);
    fs.rmSync(dir, { recursive: true, force: true });
    const teamsSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'teams.js'), 'utf8');
    const quietBody = teamsSrc.slice(teamsSrc.indexOf('function linkRsnQuiet'), teamsSrc.indexOf('function setActiveRsn'));
    const addBody = teamsSrc.slice(teamsSrc.indexOf('function addRsn'), teamsSrc.indexOf('function linkRsnQuiet'));
    ok('stafflink: linkRsnQuiet leaves an existing active name alone',
      !/^\s*entry\.active = rsn;/m.test(quietBody) && quietBody.includes('if (!entry.active) entry.active = rsn;'), quietBody.slice(0, 200));
    ok('stafflink: addRsn moves the active name', /^\s*entry\.active = rsn;/m.test(addBody));
    ok('stafflink: merge routes quiet in source', lrSrc.includes('req.quiet === true') && lrSrc.includes('applyQuiet(did, rsn)'));
  }

  // Not in the Clan Yet marker (Nov 6, 2026): granted on join beside
  // the Oath Forsakers role, removed on approval, and removed by the
  // member-update watch when any standing role lands. The predicate
  // matrix runs on config role ids; the wiring checks read source.
  {
    const NC = require(path.join(__dirname, '..', 'src', 'not-in-clan.js'));
    const cfgN = require(path.join(__dirname, '..', 'src', 'config.js'));
    const indexSrcN = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.js'), 'utf8');
    const recruitSrcN = fs.readFileSync(path.join(__dirname, '..', 'src', 'recruit.js'), 'utf8');
    const marker = '1568425058823569468';

    ok('notinclan: config carries the marker role id', cfgN.roles?.notInClanYetId === marker && NC.markerRoleId() === marker);
    const standing = NC.standingRoleIds();
    ok('notinclan: standing set covers every family',
      Object.values(cfgN.recruit.types).every((t) => standing.has(t.roleId))
        && Object.values(cfgN.seniority.rankIds).every((id) => standing.has(id))
        && standing.has(cfgN.seniority.friendOfClanRoleId)
        && cfgN.tickets.staffRoleIds.every((id) => standing.has(id)),
      [...standing].join(','));

    // Predicate matrix: marker+standing → true for one id drawn from
    // each standing family; every other shape → false.
    const fam = {
      'application type': cfgN.recruit.types.iron.roleId,
      'seniority ladder': cfgN.seniority.rankIds.ascendant,
      'friend of the clan': cfgN.seniority.friendOfClanRoleId,
      'staff': cfgN.tickets.staffRoleIds[0],
    };
    for (const [name, id] of Object.entries(fam)) {
      ok(`notinclan: watch fires with ${name} standing`,
        NC.shouldRemoveMarker({ isBot: false, roleIds: new Set([marker, id]) }) === true);
    }
    ok('notinclan: marker alone does not fire',
      NC.shouldRemoveMarker({ isBot: false, roleIds: new Set([marker]) }) === false);
    ok('notinclan: standing alone does not fire (marker already gone)',
      NC.shouldRemoveMarker({ isBot: false, roleIds: new Set([fam['seniority ladder']]) }) === false);
    ok('notinclan: bot user never fires',
      NC.shouldRemoveMarker({ isBot: true, roleIds: new Set([marker, fam.staff]) }) === false);
    ok('notinclan: unrelated roles do not fire',
      NC.shouldRemoveMarker({ isBot: false, roleIds: new Set([marker, cfgN.roles.oathForsakersId]) }) === false);

    ok('notinclan: approval path removes the marker',
      recruitSrcN.includes("require('./not-in-clan')") && recruitSrcN.includes("target.roles.remove(markerId, 'Approved; no longer waiting')"));
    ok('notinclan: join path grants the marker',
      indexSrcN.includes("require('./not-in-clan')") && indexSrcN.includes("member.roles.add(markerRole, 'New joiner; not in the clan yet')"));
    ok('notinclan: update watch is wired in index',
      indexSrcN.includes('handleNotInClanUpdate(newMember)'));
    ok('notinclan: watch removal is logged once and errors are not swallowed',
      fs.readFileSync(path.join(__dirname, '..', 'src', 'not-in-clan.js'), 'utf8').includes('[not-in-clan] Removed the Not in the Clan Yet marker')
        && fs.readFileSync(path.join(__dirname, '..', 'src', 'not-in-clan.js'), 'utf8').includes("console.error('[not-in-clan] Marker removal failed:'"));
  }

  // Launch countdown (Nov 5, 2026): the day-count math picks the
  // banner for each New York date. Fixed instants, no clock reading.
  {
    const LC = require(path.join(__dirname, '..', 'src', 'launch-countdown.js'));
    const { DateTime } = require('luxon');
    const at = (iso) => DateTime.fromISO(iso, { zone: 'America/New_York' });
    ok('countdown: Nov 5 evening is 18 days out', LC.daysRemaining(at('2026-11-05T21:45')) === 18, String(LC.daysRemaining(at('2026-11-05T21:45'))));
    ok('countdown: just after midnight Nov 6 is 17 days out', LC.daysRemaining(at('2026-11-06T00:05')) === 17, String(LC.daysRemaining(at('2026-11-06T00:05'))));
    ok('countdown: Nov 22 is 1 day out', LC.daysRemaining(at('2026-11-22T09:00')) === 1, String(LC.daysRemaining(at('2026-11-22T09:00'))));
    ok('countdown: launch day is 0', LC.daysRemaining(at('2026-11-23T08:00')) === 0, String(LC.daysRemaining(at('2026-11-23T08:00'))));
    ok('countdown: the day after launch is negative', LC.daysRemaining(at('2026-11-24T00:05')) === -1, String(LC.daysRemaining(at('2026-11-24T00:05'))));
    ok('countdown: banners map to the rendered files',
      LC.bannerFileFor(18) === 'day-18.jpg' && LC.bannerFileFor(1) === 'day-01.jpg'
        && LC.bannerFileFor(0) === 'today.jpg' && LC.bannerFileFor(-3) === 'today.jpg');
    const assetDir = path.join(__dirname, '..', 'assets', 'countdown');
    ok('countdown: every banner file exists on disk',
      [18, 12, 7, 1, 0].every((d) => fs.existsSync(path.join(assetDir, LC.bannerFileFor(d)))));
    const unix = Math.floor(LC.launchInstant().toSeconds());
    ok('countdown: message carries the full and relative timestamps',
      LC.messageContent() === `**Oath Forsaken launches** <t:${unix}:F>\n<t:${unix}:R>\nhttps://oathforsaken.cc`);
    ok('countdown: message ends with the site link line',
      LC.messageContent().split('\n').pop() === 'https://oathforsaken.cc');
  }

  // Card Refresh (Nov 6, 2026): the charge rules in refresh.js,
  // driven through runRefresh with recording update stubs and a
  // scratch state file: no network, no live data writes. Fake
  // ids and names throughout, per the repo rule. The handler's
  // response sequence is covered separately below, through a
  // recording fake interaction and the handler's deps seam.
  {
    const R = require(path.join(__dirname, '..', 'src', 'refresh.js'));
    const os = require('os');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'smoke-refresh-'));
    const file = path.join(dir, 'refresh-state.json');
    const NOW = Date.UTC(2026, 10, 6, 12, 0, 0);
    let pulls = [];
    const okPull = async (rsn) => { pulls.push(rsn); return true; };
    const badPull = async () => { pulls.push('x'); return false; };
    const UID = '111111111';
    const UID2 = '222222222';
    const buttonsSrc2 = fs.readFileSync(path.join(__dirname, '..', 'src', 'buttons.js'), 'utf8');
    ok('refresh: button routed in buttons.js', buttonsSrc2.includes("kind === 'refresh'"));
    ok('refresh: handler exported', typeof S.handleRefreshButton === 'function');
    // Forged or stale refresh ids end quietly, before any defer.
    for (const bad of ['refresh:kc::', 'refresh:dry:zulrah:', 'refresh:hub:garbage', 'refresh:nope:x:y']) {
      let threw = false;
      try { await S.handleRefreshButton({ customId: bad, user: { id: UID } }); } catch { threw = true; }
      ok(`refresh: malformed id survives: ${bad}`, !threw);
    }

    // A charged pull: one spend, the count drops, the name locks.
    pulls = [];
    let r = await R.runRefresh({ userId: UID, rsn: 'Testiron', updateFn: okPull, now: NOW, file });
    ok('refresh: success spends one and reports 19 left', r.outcome === 'ok' && r.remaining === 19, JSON.stringify(r));
    ok('refresh: success pulled exactly once', pulls.length === 1 && pulls[0] === 'Testiron', JSON.stringify(pulls));
    ok('refresh: spend recorded in the state file', R.loadState(file).users[UID].used === 1);
    r = await R.runRefresh({ userId: UID2, rsn: 'testiron', updateFn: okPull, now: NOW + 1000, file });
    ok('refresh: name lock blocks a second refresh inside 5 minutes',
      r.outcome === 'locked' && r.minutes === 5, JSON.stringify(r));
    ok('refresh: a locked tap pulls nothing and charges nobody',
      pulls.length === 1 && !R.loadState(file).users[UID2]);
    r = await R.runRefresh({ userId: UID, rsn: 'Othertest', updateFn: okPull, now: NOW + 2000, file });
    ok('refresh: a second name spends a second refresh', r.outcome === 'ok' && r.remaining === 18, JSON.stringify(r));
    r = await R.runRefresh({ userId: UID, rsn: 'Testiron', updateFn: okPull, now: NOW + R.LOCK_MS + 1, file });
    ok('refresh: the lock expires after 5 minutes', r.outcome === 'ok' && r.remaining === 17, JSON.stringify(r));

    // A failed pull: no charge, no lock, a retry goes through.
    const f2 = path.join(dir, 'state-fail.json');
    pulls = [];
    r = await R.runRefresh({ userId: UID, rsn: 'Failname', updateFn: badPull, now: NOW, file: f2 });
    ok('refresh: a failed pull reports failed', r.outcome === 'failed', JSON.stringify(r));
    ok('refresh: a failed pull charges nothing and locks nothing',
      !R.loadState(f2).users[UID] && !R.loadState(f2).locks.failname, JSON.stringify(R.loadState(f2)));
    r = await R.runRefresh({ userId: UID, rsn: 'Failname', updateFn: okPull, now: NOW + 1, file: f2 });
    ok('refresh: a retry after failure is allowed', r.outcome === 'ok' && r.remaining === 19, JSON.stringify(r));

    // Out of allowance: refused before any pull.
    const f3 = path.join(dir, 'state-empty.json');
    fs.writeFileSync(f3, JSON.stringify({ users: { [UID]: { day: R.dayKey(NOW), used: R.DAILY_LIMIT } }, locks: {} }));
    pulls = [];
    r = await R.runRefresh({ userId: UID, rsn: 'Anyname', updateFn: okPull, now: NOW, file: f3 });
    ok('refresh: out of allowance refuses with no pull', r.outcome === 'empty' && pulls.length === 0, JSON.stringify(r));
    ok('refresh: remaining reads zero at the cap', R.remainingIn(R.loadState(f3), UID, NOW) === 0);
    fs.writeFileSync(f3, JSON.stringify({ users: { [UID]: { day: R.dayKey(NOW - 86400000), used: R.DAILY_LIMIT } }, locks: {} }));
    r = await R.runRefresh({ userId: UID, rsn: 'Anyname', updateFn: okPull, now: NOW, file: f3 });
    ok('refresh: a new UTC day restores the allowance', r.outcome === 'ok' && r.remaining === R.DAILY_LIMIT - 1, JSON.stringify(r));

    // Simultaneous taps on one name: the second waits, uncharged.
    const f4 = path.join(dir, 'state-busy.json');
    let release;
    const gate = new Promise((res) => { release = res; });
    const slowPull = async () => { await gate; return true; };
    const first = R.runRefresh({ userId: UID, rsn: 'Busyname', updateFn: slowPull, now: NOW, file: f4 });
    r = await R.runRefresh({ userId: UID2, rsn: 'Busyname', updateFn: okPull, now: NOW, file: f4 });
    ok('refresh: a tap during a pull is told busy', r.outcome === 'busy', JSON.stringify(r));
    release();
    const firstDone = await first;
    ok('refresh: the first pull completes and charges once',
      firstDone.outcome === 'ok' && R.loadState(f4).users[UID].used === 1 && !R.loadState(f4).users[UID2],
      JSON.stringify(firstDone));

    // The handler's response sequence (Nov 6, 2026 fix): the
    // tapper must see a reply at once. A fake interaction
    // records every call in order; the pull is a recording
    // stub through the handler's deps seam; state stays in
    // the scratch dir, so no live count is spent. The rebuild
    // runs the real kc payload for the fixture name, the same
    // build the card checks below use.
    const encPrimary = PRIMARY.replace(/ /g, '_');
    const kcTap = `refresh:kc:zulrah:${encPrimary}`;
    const mkInteraction = (customId, userId, log) => ({
      customId,
      user: { id: userId },
      reply: async (o) => { log.push(['reply', o.content]); },
      editReply: async (o) => { log.push(['editReply', o.content]); },
      followUp: async (o) => { log.push(['followUp', o.content]); },
      message: { edit: async (o) => { log.push(['message.edit', o]); } },
    });

    // A working tap: ACK reply first, pull after it, the card
    // edited on its own message, the result line last.
    const f5 = path.join(dir, 'state-handler.json');
    const log5 = [];
    await S.handleRefreshButton(mkInteraction(kcTap, OWNER, log5),
      { updateFn: async (name) => { log5.push(['pull', name]); return true; }, now: NOW, file: f5 });
    const kinds5 = log5.map((e) => e[0]);
    ok('refresh: the ACK reply is the first response',
      log5.length > 0 && log5[0][0] === 'reply' && log5[0][1] === 'Refreshing that name now.',
      JSON.stringify(kinds5));
    ok('refresh: the ACK is issued before the pull starts',
      kinds5.indexOf('pull') > kinds5.indexOf('reply') && kinds5.indexOf('reply') === 0,
      JSON.stringify(kinds5));
    ok('refresh: the handler pull runs exactly once, on the card name',
      log5.filter((e) => e[0] === 'pull').length === 1
        && log5.find((e) => e[0] === 'pull')[1] === PRIMARY, JSON.stringify(kinds5));
    const cardEdit = log5.find((e) => e[0] === 'message.edit');
    ok('refresh: the card is edited on its own message with the new image',
      !!cardEdit && !!cardEdit[1].files && cardEdit[1].files.length > 0, JSON.stringify(kinds5));
    ok('refresh: the result line edits the reply, after the card edit',
      log5[log5.length - 1][0] === 'editReply'
        && log5[log5.length - 1][1] === 'Refreshed. You have 19 refreshes left today.'
        && kinds5.indexOf('editReply') > kinds5.indexOf('message.edit'),
      JSON.stringify(log5.map((e) => (typeof e[1] === 'string' ? e[1] : e[0]))));
    ok('refresh: the handler spend landed in the scratch state',
      R.loadState(f5).users[OWNER].used === 1, JSON.stringify(R.loadState(f5)));

    // A locked name: answered by the first reply, no pull.
    const f6 = path.join(dir, 'state-locked-tap.json');
    fs.writeFileSync(f6, JSON.stringify({ users: {}, locks: { [PRIMARY.toLowerCase()]: NOW + R.LOCK_MS } }));
    const log6 = [];
    let pulls6 = 0;
    await S.handleRefreshButton(mkInteraction(kcTap, UID2, log6),
      { updateFn: async () => { pulls6 += 1; return true; }, now: NOW, file: f6 });
    ok('refresh: a locked tap is answered at once, with no pull',
      log6.length === 1 && log6[0][0] === 'reply'
        && log6[0][1] === 'That name was just refreshed. It is locked for about 5 more minutes.'
        && pulls6 === 0, JSON.stringify(log6));

    // An empty tapper: answered by the first reply, no pull.
    const f7 = path.join(dir, 'state-empty-tap.json');
    fs.writeFileSync(f7, JSON.stringify({ users: { [UID2]: { day: R.dayKey(NOW), used: R.DAILY_LIMIT } }, locks: {} }));
    const log7 = [];
    let pulls7 = 0;
    await S.handleRefreshButton(mkInteraction(kcTap, UID2, log7),
      { updateFn: async () => { pulls7 += 1; return true; }, now: NOW, file: f7 });
    ok('refresh: an empty tapper is answered at once, with no pull',
      log7.length === 1 && log7[0][0] === 'reply'
        && log7[0][1] === 'You are out of refreshes for today. Cards keep working off the saved numbers.'
        && pulls7 === 0, JSON.stringify(log7));

    // A name mid-pull: answered by the first reply, no pull.
    const f8 = path.join(dir, 'state-busy-tap.json');
    let release8;
    const gate8 = new Promise((res) => { release8 = res; });
    const firstPull = R.runRefresh({ userId: UID, rsn: PRIMARY, updateFn: async () => { await gate8; return true; }, now: NOW, file: f8 });
    const log8 = [];
    let pulls8 = 0;
    await S.handleRefreshButton(mkInteraction(kcTap, UID2, log8),
      { updateFn: async () => { pulls8 += 1; return true; }, now: NOW, file: f8 });
    ok('refresh: a busy tap is answered at once, with no second pull',
      log8.length === 1 && log8[0][0] === 'reply'
        && log8[0][1] === 'That name is being refreshed right now. Give it a few seconds.'
        && pulls8 === 0, JSON.stringify(log8));
    release8();
    await firstPull;

    // A failed pull: the ACK is edited into the failure line,
    // the card is never edited, and nothing is charged.
    const f9 = path.join(dir, 'state-failed-tap.json');
    const log9 = [];
    await S.handleRefreshButton(mkInteraction(kcTap, UID2, log9),
      { updateFn: async () => { log9.push(['pull', 'x']); return false; }, now: NOW, file: f9 });
    ok('refresh: a failed pull edits the ACK into the failure line',
      log9.length === 3 && log9[0][0] === 'reply' && log9[0][1] === 'Refreshing that name now.'
        && log9[2][0] === 'editReply'
        && log9[2][1] === 'The update did not go through. Nothing was spent, try again in a bit.',
      JSON.stringify(log9.map((e) => (typeof e[1] === 'string' ? e[1] : e[0]))));
    ok('refresh: a failed tap charges nothing and locks nothing',
      !R.loadState(f9).users[UID2] && !R.loadState(f9).locks[PRIMARY.toLowerCase()],
      JSON.stringify(R.loadState(f9)));
    fs.rmSync(dir, { recursive: true, force: true });

    // The age line's wording, from fixed stamps.
    ok('refresh: age line reads just now', S.updatedAgoText(NOW, NOW) === 'Updated just now');
    ok('refresh: age line reads minutes', S.updatedAgoText(NOW - 12 * 60000, NOW) === 'Updated 12 minutes ago');
    ok('refresh: age line reads one hour', S.updatedAgoText(NOW - 3600000, NOW) === 'Updated 1 hour ago');
    ok('refresh: age line reads hours', S.updatedAgoText(NOW - 3 * 3600000, NOW) === 'Updated 3 hours ago');
    ok('refresh: age line reads one day', S.updatedAgoText(NOW - 86400000, NOW) === 'Updated 1 day ago');
    ok('refresh: age line is empty with no stamp', S.updatedAgoText(null, NOW) === null);

    // The three cards carry the button and the age line.
    const kcP = await S.kcPayload('zulrah', PRIMARY, OWNER);
    const kcBtn = flat(kcP).find((c) => c.id.startsWith('refresh:kc:zulrah:'));
    ok('refresh: kc card carries the Refresh button', !!kcBtn, JSON.stringify(flat(kcP).map((c) => c.id)));
    ok('refresh: kc button label shows the count left', !!kcBtn && /^Refresh · \d+ left$/.test(kcBtn.label), kcBtn && kcBtn.label);
    ok('refresh: kc card carries the Updated line', typeof kcP.content === 'string' && kcP.content.startsWith('Updated '), String(kcP.content));
    const dryP = await S.dryPayload('zulrah', PRIMARY, OWNER);
    ok('refresh: dry card carries the Refresh button',
      flat(dryP).some((c) => c.id.startsWith('refresh:dry:zulrah:')), JSON.stringify(flat(dryP).map((c) => c.id)));
    ok('refresh: dry card carries the Updated line', typeof dryP.content === 'string' && dryP.content.startsWith('Updated '), String(dryP.content));
    const hubP = await S.hubPayload(PRIMARY, OWNER, {});
    ok('refresh: profile hub carries the Refresh button',
      flat(hubP).some((c) => c.id.startsWith('refresh:hub:')), JSON.stringify(flat(hubP).map((c) => c.id)));
    ok('refresh: profile hub carries the Updated line', typeof hubP.content === 'string' && hubP.content.startsWith('Updated '), String(hubP.content));
  }

  // Website controls (Nov 6, 2026): the staff-chat panel that
  // edits the recorded membership standing by hand. The handlers
  // run against a fixture membership.json with fake ids; the
  // file is restored byte for byte afterwards.
  {
    const WC = require(path.join(__dirname, '..', 'src', 'website-controls.js'));
    const storeW = require(path.join(__dirname, '..', 'src', 'store.js'));
    const cfgW = require(path.join(__dirname, '..', 'src', 'config.js'));
    const { Collection } = require('discord.js');
    const wcSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'website-controls.js'), 'utf8');
    const wcIndexSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.js'), 'utf8');
    const wcButtonsSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'buttons.js'), 'utf8');

    // Panel: one Danger button with the exact label, house red.
    const wcPanel = WC.panelPayload();
    const wcPanelJson = JSON.stringify(wcPanel.components.map((r) => r.toJSON()));
    const wcPanelFlat = wcPanel.components.flatMap((r) => r.components);
    ok('webctl: panel button is labelled Set standing', wcPanelJson.includes('"label":"Set standing"') && wcPanelJson.includes('webctl:open'), wcPanelJson);
    ok('webctl: panel carries exactly one button', wcPanelFlat.length === 1, wcPanelJson);
    ok('webctl: panel button is Danger', wcPanelJson.includes('"style":4'), wcPanelJson);
    ok('webctl: panel embed is house red and titled Website controls',
      wcPanel.embeds[0].data.color === 0x6b0e0e && wcPanel.embeds[0].data.title === 'Website controls');
    ok('webctl: button routed in buttons.js', wcButtonsSrc.includes("kind === 'webctl'"));
    ok('webctl: user select routed in index.js', wcIndexSrc.includes("interaction.customId === 'webctl:member'"));
    ok('webctl: command registered', WC.commands.some((c) => c.data.name === 'website-controls-panel'));
    ok('webctl: staff gate on command, button, select, and set buttons',
      (wcSrc.match(/isStaff\(interaction\)/g) || []).length >= 4);
    ok('webctl: audit line posts to the mod-log', wcSrc.includes('config.channels.modLog') && wcSrc.includes('Website controls:'));

    // Panel home: the configured thread wins; with no thread
    // configured the panel falls back to the staff chat channel.
    const wcHomeChannels = {
      '777777777': { id: '777777777' },
      '888888888': { id: '888888888' },
    };
    const wcHomeGuild = { channels: { cache: { get: (id) => wcHomeChannels[id] || null } } };
    ok('webctl: panel home is the thread when one is configured',
      WC.panelHome(wcHomeGuild, { websiteControls: { threadId: '888888888' }, ccChecklist: { staffChatId: '777777777' } })?.id === '888888888');
    ok('webctl: panel home falls back to staff chat with no thread configured',
      WC.panelHome(wcHomeGuild, { ccChecklist: { staffChatId: '777777777' } })?.id === '777777777');

    // Writes against a fixture record file.
    const memPath = path.join(DATA, 'membership.json');
    const memSaved = fs.existsSync(memPath) ? fs.readFileSync(memPath) : null;
    const WG = '990000000000009101';
    const WG2 = '990000000000009102';
    const WU1 = '990000000000000201';
    const WU2 = '990000000000000202';
    const WU3 = '990000000000000203';
    const STAFF_ROLE = (cfgW.tickets?.staffRoleIds || [])[0];
    const fakeIx = ({ staff, customId, guildId = WG }) => {
      const cache = new Collection();
      if (staff && STAFF_ROLE) cache.set(STAFF_ROLE, { id: STAFF_ROLE });
      const replies = [];
      return {
        customId,
        guildId,
        member: { roles: { cache }, permissions: { has: () => false } },
        user: { id: '990000000000000900', tag: 'fake-staff' },
        guild: { channels: { cache: { get: (id) => (id === cfgW.channels.modLog ? { send: async () => {} } : null) } } },
        replies,
        reply: async (p) => { replies.push(p); },
      };
    };
    try {
      fs.writeFileSync(memPath, JSON.stringify({
        [WG]: {
          [WU1]: { standing: 'member', at: 1, via: 'approval' },
          [WU2]: { standing: 'guest', at: 1, via: 'approval' },
        },
        [WG2]: { [WU3]: { standing: 'member', at: 1, via: 'backfill' } },
      }));

      // The gate refuses a non-staff id on the panel button and
      // on a standing button, and writes nothing.
      const denied = fakeIx({ staff: false, customId: 'webctl:open' });
      await WC.handleWebsiteControlsButton(denied);
      ok('webctl: gate rejects a non-staff user on the panel button',
        denied.replies.length === 1 && denied.replies[0].content === 'That button is for staff only.', JSON.stringify(denied.replies));
      const deniedSet = fakeIx({ staff: false, customId: `webctl:set:guest:${WU1}` });
      await WC.handleWebsiteControlsButton(deniedSet);
      ok('webctl: gate rejects a non-staff user on a standing button',
        deniedSet.replies.length === 1 && storeW.getMembership(WG)[WU1].standing === 'member');

      // Current standing reads truthfully for all three states,
      // and the picker step carries the three write buttons.
      ok('webctl: current standing reads member, guest, and no record',
        WC.currentStanding(WG, WU1) === 'member' && WC.currentStanding(WG, WU2) === 'guest' && WC.currentStanding(WG, WU3) === null);
      const spMember = WC.standingPayload(WG, WU1);
      const spNone = WC.standingPayload(WG, WU3);
      const spJson = JSON.stringify(spMember.components.map((r) => r.toJSON()));
      ok('webctl: standing lines are truthful for a record and for no record',
        spMember.content === `<@${WU1}> is recorded as a member.` && spNone.content === `<@${WU3}> has no standing record.`,
        `${spMember.content} / ${spNone.content}`);
      ok('webctl: picker step carries the three standing buttons',
        spJson.includes(`webctl:set:member:${WU1}`) && spJson.includes(`webctl:set:guest:${WU1}`) && spJson.includes(`webctl:set:clear:${WU1}`), spJson);

      // Set guest overwrites a member record, via the panel.
      const setGuest = fakeIx({ staff: true, customId: `webctl:set:guest:${WU1}` });
      await WC.handleWebsiteControlsButton(setGuest);
      const afterGuest = storeW.getMembership(WG);
      ok('webctl: set guest overwrites the record via the panel',
        afterGuest[WU1].standing === 'guest' && afterGuest[WU1].via === 'panel'
        && setGuest.replies[0].content === `Standing for <@${WU1}> is now guest.`, JSON.stringify(afterGuest[WU1]));

      // Set member writes a guest record up to member.
      const setMember = fakeIx({ staff: true, customId: `webctl:set:member:${WU2}` });
      await WC.handleWebsiteControlsButton(setMember);
      ok('webctl: set member writes the record',
        storeW.getMembership(WG)[WU2].standing === 'member'
        && setMember.replies[0].content === `Standing for <@${WU2}> is now member.`);

      // Clear deletes only that entry: the other member in the
      // guild and the other guild's record both survive.
      const clear = fakeIx({ staff: true, customId: `webctl:set:clear:${WU1}` });
      await WC.handleWebsiteControlsButton(clear);
      const afterClear = JSON.parse(fs.readFileSync(memPath, 'utf8'));
      ok('webctl: clear deletes only that entry',
        !(WU1 in (afterClear[WG] || {})) && afterClear[WG][WU2].standing === 'member'
        && afterClear[WG2][WU3].standing === 'member'
        && clear.replies[0].content === `The record for <@${WU1}> was cleared.`, JSON.stringify(afterClear));

      // Clearing a member with no record changes nothing and
      // says so.
      const clearNone = fakeIx({ staff: true, customId: `webctl:set:clear:${WU1}` });
      await WC.handleWebsiteControlsButton(clearNone);
      ok('webctl: clear with no record is a truthful no-op',
        clearNone.replies[0].content === `There is no record for <@${WU1}>. Nothing changed.`, JSON.stringify(clearNone.replies));
    } finally {
      if (memSaved === null) { try { fs.unlinkSync(memPath); } catch {} }
      else fs.writeFileSync(memPath, memSaved);
    }
  }

  // Timing guard (Nov 2, 2026): a payload builder that burns
  // seconds of CPU starves Discord's 3-second interaction
  // acknowledgement and the command dies with "Unknown
  // interaction" while looking fine in tests. Any timed build
  // over the budget fails the sweep.
  const slowest = timings.slice().sort((a, b) => b.ms - a.ms)[0];
  if (slowest) console.log(` slowest build: ${slowest.name} ${slowest.ms}ms`);
  for (const tm of timings) {
    if (tm.ms > 4000) ok(`timing budget: ${tm.name}`, false, `${tm.ms}ms > 4000ms`);
  }
  ok('timing budget: all builds under 4s', timings.every((tm) => tm.ms <= 4000));

  console.log(`\nRESULT: ${pass} pass, ${fail} fail`);
  if (fails.length) console.log('FAILURES:', fails.join(' ;; '));
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('SCRIPT FAIL', e); process.exit(1); });
