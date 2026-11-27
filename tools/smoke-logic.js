// Logic smoke suite: everything that acts on people or writes data,
// plus every exact-wording check. Membership standing and holds,
// seniority sync, RSN links and the staff link panel, website
// controls, leaver cleanup, WOM sync alerts, role watch and the role
// sync panel, sync-settled, the application pre-link flow, card
// Refresh charge rules, the help menu copy, the /total fixture block
// and the approval skills-card block.
//
// What this suite touches (be exact, nothing is hidden):
//   READS   src/ and config.json of the tree it sits in.
//   WRITES  data/*.json in THAT tree: membership.json, rsn-links.json,
//           cc-checklist.json, seniority-assigned.json,
//           seniority-holds.json, tenure.json, sync-settled.json,
//           cleanup-cases.json, departed.json, luck-tuning.json and
//           more, always with fake 99000... ids. Scratch folders go
//           under the OS temp dir. Several sections still snapshot
//           and restore the files they touch; in the sandbox that is
//           belt and braces, since the whole tree is thrown away.
//   POSTS   nothing to Discord (fake guilds, members and threads).
//
// It must NEVER run against a live data/ folder. It refuses to start
// unless data/.smoke-sandbox exists, which only tools/run-suites.sh
// creates, in a throwaway copy of src/ + tools/ with fixture data:
//   bash tools/run-suites.sh logic
// Killing a run mid-way leaves nothing real damaged: the runner also
// checksums the real data/ before and after and fails if it moved.
//
const fs = require('fs');
const path = require('path');
const DATA_GUARD = path.join(__dirname, '..', 'data');
if (!fs.existsSync(path.join(DATA_GUARD, '.smoke-sandbox'))) {
  console.error('SMOKE LOGIC: refusing to run: ' + DATA_GUARD + ' is not a sandbox (no .smoke-sandbox marker).\n'
    + 'This suite writes data files. Run it through tools/run-suites.sh.');
  process.exit(2);
}
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
const LORE = require(path.join(__dirname, '..', 'src', 'lore.js'));
const GD = require(path.join(__dirname, '..', 'src', 'guide.js'));
const L = require(path.join(__dirname, '..', 'src', 'luck.js'));
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


// Offline guard (set by tools/run-suites.sh as SMOKE_OFFLINE=1): the
// sandboxed suites run on fixture data only, so any request to a host
// other than the local card stub fails at once instead of reaching
// RuneProfile / Wise Old Man. Without it a cold fixture name queues
// behind RuneProfile's 2.5 s request pacing and one section can wait
// minutes on live 404s. A direct run in the bot container leaves it
// unset and behaves exactly as before.
if (process.env.SMOKE_OFFLINE === '1') {
  const realFetch = global.fetch;
  global.fetch = (url, opts) => {
    const u = String(url && url.url ? url.url : url);
    if (/^https?:\/\/(127\.0\.0\.1|localhost)[:/]/.test(u)) return realFetch(url, opts);
    return Promise.reject(new TypeError('smoke offline: blocked ' + u.slice(0, 80)));
  };
}

// Per-section timing: sec() closes the previous section with its
// wall time and opens the next, so slow sections show in the log.
let secName = null, secStart = 0;
const secTimes = [];
function sec(name) {
  const now = Date.now();
  if (secName) {
    secTimes.push({ name: secName, ms: now - secStart });
    console.log(`SECTION-TIME ${secName}: ${now - secStart}ms`);
  }
  secName = name; secStart = now;
}
(async () => {
  sec('Q. luck tuning file');
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

  sec('R. application pre-link');
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
    const typeQs = Object.values(cfg.recruit.types).map((t) => (t.questions || []).map((q) => q.id));
    ok('prelink: config has no age question', typeQs.every((ids) => !ids.includes('age')), JSON.stringify(typeQs));
    ok('prelink: modal fields are rsn, nickname, heard', typeQs.every((ids) => JSON.stringify(ids) === JSON.stringify(['rsn', 'nickname', 'heard'])), JSON.stringify(typeQs));

    // Staff card: house red always, Link state field present.
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
    ok('prelink: fail safe link state reads for staff',
      R.linkStateFieldText('failsafe', 0) === 'Fail safe: name not on Wise Old Man after two tries - let through unchecked');
    ok('prelink: fail safe stores no badge',
      R.recordBadgeFor({ linkState: 'failsafe', type: 'iron', badgePicked: true, badge: 'ironman' }) === null);
    ok('prelink: fail safe gate stops the first failed check',
      R.noteRsnCheck('smoke-gate-user', 0) === 'stop');
    ok('prelink: fail safe gate lets the second failed check through',
      R.noteRsnCheck('smoke-gate-user', 0) === 'through');
    ok('prelink: fail safe gate restarts its count after tripping',
      R.noteRsnCheck('smoke-gate-user', 0) === 'stop');
    ok('prelink: a found name clears the fail count',
      R.noteRsnCheck('smoke-gate-user', 3) === 'confirm' && R.noteRsnCheck('smoke-gate-user', 0) === 'stop');
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
    ok('prelink: iron pick routes every badge id plus auto',
      ['ironman', 'hc', 'ult', 'gim', 'ugim', 'hcgim', 'auto'].every((id) => mpJson.includes(`apply:pick:${id}`)), mpJson);
    const gk = R.guestKindPayload();
    const gkJson = JSON.stringify(gk.components.map((r) => r.toJSON()));
    ok('prelink: guest pick screen asks the approved question', gk.content === 'What game mode do you play?', gk.content);
    ok('prelink: guest pick puts Ironman before Main',
      gkJson.indexOf('apply:pickkind:ironman') > -1 && gkJson.indexOf('apply:pickkind:main') > gkJson.indexOf('apply:pickkind:ironman'), gkJson);
    ok('prelink: guest pick carries the mode emojis', gkJson.includes(cfg.recruit.ironEmojiId) && gkJson.includes(cfg.recruit.mainEmojiId), gkJson);
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
    // Nickname warning (Nov 8, 2026): the nickname box in every type's
    // form carries the locked placeholder; the other boxes carry none.
    const nickText = 'This becomes your server nickname: Name [RSN]. Example: Mike [Durial321]';
    const nickOk = ['iron', 'main', 'guest'].every((tp) => {
      const m = R.buildFormModal(tp).toJSON();
      const byId = {};
      for (const row of m.components) for (const c of row.components) byId[c.custom_id] = c;
      return byId.nickname && byId.nickname.placeholder === nickText && !byId.rsn.placeholder && !byId.heard.placeholder;
    });
    ok('nickname warning: placeholder on the nickname box, all types', nickOk);
    ok('prelink: main records main without a pick', R.recordBadgeFor({ type: 'main', linkState: 'verified', badgePicked: false, badge: null }) === 'main');
    ok('prelink: the up-front pick applies to the record', R.recordBadgeFor({ type: 'iron', linkState: 'verified', badgePicked: true, badge: 'hc' }) === 'hc');
    ok('prelink: Not sure stores no badge', R.recordBadgeFor({ type: 'guest', linkState: 'partial', badgePicked: true, badge: null }) === null);
    ok('prelink: unchecked applies no badge', R.recordBadgeFor({ type: 'iron', linkState: 'unchecked', badgePicked: true, badge: 'hc' }) === null
      && R.recordBadgeFor({ type: 'main', linkState: 'unchecked', badgePicked: false, badge: null }) === null);

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
    ok('prelink: DM says linked when all link', R.approvalDmText({ attempted: true, linked: ['Found Name'], failed: [] }).includes('**Your RSN is already linked and your types are set:** **Found Name**.'));
    ok('prelink: DM is honest on failure', R.approvalDmText({ attempted: true, linked: [], failed: [{ rsn: 'Found Name', reason: 'x' }] }).includes('Your link needs a hand for: Found Name.'));
    ok('prelink: legacy DM unchanged without a record', R.approvalDmText({ attempted: false, linked: [], failed: [] }) === '⛧ Welcome to Oath Forsaken ⛧\n\nYour application was approved.');

    // Welcome posts: linked members are not told to link.
    ok('prelink: initiate welcome swaps the link bullet', U.buildInitiateWelcome('111', ['Found Name']).includes('**Your RSN is already linked:** **Found Name**')
      && U.buildInitiateWelcome('111').includes('Hit **Link RSN**'));
    ok('prelink: guest welcome only adds the line when linked', U.buildGuestWelcome('111', ['Found Name']).includes('**Your RSN is already linked:** **Found Name**')
      && !U.buildGuestWelcome('111').includes('already linked'));

    // Join flag age math: 29 days flags, 30 does not.
    const nowMs = Date.UTC(2026, 10, 5);
    const mkUser = (days) => ({ id: '42', tag: 'newbie', createdAt: new Date(nowMs - days * 86400000) });
    ok('prelink: join flag fires at 29 days', !!R.youngAccountFlag(mkUser(29), nowMs));
    ok('prelink: join flag silent at 30 days', R.youngAccountFlag(mkUser(30), nowMs) === null);
    ok('prelink: join flag text', R.youngAccountFlag(mkUser(3), nowMs).text === 'New account flagged: <@42> (newbie). Discord account is 3 days old, under the 30 day mark. Flagged at join.');
    ok('prelink: join flag wired in the join handler', indexSrc.includes('youngAccountFlag(member.user)'));
  }

  sec('S. cc checklist wiring');
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

  sec('T. membership standing + holds + seniority sync');
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
    ok('standing: sync keeps an assigned record and honors staff removals',
      senioritySrc4.includes('getSeniorityAssigned') && senioritySrc4.includes('assignedRecords[m.id]'));
    const seedAt = indexSrc4.indexOf('await seedMembership(client)');
    const firstSyncAt = indexSrc4.indexOf('await syncSeniority(client)');
    ok('standing: startup seeds standing before the first sync', seedAt >= 0 && firstSyncAt > seedAt);

    // Snapshot every data file the fixtures touch.
    const touched = ['wom-group.json', 'rsn-links.json', 'tenure.json', 'membership.json', 'seniority-holds.json', 'seniority-assigned.json', 'seniority.json'];
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
      memberTop: '990000000000000107',
      memberFirst: '990000000000000108',
      recordMember: '990000000000000109',
      recordGuest: '990000000000000110',
      memberRemoved: '990000000000000111',
      memberSeeded: '990000000000000112',
    };
    try {
      writeFixture('wom-group.json', [
        { rsn: 'Fake Wom' }, { rsn: 'Fake High' }, { rsn: 'Fake Low' },
        { rsn: 'Fake Asc' }, { rsn: 'Fake First' },
      ]);
      writeFixture('rsn-links.json', {
        [U.womMember]: { rsns: ['Fake Wom'], verified: ['Fake Wom'] },
        [U.memberHigh]: { rsns: ['Fake High'], verified: ['Fake High'] },
        [U.memberLow]: { rsns: ['Fake Low'], verified: ['Fake Low'] },
        [U.memberTop]: { rsns: ['Fake Top'] },
        [U.memberFirst]: { rsns: ['Fake First'], verified: ['Fake First'] },
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

      // Hold round-trip: setting a hold stamps when it was set
      // (Nov 26, 2026); a legacy `true` value still reads as held.
      storeM.setSeniorityHold(TG, U.womMember, true);
      const holdsRaw = JSON.parse(fs.readFileSync(path.join(DATA, 'seniority-holds.json'), 'utf8'));
      ok('holds: setting a hold stamps the time',
        !!holdsRaw[TG] && typeof (holdsRaw[TG][U.womMember] || {}).at === 'number',
        JSON.stringify(holdsRaw[TG] || null));
      ok('holds: a stamped hold reads as held',
        storeM.isSeniorityHeld(TG, U.womMember) && storeM.getSeniorityHolds(TG).has(U.womMember));
      ok('holds: the records getter returns the stamp',
        typeof (storeM.getSeniorityHoldRecords(TG)[U.womMember] || {}).at === 'number');
      writeFixture('seniority-holds.json', { [TG]: { [U.plainGuest]: true } });
      ok('holds: a legacy unstamped hold still reads as held',
        storeM.isSeniorityHeld(TG, U.plainGuest) && !storeM.isSeniorityHeld(TG, U.womMember));
      ok('holds: the records getter keeps a legacy hold as true',
        storeM.getSeniorityHoldRecords(TG)[U.plainGuest] === true);
      storeM.setSeniorityHold(TG, U.plainGuest, false);
      ok('holds: releasing a hold removes it',
        !storeM.isSeniorityHeld(TG, U.plainGuest) && storeM.getSeniorityHolds(TG).size === 0);
      writeFixture('seniority-holds.json', {});

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
          [U.memberRemoved]: { standing: 'member', at: 1, via: 'approval' },
          [U.memberSeeded]: { standing: 'member', at: 1, via: 'approval' },
          [U.memberLow]: { standing: 'member', at: 1, via: 'approval' },
          [U.memberFirst]: { standing: 'member', at: 1, via: 'approval' },
        },
      });
      writeFixture('seniority-assigned.json', {
        [GID]: { [U.memberRemoved]: { rank: 'Initiate', at: 1 } },
      });
      writeFixture('seniority.json', {
        generatedAt: 'fixture',
        ranks: { [U.memberSeeded]: { rank: 'Initiate', months: 0.1, stretchStart: null, bankedMs: 0 } },
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
        mkMember(U.memberTop, [RIDS.godslayer]),
        mkMember(U.memberFirst, []),
        mkMember(U.recordMember, [RIDS.initiate]),
        mkMember(U.recordGuest, [RIDS.acolyte]),
        mkMember(U.memberRemoved, []),
        mkMember(U.memberSeeded, []),
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
      ok('standing: (d) a Godslayer holder is untouched', !entryFor(U.memberTop), joined);
      ok('standing: a recorded member not on the WOM list still ranks up',
        entryFor(U.recordMember) === `fake${U.recordMember.slice(-3)}: Initiate → Devout`, joined);
      ok('standing: a recorded guest is skipped, rank and all',
        !entryFor(U.recordGuest), joined);
      ok('standing: a member with no rank gets the first assignment',
        entryFor(U.memberFirst) === `fake${U.memberFirst.slice(-3)}: None → Initiate (initial)`, joined);
      ok('standing: a member whose rank staff removed is never re-assigned',
        !entryFor(U.memberRemoved), joined);
      ok('standing: a removal from before the assigned record is honored via the last publish',
        !entryFor(U.memberSeeded), joined);
      // Reset the module caches so later checks bind to the real data.
      delete require.cache[tenurePath];
      delete require.cache[seniorityPath];
      require(seniorityPath);
    } finally {
      restoreAll();
    }
  }

  sec('U. staff rsn link + h1/h2');
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
    ok('stafflink: audit line posts to the joins/leaves log', slSrc.includes('config.channels.joinsLeaves') && slSrc.includes('Staff link:'));

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

    // Security fix H1/H2 (Nov 24, 2026): the merge drops a request for a
    // name linked (verified or not) to another member, and markVerified
    // never stamps a name already on another member's list.
    {
      const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'smoke-linkreq2-'));
      const calls2 = [];
      const holders = { 'Held Name': '222222222', 'Own Name': '123456789' };
      const deps2 = {
        dir: dir2,
        addRsn: (did, rsn) => calls2.push(['add', did, rsn]),
        linkRsnQuiet: (did, rsn) => calls2.push(['quiet', did, rsn]),
        verifiedOwnerOf: () => null,
        otherLinkHolderOf: (rsn, did) => (holders[rsn] && holders[rsn] !== did ? holders[rsn] : null),
      };
      fs.writeFileSync(path.join(dir2, 'a.json'), JSON.stringify({ discordId: '123456789', rsn: 'Held Name' }));
      fs.writeFileSync(path.join(dir2, 'b.json'), JSON.stringify({ discordId: '123456789', rsn: 'Held Name', quiet: true }));
      fs.writeFileSync(path.join(dir2, 'c.json'), JSON.stringify({ discordId: '123456789', rsn: 'Own Name' }));
      fs.writeFileSync(path.join(dir2, 'd.json'), JSON.stringify({ discordId: '123456789', rsn: 'Free Name' }));
      const errs = console.error; console.error = () => {};
      let merged2;
      try { merged2 = LR.mergeSiteLinkRequests(deps2); } finally { console.error = errs; }
      ok('h1: any-owner merge drops unverified-held names, keeps own and free',
        merged2 === 2 && calls2.length === 2 && calls2[0][2] === 'Own Name' && calls2[1][2] === 'Free Name' && fs.readdirSync(dir2).length === 0,
        JSON.stringify(calls2));
      fs.rmSync(dir2, { recursive: true, force: true });

      const tFile = path.join(DATA, 'rsn-links.json');
      const tSaved = fs.existsSync(tFile) ? fs.readFileSync(tFile) : null;
      const errs2 = console.error; console.error = () => {};
      try {
        fs.writeFileSync(tFile, JSON.stringify({
          '990000000000000201': { rsns: ['Squat Name'] },
          '990000000000000202': { rsns: ['Mine Name'] },
        }));
        ok('h2: otherLinkHolderOf finds an unverified holder',
          T.otherLinkHolderOf('squat name', '990000000000000202') === '990000000000000201'
          && T.otherLinkHolderOf('Squat Name', '990000000000000201') === null);
        ok('h2: markVerified refuses a name on another member\'s list',
          T.markVerified('990000000000000202', 'Squat Name', 5) === false
          && !T.loadRsnLinks()['990000000000000202'].rsns.includes('Squat Name')
          && !(T.loadRsnLinks()['990000000000000201'].verified || []).includes('Squat Name'));
        ok('h2: markVerified still stamps a free name and the holder\'s own name',
          T.markVerified('990000000000000202', 'Free Name', 6) === true
          && T.markVerified('990000000000000202', 'Mine Name', 7) === true
          && T.loadRsnLinks()['990000000000000202'].verified.includes('Mine Name'));
      } finally {
        console.error = errs2;
        if (tSaved === null) { try { fs.unlinkSync(tFile); } catch {} } else fs.writeFileSync(tFile, tSaved);
      }
    }

    // M1/M2.3: snapshot builder shape and the leave hook.
    {
      const PC = require(path.join(__dirname, '..', 'src', 'plugin-connect.js'));
      const fakeGuild = {
        id: 'G1',
        roles: { cache: new Map([['G1', { id: 'G1', name: '@everyone' }], ['R1', { id: 'R1', name: 'Member' }]]) },
      };
      const fakeMembers = new Map([['U1', { id: 'U1', roles: { cache: new Map([['G1', {}], ['R1', {}]]) } }]]);
      const snap = PC.buildRolesSnapshot(fakeGuild, fakeMembers);
      ok('m1: snapshot has generatedAt, members->role ids, role names',
        typeof snap.generatedAt === 'string' && JSON.stringify(snap.members) === '{"U1":["R1"]}' && snap.roles.R1 === 'Member');
      const idxSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.js'), 'utf8');
      ok('m2: guildMemberRemove revokes the connect code', /GuildMemberRemove[\s\S]{0,200}revokeCodeFor\(member\.id\)/.test(idxSrc));
      ok('m1: snapshot published at startup and on a 5-minute loop',
        idxSrc.includes('await publishRolesSnapshot(client)') && /roles-snapshot[^\n]*5 \* 60 \* 1000/.test(idxSrc));
    }
  }

  sec('V. not-in-clan marker');
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
      'seniority ladder': cfgN.seniority.rankIds.godslayer,
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

  sec('W. card refresh');
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
    // Forged or stale refresh ids end quietly, before any defer.
    for (const bad of ['refresh:kc::', 'refresh:dry:zulrah:', 'refresh:hub:garbage', 'refresh:nope:x:y']) {
      let threw = false;
      try { await S.handleRefreshButton({ customId: bad, user: { id: UID }, reply: async () => {} }); } catch { threw = true; }
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
    ok('refresh: kc button label is Refresh', !!kcBtn && kcBtn.label === 'Refresh', kcBtn && kcBtn.label);
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

  sec('X. website controls');
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

    // Panel: one Danger button with the exact label, house red.
    const wcPanel = WC.panelPayload();
    const wcPanelJson = JSON.stringify(wcPanel.components.map((r) => r.toJSON()));
    const wcPanelFlat = wcPanel.components.flatMap((r) => r.components);
    ok('webctl: panel button is labelled Set standing', wcPanelJson.includes('"label":"Set standing"') && wcPanelJson.includes('webctl:open'), wcPanelJson);
    ok('webctl: panel carries exactly one button', wcPanelFlat.length === 1, wcPanelJson);
    ok('webctl: panel button is Danger', wcPanelJson.includes('"style":4'), wcPanelJson);
    ok('webctl: panel embed is house red and titled Website controls',
      wcPanel.embeds[0].data.color === 0x6b0e0e && wcPanel.embeds[0].data.title === 'Website controls');
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
      ok('webctl: picker step carries the standing buttons and the two clan actions',
        spJson.includes(`webctl:set:member:${WU1}`) && spJson.includes(`webctl:set:guest:${WU1}`)
        && spJson.includes(`webctl:remove:${WU1}`) && spJson.includes(`webctl:friend:${WU1}`)
        && !spJson.includes('webctl:set:clear'), spJson);

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

      // Move to Friend deletes only that entry: the other member
      // in the guild and the other guild's record both survive.
      const friend = fakeIx({ staff: true, customId: `webctl:friend:${WU1}` });
      await WC.handleWebsiteControlsButton(friend);
      const afterFriend = JSON.parse(fs.readFileSync(memPath, 'utf8'));
      ok('webctl: Move to Friend deletes only that entry',
        !(WU1 in (afterFriend[WG] || {})) && afterFriend[WG][WU2].standing === 'member'
        && afterFriend[WG2][WU3].standing === 'member'
        && friend.replies[0].content === `The record for <@${WU1}> was cleared. They show as a Friend of the Clan while they hold the Friend role.`,
        JSON.stringify(afterFriend));

      // Moving a member with no record changes nothing and
      // says so.
      const friendNone = fakeIx({ staff: true, customId: `webctl:friend:${WU1}` });
      await WC.handleWebsiteControlsButton(friendNone);
      ok('webctl: Move to Friend with no record is a truthful no-op',
        friendNone.replies[0].content === `There is no record for <@${WU1}>. Nothing changed.`, JSON.stringify(friendNone.replies));
    } finally {
      if (memSaved === null) { try { fs.unlinkSync(memPath); } catch {} }
      else fs.writeFileSync(memPath, memSaved);
    }
  }

  sec('Y. leaver cleanup');
  // Leaver cleanup (Nov 26, 2026): a departure opens a case that
  // runs the reversible removal steps (record marked left, link
  // parked in the case, checklist closed plus a Remove CC rank
  // entry, departed snapshot), and a staff Restore from the case
  // puts it all back. The flows run against fixture data files
  // with a fake guild and thread; every touched file is restored
  // byte for byte afterwards.
  {
    const LC = require(path.join(__dirname, '..', 'src', 'leaver-cleanup.js'));
    const storeC = require(path.join(__dirname, '..', 'src', 'store.js'));
    const cfgCl = require(path.join(__dirname, '..', 'src', 'config.js'));
    const { Collection } = require('discord.js');
    const indexSrcCl = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.js'), 'utf8');
    const GIDCL = cfgCl.guildId;
    const THREADCL = cfgCl.ccChecklist.threadId;
    const IRONCL = cfgCl.teams.ironSwornRoleId;
    const INITIATECL = cfgCl.seniorityRanks.find((r) => r.minMonths === 0).roleId;
    const UCL = { leaver: '990000000000000401', stayer: '990000000000000402' };

    // Wiring: the case opens on leave after the WOM snapshot, the
    // restore offer posts on rejoin, the button is routed.
    ok('cleanup: index opens the case on leave, after the WOM snapshot',
      indexSrcCl.indexOf('onCleanupLeave(client, member)') > indexSrcCl.indexOf('onWomSyncLeave(client, member)'));
    ok('cleanup: index posts the restore offer on rejoin', indexSrcCl.includes('onCleanupRejoin(client, member)'));

    const touchedCl = ['membership.json', 'rsn-links.json', 'cc-checklist.json', 'cleanup-cases.json', 'departed.json', 'seniority-assigned.json'];
    const savedCl = {};
    for (const name of touchedCl) {
      const p = path.join(DATA, name);
      savedCl[name] = fs.existsSync(p) ? fs.readFileSync(p) : null;
    }
    const writeFixtureCl = (name, obj) => fs.writeFileSync(path.join(DATA, name), JSON.stringify(obj));
    const restoreCl = () => {
      for (const name of touchedCl) {
        const p = path.join(DATA, name);
        if (savedCl[name] === null) { try { fs.unlinkSync(p); } catch {} }
        else fs.writeFileSync(p, savedCl[name]);
      }
    };
    writeFixtureCl('membership.json', {
      [GIDCL]: {
        [UCL.leaver]: { standing: 'member', at: Date.now() - 48 * 3600 * 1000, via: 'approval' },
        [UCL.stayer]: { standing: 'member', at: Date.now() - 48 * 3600 * 1000, via: 'approval' },
      },
    });
    writeFixtureCl('rsn-links.json', {
      [UCL.leaver]: { rsns: ['Leaver Rsn'], verified: ['Leaver Rsn'], active: 'Leaver Rsn' },
      [UCL.stayer]: { rsns: ['Stayer Rsn'], active: 'Stayer Rsn' },
    });
    writeFixtureCl('cc-checklist.json', { entries: [], messageId: null, page: 0 });
    writeFixtureCl('seniority-assigned.json', { [GIDCL]: { [UCL.leaver]: { rank: 'Initiate', at: 1 } } });
    try { fs.unlinkSync(path.join(DATA, 'cleanup-cases.json')); } catch {}
    try { fs.unlinkSync(path.join(DATA, 'departed.json')); } catch {}

    const sentCl = [];
    const fakeThreadCl = {
      send: async (opts) => { sentCl.push(opts); return { id: `cleanup-fake-${sentCl.length}` }; },
      messages: { fetch: async () => null },
    };
    const leaverRolesCl = new Collection([[IRONCL, { id: IRONCL }], [INITIATECL, { id: INITIATECL }]]);
    const fakeLeaverCl = {
      id: UCL.leaver, displayName: 'Leaver', user: { username: 'leaver', bot: false },
      roles: { cache: leaverRolesCl },
    };
    const fakeGuildCl = {
      id: GIDCL,
      channels: { cache: new Map([[THREADCL, fakeThreadCl]]) },
      roles: { cache: new Map([[IRONCL, { id: IRONCL }], [INITIATECL, { id: INITIATECL }]]) },
      members: { fetch: async (id) => (id === UCL.leaver ? fakeLeaverCl : null), cache: new Map() },
    };
    fakeLeaverCl.guild = fakeGuildCl;
    const fakeClientCl = {
      channels: { fetch: async () => fakeThreadCl },
      guilds: { cache: new Map([[GIDCL, fakeGuildCl]]) },
    };
    const readJsonCl = (name) => JSON.parse(fs.readFileSync(path.join(DATA, name), 'utf8'));
    try {
      const openedCl = await LC.onMemberLeave(fakeClientCl, fakeLeaverCl);
      const caseCl = LC.getCase(UCL.leaver);
      ok('cleanup: a server leave opens a case with the full snapshot',
        openedCl === true && !!caseCl && caseCl.priorStanding === 'member'
        && caseCl.priorLink.rsns.includes('Leaver Rsn') && caseCl.priorRank === 'Initiate'
        && caseCl.priorRoleIds.includes(IRONCL) && caseCl.priorRoleIds.includes(INITIATECL),
        JSON.stringify(caseCl));
      ok('cleanup: the case marks the record left and parks the link',
        storeC.getMembership(GIDCL)[UCL.leaver].standing === 'left'
        && !(UCL.leaver in readJsonCl('rsn-links.json')));
      const entriesCl = readJsonCl('cc-checklist.json').entries;
      ok('cleanup: the case adds one Remove CC rank entry',
        entriesCl.length === 1 && entriesCl[0].userId === UCL.leaver
        && entriesCl[0].newRank === 'Remove' && entriesCl[0].oldRank === 'Initiate',
        JSON.stringify(entriesCl));
      ok('cleanup: the case post carries the restore button',
        sentCl.some((m) => typeof m.content === 'string' && m.content.includes('left the server')
          && JSON.stringify(m.components || []).includes(`cleanup:restore:${UCL.leaver}`)),
        JSON.stringify(sentCl.map((m) => m.content)));
      ok('cleanup: the departure is snapshotted for the WOM alert',
        !!readJsonCl('departed.json')[UCL.leaver]);
      const openedAgainCl = await LC.onMemberLeave(fakeClientCl, fakeLeaverCl);
      ok('cleanup: a second leave opens no second case', openedAgainCl === false && !!LC.getCase(UCL.leaver));

      // Rejoin: the offer posts, and Restore puts everything back.
      const rejoinRolesCl = new Collection();
      const rejoinAddedCl = [];
      const fakeRejoinCl = {
        id: UCL.leaver, displayName: 'Leaver', user: { username: 'leaver', bot: false },
        roles: { cache: rejoinRolesCl, add: async (id) => { rejoinAddedCl.push(id); rejoinRolesCl.set(id, { id }); } },
        guild: fakeGuildCl,
      };
      const offeredCl = await LC.onMemberRejoin(fakeClientCl, fakeRejoinCl);
      ok('cleanup: a rejoin with an open case posts the restore offer',
        offeredCl === true && sentCl.some((m) => typeof m.content === 'string' && m.content.includes('back in the server')));
      const restoredCl = await LC.restoreCase(fakeClientCl, fakeGuildCl, UCL.leaver, fakeRejoinCl);
      ok('cleanup: restore puts back standing, link, roles, and rank eligibility',
        restoredCl === true
        && storeC.getMembership(GIDCL)[UCL.leaver].standing === 'member'
        && readJsonCl('rsn-links.json')[UCL.leaver].rsns.includes('Leaver Rsn')
        && rejoinAddedCl.includes(IRONCL) && rejoinAddedCl.includes(INITIATECL)
        && !(UCL.leaver in (readJsonCl('seniority-assigned.json')[GIDCL] || {}))
        && !LC.getCase(UCL.leaver),
        JSON.stringify(rejoinAddedCl));
      ok('cleanup: restore closes the removal entry',
        !readJsonCl('cc-checklist.json').entries.some((e) => e.userId === UCL.leaver));
      const restoredAgainCl = await LC.restoreCase(fakeClientCl, fakeGuildCl, UCL.leaver, fakeRejoinCl);
      ok('cleanup: a second restore is a no-op', restoredAgainCl === false);

      // Panel remove: a case opens with the panel as its source.
      const panelCaseCl = await LC.onPanelRemove(fakeClientCl, fakeGuildCl, UCL.stayer, '990000000000000900');
      ok('cleanup: a panel remove opens a panel case',
        !!panelCaseCl && panelCaseCl.openedBy === 'panel'
        && storeC.getMembership(GIDCL)[UCL.stayer].standing === 'left',
        JSON.stringify(panelCaseCl));
    } finally {
      restoreCl();
    }
  }

  // ---- leaver cleanup part 2 (day-7 close) ----
  {
    const LC2 = require(path.join(__dirname, '..', 'src', 'leaver-cleanup.js'));
    const PC2 = require(path.join(__dirname, '..', 'src', 'plugin-connect.js'));
    const cfg2 = require(path.join(__dirname, '..', 'src', 'config.js'));
    const DAY2 = 24 * 3600 * 1000;
    const NOW2 = Date.now();
    const U2 = { young: '990000000000000501', old: '990000000000000502', fail: '990000000000000503' };
    const rsnY = 'Part2 Young Rsn';
    const rsnO = 'Part2 Old Rsn';
    const rsnF = 'Part2 Fail Rsn';
    const archiveDir2 = path.join(path.dirname(path.dirname(PC2.recordPath(rsnO))), 'archive');
    const files2 = [LC2.CASES_FILE, LC2.CLOSED_FILE, PC2.recordPath(rsnY), PC2.recordPath(rsnO), PC2.recordPath(rsnF), path.join(archiveDir2, path.basename(PC2.recordPath(rsnO)))];
    const saved2 = new Map(files2.map((f) => [f, fs.existsSync(f) ? fs.readFileSync(f) : null]));
    const archiveDirExisted2 = fs.existsSync(archiveDir2);
    const mkCase2 = (name, rsn, ageMs) => ({
      openedAt: NOW2 - ageMs, openedBy: 'leave', by: null, name, rsns: [rsn],
      priorStanding: 'member', priorLink: { rsns: [rsn], active: rsn }, priorRank: 'Initiate', priorRoleIds: ['r1'],
    });
    const sent2 = [];
    const thread2 = { send: async (o) => { sent2.push(o); return { id: 'p2' }; } };
    const client2 = { channels: { fetch: async () => thread2 }, guilds: { cache: new Map() } };
    const cases2 = () => (fs.existsSync(LC2.CASES_FILE) ? JSON.parse(fs.readFileSync(LC2.CASES_FILE, 'utf8')) : {});
    const closed2 = () => (fs.existsSync(LC2.CLOSED_FILE) ? JSON.parse(fs.readFileSync(LC2.CLOSED_FILE, 'utf8')) : {});
    try {
      try { fs.unlinkSync(LC2.CLOSED_FILE); } catch {}
      fs.mkdirSync(path.dirname(PC2.recordPath(rsnY)), { recursive: true });
      for (const r of [rsnY, rsnO, rsnF]) fs.writeFileSync(PC2.recordPath(r), JSON.stringify({ rsn: r }));
      fs.writeFileSync(LC2.CASES_FILE, JSON.stringify({
        [U2.young]: mkCase2('Young', rsnY, 7 * DAY2 - 3600 * 1000),
        [U2.old]: mkCase2('Old', rsnO, 7 * DAY2),
      }));

      await LC2.closeExpiredCases(client2, null, NOW2);
      ok('cleanup2: a 6d23h case is untouched',
        !!cases2()[U2.young] && fs.existsSync(PC2.recordPath(rsnY)) && !closed2()[U2.young]);
      const t2 = closed2()[U2.old];
      ok('cleanup2: a 7d case leaves the live file',
        !cases2()[U2.old] && LC2.getCase(U2.old) === null);
      ok('cleanup2: tombstone has no priorLink or priorRoleIds',
        !!t2 && t2.closedBy === 'day-7 sweep' && t2.closedAt === NOW2 && t2.name === 'Old'
        && t2.priorStanding === 'member' && t2.priorRank === 'Initiate' && t2.openedBy === 'leave'
        && !('priorLink' in t2) && !('priorRoleIds' in t2), JSON.stringify(t2));
      ok('cleanup2: the plugin record moved to archive/',
        !fs.existsSync(PC2.recordPath(rsnO))
        && fs.existsSync(path.join(archiveDir2, path.basename(PC2.recordPath(rsnO)))));
      ok('cleanup2: one staff line, no pings',
        sent2.length === 1 && sent2[0].content === LC2.TEXT.closed('Old', [rsnO])
        && JSON.stringify(sent2[0].allowedMentions) === JSON.stringify({ parse: [] }), JSON.stringify(sent2));
      console.log(`    staff line captured: ${sent2[0] && sent2[0].content}`);

      const casesBefore2 = fs.readFileSync(LC2.CASES_FILE, 'utf8');
      const closedBefore2 = fs.readFileSync(LC2.CLOSED_FILE, 'utf8');
      await LC2.closeExpiredCases(client2, null, NOW2 + 1000);
      ok('cleanup2: a second sweep changes nothing',
        fs.readFileSync(LC2.CASES_FILE, 'utf8') === casesBefore2
        && fs.readFileSync(LC2.CLOSED_FILE, 'utf8') === closedBefore2 && sent2.length === 1);

      // Forced archive failure: the case stays open.
      const orig2 = PC2.archiveRecordsFor;
      PC2.archiveRecordsFor = () => { throw new Error('forced'); };
      const errOrig2 = console.error;
      console.error = () => {};
      try {
        const c = cases2();
        c[U2.fail] = mkCase2('Fail', rsnF, 8 * DAY2);
        fs.writeFileSync(LC2.CASES_FILE, JSON.stringify(c));
        await LC2.closeExpiredCases(client2, null, NOW2);
      } finally {
        PC2.archiveRecordsFor = orig2;
        console.error = errOrig2;
      }
      ok('cleanup2: a failed archive keeps the case open',
        !!cases2()[U2.fail] && !closed2()[U2.fail] && fs.existsSync(PC2.recordPath(rsnF)) && sent2.length === 1);

      // Once closed, restore has nothing to act on and rejoin posts no offer.
      ok('cleanup2: getCase on a closed case is null (Restore answers already-closed)', LC2.getCase(U2.old) === null);
      const offersBefore2 = sent2.length;
      await LC2.onMemberRejoin(client2, { id: U2.old, displayName: 'Old' });
      ok('cleanup2: rejoin after close posts no offer', sent2.length === offersBefore2);
      ok('cleanup2: no guild, no client: still never throws',
        Array.isArray(await LC2.closeExpiredCases(null, null, NOW2)));
    } finally {
      for (const [f, buf] of saved2) {
        if (buf === null) { try { fs.unlinkSync(f); } catch {} }
        else fs.writeFileSync(f, buf);
      }
      if (!archiveDirExisted2) { try { fs.rmdirSync(archiveDir2); } catch {} }
    }
  }

  sec('Z. help menu + setup card');
  // ── Help menu + setup card + staff help ──
  // /help mimics the DropTracker menu: plain "Help Menu" title, logo
  // thumbnail, every member command as a slash mention pill plus one
  // plain sentence, a Bot Guide link row, and one red setup button.
  // /staff-help is the same shape for staff commands, gated on
  // Moderate Members. The setup card answers with the Getting
  // started page plus the scam line.
  GD.setCommandIds(new Map([
    ['connect', '101'], ['unlink', '102'], ['kc', '103'], ['clog', '104'],
    ['dry', '105'], ['skills', '106'], ['gains', '107'], ['profile', '108'],
    ['pb', '109'], ['leaderboard', '110'], ['compare', '111'], ['events', '112'],
    ['poll', '113'], ['poll-close', '114'], ['lore', '115'], ['help', '116'],
    ['warn', '117'], ['strikes', '118'], ['clear-strikes', '119'],
    ['seniority-hold', '120'], ['sync-seniority', '121'], ['apply-stats', '122'],
    ['reset-application', '123'], ['force-unlink', '124'], ['link-rsn-panel', '125'],
    ['event-create', '126'], ['event-cancel', '127'], ['roster', '128'],
    ['calendar-sync', '129'], ['bounty', '130'], ['setup-roles', '131'],
    ['setup-rules', '132'], ['setup-ranks', '133'], ['setup-strikes', '134'],
    ['setup-tickets', '135'], ['setup-cc-checklist', '136'], ['setup-applications', '137'],
    ['setup-team-panel', '138'], ['website-controls-panel', '139'], ['check-permissions', '140'],
  ]));
  const helpIx = fakeIx(null);
  helpIx.deleteReply = async () => {};
  await GD.commands.find((c) => c.data.name === 'help').run(helpIx);
  const menuPayload = helpIx.replied;
  const menuEmbedData = menuPayload && menuPayload.embeds && menuPayload.embeds[0]
    && menuPayload.embeds[0].data;
  const menuDesc = menuEmbedData && menuEmbedData.description;
  ok('help: menu is the plain index with mention pills',
    !!menuDesc && menuPayload.ephemeral === true
      && menuEmbedData.title === 'Help Menu'
      && menuEmbedData.thumbnail && menuEmbedData.thumbnail.url === 'https://oathforsaken.cc/assets/server-icon-helm.gif'
      && menuDesc.startsWith('Guides for everything are in the [Bot Guide](https://oathforsaken.cc/guide/).')
      && menuDesc.includes('**Your account**') && menuDesc.includes('**Cards**') && menuDesc.includes('**Clan**')
      && menuDesc.includes('</kc:103> - Posts the kill count and collection log card for a boss.')
      && menuDesc.includes('</compare:111> - Compares two players on one card.')
      && menuDesc.includes('</help:116> - Opens this help menu.'),
    menuDesc ? menuDesc.slice(0, 120) : 'no reply');
  const menuRows = menuPayload ? compsOf(menuPayload) : [];
  const menuBtns = menuRows.flat();
  const menuLinkUrl = menuPayload && menuPayload.components && menuPayload.components[0]
    && menuPayload.components[0].toJSON().components[0].url;
  ok('help: menu buttons are the guide link row + one gray setup button',
    menuRows.length === 2
      && menuRows[0].length === 1 && menuRows[0][0].label === 'Bot Guide ↗' && menuRows[0][0].style === 5
      && menuLinkUrl === 'https://oathforsaken.cc/guide/'
      && menuRows[1].length === 1 && menuRows[1][0].id === 'help:setup'
      && menuRows[1][0].label === '🙋 View Setup Guide' && menuRows[1][0].style === 2
      && !menuBtns.some((b) => /github|ko-fi/i.test(b.label)),
    JSON.stringify(menuBtns));

  const setupIx = fakeIx('help:setup');
  setupIx.deleteReply = async () => {};
  await GD.handleHelpButton(setupIx);
  const setupPayload = setupIx.replied;
  const setupDesc = setupPayload && setupPayload.embeds && setupPayload.embeds[0]
    && setupPayload.embeds[0].data.description;
  ok('help: setup card renders the getting-started steps + scam line',
    !!setupDesc && setupPayload.ephemeral === true
      && setupDesc.includes('1. Link your RSN.')
      && setupDesc.includes('3. Sync your collection log.')
      && setupDesc.includes('We never ask for a Jagex login anywhere. Anything that does is a scam.'),
    setupDesc ? setupDesc.slice(0, 120) : 'no reply');
  const setupBtns = setupPayload ? flat(setupPayload) : [];
  ok('help: setup card links guide + safety page',
    setupBtns.filter((b) => b.label === 'Bot Guide' || b.label === 'Safety').length === 2,
    JSON.stringify(setupBtns));
  ok('help: setup card links the DropTracker setup page',
    setupBtns.some((b) => b.label === 'Set up DropTracker' && b.style === 5),
    JSON.stringify(setupBtns));
  ok('help: setup card carries the DropTracker steps from the guide page',
    !!setupDesc
      && setupDesc.includes('DropTracker is a separate RuneLite plugin.')
      && setupDesc.includes('Install the plugin:')
      && setupDesc.includes('5. In the DropTracker settings, open the Advanced section and turn on Use API.')
      && setupDesc.includes('Run `/claim-rsn` with your in-game name.')
      && setupDesc.includes('Drops post only for names on the clan\'s Wise Old Man group.'),
    setupDesc ? setupDesc.slice(-220) : 'no reply');
  // The Link button reuses the #bot-guide post flow: buttons.js
  // routes the team: kind to handleTeamButton, so the team:rsn id
  // on the button IS the wiring.
  ok('help: setup card carries the Link RSN action on the shared team flow',
    setupBtns.some((b) => b.id === 'team:rsn' && b.label === 'Link your RSN' && b.style === 2),
    JSON.stringify(setupBtns));

  const staffCmd = GD.commands.find((c) => c.data.name === 'staff-help');
  ok('staff-help: registered with the Moderate Members default',
    !!staffCmd && staffCmd.data.toJSON().default_member_permissions === '1099511627776');
  const staffIx = fakeIx(null);
  staffIx.deleteReply = async () => {};
  staffIx.memberPermissions = { has: () => true };
  await staffCmd.run(staffIx);
  const staffPayload = staffIx.replied;
  const staffEmbedData = staffPayload && staffPayload.embeds && staffPayload.embeds[0]
    && staffPayload.embeds[0].data;
  const staffDesc = staffEmbedData && staffEmbedData.description;
  ok('staff-help: renders staff commands as pills for a permitted member',
    !!staffDesc && staffPayload.ephemeral === true
      && staffEmbedData.title === 'Staff Help'
      && staffDesc.includes('</warn:117> - Gives a member a strike and logs the reason.')
      && staffDesc.includes('</seniority-hold:120>')
      && staffDesc.includes('</check-permissions:140>')
      && !(staffPayload.components || []).length,
    staffDesc ? staffDesc.slice(0, 120) : 'no reply');
  const deniedIx = fakeIx(null);
  deniedIx.deleteReply = async () => {};
  deniedIx.memberPermissions = { has: () => false };
  await staffCmd.run(deniedIx);
  ok('staff-help: refuses a member without Moderate Members',
    !!deniedIx.replied && deniedIx.replied.ephemeral === true
      && deniedIx.replied.content === 'You do not have permission to use this command.'
      && !deniedIx.replied.embeds,
    JSON.stringify(deniedIx.replied));

  sec('AA. wom sync alerts');
  // WOM sync alerts (Nov 25, 2026): the bot watches for drift
  // between the Wise Old Man group and Discord and posts plain lines
  // to the CC checklist thread (leaves with RSNs still in the group,
  // members not in the group yet, group names matching no member).
  // The pure sweep runs on fake records here; the wrappers run
  // against fixture data files with a stubbed group fetch and a fake
  // checklist channel. Every file the fixtures touch is restored
  // byte for byte afterwards.
  {
    const ws = require(path.join(__dirname, '..', 'src', 'wom-sync-alerts.js'));
    const womM = require(path.join(__dirname, '..', 'src', 'wom.js'));
    const guildCacheM = require(path.join(__dirname, '..', 'src', 'guild-cache.js'));
    const cfgW = require(path.join(__dirname, '..', 'src', 'config.js'));
    const indexSrcW = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.js'), 'utf8');
    const GIDW = cfgW.guildId;
    const HOURW = 3600 * 1000;
    const NOWW = Date.now();

    // Wiring: the leave hook sits in the GuildMemberRemove handler
    // after the connect-code revoke; the sweep timer starts on ready.
    const revokeAtW = indexSrcW.indexOf('revokeCodeFor(member.id)');
    const leaveHookAtW = indexSrcW.indexOf('onWomSyncLeave(client, member)', revokeAtW);
    ok('womsync: index imports the module', indexSrcW.includes("require('./wom-sync-alerts')"));
    ok('womsync: leave hook runs after the connect-code revoke', revokeAtW >= 0 && leaveHookAtW > revokeAtW);
    ok('womsync: daily sweep timer starts on ready', indexSrcW.includes('startWomSyncAlerts(client)'));
    ok('womsync: index clears the departed case on rejoin', indexSrcW.includes('onWomSyncRejoin(member.id)'));

    // Name matching: case and underscores fold; alt notations split.
    ok('womsync: name keys fold case and underscores', ws.nameKeys('Fake_Name').includes('fake name'));
    ok('womsync: name keys split alt notations',
      ws.nameKeys('Main Name | Alt_Name').includes('alt name')
      && ws.nameKeys('Main Name / Alt Name').includes('main name'));

    // Pure sweep over fake records.
    const sweepArgs = {
      membership: {
        'u-old': { standing: 'member', at: NOWW - 48 * HOURW, via: 'approval' },
        'u-new': { standing: 'member', at: NOWW - 1 * HOURW, via: 'approval' },
        'u-guest': { standing: 'guest', at: NOWW - 48 * HOURW, via: 'approval' },
        'u-gone': { standing: 'member', at: NOWW - 48 * HOURW, via: 'approval' },
      },
      links: {
        'u-old': { rsns: ['Missing Rsn'] },
        'u-new': { rsns: ['Newbie Rsn'] },
        'u-guest': { rsns: ['Guest Rsn'] },
        'u-gone': { rsns: ['Gone Rsn'], verified: ['Gone Rsn'] },
      },
      groupNames: ['Gone Rsn', 'Mystery Name'],
      inGuild: new Set(['u-old', 'u-new', 'u-guest']),
      nameOf: (id) => ({ 'u-old': 'Old Member', 'u-gone': 'Gone Member' })[id] || `user ${id}`,
      now: NOWW,
    };
    const sweepIssues = ws.computeSweep(sweepArgs);
    const kindOf = (k) => sweepIssues.filter((i) => i.key.startsWith(k));
    ok('womsync: sweep flags the departed member for removal',
      kindOf('remove:').length === 1 && kindOf('remove:')[0].text === ws.TEXT.leave('Gone Member', 'Gone Rsn'),
      JSON.stringify(sweepIssues));
    ok('womsync: sweep flags a member missing from the group',
      kindOf('missing:').length === 1 && kindOf('missing:')[0].text === ws.TEXT.missing('Old Member', 'Missing Rsn'));
    ok('womsync: sweep skips new approvals and guests for the missing check',
      !sweepIssues.some((i) => i.key.includes('u-new')) && !sweepIssues.some((i) => i.key.startsWith('missing:u-guest')));
    ok('womsync: sweep lists group names that match no member',
      kindOf('unknown:').length === 1 && kindOf('unknown:')[0].text === ws.TEXT.unknown('Mystery Name'));
    ok('womsync: sweep is empty when the lists agree',
      ws.computeSweep({
        ...sweepArgs,
        groupNames: ['Gone Rsn', 'Missing Rsn', 'Newbie Rsn', 'Guest Rsn'],
        inGuild: new Set(['u-old', 'u-new', 'u-guest', 'u-gone']),
      }).length === 0);

    // Settled cases: a settled RSN missing from the group is not
    // drift, a settled user is not flagged, and a settled group
    // name is not a mystery. Removals are never settled away.
    const ss = require(path.join(__dirname, '..', 'src', 'sync-settled.js'));
    ok('settled: a missing settled file reads as nothing settled',
      ss.loadSettled().userIds.size === 0 && ss.loadSettled().rsns.size === 0);
    ok('settled: matching folds case and underscores',
      ss.isRsnSettled({ userIds: new Set(), rsns: new Set(['pt is free']) }, 'Pt_Is_Free') === true
      && ss.isRsnSettled({ userIds: new Set(), rsns: new Set(['pt is free']) }, 'Other Name') === false
      && ss.isUserSettled({ userIds: new Set(['42']), rsns: new Set() }, '42') === true
      && ss.isUserSettled({ userIds: new Set(['42']), rsns: new Set() }, '43') === false);
    const settledRsnSweep = ws.computeSweep({
      ...sweepArgs,
      settled: { userIds: new Set(), rsns: new Set(['missing rsn']) },
    });
    ok('womsync: a settled RSN is not flagged missing',
      !settledRsnSweep.some((i) => i.key.startsWith('missing:'))
      && settledRsnSweep.some((i) => i.key.startsWith('remove:')),
      JSON.stringify(settledRsnSweep));
    const settledUserSweep = ws.computeSweep({
      ...sweepArgs,
      settled: { userIds: new Set(['u-old']), rsns: new Set() },
    });
    ok('womsync: a settled user is not flagged missing',
      !settledUserSweep.some((i) => i.key.includes('u-old')));
    const settledNameSweep = ws.computeSweep({
      ...sweepArgs,
      settled: { userIds: new Set(), rsns: new Set(['mystery name']) },
    });
    ok('womsync: a settled group name is not flagged unknown',
      !settledNameSweep.some((i) => i.key.startsWith('unknown:')));

    // Departed registry: the removal alert reads the departure
    // snapshot, so it survives the record being marked left and the
    // link being parked (the leaver cleanup's shape), and it never
    // doubles the record path's own line.
    const depOnly = ws.computeSweep({
      membership: {},
      links: {},
      groupNames: ['Gone Rsn'],
      inGuild: new Set(),
      nameOf: (id) => `user ${id}`,
      now: NOWW,
      departed: { 'u-gone': { name: 'Gone Member', rsns: ['Gone Rsn'], at: NOWW - HOURW } },
    });
    ok('womsync: a departed snapshot flags removal with no record at all',
      depOnly.length === 1 && depOnly[0].key.startsWith('remove:u-gone')
      && depOnly[0].text === ws.TEXT.leave('Gone Member', 'Gone Rsn'),
      JSON.stringify(depOnly));
    const depCleaned = ws.computeSweep({
      membership: { 'u-gone': { standing: 'left', at: NOWW - 48 * HOURW, via: 'cleanup' } },
      links: { 'u-gone': { rsns: [] } },
      groupNames: ['Gone Rsn'],
      inGuild: new Set(),
      nameOf: (id) => `user ${id}`,
      now: NOWW,
      departed: { 'u-gone': { name: 'Gone Member', rsns: ['Gone Rsn'], at: NOWW - HOURW } },
    });
    ok('womsync: the removal alert survives a cleaned record and a parked link',
      depCleaned.filter((i) => i.key.startsWith('remove:')).length === 1,
      JSON.stringify(depCleaned));
    const depBoth = ws.computeSweep({
      ...sweepArgs,
      departed: { 'u-gone': { name: 'Gone Member', rsns: ['Gone Rsn'], at: NOWW - HOURW } },
    });
    ok('womsync: snapshot and record never double-report a departure',
      depBoth.filter((i) => i.key.startsWith('remove:')).length === 1,
      JSON.stringify(depBoth));
    const depBack = ws.computeSweep({
      membership: {},
      links: {},
      groupNames: ['Gone Rsn'],
      inGuild: new Set(['u-gone']),
      nameOf: (id) => `user ${id}`,
      now: NOWW,
      departed: { 'u-gone': { name: 'Gone Member', rsns: ['Gone Rsn'], at: NOWW - HOURW } },
    });
    ok('womsync: a departed entry for someone back in the guild stays silent',
      !depBack.some((i) => i.key.startsWith('remove:')));
    const depOut = ws.computeSweep({
      membership: {},
      links: {},
      groupNames: ['Other Name'],
      inGuild: new Set(),
      nameOf: (id) => `user ${id}`,
      now: NOWW,
      departed: { 'u-gone': { name: 'Gone Member', rsns: ['Gone Rsn'], at: NOWW - HOURW } },
    });
    ok('womsync: a departed entry with no RSNs left in the group stays silent',
      !depOut.some((i) => i.key.startsWith('remove:')));

    // Rename pairing: one missing member whose display name
    // carries the one unknown group name is a single rename line,
    // not a missing line plus an unknown line.
    const renameSweep = ws.computeSweep({
      membership: { 'u-ren': { standing: 'member', at: NOWW - 48 * HOURW, via: 'approval' } },
      links: { 'u-ren': { rsns: ['Old Name'] } },
      groupNames: ['New Name'],
      inGuild: new Set(['u-ren']),
      nameOf: () => 'Renamed [New Name]',
      now: NOWW,
    });
    ok('womsync: a rename pairs into one line',
      renameSweep.length === 1 && renameSweep[0].key.startsWith('rename:u-ren')
      && renameSweep[0].text === ws.TEXT.rename('Renamed [New Name]', 'Old Name', 'New Name'),
      JSON.stringify(renameSweep));
    const ambSweep = ws.computeSweep({
      membership: {
        'u-a': { standing: 'member', at: NOWW - 48 * HOURW, via: 'approval' },
        'u-b': { standing: 'member', at: NOWW - 48 * HOURW, via: 'approval' },
      },
      links: { 'u-a': { rsns: ['A Old'] }, 'u-b': { rsns: ['B Old'] } },
      groupNames: ['New Name'],
      inGuild: new Set(['u-a', 'u-b']),
      nameOf: (id) => (id === 'u-a' ? 'New Name A' : 'New Name B'),
      now: NOWW,
    });
    ok('womsync: an ambiguous rename does not pair',
      ambSweep.filter((i) => i.key.startsWith('missing:')).length === 2
      && ambSweep.filter((i) => i.key.startsWith('unknown:')).length === 1
      && !ambSweep.some((i) => i.key.startsWith('rename:')),
      JSON.stringify(ambSweep));

    // Sweep timing: next run is the coming 14:00 UTC.
    ok('womsync: sweep timer targets 14:00 UTC',
      ws.msUntilNextSweep(new Date(Date.UTC(2026, 10, 25, 13, 0, 0))) === HOURW
      && ws.msUntilNextSweep(new Date(Date.UTC(2026, 10, 25, 15, 0, 0))) === 23 * HOURW);

    // The post itself: one embed, owner-role ping only, issues
    // grouped under their headings in display order.
    const payloadW = ws.buildPayload([
      { kind: 'unknown', line: ws.LINES.unknown('Mystery Name') },
      { kind: 'rename', line: ws.LINES.rename('Ren', 'Old Name', 'New Name') },
      { kind: 'missing', line: ws.LINES.missing('Stayer', 'Stayer Rsn') },
      { kind: 'remove', line: ws.LINES.leave('Leaver', 'Leaver Rsn') },
      { kind: 'missing' },
    ]);
    const descW = payloadW.embeds[0].description;
    ok('womsync: payload pings only the owner role and groups the embed',
      payloadW.content === `<@&${ws.PING_ROLE_ID}>`
      && JSON.stringify(payloadW.allowedMentions) === JSON.stringify({ roles: [ws.PING_ROLE_ID] })
      && payloadW.embeds[0].color === 0xA31621
      && payloadW.embeds[0].footer.text.includes('Settled cases stay quiet')
      && descW.indexOf('**Left, still in the group**') < descW.indexOf('**Missing from the group**')
      && descW.indexOf('**Missing from the group**') < descW.indexOf('**Looks renamed**')
      && descW.indexOf('**Looks renamed**') < descW.indexOf('**In the group, not a member**')
      && descW.includes('Ren — link says Old Name, the group says New Name.'),
      JSON.stringify(payloadW));

    // Wrappers against fixture files, a stubbed fetch, a fake thread.
    const touchedW = ['membership.json', 'rsn-links.json', 'wom-sync-alerts.json', 'departed.json'];
    const savedW = {};
    for (const name of touchedW) {
      const p = path.join(DATA, name);
      savedW[name] = fs.existsSync(p) ? fs.readFileSync(p) : null;
    }
    const writeFixtureW = (name, obj) => fs.writeFileSync(path.join(DATA, name), JSON.stringify(obj));
    const restoreW = () => {
      for (const name of touchedW) {
        const p = path.join(DATA, name);
        if (savedW[name] === null) { try { fs.unlinkSync(p); } catch {} }
        else fs.writeFileSync(p, savedW[name]);
      }
    };
    const UW = { leaver: '990000000000000201', quiet: '990000000000000202', stayer: '990000000000000203' };
    writeFixtureW('membership.json', {
      [GIDW]: {
        [UW.leaver]: { standing: 'member', at: NOWW - 48 * HOURW, via: 'approval' },
        [UW.quiet]: { standing: 'guest', at: NOWW - 48 * HOURW, via: 'approval' },
        [UW.stayer]: { standing: 'member', at: NOWW - 48 * HOURW, via: 'approval' },
      },
    });
    writeFixtureW('rsn-links.json', {
      [UW.leaver]: { rsns: ['Leaver Rsn'], verified: ['Leaver Rsn'] },
      [UW.quiet]: { rsns: ['Quiet Rsn'] },
      [UW.stayer]: { rsns: ['Stayer Rsn'] },
    });
    try { fs.unlinkSync(path.join(DATA, 'wom-sync-alerts.json')); } catch {}

    const sentW = [];
    const fakeChannelW = { send: async (opts) => { sentW.push(opts); return { id: 'womsync-fake' }; } };
    const guildMembersW = new Map([
      [UW.stayer, { id: UW.stayer, displayName: 'Stayer', user: { username: 'stayer' } }],
    ]);
    const fakeGuildW = { id: GIDW, members: { fetch: async () => guildMembersW, cache: guildMembersW } };
    const fakeClientW = {
      channels: { fetch: async () => fakeChannelW },
      guilds: { cache: new Map([[GIDW, fakeGuildW]]) },
    };
    const realGroupFetch = womM.getGroupMembers;
    let groupStub = ['Leaver Rsn', 'Stayer Rsn', 'Mystery Name'];
    womM.getGroupMembers = async () => groupStub;
    guildCacheM.invalidateCache();
    try {
      const leaverMember = { id: UW.leaver, displayName: 'Leaver', user: { username: 'leaver' }, guild: { id: GIDW } };
      const postedLeave = await ws.onMemberLeave(fakeClientW, leaverMember);
      ok('womsync: leave with RSNs in the group posts one embed pinging only the owner role',
        postedLeave === true && sentW.length === 1
        && sentW[0].content === `<@&${ws.PING_ROLE_ID}>`
        && JSON.stringify(sentW[0].allowedMentions) === JSON.stringify({ roles: [ws.PING_ROLE_ID] })
        && sentW[0].embeds[0].title === '⛧ WOM Sync Check ⛧'
        && sentW[0].embeds[0].description.includes('Leaver — left the server. Still in the group: Leaver Rsn.'),
        JSON.stringify(sentW));
      const postedLeaveAgain = await ws.onMemberLeave(fakeClientW, leaverMember);
      ok('womsync: the same leave never alerts twice', postedLeaveAgain === false && sentW.length === 1);
      const depM = require(path.join(__dirname, '..', 'src', 'departed.js'));
      const depAfterLeave = depM.loadDeparted();
      ok('womsync: the leave hook snapshots the departure',
        !!depAfterLeave[UW.leaver] && depAfterLeave[UW.leaver].rsns.includes('Leaver Rsn')
        && depAfterLeave[UW.leaver].name === 'Leaver',
        JSON.stringify(depAfterLeave));
      const quietMember = { id: UW.quiet, displayName: 'Quiet', user: { username: 'quiet' }, guild: { id: GIDW } };
      const postedQuiet = await ws.onMemberLeave(fakeClientW, quietMember);
      ok('womsync: leave with no RSNs in the group stays silent', postedQuiet === false && sentW.length === 1);

      // Sweep: the leaver's removal is already recorded by the leave
      // alert, so only the unknown name is fresh.
      const sweptOnce = await ws.runSweep(fakeClientW);
      ok('womsync: sweep posts fresh drift as one message and does not repeat the leave alert',
        sweptOnce === true && sentW.length === 2
        && sentW[1].embeds[0].description.includes("Mystery Name — in the group but isn't a member here.")
        && sentW[1].embeds[0].description.includes('**In the group, not a member**'),
        JSON.stringify(sentW.map((s) => s.content)));

      // Stayer drops out of the group: one missing line, nothing else.
      groupStub = ['Leaver Rsn', 'Mystery Name'];
      const sweptTwice = await ws.runSweep(fakeClientW);
      ok('womsync: sweep flags a member who fell out of the group',
        sweptTwice === true && sentW.length === 3
        && sentW[2].embeds[0].description.includes('Stayer — a member, but not in the group yet: Stayer Rsn.')
        && sentW[2].embeds[0].description.includes('**Missing from the group**'),
        JSON.stringify(sentW.map((s) => s.content)));
      const sweptThrice = await ws.runSweep(fakeClientW);
      ok('womsync: a repeat sweep with the same drift stays silent', sweptThrice === false && sentW.length === 3);

      // WOM unreachable: no alerts, no crash, from either trigger.
      womM.getGroupMembers = async () => null;
      const failLeave = await ws.onMemberLeave(fakeClientW, { id: UW.stayer, displayName: 'Stayer', user: { username: 'stayer' }, guild: { id: GIDW } });
      const failSweep = await ws.runSweep(fakeClientW);
      ok('womsync: a failed WOM fetch stays silent', failLeave === false && failSweep === false && sentW.length === 3);

      // Drift resolved (stayer back in, mystery name gone): the
      // sweep posts nothing and the resolved keys clear, leaving
      // only the leaver's still-open removal key.
      womM.getGroupMembers = async () => groupStub;
      groupStub = ['Leaver Rsn', 'Stayer Rsn'];
      const sweptClean = await ws.runSweep(fakeClientW);
      const stateAfter = JSON.parse(fs.readFileSync(path.join(DATA, 'wom-sync-alerts.json'), 'utf8'));
      ok('womsync: resolved issues clear their dedup keys',
        sweptClean === false && sentW.length === 3
        && Object.keys(stateAfter.sent).length === 1
        && Object.keys(stateAfter.sent)[0].startsWith(`remove:${UW.leaver}:`),
        JSON.stringify(stateAfter));

      // The leaver cleanup's shape: the record is marked left and
      // the link is parked, but the name is still in the group. The
      // removal issue must stay open (its dedup key survives the
      // sweep's prune), or the alert has been silenced.
      writeFixtureW('membership.json', {
        [GIDW]: {
          [UW.leaver]: { standing: 'left', at: NOWW - 48 * HOURW, via: 'cleanup' },
          [UW.stayer]: { standing: 'member', at: NOWW - 48 * HOURW, via: 'approval' },
        },
      });
      writeFixtureW('rsn-links.json', {
        [UW.stayer]: { rsns: ['Stayer Rsn'] },
      });
      const sweptCleaned = await ws.runSweep(fakeClientW);
      const stateCleaned = JSON.parse(fs.readFileSync(path.join(DATA, 'wom-sync-alerts.json'), 'utf8'));
      ok('womsync: the removal case survives the cleanup shape',
        sweptCleaned === false && sentW.length === 3
        && Object.keys(stateCleaned.sent).some((k) => k.startsWith(`remove:${UW.leaver}:`)),
        JSON.stringify(stateCleaned));
      ws.onMemberRejoin(UW.leaver);
      ok('womsync: a rejoin clears the departed entry',
        !depM.loadDeparted()[UW.leaver]);
    } finally {
      womM.getGroupMembers = realGroupFetch;
      guildCacheM.invalidateCache();
      restoreW();
    }
  }

  sec('AB. role watch + role sync panel');
  // Role watch (Nov 25, 2026): staff promote guests to members by
  // editing Discord roles by hand, and the watcher lines the
  // records up behind the move (standing flip, Initiate, CC
  // checklist entry, comp roster refresh, welcome, one staff line)
  // and flags the two cases staff must decide. The pure classifier
  // runs on fake role sets here; the wrappers run against fixture
  // data files with fake members. Every file the fixtures touch is
  // restored byte for byte afterwards.
  {
    const rw = require(path.join(__dirname, '..', 'src', 'role-watch.js'));
    const cfgR = require(path.join(__dirname, '..', 'src', 'config.js'));
    const guildCacheR = require(path.join(__dirname, '..', 'src', 'guild-cache.js'));
    const compRosterM = require(path.join(__dirname, '..', 'src', 'comp-roster.js'));
    const womWarmM = require(path.join(__dirname, '..', 'src', 'wom-warm.js'));
    const indexSrcR = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.js'), 'utf8');
    const womSyncSrcR = fs.readFileSync(path.join(__dirname, '..', 'src', 'wom-sync-alerts.js'), 'utf8');
    const GIDR = cfgR.guildId;
    const IRON = cfgR.teams.ironSwornRoleId;
    const UNBOUND = cfgR.recruit.types.main.roleId;
    const GUEST = cfgR.recruit.types.guest.roleId;
    const FRIEND = cfgR.seniority.friendOfClanRoleId;
    const INITIATE = cfgR.seniorityRanks.find((r) => r.minMonths === 0).roleId;
    const PING = '1558000000000000001'; // a non-access role stand-in
    const asSet = (...ids) => new Set(ids);

    // Wiring: the live hook sits in the GuildMemberUpdate handler,
    // the sweep rides the WOM module's daily 14:00 UTC pass, and
    // the old weekly uncovered-members report is no longer called
    // (its module and its other functions stay in place).
    ok('rolewatch: index hooks the watcher into GuildMemberUpdate',
      indexSrcR.includes("require('./role-watch')")
      && indexSrcR.includes('onRoleWatchUpdate(client, oldMember, newMember)'));
    ok('rolewatch: the role sweep rides the daily WOM pass',
      womSyncSrcR.includes('roleWatch.runSweep(client)'));
    ok('rolewatch: the old weekly WOM report is retired',
      !indexSrcR.includes('reportUncoveredMembers')
      && typeof womWarmM.warmMemberStats === 'function'
      && typeof womWarmM.reportUncoveredMembers === 'function');

    // Panel strings, word for word (approved Nov 26, 2026).
    const PT = require(path.join(__dirname, '..', 'src', 'role-sync-panel.js')).TEXT;
    ok('rolesync: panel strings word for word',
      PT.title === '⛧ Role Sync ⛧'
      && PT.flagsHeading === 'Needs a staff call'
      && PT.flag.demotion(1, '42', 100) === '**1.** <@42>: member on record, no member role. <t:100:R>'
      && PT.flag.norecord(2, '42', 100) === '**2.** <@42>: member role, no record. <t:100:R>'
      && PT.flagsEmpty === 'Nothing needs a staff call.'
      && PT.recentHeading === 'Done by the bot'
      && PT.recent.promote('42', 100) === '<@42> set to member. Checklist entry added. <t:100:R>'
      && PT.recent.repair('42', 100) === '<@42> record fixed to member. Checklist entry added. <t:100:R>'
      && PT.recent.demote('42', 100, true) === '<@42> set to guest. Rank role removed. <t:100:R>'
      && PT.recent.demote('42', 100, false) === '<@42> set to guest. <t:100:R>'
      && PT.recentEmpty === 'Nothing in the last 7 days.'
      && PT.allClear === 'All caught up. Roles and records match.'
      && PT.footer === 'Fix opens their record. A row clears once roles and record agree.'
      && PT.fixButton(3) === 'Fix 3'
      && PT.fixGone === 'That one is already sorted.'
      && PT.staffOnly === 'That button is for staff only.');
    ok('rolewatch: the old staff-line strings and posters are gone',
      rw.TEXT === undefined && rw.postToChecklist === undefined);

    // The classifier, case by case.
    const cls = (standing, roleIds, isBot = false) => rw.classify({ standing, roleIds, isBot });
    ok('rolewatch: guest with Iron Sworn promotes', cls('guest', asSet(IRON, GUEST)) === 'promote');
    ok('rolewatch: guest with Unbound promotes', cls('guest', asSet(UNBOUND)) === 'promote');
    ok('rolewatch: guest with no member role is left alone', cls('guest', asSet(GUEST)) === null);
    ok('rolewatch: member with a member role is consistent', cls('member', asSet(IRON)) === null);
    ok('rolewatch: member holding only Guest is a hand swap to guest', cls('member', asSet(GUEST)) === 'demote');
    ok('rolewatch: member holding Guest and a member role is left alone', cls('member', asSet(GUEST, IRON)) === null);
    ok('rolewatch: member with no access role flags demotion drift', cls('member', asSet(PING)) === 'demotion');
    ok('rolewatch: no record with a member role flags for staff', cls(null, asSet(IRON)) === 'norecord');
    ok('rolewatch: no record with only a non-access role is untouched', cls(null, asSet(PING)) === null);
    ok('rolewatch: Friend holders are exempt in every state',
      cls('guest', asSet(IRON, FRIEND)) === null
      && cls('member', asSet(FRIEND)) === null
      && cls(null, asSet(IRON, FRIEND)) === null);
    ok('rolewatch: bots are exempt', cls('guest', asSet(IRON), true) === null && cls(null, asSet(IRON), true) === null);
    ok('rolewatch: an unrecognised standing is left alone', cls('weird', asSet(IRON)) === null);

    // The access gate: only access-role changes wake the watcher.
    ok('rolewatch: access gate sees member and guest changes',
      rw.accessChanged(asSet(GUEST), asSet(IRON)) === true
      && rw.accessChanged(asSet(), asSet(GUEST)) === true);
    ok('rolewatch: access gate ignores cosmetic changes',
      rw.accessChanged(asSet(IRON), asSet(IRON, INITIATE)) === false
      && rw.accessChanged(asSet(IRON), asSet(IRON)) === false);

    // Wrappers against fixture files and fake members.
    const touchedR = ['membership.json', 'rsn-links.json', 'cc-checklist.json', 'role-watch.json'];
    const savedR = {};
    for (const name of touchedR) {
      const p = path.join(DATA, name);
      savedR[name] = fs.existsSync(p) ? fs.readFileSync(p) : null;
    }
    const snapPathR = path.join(DATA, 'plugin-sync', 'roles-snapshot.json');
    const savedSnapR = fs.existsSync(snapPathR) ? fs.readFileSync(snapPathR) : null;
    const writeFixtureR = (name, obj) => fs.writeFileSync(path.join(DATA, name), JSON.stringify(obj));
    const restoreR = () => {
      for (const name of touchedR) {
        const p = path.join(DATA, name);
        if (savedR[name] === null) { try { fs.unlinkSync(p); } catch {} }
        else fs.writeFileSync(p, savedR[name]);
      }
      if (savedSnapR === null) { try { fs.unlinkSync(snapPathR); } catch {} }
      else fs.writeFileSync(snapPathR, savedSnapR);
    };
    const readMembershipR = () => JSON.parse(fs.readFileSync(path.join(DATA, 'membership.json'), 'utf8'))[GIDR];
    const readCcR = () => JSON.parse(fs.readFileSync(path.join(DATA, 'cc-checklist.json'), 'utf8'));
    const readStateR = () => JSON.parse(fs.readFileSync(path.join(DATA, 'role-watch.json'), 'utf8'));

    const UR = {
      promo: '990000000000000301', demoted: '990000000000000302', stray: '990000000000000303',
      friend: '990000000000000304', quiet: '990000000000000305', repair: '990000000000000306', guestSwap: '990000000000000312',
      sweepDemoted: '990000000000000307', stray2: '990000000000000308', turtle: '990000000000000309',
      snapStray: '990000000000000310', bot: '990000000000000311', clearMe: '990000000000000313',
    };
    writeFixtureR('membership.json', {
      [GIDR]: {
        [UR.promo]: { standing: 'guest', at: Date.now(), via: 'approval' },
        [UR.demoted]: { standing: 'member', at: Date.now(), via: 'approval' },
        [UR.friend]: { standing: 'guest', at: Date.now(), via: 'approval' },
        [UR.quiet]: { standing: 'member', at: Date.now(), via: 'approval' },
        [UR.repair]: { standing: 'guest', at: Date.now(), via: 'approval' },
        [UR.sweepDemoted]: { standing: 'member', at: Date.now(), via: 'approval' },
        [UR.guestSwap]: { standing: 'member', at: Date.now(), via: 'approval' },
      },
    });
    const linkR = (rsn) => ({ rsns: [rsn], active: rsn, verified: [] });
    writeFixtureR('rsn-links.json', {
      [UR.promo]: linkR('Promo Rsn'),
      [UR.demoted]: linkR('Demoted Rsn'),
      [UR.friend]: linkR('Friend Rsn'),
      [UR.quiet]: linkR('Quiet Rsn'),
      [UR.repair]: linkR('Repair Rsn'),
      [UR.guestSwap]: linkR('Swap Rsn'),
    });
    writeFixtureR('cc-checklist.json', { entries: [], messageId: null, page: 0 });
    try { fs.unlinkSync(path.join(DATA, 'role-watch.json')); } catch {}

    const panelM = require(path.join(__dirname, '..', 'src', 'role-sync-panel.js'));
    const settledPathR = path.join(DATA, 'sync-settled.json');
    const savedSettledR = fs.existsSync(settledPathR) ? fs.readFileSync(settledPathR) : null;
    const stateFileR = path.join(DATA, 'role-watch.json');
    const resetStateR = () => { try { fs.unlinkSync(stateFileR); } catch {} };
    resetStateR();

    // The panel thread: a fake thread that stores messages, counts
    // sends and edits, and throws Unknown Message for a missing id.
    // The test points config.roleSync.threadId at a thread id of its
    // own (restored afterwards), so CC checklist posts and panel
    // posts stay apart.
    const panelThreadId = '990000000000009001';
    const roleSyncBefore = cfgR.roleSync;
    ok('rolesync: config.roleSync.threadId ships as the Role sync thread',
      roleSyncBefore && roleSyncBefore.threadId === '1575620420252467240');
    cfgR.roleSync = { threadId: panelThreadId };
    const panelMsgs = new Map();
    const sentR = [];
    let panelSeq = 0;
    let panelEdits = 0;
    const fakePanelThread = {
      id: panelThreadId,
      archived: false,
      isThread: () => true,
      setArchived: async () => { fakePanelThread.archived = false; },
      messages: {
        fetch: async (id) => {
          const m = panelMsgs.get(id);
          if (!m) { const e = new Error('Unknown Message'); e.code = 10008; throw e; }
          return m;
        },
      },
      send: async (opts) => {
        const m = {
          id: `panel-${++panelSeq}`, payload: opts,
          edit: async (o) => { m.payload = o; panelEdits++; return m; },
        };
        panelMsgs.set(m.id, m);
        sentR.push(opts);
        return m;
      },
    };
    const generalSentR = [];
    const fakeGeneralR = { send: async (opts) => { generalSentR.push(opts); return { id: 'rolewatch-general' }; } };
    const channelsR = () => new Map([[cfgR.recruit.generalChannelId, fakeGeneralR], [panelThreadId, fakePanelThread]]);
    const fakeMemberR = (id, name, roleIds, isBot = false) => {
      const cache = new Map(roleIds.map((r) => [r, { id: r }]));
      return {
        id, displayName: name, user: { username: name.toLowerCase(), bot: isBot },
        roles: {
          cache,
          add: async (roleId) => { cache.set(roleId, { id: roleId }); return {}; },
          remove: async (roleId) => { cache.delete(roleId); return {}; },
        },
      };
    };
    const liveGuildR = (members) => ({
      id: GIDR,
      members: { cache: new Map(members.map((m) => [m.id, m])) },
      channels: { cache: channelsR() },
    });
    const liveClientR = (guild) => ({
      channels: { fetch: async () => fakePanelThread },
      guilds: { cache: new Map([[GIDR, guild]]) },
    });
    const panelDesc = () => {
      const st = panelM.loadState();
      const m = st.messageId && panelMsgs.get(st.messageId);
      return m ? m.payload.embeds[0].data.description || '' : null;
    };
    const openKeys = () => Object.keys(panelM.loadState().open).sort();
    const err10007 = () => { const e = new Error('Unknown Member'); e.code = 10007; return e; };

    let rosterRefreshes = 0;
    const realScheduleRefresh = compRosterM.scheduleRefresh;
    compRosterM.scheduleRefresh = () => { rosterRefreshes++; };
    guildCacheR.invalidateCache();
    try {
      // ---- State migration ------------------------------------------
      const V1 = 1764160000000;
      fs.writeFileSync(stateFileR, JSON.stringify({ sent: {
        'demotion:111': V1, 'norecord:222': V1 + 5000, 'demote:333': V1,
      } }));
      const mig = panelM.loadState();
      ok('rolesync: a v1 file migrates to open flags with the old timestamps',
        mig.version === 2 && mig.messageId === null
        && Object.keys(mig.open).sort().join() === 'demotion:111,norecord:222'
        && mig.open['demotion:111'].since === Math.floor(V1 / 1000)
        && mig.open['demotion:111'].action === 'demotion' && mig.open['demotion:111'].userId === '111'
        && mig.open['norecord:222'].since === Math.floor((V1 + 5000) / 1000)
        && !('demote:333' in mig.open) && mig.recent.length === 0,
        JSON.stringify(mig));
      fs.writeFileSync(stateFileR, '{ not json');
      const corrupt = panelM.loadState();
      ok('rolesync: a corrupt state file reads as empty',
        corrupt.version === 2 && Object.keys(corrupt.open).length === 0 && corrupt.recent.length === 0);
      resetStateR();

      // ---- Embed build ----------------------------------------------
      const nowSec = Math.floor(Date.now() / 1000);
      const stBoth = {
        messageId: null, page: 0,
        open: {
          'demotion:101': { action: 'demotion', userId: '101', since: nowSec - 300 },
          'norecord:102': { action: 'norecord', userId: '102', since: nowSec - 100 },
        },
        recent: [
          { action: 'promote', userId: '201', at: nowSec - 60, rankRemoved: false },
          { action: 'demote', userId: '202', at: nowSec - 90, rankRemoved: true },
        ],
      };
      const descBoth = panelM.buildEmbed(stBoth).data.description;
      ok('rolesync: both sections render from state',
        descBoth.includes('**Needs a staff call**') && descBoth.includes('**Done by the bot**')
        && descBoth.includes(`**1.** <@101>: member on record, no member role. <t:${nowSec - 300}:R>`)
        && descBoth.includes(`**2.** <@102>: member role, no record. <t:${nowSec - 100}:R>`)
        && descBoth.includes(`<@201> set to member. Checklist entry added. <t:${nowSec - 60}:R>`)
        && descBoth.includes(`<@202> set to guest. Rank role removed. <t:${nowSec - 90}:R>`)
        && !descBoth.includes('All caught up'),
        descBoth);
      const stFlagsOnly = { ...stBoth, recent: [] };
      const descFlagsOnly = panelM.buildEmbed(stFlagsOnly).data.description;
      const descRecentOnly = panelM.buildEmbed({ ...stBoth, open: {} }).data.description;
      ok('rolesync: an empty section shows its own empty line',
        descFlagsOnly.includes('Nothing in the last 7 days.')
        && descRecentOnly.includes('Nothing needs a staff call.'));
      const embedClear = panelM.buildEmbed({ messageId: null, page: 0, open: {}, recent: [] });
      ok('rolesync: the all-clear text shows when both sections are empty',
        embedClear.data.description === 'All caught up. Roles and records match.'
        && panelM.buildButtons({ open: {}, recent: [], page: 0 }).length === 0);
      const manyOpen = {};
      for (let i = 1; i <= 7; i++) manyOpen[`demotion:30${i}`] = { action: 'demotion', userId: `30${i}`, since: nowSec - 1000 + i };
      const pg0 = { messageId: null, page: 0, open: manyOpen, recent: [] };
      const pg1 = { ...pg0, page: 1 };
      const d0 = panelM.buildEmbed(pg0).data.description;
      const d1 = panelM.buildEmbed(pg1).data.description;
      const b0 = panelM.buildButtons(pg0);
      const b1 = panelM.buildButtons(pg1);
      ok('rolesync: flags are numbered and paged at 5',
        d0.includes('**5.** <@305>') && !d0.includes('**6.**')
        && d1.includes('**6.** <@306>') && d1.includes('**7.** <@307>') && !d1.includes('**5.**')
        && b0.length === 2 && b0[0].components.length === 5
        && b0[0].components[0].data.custom_id === 'rsync:fix:301'
        && b0[0].components[0].data.label === 'Fix 1'
        && b0[1].components.map((c) => c.data.custom_id).join() === 'rsync:prev,rsync:next'
        && b1[0].components.length === 2 && b1[0].components[0].data.label === 'Fix 6',
        JSON.stringify({ d0, d1 }));
      ok('rolesync: one page of flags has no paging row',
        panelM.buildButtons(stFlagsOnly).length === 1);

      // ---- recordAction ---------------------------------------------
      resetStateR();
      for (let i = 1; i <= 12; i++) panelM.recordAction('promote', `40${i}`, { at: nowSec - 1000 + i });
      const rec12 = panelM.loadState().recent;
      ok('rolesync: recordAction keeps newest first and trims to 10',
        rec12.length === 10 && rec12[0].userId === '4012' && rec12[9].userId === '403',
        JSON.stringify(rec12.map((r) => r.userId)));
      panelM.recordAction('repair', '499', { at: nowSec - 8 * 86400 });
      panelM.recordAction('demote', '498', { rankRemoved: true });
      const recAged = panelM.loadState().recent;
      ok('rolesync: recordAction drops entries older than 7 days on write',
        !recAged.some((r) => r.userId === '499')
        && recAged[0].userId === '498' && recAged[0].rankRemoved === true && recAged.length === 10,
        JSON.stringify(recAged.map((r) => r.userId)));
      resetStateR();

      // ---- Refresh ----------------------------------------------------
      const homeGuild = { channels: { cache: new Map([['111', 'ccthread'], ['222', 'ownthread']]) } };
      ok('rolesync: the panel home is its own thread, else the CC checklist thread',
        panelM.panelHome(homeGuild, { roleSync: { threadId: '222' }, ccChecklist: { threadId: '111' } }) === 'ownthread'
        && panelM.panelHome(homeGuild, { roleSync: { threadId: null }, ccChecklist: { threadId: '111' } }) === 'ccthread'
        && panelM.panelHome(homeGuild, { ccChecklist: { threadId: '111' } }) === 'ccthread'
        && panelM.panelHome(homeGuild, { roleSync: { threadId: null } }) === null);
      const GROUP = {
        resolved: '990000000000000401', settledU: '990000000000000402', left: '990000000000000403',
        errU: '990000000000000404', valid: '990000000000000405',
      };
      writeFixtureR('membership.json', {
        [GIDR]: {
          [GROUP.resolved]: { standing: 'member', at: Date.now(), via: 'approval' },
          [GROUP.settledU]: { standing: 'member', at: Date.now(), via: 'approval' },
          [GROUP.valid]: { standing: 'member', at: Date.now(), via: 'approval' },
        },
      });
      fs.writeFileSync(settledPathR, JSON.stringify({ userIds: [GROUP.settledU], rsns: [] }));
      const refGuild = {
        id: GIDR,
        channels: { cache: channelsR() },
        members: {
          cache: new Map([
            [GROUP.resolved, fakeMemberR(GROUP.resolved, 'Resolved', [IRON])],
            [GROUP.settledU, fakeMemberR(GROUP.settledU, 'SettledU', [PING])],
            [GROUP.valid, fakeMemberR(GROUP.valid, 'Valid', [PING])],
          ]),
          fetch: async (id) => {
            if (id === GROUP.left) throw err10007();
            throw new Error('network down');
          },
        },
      };
      // Posts when messageId is null.
      resetStateR();
      const sendsBefore = sentR.length;
      await panelM.refresh(refGuild);
      const afterPost = panelM.loadState();
      ok('rolesync: refresh posts a new panel when messageId is null',
        sentR.length === sendsBefore + 1 && !!afterPost.messageId && afterPost.channelId === panelThreadId
        && panelDesc() === 'All caught up. Roles and records match.'
        && JSON.stringify(sentR[sentR.length - 1].allowedMentions) === JSON.stringify({ parse: [] }));
      // Edits in place when it exists.
      const editsBefore = panelEdits;
      const idBefore = afterPost.messageId;
      await panelM.refresh(refGuild);
      ok('rolesync: refresh edits in place when the message exists',
        panelEdits === editsBefore + 1 && sentR.length === sendsBefore + 1
        && panelM.loadState().messageId === idBefore
        && JSON.stringify(panelMsgs.get(idBefore).payload.allowedMentions) === JSON.stringify({ parse: [] }));
      // Reposts when the message is gone.
      panelMsgs.clear();
      await panelM.refresh(refGuild);
      ok('rolesync: refresh posts again when the message is gone',
        sentR.length === sendsBefore + 2 && panelM.loadState().messageId !== idBefore
        && panelMsgs.has(panelM.loadState().messageId));
      // Two refreshes at once post once (chained ordering).
      panelMsgs.clear();
      const sendsRace = sentR.length;
      await Promise.all([panelM.refresh(refGuild), panelM.refresh(refGuild)]);
      ok('rolesync: concurrent refreshes post only once',
        sentR.length === sendsRace + 1);
      // A thread that slept is woken first.
      fakePanelThread.archived = true;
      await panelM.refresh(refGuild);
      ok('rolesync: refresh un-archives the thread', fakePanelThread.archived === false);

      // Flag re-check.
      const base = panelM.loadState();
      base.open = {
        [`demotion:${GROUP.resolved}`]: { action: 'demotion', userId: GROUP.resolved, since: nowSec - 500 },
        [`norecord:${GROUP.settledU}`]: { action: 'norecord', userId: GROUP.settledU, since: nowSec - 500 },
        [`norecord:${GROUP.left}`]: { action: 'norecord', userId: GROUP.left, since: nowSec - 500 },
        [`norecord:${GROUP.errU}`]: { action: 'norecord', userId: GROUP.errU, since: nowSec - 500 },
        [`demotion:${GROUP.valid}`]: { action: 'demotion', userId: GROUP.valid, since: nowSec - 500 },
      };
      panelM.saveState(base);
      await panelM.refresh(refGuild);
      const keysAfter = openKeys();
      ok('rolesync: refresh drops resolved, settled and departed flags and keeps the rest',
        keysAfter.join() === [`demotion:${GROUP.valid}`, `norecord:${GROUP.errU}`].sort().join(),
        JSON.stringify(keysAfter));
      ok('rolesync: a flag dropped on refresh is also gone from the panel text',
        !panelDesc().includes(`<@${GROUP.resolved}>`) && panelDesc().includes(`<@${GROUP.valid}>`)
        && panelDesc().includes(`<@${GROUP.errU}>`));
      const errKept = keysAfter.includes(`norecord:${GROUP.errU}`);
      ok('rolesync: a fetch error keeps the flag', errKept);

      // ---- Fix button -------------------------------------------------
      const replies = [];
      const mkInteraction = (customId, staff) => ({
        customId, guildId: GIDR,
        member: { roles: { cache: { some: () => staff } }, permissions: { has: () => false } },
        reply: async (o) => { replies.push(o); },
      });
      replies.length = 0;
      await panelM.handleRoleSyncButton(mkInteraction(`rsync:fix:${GROUP.valid}`, false));
      ok('rolesync: the Fix button is staff only',
        replies.length === 1 && replies[0].content === 'That button is for staff only.' && replies[0].ephemeral === true);
      replies.length = 0;
      await panelM.handleRoleSyncButton(mkInteraction(`rsync:fix:${GROUP.valid}`, true));
      const wcM = require(path.join(__dirname, '..', 'src', 'website-controls.js'));
      const expectPayload = wcM.standingPayload(GIDR, GROUP.valid);
      ok('rolesync: Fix on a live flag replies with the standing payload',
        replies.length === 1 && replies[0].ephemeral === true
        && replies[0].content === expectPayload.content
        && replies[0].content === `<@${GROUP.valid}> is recorded as a member.`
        && replies[0].components.length === expectPayload.components.length
        && replies[0].components[0].components[0].data.custom_id === `webctl:set:member:${GROUP.valid}`);
      replies.length = 0;
      await panelM.handleRoleSyncButton(mkInteraction(`rsync:fix:${GROUP.resolved}`, true));
      ok('rolesync: Fix on a cleared flag replies with the already-sorted line',
        replies.length === 1 && replies[0].content === 'That one is already sorted.' && replies[0].ephemeral === true);

      // ---- Role-watch integration -------------------------------------
      resetStateR();
      panelMsgs.clear();
      if (savedSettledR === null) { try { fs.unlinkSync(settledPathR); } catch {} }
      else fs.writeFileSync(settledPathR, savedSettledR);
      writeFixtureR('membership.json', {
        [GIDR]: {
          [UR.promo]: { standing: 'guest', at: Date.now(), via: 'approval' },
          [UR.demoted]: { standing: 'member', at: Date.now(), via: 'approval' },
          [UR.friend]: { standing: 'guest', at: Date.now(), via: 'approval' },
          [UR.quiet]: { standing: 'member', at: Date.now(), via: 'approval' },
          [UR.repair]: { standing: 'guest', at: Date.now(), via: 'approval' },
          [UR.sweepDemoted]: { standing: 'member', at: Date.now(), via: 'approval' },
          [UR.guestSwap]: { standing: 'member', at: Date.now(), via: 'approval' },
          [UR.clearMe]: { standing: 'member', at: Date.now(), via: 'approval' },
        },
      });
      const sendsStart = sentR.length;

      // Live promotion: a guest gains Iron Sworn by hand.
      const promoNew = fakeMemberR(UR.promo, 'Promo', [GUEST, IRON, PING]);
      const promoOld = fakeMemberR(UR.promo, 'Promo', [GUEST, PING]);
      const promoGuild = liveGuildR([promoNew]);
      promoNew.guild = promoGuild; promoOld.guild = promoGuild;
      const promoted = await rw.onMemberUpdate(liveClientR(promoGuild), promoOld, promoNew, { settleMs: 0 });
      const stPromo = panelM.loadState();
      ok('rolewatch: a hand promotion lines everything up and records a recent action',
        promoted === true
        && readMembershipR()[UR.promo].standing === 'member'
        && readMembershipR()[UR.promo].via === 'role-watch'
        && promoNew.roles.cache.has(INITIATE)
        && readCcR().entries.some((e) => e.userId === UR.promo && e.oldRank === 'None' && e.newRank === 'Initiate')
        && rosterRefreshes >= 1
        && generalSentR.length === 1 && generalSentR[0].content.includes(`<@${UR.promo}> has joined Oath Forsaken.`)
        && stPromo.recent.length === 1 && stPromo.recent[0].action === 'promote' && stPromo.recent[0].userId === UR.promo
        && panelDesc().includes(`<@${UR.promo}> set to member. Checklist entry added.`),
        JSON.stringify(stPromo));
      ok('rolewatch: a live promotion posts no thread line, only the panel',
        sentR.length === sendsStart + 1
        && sentR.every((p) => p.content === undefined && Array.isArray(p.embeds)),
        JSON.stringify({ n: sentR.length, start: sendsStart }));
      const promotedAgain = await rw.onMemberUpdate(liveClientR(promoGuild), promoOld, promoNew, { settleMs: 0 });
      ok('rolewatch: a repeat promotion event does nothing twice',
        promotedAgain === false && panelM.loadState().recent.length === 1 && generalSentR.length === 1);

      // A cosmetic change is ignored; a bot role change is ignored.
      const cosOld = fakeMemberR(UR.quiet, 'Quiet', [IRON]);
      const cosNew = fakeMemberR(UR.quiet, 'Quiet', [IRON, INITIATE]);
      cosOld.guild = promoGuild; cosNew.guild = promoGuild;
      const cosmetic = await rw.onMemberUpdate(liveClientR(promoGuild), cosOld, cosNew, { settleMs: 0 });
      ok('rolewatch: a cosmetic role change is ignored', cosmetic === false && panelM.loadState().recent.length === 1);
      const botOld = fakeMemberR(UR.bot, 'Botty', [], true);
      const botNew = fakeMemberR(UR.bot, 'Botty', [IRON], true);
      botOld.guild = promoGuild; botNew.guild = promoGuild;
      const botSeen = await rw.onMemberUpdate(liveClientR(promoGuild), botOld, botNew, { settleMs: 0 });
      ok('rolewatch: a bot role change is ignored', botSeen === false && openKeys().length === 0);

      // Demotion drift: a panel row, no record change, no repeat.
      const demOld = fakeMemberR(UR.demoted, 'Demoted', [IRON]);
      const demNew = fakeMemberR(UR.demoted, 'Demoted', [PING]);
      const demGuild = liveGuildR([demNew]);
      demOld.guild = demGuild; demNew.guild = demGuild;
      const editsPre = panelEdits;
      const demotedOnce = await rw.onMemberUpdate(liveClientR(demGuild), demOld, demNew, { settleMs: 0 });
      ok('rolewatch: losing the last member role opens a panel row and changes nothing',
        demotedOnce === true && openKeys().join() === `demotion:${UR.demoted}`
        && panelEdits === editsPre + 1 && sentR.length === sendsStart + 1
        && panelDesc().includes(`<@${UR.demoted}>: member on record, no member role.`)
        && readMembershipR()[UR.demoted].standing === 'member',
        JSON.stringify({ k: openKeys(), e: panelEdits - editsPre, n: sentR.length - sendsStart, d: panelDesc() }));
      const demotedTwice = await rw.onMemberUpdate(liveClientR(demGuild), demOld, demNew, { settleMs: 0 });
      ok('rolewatch: the same demotion drift never opens twice',
        demotedTwice === false && openKeys().length === 1);

      // No record: a panel row, and no standing is created.
      const strayOld = fakeMemberR(UR.stray, 'Stray', [PING]);
      const strayNew = fakeMemberR(UR.stray, 'Stray', [PING, UNBOUND]);
      const strayGuild = liveGuildR([strayNew]);
      strayOld.guild = strayGuild; strayNew.guild = strayGuild;
      const straySeen = await rw.onMemberUpdate(liveClientR(strayGuild), strayOld, strayNew, { settleMs: 0 });
      ok('rolewatch: a member role with no record opens a panel row and creates nothing',
        straySeen === true && openKeys().includes(`norecord:${UR.stray}`)
        && panelDesc().includes(`<@${UR.stray}>: member role, no record.`)
        && !readMembershipR()[UR.stray]);

      // Friend holder gaining a member role: exempt, untouched.
      const frOld = fakeMemberR(UR.friend, 'Friend', [GUEST, FRIEND]);
      const frNew = fakeMemberR(UR.friend, 'Friend', [GUEST, FRIEND, IRON]);
      const frGuild = liveGuildR([frNew]);
      frOld.guild = frGuild; frNew.guild = frGuild;
      const friendSeen = await rw.onMemberUpdate(liveClientR(frGuild), frOld, frNew, { settleMs: 0 });
      ok('rolewatch: a Friend holder is exempt from the live watch',
        friendSeen === false && readMembershipR()[UR.friend].standing === 'guest'
        && !openKeys().some((k) => k.endsWith(UR.friend)));

      // Member to guest: record flips, rank role comes off, a recent row.
      const swapOld = fakeMemberR(UR.guestSwap, 'GuestSwap', [IRON, INITIATE]);
      const swapNew = fakeMemberR(UR.guestSwap, 'GuestSwap', [GUEST, INITIATE]);
      const swapGuild = liveGuildR([swapNew]);
      swapOld.guild = swapGuild; swapNew.guild = swapGuild;
      const swapsBefore = rosterRefreshes;
      const swapped = await rw.onMemberUpdate(liveClientR(swapGuild), swapOld, swapNew, { settleMs: 0 });
      const swapRecent = panelM.loadState().recent[0];
      ok('rolewatch: a hand swap to Guest lines the record up and records a recent action',
        swapped === true
        && readMembershipR()[UR.guestSwap].standing === 'guest'
        && readMembershipR()[UR.guestSwap].via === 'role-watch'
        && !swapNew.roles.cache.has(INITIATE) && swapNew.roles.cache.has(GUEST)
        && rosterRefreshes > swapsBefore
        && swapRecent.action === 'demote' && swapRecent.userId === UR.guestSwap && swapRecent.rankRemoved === true
        && panelDesc().includes(`<@${UR.guestSwap}> set to guest. Rank role removed.`));
      const swappedAgain = await rw.onMemberUpdate(liveClientR(swapGuild), swapOld, swapNew, { settleMs: 0 });
      ok('rolewatch: a repeat guest-swap event does nothing twice',
        swappedAgain === false && panelM.loadState().recent.filter((r) => r.userId === UR.guestSwap).length === 1);

      // A live fix clears an open flag: the flag opens, the record
      // is set to guest by hand, the person gains Guest, and the
      // access change lets classify() return null.
      const clrOld = fakeMemberR(UR.clearMe, 'ClearMe', [IRON]);
      const clrNew = fakeMemberR(UR.clearMe, 'ClearMe', [PING]);
      const clrGuild = liveGuildR([clrNew]);
      clrOld.guild = clrGuild; clrNew.guild = clrGuild;
      await rw.onMemberUpdate(liveClientR(clrGuild), clrOld, clrNew, { settleMs: 0 });
      const flagOpened = openKeys().includes(`demotion:${UR.clearMe}`);
      require(path.join(__dirname, '..', 'src', 'store.js')).setMembershipStanding(GIDR, UR.clearMe, 'guest', 'panel');
      const clrNew2 = fakeMemberR(UR.clearMe, 'ClearMe', [PING, GUEST]);
      const clrGuild2 = liveGuildR([clrNew2]);
      clrNew2.guild = clrGuild2;
      const cleared = await rw.onMemberUpdate(liveClientR(clrGuild2), clrNew, clrNew2, { settleMs: 0 });
      ok('rolewatch: an access change that resolves a flag clears the row at once',
        flagOpened && cleared === true && !openKeys().includes(`demotion:${UR.clearMe}`)
        && !panelDesc().includes(`<@${UR.clearMe}>`));

      // ---- The sweep --------------------------------------------------
      // Before the sweep the panel holds the live demotion and
      // no-record rows. Neither person is in the sweep roster, so
      // both rows are pruned.
      const sweepMembersR = new Map();
      const sweepGuildR = {
        id: GIDR,
        members: { fetch: async () => sweepMembersR, cache: sweepMembersR },
        channels: { cache: channelsR() },
      };
      const addSweepMember = (m) => { m.guild = sweepGuildR; sweepMembersR.set(m.id, m); return m; };
      const repairMember = fakeMemberR(UR.repair, 'Repair', [GUEST, IRON]);
      addSweepMember(repairMember);
      addSweepMember(fakeMemberR(UR.sweepDemoted, 'SweepDemoted', [GUEST]));
      addSweepMember(fakeMemberR(UR.stray2, 'StrayTwo', [UNBOUND]));
      addSweepMember(fakeMemberR(UR.quiet, 'Quiet', [IRON]));
      addSweepMember(fakeMemberR(UR.friend, 'Friend', [GUEST, FRIEND, IRON]));
      addSweepMember(fakeMemberR(UR.turtle, 'Turtle', [PING]));
      addSweepMember(fakeMemberR(UR.bot, 'Botty', [IRON], true));
      const sweepClientR = liveClientR(sweepGuildR);
      guildCacheR.invalidateCache();
      const preKeys = openKeys();
      const editsPreSweep = panelEdits;
      const sweptOnce = await rw.runSweep(sweepClientR);
      const stSweep = panelM.loadState();
      ok('rolewatch: the sweep repairs, records, flags and prunes a resolved flag from the panel',
        sweptOnce === true
        && preKeys.includes(`demotion:${UR.demoted}`) && preKeys.includes(`norecord:${UR.stray}`)
        && Object.keys(stSweep.open).sort().join() === `norecord:${UR.stray2}`
        && stSweep.recent.some((r) => r.action === 'repair' && r.userId === UR.repair)
        && stSweep.recent.some((r) => r.action === 'demote' && r.userId === UR.sweepDemoted && r.rankRemoved === false)
        && readMembershipR()[UR.sweepDemoted].standing === 'guest'
        && readMembershipR()[UR.repair].standing === 'member'
        && repairMember.roles.cache.has(INITIATE)
        && readCcR().entries.some((e) => e.userId === UR.repair && e.newRank === 'Initiate')
        && generalSentR.length === 1
        && panelEdits > editsPreSweep
        && panelDesc().includes(`<@${UR.stray2}>: member role, no record.`)
        && panelDesc().includes(`<@${UR.repair}> record fixed to member.`),
        JSON.stringify(stSweep));
      const recentLen = stSweep.recent.length;
      const editsPre2 = panelEdits;
      const sweptTwice = await rw.runSweep(sweepClientR);
      ok('rolewatch: a repeat sweep adds nothing new but still refreshes the panel',
        sweptTwice === true && panelM.loadState().recent.length === recentLen
        && panelEdits === editsPre2 + 1
        && Object.keys(panelM.loadState().open).join() === `norecord:${UR.stray2}`);
      // A deleted panel comes back on the next sweep.
      panelMsgs.clear();
      const sendsBeforeSweep3 = sentR.length;
      await rw.runSweep(sweepClientR);
      ok('rolewatch: the sweep re-posts a deleted panel', sentR.length === sendsBeforeSweep3 + 1);

      // Settled cases: a settled member's drift is not flagged
      // live, and the sweep drops an existing row for them.
      fs.writeFileSync(settledPathR, JSON.stringify({ userIds: [UR.stray2, UR.demoted], rsns: [] }));
      const demSettled = await rw.onMemberUpdate(liveClientR(demGuild), demOld, demNew, { settleMs: 0 });
      ok('rolewatch: a settled member is not flagged by the live watch',
        demSettled === false && !openKeys().includes(`demotion:${UR.demoted}`)
        && readMembershipR()[UR.demoted].standing === 'member');
      await rw.runSweep(sweepClientR);
      ok('rolewatch: a settled no-record member is dropped from the panel by the sweep',
        openKeys().length === 0, JSON.stringify(openKeys()));
      if (savedSettledR === null) { try { fs.unlinkSync(settledPathR); } catch {} }
      else fs.writeFileSync(settledPathR, savedSettledR);

      // Snapshot fallback: the member fetch fails, the roles
      // snapshot still answers, and the sweep flags from it.
      guildCacheR.invalidateCache();
      writeFixtureR('membership.json', {
        [GIDR]: { [UR.quiet]: { standing: 'member', at: Date.now(), via: 'approval' } },
      });
      fs.writeFileSync(snapPathR, JSON.stringify({
        generatedAt: new Date().toISOString(), roles: {},
        members: { [UR.snapStray]: [IRON], [UR.quiet]: [IRON] },
      }));
      const snapGuildR = {
        id: GIDR,
        members: { fetch: async () => { throw new Error('fetch down'); }, cache: new Map() },
        channels: { cache: channelsR() },
      };
      const snapSwept = await rw.runSweep(liveClientR(snapGuildR));
      ok('rolewatch: the sweep falls back to the roles snapshot',
        snapSwept === true && openKeys().join() === `norecord:${UR.snapStray}`
        && panelDesc().includes(`<@${UR.snapStray}>: member role, no record.`),
        JSON.stringify(openKeys()));

      // Neither source answers: silence, no crash, no panel change.
      try { fs.unlinkSync(snapPathR); } catch {}
      guildCacheR.invalidateCache();
      const stBeforeNone = JSON.stringify(panelM.loadState());
      const editsNone = panelEdits;
      const noSource = await rw.runSweep(liveClientR(snapGuildR));
      ok('rolewatch: with no member source the sweep stays silent',
        noSource === false && JSON.stringify(panelM.loadState()) === stBeforeNone && panelEdits === editsNone);
    } finally {
      cfgR.roleSync = roleSyncBefore;
      compRosterM.scheduleRefresh = realScheduleRefresh;
      guildCacheR.invalidateCache();
      if (savedSettledR === null) { try { fs.unlinkSync(settledPathR); } catch {} }
      else fs.writeFileSync(settledPathR, savedSettledR);
      restoreR();
    }
  }

  sec('AC. /total fixture block');
  // /total (Nov 26, 2026): the in-game skills tab card. A fixture
  // account with a known WOM-shaped skill set goes in the stats
  // cache; the stub captures the /total body so the levels order,
  // clamping, the missing-skill default and the total are checked
  // exactly. A cached not-found name checks the miss text against
  // /skills. Both names carry a seed marker so no lookup leaves
  // the machine.
  {
    const totalSrcIdx = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.js'), 'utf8');
    const totalSrcCmds = fs.readFileSync(path.join(__dirname, '..', 'src', 'commands.js'), 'utf8');
    const slashNames = S.commands.map((c) => c.data.name);
    ok('total: /total is in the slash command list',
      slashNames.includes('total') && totalSrcCmds.includes('...showoff.commands'));
    const totalSlash = S.commands.find((c) => c.data.name === 'total');
    const totalOpts = totalSlash ? (totalSlash.data.toJSON().options || []) : [];
    ok('total: /total takes one optional player option, like /skills',
      totalOpts.length === 1 && totalOpts[0].name === 'player' && !totalOpts[0].required);
    ok('total: !total is in the text command map',
      typeof S.handleTotalCommand === 'function'
      && /const \{[^}]*\bhandleTotalCommand\b[^}]*\} = require\('\.\/showoff'\)/.test(totalSrcIdx)
      && totalSrcIdx.includes("else if (cmd === 'total') await handleTotalCommand(message, parts.slice(1));"));

    const wcPath = path.join(DATA, 'wom-cache-v3.json');
    const seedPath = path.join(DATA, 'cold-seeds.json');
    const vaultPath = path.join(DATA, 'player-vault.json');
    const savedT = {};
    for (const p of [wcPath, seedPath, vaultPath]) savedT[p] = fs.existsSync(p) ? fs.readFileSync(p) : null;
    const TAB = ['attack', 'hitpoints', 'mining', 'strength', 'agility', 'smithing',
      'defence', 'herblore', 'fishing', 'ranged', 'thieving', 'cooking',
      'prayer', 'crafting', 'firemaking', 'magic', 'fletching', 'woodcutting',
      'runecrafting', 'slayer', 'farming', 'construction', 'hunter', 'sailing'];
    // Distinct level per skill so any order slip shows; sailing is
    // missing (defaults to 1), hunter is 0 (clamps up to 1).
    const fxLevels = [70, 80, 61, 75, 55, 63, 72, 50, 66, 90, 58, 71,
      52, 64, 73, 94, 85, 67, 44, 88, 62, 56, 0, null];
    const fxSkills = { overall: { level: 1567, xp: 12345678 } };
    TAB.forEach((k, i) => { if (fxLevels[i] !== null) fxSkills[k] = { level: fxLevels[i], xp: 1000 + i }; });
    const fxName = 'Total Fixture';
    const ghost = 'Total Ghost';
    try {
      const wc = savedT[wcPath] ? JSON.parse(savedT[wcPath]) : {};
      wc[fxName.toLowerCase()] = { fetchedAt: Date.now(), stats: { combat: 90, skills: fxSkills, kc: {} } };
      wc[ghost.toLowerCase()] = { fetchedAt: Date.now(), stats: { notFound: true } };
      fs.writeFileSync(wcPath, JSON.stringify(wc));
      const seeds = savedT[seedPath] ? JSON.parse(savedT[seedPath]) : {};
      seeds[fxName.toLowerCase()] = Date.now();
      seeds[ghost.toLowerCase()] = Date.now();
      fs.writeFileSync(seedPath, JSON.stringify(seeds));

      const tp = await S.totalPayload(fxName, null);
      const files = (tp && tp.files) || [];
      ok('total: reply is one total.png and nothing else',
        files.length === 1 && files[0].name === 'total.png' && !tp.content && !(tp.components || []).length,
        JSON.stringify(Object.keys(tp || {})));
      let captured = null;
      if (process.env.CARD_API_URL) {
        const r = await fetch(process.env.CARD_API_URL.replace(/\/$/, '') + '/__captured/total').catch(() => null);
        if (r && r.ok) captured = await r.json().catch(() => null);
      }
      if (captured) {
        const want = [70, 80, 61, 75, 55, 63, 72, 50, 66, 90, 58, 71,
          52, 64, 73, 94, 85, 67, 44, 88, 62, 56, 1, 1];
        ok('total: posts the 24 levels in skills-tab order (missing -> 1, clamped 1..99)',
          JSON.stringify(captured.levels) === JSON.stringify(want), JSON.stringify(captured.levels));
        ok('total: posts the stats total level', captured.total === 1567, String(captured.total));
      } else {
        console.log('SKIP total: body capture needs tools/card-stub.js at CARD_API_URL');
      }

      const skMiss = await S.skillsPayload(ghost, null);
      const tMiss = await S.totalPayload(ghost, null);
      ok('total: unknown name gets the /skills not-found text, word for word',
        !!skMiss && !!tMiss && typeof tMiss.content === 'string'
        && tMiss.content === skMiss.content
        && tMiss.content === `Could not find the RuneScape name **${ghost}**. Check the spelling and try again.`,
        tMiss && tMiss.content);
    } finally {
      for (const p of [wcPath, seedPath, vaultPath]) {
        if (savedT[p] === null) { try { fs.unlinkSync(p); } catch {} }
        else fs.writeFileSync(p, savedT[p]);
      }
    }
  }

  sec('AD. skills card on approval');
  // Skills card on approval (2026-11-26): gate-free helper plus the
  // approve-path hook, checked by source shape.
  {
    ok('skills approval: skillsCardAttachment is exported', typeof S.skillsCardAttachment === 'function');
    const realFetch = global.fetch;
    let cardCalls = 0;
    global.fetch = async (url, opts) => {
      if (String(url).includes('/skills')) {
        cardCalls++;
        return { ok: true, status: 200, headers: { get: () => null }, arrayBuffer: async () => new Uint8Array([137, 80, 78, 71]).buffer };
      }
      return realFetch(url, opts);
    };
    try {
      const att = await S.skillsCardAttachment(PRIMARY);
      ok('skills approval: known RSN returns an attachment named skills.png',
        !!att && att.name === 'skills.png' && cardCalls === 1, `calls=${cardCalls}`);
      ok('skills approval: empty RSN returns null', (await S.skillsCardAttachment('')) === null);
      const none = await S.skillsCardAttachment('zzq no such rsn 9981');
      ok('skills approval: unknown RSN returns null', none === null);
    } finally {
      global.fetch = realFetch;
    }
    const recruitSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'recruit.js'), 'utf8');
    const hookAt = recruitSrc.indexOf('skillsCardAttachment');
    ok('skills approval: recruit.js references the helper exactly once',
      hookAt >= 0 && recruitSrc.indexOf('skillsCardAttachment', hookAt + 1) === -1);
    const approveAt = recruitSrc.indexOf("decision === 'approve'");
    const prelinkAt = recruitSrc.indexOf('await runApprovalPrelink(');
    const renameAt = recruitSrc.indexOf('thread.setName(`${base} - ${verdict}`');
    ok('skills approval: hook sits after prelink and before the rename/lock block',
      approveAt >= 0 && prelinkAt > approveAt && hookAt > prelinkAt && renameAt > hookAt);
    const showSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'showoff.js'), 'utf8');
    const fnAt = showSrc.indexOf('async function skillsCardAttachment');
    const fnBody = showSrc.slice(fnAt, showSrc.indexOf('\n}\n', fnAt));
    ok('skills approval: helper has no gate and no cooldown call',
      fnAt > 0 && !/ownAccountGate|noteUse/.test(fnBody));
  }


  sec('AE. bump tool public panel');
  {
    const BT = require(path.join(__dirname, '..', 'src', 'bump-tool.js'));
    const st = {
      lastBumpedAt: new Date(Date.now() - 3 * 3600 * 1000).toISOString(),
      lastBumpedBy: 'u1',
      counts: { u1: 14, u2: 11, u3: 9, u4: 7, u5: 5, u6: 2 },
      names: { u1: 'Ptstud', u2: 'Kagaku', u3: 'Ben Lad Iron', u4: 'IronClamChow', u5: 'Ferric Niko', u6: 'Extra' },
    };
    const top = BT.topBumpers(st);
    ok('bump panel: leaderboard sorts and cuts at 5', top.length === 5 && top[0][0] === 'u1' && top[4][0] === 'u5');
    const txt = BT.publicPanelContent(st);
    ok('bump panel: ready once the 2h window has passed', txt.includes('Status: **Ready to bump**'));
    ok('bump panel: leader carries the star and the count', txt.includes('\u{1F947} Ptstud \u2605 - 14'));
    ok('bump panel: plain text, medals on the top 3, no instruction line', txt.startsWith('**Bump**') && txt.includes('\u{1F947} Ptstud') && txt.includes('\u{1F948} Kagaku') && txt.includes('\u{1F949} Ben Lad Iron') && !txt.includes('tap **I bumped**'));
    const txt2 = BT.publicPanelContent({});
    ok('bump panel: empty state is ready with no board', txt2.includes('Ready to bump') && !txt2.includes('Top bumpers'));
    const btSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'bump-tool.js'), 'utf8');
    ok('bump panel: public gate names members and Friends', btSrc.includes('Only members and Friends of the Clan can log a bump.'));
    ok('bump panel: config carries the public channel', Boolean(require(path.join(__dirname, '..', 'src', 'config.js')).bumpTool.publicChannelId));
  }

  sec(null);
  console.log(`SECTION-TIME total: ${secTimes.reduce((a, s) => a + s.ms, 0)}ms`);
  console.log(`\nRESULT: ${pass} pass, ${fail} fail`);
  if (fails.length) console.log('FAILURES:', fails.join(' ;; '));
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('SCRIPT FAIL', e); process.exit(1); });
