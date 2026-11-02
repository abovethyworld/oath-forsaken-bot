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
async function t(name, fn, needFile = true) {
  let p = null, threw = null;
  try { p = await fn(); } catch (e) { threw = e; }
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
  const dryHard = await S.dryPayload('clue:hard', 'IronVale', GAVIN);
  ok('dry renders for hard clues', hasFile(dryHard),
    dryHard && dryHard.content ? dryHard.content.slice(0, 80) : '');
  ok('clue dry card has the Clues bridge',
    !!(dryHard && dryHard.components) && flat(dryHard).some((c) => c.id.startsWith('bridge:clues:')));
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

  console.log(`\nRESULT: ${pass} pass, ${fail} fail`);
  if (fails.length) console.log('FAILURES:', fails.join(' ;; '));
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('SCRIPT FAIL', e); process.exit(1); });
