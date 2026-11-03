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
// abuse, and regression checks for the Nov 2, 2026 bugs (compare
// clogs totals crash, clog boss card missing its Leaderboard
// button, compare PvM tab not lighting, profile-luck file).
// The Account Type forged-press fix is NOT covered here: its
// handler runs role sync against the guild, so it stays a
// one-off test with data backups (done 2026-11-02).
const fs = require('fs');
const path = require('path');
const S = require(path.join(__dirname, '..', 'src', 'showoff.js'));
const DATA = path.join(__dirname, '..', 'data');
const GAVIN = '111111111111111111';
const CHOWDER = '210259442317524993';
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
function fakeIx(customId, messageComponents, userId) {
  const ix = {
    customId, user: { id: userId || GAVIN },
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
  await t('profile card', () => S.profilePayload('IronVale', GAVIN));
  await t('profile card (Go Far)', () => S.profilePayload('Go Far', GAVIN));
  await t('skills card', () => S.skillsPayload('IronVale', GAVIN));
  await t('clog total card', () => S.clogPayload('total', 'IronVale', GAVIN));
  await t('clog page card (Zulrah)', () => S.clogPayload('zulrah', 'IronVale', GAVIN));
  await t('clog clues summary card', () => S.clogPayload('clues', 'IronVale', GAVIN));
  await t('clog scrolls summary card', () => S.clogPayload('scrolls', 'IronVale', GAVIN));
  await t('dry card (Zulrah)', () => S.dryPayload('zulrah', 'IronVale', GAVIN));
  await t('gains card', () => S.gainsPayload('IronVale', 'week', GAVIN), false);
  await t('pb reply', () => S.pbPayload('', 'IronVale', GAVIN), false);
  await t('compare overall', () => S.compareOverallPayload('IronVale', 'IronStewPot', GAVIN, GAVIN));
  await t('compare skills', () => S.compareSkillsPayload('IronVale', 'IronStewPot', GAVIN, GAVIN, {}));
  await t('compare skill inspect (Fishing)', () => S.compareSkillsPayload('IronVale', 'IronStewPot', GAVIN, GAVIN, { skill: 'fishing' }));
  // Regression (Nov 2): the clogs totals branch crashed on an
  // out-of-scope variable after badges were added to compare.
  await t('compare clogs totals', () => S.compareClogsPayload('IronVale', 'IronStewPot', GAVIN, GAVIN, {}));
  await t('compare clogs page (Zulrah)', () => S.compareClogsPayload('IronVale', 'IronStewPot', GAVIN, GAVIN, { page: 'Zulrah' }));
  await t('leaderboard card', () => S.leaderboardPayload(GAVIN, 'overall'));
  await t('kc card (m o u z, spaces)', () => S.kcPayload('zulrah', 'm o u z', GAVIN));

  // ── B. Leaderboard boards + variant toggles ──────────
  for (const arg of ['overall', 'boss:zulrah', 'skill:fishing', 'clogtotal', 'gains']) {
    const p = await S.leaderboardPayload(GAVIN, arg);
    ok(`board renders: ${arg}`, hasFile(p));
  }
  const bad = await S.leaderboardPayload(GAVIN, 'boss:doesnotexist');
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
    const p = await S.leaderboardPayload(GAVIN, `boss:${key}`);
    const varBtns = flat(p).filter((c) => c.id.startsWith('lbvar:'));
    if (labels === null) { ok(`no toggle: ${key}`, varBtns.length === 0); continue; }
    ok(`toggle labels: ${key}`, JSON.stringify(varBtns.map((b) => b.label)) === JSON.stringify(labels),
      JSON.stringify(varBtns.map((b) => b.label)));
  }
  const toaFull = await S.leaderboardPayload(GAVIN, 'boss:toa');
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
  const kc = await S.kcPayload('gauntlet', 'IronVale', GAVIN);
  const swapBtn = flat(kc)[0];
  const ixS = fakeIx(swapBtn.id, kc.components, CHOWDER);
  await S.handleLbSwapButton(ixS);
  const scopedIds = flat(ixS.last).map((c) => c.id);
  ok('scoped board has no tabs/picker',
    !scopedIds.some((i) => i.startsWith('lbtab:') || i.startsWith('lbpick:')));
  ok('scoped board return label', flat(ixS.last).some((c) => c.label === '← KC card'));
  // Regression (Nov 2): the same combined card posted via /clog
  // must carry the same Leaderboard button /kc posts.
  const clogBoss = await S.clogPayload('zulrah', 'IronVale', GAVIN);
  ok('clog boss card carries Leaderboard button',
    flat(clogBoss).some((c) => c.id.startsWith('lbswap:boss:zulrah')));

  // ── D. KC cards across bosses ────────────────────────
  for (const key of ['toa', 'cox', 'tob', 'gauntlet', 'dks', 'nightmare', 'callisto',
    'venenatis', 'vetion', 'bh', 'clues', 'colosseum', 'zulrah']) {
    let p = null, threw = false;
    try { p = await S.kcPayload(key, 'IronVale', GAVIN); } catch { threw = true; }
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
    const g3 = await S.kcPayload('zulrah', 'IronVale', unstated.uid);
    ok('no gate on someone else\'s account',
      !(typeof g3.content === 'string' && g3.content.includes('Set the account type')));
  }
  const own = await S.kcPayload('zulrah', 'ptstud', GAVIN);
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
    const ix = fakeIx(`lbback:skill:${sk}:IronVale`, []);
    let threw = false;
    try { await S.handleLbBackButton(ix); } catch { threw = true; }
    ok(`solo skill renders: ${sk}`, !threw && !!ix.last && hasFile(ix.last));
  }
  const ixF = fakeIx('lbback:skill:fishing:IronVale', []);
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
  const cmp = await S.compareBossPayload('zulrah', 'IronVale', 'IronStewPot', GAVIN, GAVIN, {});
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
    ok('compare swap id carries the pair', dec[0] === 'IronVale' && dec[1] === 'IronStewPot');
    const ixB = fakeIx(cmpSwap.id, cmp.components);
    await S.handleLbSwapButton(ixB);
    ok('compare scoped return label', flat(ixB.last).some((c) => c.label === '← Compare card'),
      JSON.stringify(flat(ixB.last).map((c) => c.label)));
  }
  const changeBtn = flat(cmp).find((c) => c.id.startsWith('cmpswap'));
  ok('compare Change players button present', !!changeBtn);
  if (changeBtn) {
    const ixC = fakeIx(changeBtn.id, cmp.components, CHOWDER);
    let threw = false;
    try { await S.handleCompareSwapButton(ixC); } catch { threw = true; }
    const note = (ixC.replied && ixC.replied.content) || (ixC.last && ixC.last.content) || '';
    ok('non-owner Change players gets make-my-own note', !threw && note.includes('make your own'),
      note.slice(0, 120));
  }

  // ── I. Gains: WOM periods (Nov 2, 2026) ──────────────
  for (const per of ['day', 'week', 'month', 'year']) {
    const gp = await S.gainsPayload('IronVale', per, GAVIN);
    ok(`gains card renders: ${per}`, hasFile(gp), gp && gp.content ? gp.content.slice(0, 80) : '');
  }
  const gw = await S.gainsPayload('IronVale', 'week', GAVIN);
  const gBtns = flat(gw).filter((c) => c.id.startsWith('gains:'));
  ok('gains card carries 4 period buttons', gBtns.length === 4,
    JSON.stringify(gBtns.map((b) => b.id)));
  let flipped = null;
  await S.handleGainsButton({ customId: 'gains:year:IronVale', user: { id: GAVIN },
    update: async (p) => { flipped = p; }, reply: async (p) => { flipped = p; } });
  ok('gains period flip swaps the card', !!(flipped && flipped.files));
  let wgOk = false;
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(DATA, 'wom-gains.json'), 'utf8'));
    wgOk = !!(raw.ptstud && raw.ptstud.week && raw.ptstud.year);
  } catch {}
  ok('wom-gains.json holds IronVale week + year', wgOk);
  const gb = await S.leaderboardPayload(GAVIN, 'gains');
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
  const kcZ = await S.kcPayload('zulrah', 'IronVale', GAVIN);
  ok('kc card has the Dry bridge', flat(kcZ).some((c) => c.id.startsWith('bridge:dry:zulrah:')));
  const kcT = await S.kcPayload('toa', 'IronVale', GAVIN);
  ok('kc card has no Dry bridge for unscored ToA', !flat(kcT).some((c) => c.id.startsWith('bridge:')));
  const dryZ = await S.dryPayload('zulrah', 'IronVale', GAVIN);
  ok('dry card has the KC bridge', flat(dryZ).some((c) => c.id.startsWith('bridge:kc:zulrah:')));
  let bridged = null;
  await S.handleBridgeButton({ customId: 'bridge:dry:zulrah:IronVale', user: { id: GAVIN },
    update: async (p) => { bridged = p; }, reply: async (p) => { bridged = p; } });
  ok('bridge press swaps KC into dry', !!(bridged && bridged.files));
  let toClues = null;
  await S.handleBridgeButton({ customId: 'bridge:clues:-:IronVale', user: { id: GAVIN },
    update: async (p) => { toClues = p; }, reply: async (p) => { toClues = p; } });
  // The summary carries its own Profile button now (hub wave);
  // the landing must show that, never the stale bridge row.
  ok('bridge to clues lands with its Profile button, no stale bridge row',
    !!(toClues && toClues.files)
      && flat(toClues).some((c) => c.id.startsWith('prof:clogs:clues:'))
      && !flat(toClues).some((c) => c.id.startsWith('bridge:')));
  const dryHard = await S.dryPayload('clue:hard', 'IronVale', GAVIN);
  ok('dry renders for hard clues', hasFile(dryHard),
    dryHard && dryHard.content ? dryHard.content.slice(0, 80) : '');
  ok('clue dry card has the Clues bridge',
    !!(dryHard && dryHard.components) && flat(dryHard).some((c) => c.id.startsWith('bridge:clues:')));
  const dryAll = await S.dryPayload('clue:all', 'IronVale', GAVIN);
  ok('dry renders for all clue tiers', hasFile(dryAll),
    dryAll && dryAll.content ? dryAll.content.slice(0, 80) : '');
  ok('all-tiers dry card has the Clues bridge',
    !!(dryAll && dryAll.components) && flat(dryAll).some((c) => c.id.startsWith('bridge:clues:')));
  let toSummary = null;
  await S.handleBridgeButton({ customId: 'bridge:clues:hard:IronVale', user: { id: GAVIN },
    update: async (p) => { toSummary = p; }, reply: async (p) => { toSummary = p; } });
  ok('summary landing from a dry card carries the way back',
    !!(toSummary && toSummary.files)
      && JSON.stringify(toSummary.components || []).includes('bridge:dryc:hard'));
  let backToDry = null;
  await S.handleBridgeButton({ customId: 'bridge:dryc:hard:IronVale', user: { id: GAVIN },
    update: async (p) => { backToDry = p; }, reply: async (p) => { backToDry = p; } });
  ok('way-back press returns the tier dry card', !!(backToDry && backToDry.files));
  let oldLanding = null;
  await S.handleBridgeButton({ customId: 'bridge:clues:-:IronVale', user: { id: GAVIN },
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
  ok('tracked member is warm (no cold sync)', S.isCold('IronVale') === false);
  ok('never-checked name is cold', S.isCold('zz no such rsn 42') === true);
  const warmSeed = await S.ensureSynced('IronVale', 1000);
  ok('ensureSynced no-ops for a warm name', warmSeed === false);

  // ── L. Dry list + driest board ──
  const dlStarted = Date.now();
  const dl = await S.dryListPayload('IronVale', null, 'all');
  timings.push({ name: 'dry list (section L)', ms: Date.now() - dlStarted });
  ok('dry list renders for IronVale', !!(dl && dl.files), JSON.stringify(dl && dl.content || ''));
  ok('dry list carries category buttons', !!dl && (dl.components || []).length >= 1);
  ok('dry list hides IronVale\'s empty categories',
    !!dl && flat(dl).filter((c) => c.id.startsWith('drycat:')).length === 3
      && !flat(dl).some((c) => c.id.startsWith('drycat:Minigames'))
      && !flat(dl).some((c) => c.id.startsWith('drycat:Other')));
  const dlb = await S.dryListPayload('IronVale', null, 'Bosses');
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
  const hub = await t('hub overview renders', () => S.hubPayload('IronVale', GAVIN, {}));
  ok('hub overview has tab + branch rows',
    !!hub && flat(hub).some((c) => c.id.startsWith('hub:tab:skills:'))
      && flat(hub).some((c) => c.id.startsWith('hub:lb:'))
      && flat(hub).some((c) => c.id.startsWith('hub:cmp:'))
      && flat(hub).some((c) => c.id.startsWith('hub:chg:')));
  ok('hub overview within the 5-row cap', !!hub && (hub.components || []).length <= 5,
    hub ? `${hub.components.length} rows` : 'none');
  for (const tab of ['skills', 'pvm', 'clogs', 'dry', 'gains']) {
    const p = await t(`hub tab renders: ${tab}`, () => S.hubPayload('IronVale', GAVIN, { tab }));
    ok(`hub tab within the 5-row cap: ${tab}`, !!p && (p.components || []).length <= 5,
      p ? `${(p.components || []).length} rows` : 'none');
  }
  const hubPb = await S.hubPayload('IronVale', GAVIN, { tab: 'pbs' });
  ok('hub PBs tab is the plugin notice',
    !!hubPb && (hasFile(hubPb) || String(hubPb.content || '').includes('clan plugin is live')),
    hubPb && hubPb.content ? hubPb.content.slice(0, 80) : 'no payload');
  ok('hub PBs tab carries only the shell',
    !!hubPb && flat(hubPb).every((c) => /^(hub:tab:|hub:lb:|hub:cmp:|hub:chg:)/.test(c.id)),
    JSON.stringify(flat(hubPb || {}).map((c) => c.id)));
  // Tab press swaps the card in place.
  const skillsTabBtn = flat(hub).find((c) => c.id.startsWith('hub:tab:skills:'));
  const ixTab = hubIx(skillsTabBtn.id, hub.components, GAVIN);
  await S.handleHubButton(ixTab);
  ok('hub tab press opens Skills with its picker',
    !!ixTab.last && hasFile(ixTab.last)
      && flat(ixTab.last).some((c) => c.id.startsWith('hub:skillpick:')));
  // Solo skill in place, with the named return above the tabs.
  const ixSkill = hubIx(flat(ixTab.last).find((c) => c.id.startsWith('hub:skillpick:')).id,
    ixTab.last.components, GAVIN);
  ixSkill.values = ['fishing'];
  await S.handleHubSelect(ixSkill);
  ok('hub skill pick opens the solo card in place',
    !!ixSkill.last && hasFile(ixSkill.last)
      && flat(ixSkill.last).some((c) => c.id.startsWith('hub:skillgrid:') && c.label === '← Skills card'));
  ok('hub solo skill has no Leaderboard button',
    !!ixSkill.last && !flat(ixSkill.last).some((c) => c.id.startsWith('lbswap:')));
  // PvM picker: category + boss selects, then the controls return.
  const hubPvm = await S.hubPayload('IronVale', GAVIN, { tab: 'pvm' });
  const pickBtn = flat(hubPvm).find((c) => c.id.startsWith('hub:pickboss:'));
  ok('hub PvM tab has Pick a boss', !!pickBtn);
  const ixPick = hubIx(pickBtn.id, hubPvm.components, GAVIN);
  await S.handleHubButton(ixPick);
  ok('hub boss picker shows category + boss selects',
    !!ixPick.last && flat(ixPick.last).some((c) => c.id.startsWith('hub:bosscat:'))
      && flat(ixPick.last).some((c) => c.id.startsWith('hub:bosspick:')));
  const bossOpts = selOptions(ixPick.last, 'hub:bosspick:')
    .map((o) => o.value).filter((v) => v && !v.startsWith('page:') && v !== 'none');
  ok('hub boss picker lists bosses', bossOpts.length > 0);
  if (bossOpts.length) {
    const ixBoss = hubIx(flat(ixPick.last).find((c) => c.id.startsWith('hub:bosspick:')).id,
      ixPick.last.components, GAVIN);
    ixBoss.values = [bossOpts[0]];
    await S.handleHubSelect(ixBoss);
    ok('hub boss pick returns to the controls row',
      !!ixBoss.last && hasFile(ixBoss.last)
        && flat(ixBoss.last).some((c) => c.id.startsWith('hub:pickboss:')));
  }
  // ToA variant toggles ride the PvM controls row.
  const hubToa = await S.hubPayload('IronVale', GAVIN, { tab: 'pvm', sub: 'toa' });
  const varBtns = flat(hubToa).filter((c) => c.id.startsWith('hub:var:'));
  ok('hub ToA controls carry variant toggles',
    JSON.stringify(varBtns.map((b) => b.label)) === JSON.stringify(['Total', 'Normal', 'Expert']),
    JSON.stringify(varBtns.map((b) => b.label)));
  // The Expert toggle's state carries an underscored boss key;
  // a later press must decode it back to the same key.
  const expertBtn = varBtns.find((c) => c.id.startsWith('hub:var:1:'));
  if (expertBtn) {
    const ixVar = hubIx(expertBtn.id, hubToa.components, GAVIN);
    await S.handleHubButton(ixVar);
    ok('hub variant press renders the variant card',
      !!ixVar.last && hasFile(ixVar.last)
        && flat(ixVar.last).some((c) => c.id.startsWith('hub:pickboss:')));
    const tabBtn2 = flat(ixVar.last || {}).find((c) => c.id.startsWith('hub:tab:pvm:'));
    ok('variant state round-trips the underscored key',
      !!tabBtn2 && tabBtn2.id.includes('toa_expert'), tabBtn2 ? tabBtn2.id : 'missing');
  }
  // Clogs picker: category buttons + page select, page view returns.
  const hubClogs = await S.hubPayload('IronVale', GAVIN, { tab: 'clogs' });
  const clogPickBtn = flat(hubClogs).find((c) => c.id.startsWith('hub:clogpick:'));
  ok('hub Clogs tab has Pick a page', !!clogPickBtn);
  const ixCP = hubIx(clogPickBtn.id, hubClogs.components, GAVIN);
  await S.handleHubButton(ixCP);
  ok('hub clog picker shows categories + pages',
    !!ixCP.last && flat(ixCP.last).filter((c) => c.id.startsWith('hub:clogcat:')).length === 5
      && flat(ixCP.last).some((c) => c.id.startsWith('hub:clogpage:')));
  const pageOpts = selOptions(ixCP.last, 'hub:clogpage:')
    .map((o) => o.value).filter((v) => v && !v.startsWith('pg:'));
  if (pageOpts.length) {
    const ixPage = hubIx(flat(ixCP.last).find((c) => c.id.startsWith('hub:clogpage:')).id,
      ixCP.last.components, GAVIN);
    ixPage.values = [pageOpts[0]];
    await S.handleHubSelect(ixPage);
    ok('hub clog page carries the Clogs return, no Leaderboard button',
      !!ixPage.last && hasFile(ixPage.last)
        && flat(ixPage.last).some((c) => c.id.startsWith('hub:clogtotal:') && c.label === '← Clogs card')
        && !flat(ixPage.last).some((c) => c.id.startsWith('lbswap:')));
  }
  // Dry tab: drill into a page, return to the list.
  const hubDry = await S.hubPayload('IronVale', GAVIN, { tab: 'dry' });
  // IronVale has scored drops only in Bosses and Clues, so the empty
  // Minigames and Other buttons hide for him (set Nov 2, 2026).
  ok('hub Dry tab shows only his non-empty categories',
    !!hubDry && flat(hubDry).filter((c) => c.id.startsWith('hub:drycat:')).length === 3
      && !flat(hubDry).some((c) => c.id.startsWith('hub:drycat:Minigames'))
      && !flat(hubDry).some((c) => c.id.startsWith('hub:drycat:Other')));
  const dryOpts = selOptions(hubDry, 'hub:drypick:').map((o) => o.value).filter(Boolean);
  ok('hub Dry tab has a drill-in picker', dryOpts.length > 0);
  if (dryOpts.length) {
    const ixDrill = hubIx(flat(hubDry).find((c) => c.id.startsWith('hub:drypick:')).id,
      hubDry.components, GAVIN);
    ixDrill.values = [dryOpts[0]];
    await S.handleHubSelect(ixDrill);
    ok('hub dry drill-in carries return buttons',
      !!ixDrill.last && hasFile(ixDrill.last)
        && flat(ixDrill.last).some((c) => c.id.startsWith('hub:drylist:')));
    const backBtn = flat(ixDrill.last).find((c) => c.id.startsWith('hub:drylist:'));
    const ixBack = hubIx(backBtn.id, ixDrill.last.components, GAVIN);
    await S.handleHubButton(ixBack);
    ok('hub dry return restores the list',
      !!ixBack.last && hasFile(ixBack.last)
        && flat(ixBack.last).some((c) => c.id.startsWith('hub:drycat:')));
  }
  // Gains flips inside the hub.
  const hubGains = await S.hubPayload('IronVale', GAVIN, { tab: 'gains' });
  const gainBtn = flat(hubGains).find((c) => c.id.startsWith('hub:gain:year:'));
  ok('hub Gains tab has period buttons', !!gainBtn);
  if (gainBtn) {
    const ixGain = hubIx(gainBtn.id, hubGains.components, GAVIN);
    await S.handleHubButton(ixGain);
    ok('hub gains flip swaps in place', !!ixGain.last && hasFile(ixGain.last));
  }
  // Switcher: owner opens it, picks an alt; non-owner gets the note.
  const chgBtn = flat(hub).find((c) => c.id.startsWith('hub:chg:'));
  const ixChg = hubIx(chgBtn.id, hub.components, GAVIN);
  await S.handleHubButton(ixChg);
  ok('switcher opens with Type a name + clan picker',
    !!ixChg.last && flat(ixChg.last).some((c) => c.id.startsWith('hub:name:'))
      && flat(ixChg.last).some((c) => c.id.startsWith('hub:clanpick:')));
  const altBtn = flat(ixChg.last || {}).find((c) => c.id.startsWith('hub:alt:'));
  ok('switcher lists the opener\'s other accounts', !!altBtn);
  if (altBtn) {
    const ixAlt = hubIx(altBtn.id, ixChg.last.components, GAVIN);
    await S.handleHubButton(ixAlt);
    ok('switcher pick reloads the hub and closes',
      !!ixAlt.last && hasFile(ixAlt.last)
        && !flat(ixAlt.last).some((c) => c.id.startsWith('hub:clanpick:')));
  }
  const ixChgX = hubIx(chgBtn.id, hub.components, CHOWDER);
  await S.handleHubButton(ixChgX);
  ok('non-owner Change player gets the make-my-own note',
    !!ixChgX.replied && String(ixChgX.replied.content || '').includes("can't change the players")
      && flat(ixChgX.replied).some((c) => c.id.startsWith('hubmine:')));
  // Leaderboard branch: matching board + named return, and the
  // return row survives board flips.
  const lbBtn = flat(hubClogs).find((c) => c.id.startsWith('hub:lb:'));
  const ixLb = hubIx(lbBtn.id, hubClogs.components, GAVIN);
  await S.handleHubButton(ixLb);
  ok('hub Leaderboard branch opens a board with the hub return',
    !!ixLb.last && hasFile(ixLb.last)
      && flat(ixLb.last).some((c) => c.id.startsWith('hubback:') && c.label === '← Clogs card'));
  const lbTabBtn = flat(ixLb.last).find((c) => c.id.startsWith('lbtab:skills:'));
  const ixLbFlip = hubIx(lbTabBtn.id, ixLb.last.components, GAVIN);
  await S.handleLeaderboardButton(ixLbFlip);
  ok('hub return row survives board flips',
    !!ixLbFlip.last && flat(ixLbFlip.last).some((c) => c.id.startsWith('hubback:')));
  // Open profile: picker on a standalone board, pick opens the hub.
  const board = await S.leaderboardPayload(GAVIN, 'overall');
  const profBtn = flat(board).find((c) => c.id.startsWith('lbprof:'));
  ok('standalone board carries Open profile', !!profBtn);
  if (profBtn) {
    const ixOP = hubIx(profBtn.id, board.components, GAVIN);
    await S.handleLbProfileButton(ixOP);
    ok('Open profile reveals the player picker',
      !!ixOP.last && flat(ixOP.last).some((c) => c.id.startsWith('lbprofpick:')));
    const names = selOptions(ixOP.last, 'lbprofpick:').map((o) => o.value).filter(Boolean);
    if (names.length) {
      const ixPickP = hubIx(flat(ixOP.last).find((c) => c.id.startsWith('lbprofpick:')).id,
        ixOP.last.components, GAVIN);
      ixPickP.values = [names[0]];
      await S.handleLbProfileSelect(ixPickP);
      ok('Open profile pick opens that player\'s hub',
        !!ixPickP.last && hasFile(ixPickP.last)
          && flat(ixPickP.last).some((c) => c.id.startsWith('hub:tab:')));
    }
  }
  // Compare branch: opens at once for another member, and the
  // hub return survives compare view flips.
  const hubC = await S.hubPayload('IronVale', CHOWDER, {});
  const cmpBtn = flat(hubC).find((c) => c.id.startsWith('hub:cmp:'));
  const ixCmp = hubIx(cmpBtn.id, hubC.components, CHOWDER);
  await S.handleHubButton(ixCmp);
  ok('hub Compare branch opens the matchup with the hub return',
    !!ixCmp.last && hasFile(ixCmp.last)
      && flat(ixCmp.last).some((c) => c.id.startsWith('hubback:') && c.label === '← Profile card'));
  if (ixCmp.last) {
    const viewBtn = flat(ixCmp.last).find((c) => c.id.startsWith('cmp:skills:'));
    if (viewBtn) {
      const ixView = hubIx(viewBtn.id, ixCmp.last.components, CHOWDER);
      await S.handleCompareButton(ixView);
      ok('hub return survives compare view flips',
        !!ixView.last && flat(ixView.last).some((c) => c.id.startsWith('hubback:')));
    }
  }
  // Profile buttons on the standalone cards.
  const kcP = await S.kcPayload('zulrah', 'IronVale', GAVIN);
  ok('kc card carries a Profile button',
    flat(kcP).some((c) => c.id.startsWith('prof:pvm:zulrah:')));
  const skP = await S.skillsPayload('IronVale', GAVIN);
  ok('skills card carries a Profile button',
    flat(skP).some((c) => c.id.startsWith('prof:skills:')));
  const dlP = await S.dryListPayload('IronVale', GAVIN, 'all');
  ok('dry list carries a Profile button',
    flat(dlP).some((c) => c.id.startsWith('prof:dry:list:')));
  const ctP = await S.clogPayload('total', 'IronVale', GAVIN);
  ok('clog total carries a Profile button',
    flat(ctP).some((c) => c.id.startsWith('prof:clogs:total:')));
  const profBtnKc = flat(kcP).find((c) => c.id.startsWith('prof:'));
  const ixProf = hubIx(profBtnKc.id, kcP.components, GAVIN);
  await S.handleProfileButton(ixProf);
  ok('Profile button opens the hub on the boss',
    !!ixProf.last && hasFile(ixProf.last)
      && flat(ixProf.last).some((c) => c.id.startsWith('hub:pickboss:')));
  // Compare autocomplete: linked + clan names first, capped at 25.
  const acIx = {
    commandName: 'compare', user: { id: GAVIN }, choices: null,
    options: {
      getFocused: () => ({ name: 'player_a', value: 'pt' }),
      getString: () => null,
    },
    respond: async (c) => { acIx.choices = c; },
  };
  await S.handleAutocomplete(acIx);
  ok('compare autocomplete returns linked/clan matches',
    Array.isArray(acIx.choices) && acIx.choices.length > 0 && acIx.choices.length <= 25
      && acIx.choices.some((c) => c.value === 'IronVale'),
    JSON.stringify(acIx.choices || []).slice(0, 120));
  const acIx2 = {
    commandName: 'compare', user: { id: GAVIN }, choices: null,
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
  for (const id of ['hub:tab:skills:💥💥', 'hub:lb:garbage', 'hub:chg:x|y', 'prof:pvm::IronVale', 'hubback:💥']) {
    const ix = hubIx(id, [], GAVIN);
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
  const shard = L.dryReport({ commander_zilyana: 466 }, [{ id: 11822, quantity: 0 }]);
  const shardRow = shard && shard.missing[0];
  ok('dry rate: shared single rate shows as-is', !!shardRow
    && Math.abs(shardRow.rate - 0.0006561679790026247) < 1e-9 && shardRow.kc === 466,
    shardRow && String(shardRow.rate));
  async function fakeDryMsg(userId, args) {
    const replies = [];
    const msg = {
      author: { id: userId },
      reply: async (p) => { replies.push(p); return { edit: async (p2) => { replies.push(p2); } }; },
    };
    await S.handleDryCommand(msg, args);
    return replies;
  }
  const nameList = await fakeDryMsg('drytest-a', ['ksen']);
  ok('!dry <name> opens the driest list', !!(nameList[0] && nameList[0].files),
    nameList[0] && nameList[0].content);
  const bossCard = await fakeDryMsg('drytest-b', ['zulrah', 'ksen']);
  ok('!dry <boss> <name> opens the boss card', !!(bossCard[0] && bossCard[0].files),
    bossCard[0] && bossCard[0].content);
  // Chowder's linked account, not Alex's: earlier sections
  // already spent Alex's per-command dry cooldown in this
  // same process, and a bare !dry is judged by its payload,
  // not by whose list it opens. (Fresh-process proof of the
  // Alex bare case was verified separately.)
  const ownList = await fakeDryMsg(CHOWDER, []);
  ok('!dry alone opens own list', !!(ownList[0] && ownList[0].files),
    ownList[0] && ownList[0].content);

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
