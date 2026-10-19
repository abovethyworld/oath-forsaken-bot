// Tests for the team finder (src/teams.js).
// Run with: node test/teams-tests.js
// Pure logic + light mocks. No Discord connection needed.

const assert = require('node:assert');
const {
  ACTIVITIES,
  REGIONS,
  toaModeForLevel,
  parseCoxScale,
  parseSizeInput,
  parseRaidLevel,
  validateWorld,
  rolesFor,
  roleModeFor,
  nmSizeAndPing,
  memberCount,
  isTeamFull,
  applyJoin,
  applyLeave,
  applyRoleClaim,
  buildTeamFromData,
  creationStepsFor,
  activityRoleId,
  buildTeamEmbed,
  buildListingComponents,
  teamPanelPayload,
  settingsPanelPayload,
  rsnSwitchPayload,
  normalizeRsnEntry,
  getRsnEntry,
  addRsn,
  setActiveRsn,
  boardApplies,
  shouldSweepTeam,
  shouldAutoClose,
  SPECS,
  specsForActivity,
  loadSpecs,
  getOwnedSpecs,
  toggleOwnedSpec,
  getShownSpecs,
  toggleShownSpec,
  kcMetricForTeam,
  sizeOptionsFor,
  getBadge,
  getManualBadge,
  setManualBadge,
  mutateTeams,
} = require('../src/teams');
const { combatLevel, parseStats } = require('../src/wom');
const { renderPartyBoard, boardHeight, shortDisplayName, bossIconKey } = require('../src/party-board');
const { ZAMORAK_RED } = require('../src/utils');
const config = require('../src/config');

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    failures.push({ name, error: e.message });
    console.log(`  ✗ ${name}: ${e.message}`);
  }
}

// ─── Activity registry ──────────────────────────────────────────

test('all 20 activities defined with name, category, and ping role', () => {
  const keys = Object.keys(ACTIVITIES);
  assert.strictEqual(keys.length, 20, `expected 20 activities, got ${keys.length}`);
  for (const [key, a] of Object.entries(ACTIVITIES)) {
    assert.ok(a.name, `${key} missing name`);
    assert.ok(['raids', 'skilling', 'bosses'].includes(a.category), `${key} bad category`);
    assert.ok(activityRoleId(key), `${key} missing ping role`);
  }
  // Split raid modes share the 3 raid ping roles.
  assert.strictEqual(activityRoleId('toa_expert'), activityRoleId('toa'));
  assert.strictEqual(activityRoleId('cox_cm'), activityRoleId('cox'));
  assert.strictEqual(activityRoleId('tob_hard'), activityRoleId('tob'));
});

test('creation steps are slim: activity-specific questions plus note only', () => {
  const noNote = ['wintertodt', 'gotr', 'tempoross', 'zalcano'];
  for (const key of Object.keys(ACTIVITIES)) {
    const pre = ACTIVITIES[key].pre
      ? { tobScale: '4s', nmMode: 'team', hueyInstance: 'public', wagWorld: 'mass' }[ACTIVITIES[key].pre]
      : null;
    const steps = creationStepsFor(key, pre);
    const ids = steps.map((s) => s.id);
    // Size, world, region, hub are post-creation now.
    for (const gone of ['sizeChoice', 'size', 'tier', 'region', 'world', 'hub']) {
      assert.ok(!ids.includes(gone), `${key} should not ask ${gone} in creation`);
    }
    if (!noNote.includes(key)) {
      assert.ok(ids.includes('note'), `${key} missing note step`);
    }
    // No em dashes in prompts.
    for (const s of steps) assert.ok(!s.prompt.includes('—'), `${key} step ${s.id} has em dash`);
  }
  // Raid-specific flows.
  assert.deepStrictEqual(creationStepsFor('toa').map((s) => s.id), ['note'], 'toa is just a note');
  assert.deepStrictEqual(creationStepsFor('toa_expert').map((s) => s.id), ['invo', 'note'], 'toa_expert asks invo');
  assert.deepStrictEqual(creationStepsFor('cox').map((s) => s.id), ['raiders', 'scalers', 'layout', 'note'], 'cox');
  assert.deepStrictEqual(creationStepsFor('cox_cm').map((s) => s.id), ['raiders', 'scalers', 'note'], 'cox_cm skips layout');
});

test('ToA Expert asks invo split, plain ToA asks nothing', () => {
  const invo = creationStepsFor('toa_expert', null).find((s) => s.id === 'invo');
  assert.strictEqual(invo.kind, 'buttons');
  assert.deepStrictEqual(invo.options.map((o) => o.id), ['Expert', 'High Invo']);
});

test('sizeOptionsFor: post-creation Size button options per activity', () => {
  // ToA: 2-8 + Any.
  assert.deepStrictEqual(sizeOptionsFor('toa').map((o) => o.id), ['2', '3', '4', '5', '6', '7', '8', 'any']);
  assert.deepStrictEqual(sizeOptionsFor('toa_expert').map((o) => o.id), ['2', '3', '4', '5', '6', '7', '8', 'any']);
  // Nex: 2, 3, 5, 8, Mass (wiki strat sizes).
  assert.deepStrictEqual(sizeOptionsFor('nex').map((o) => o.id), ['2', '3', '5', '8', 'mass', 'any']);
  // Hueycoatl: 3, 4, 5 + Mass.
  assert.deepStrictEqual(sizeOptionsFor('huey').map((o) => o.id), ['3', '4', '5', 'mass', 'any']);
  // Wilderness bosses: Mass + Any.
  for (const key of ['venenatis', 'callisto', 'vetion']) {
    assert.deepStrictEqual(sizeOptionsFor(key).map((o) => o.id), ['mass', 'any'], key);
  }
  // Fixed, role-based, and CoX (raiders in creation) get no Size button.
  for (const key of ['yama', 'royals', 'ba', 'tob', 'tob_hard', 'cox', 'cox_cm', 'nm', 'wintertodt', 'wag']) {
    assert.strictEqual(sizeOptionsFor(key), null, `${key} should have no Size button`);
  }
});

test('Venenatis, Callisto, and Vetion start open', () => {
  const { team, error } = buildTeamFromData('venenatis', null, { note: '' }, { id: 'org1', displayName: 'Alex' });
  assert.ok(!error, error);
  assert.strictEqual(team.size, null);
  assert.strictEqual(team.mass, false);
});

test('CoX steps are raiders, scalers, layout; CM skips layout', () => {
  const steps = creationStepsFor('cox', null);
  const raiders = steps.find((s) => s.id === 'raiders');
  const scalers = steps.find((s) => s.id === 'scalers');
  const layout = steps.find((s) => s.id === 'layout');
  assert.ok(raiders && scalers && layout);
  assert.deepStrictEqual(raiders.options.map((o) => o.id).slice(0, 3), ['1', '2', '3']);
  assert.strictEqual(scalers.options[0].id, '0');
  assert.strictEqual(scalers.options[0].label, 'None');
  assert.deepStrictEqual(layout.options.map((o) => o.id), ['Normal', 'Large', 'Full']);
  const cmSteps = creationStepsFor('cox_cm', null).map((s) => s.id);
  assert.ok(!cmSteps.includes('layout'), 'CM has no layout step');
});

test('four regions are offered', () => {
  assert.deepStrictEqual(REGIONS.map((r) => r.id), ['US-East', 'US-West', 'UK', 'DE', 'AU', 'SG', 'JP']);
});

test('pre-choice activities have matching PRE_CHOICES entries', () => {
  const { PRE_CHOICES } = require('../src/teams');
  for (const [key, a] of Object.entries(ACTIVITIES)) {
    if (a.pre) assert.ok(PRE_CHOICES[a.pre], `${key} pre ${a.pre} not defined`);
  }
});

// ─── Validators ──────────────────────────────────────────────────

test('toaModeForLevel boundaries match the wiki', () => {
  assert.strictEqual(toaModeForLevel(0), 'Entry');
  assert.strictEqual(toaModeForLevel(149), 'Entry');
  assert.strictEqual(toaModeForLevel(150), 'Normal');
  assert.strictEqual(toaModeForLevel(299), 'Normal');
  assert.strictEqual(toaModeForLevel(300), 'Expert');
  assert.strictEqual(toaModeForLevel(349), 'Expert');
  assert.strictEqual(toaModeForLevel(350), 'High Invo');
  assert.strictEqual(toaModeForLevel(600), 'High Invo');
});

test('parseCoxScale handles raiders+scalers and bare numbers', () => {
  assert.deepStrictEqual(parseCoxScale('3+2'), { raiders: 3, scalers: 2 });
  assert.deepStrictEqual(parseCoxScale('2+12'), { raiders: 2, scalers: 12 });
  assert.deepStrictEqual(parseCoxScale('5'), { raiders: 5, scalers: 0 });
  assert.strictEqual(parseCoxScale('abc'), null);
  assert.strictEqual(parseCoxScale('3+'), null);
  assert.strictEqual(parseCoxScale('0+2'), null);
  assert.strictEqual(parseCoxScale('101'), null);
});

test('validateWorld requires a 3-digit number', () => {
  assert.strictEqual(validateWorld('388'), true);
  assert.strictEqual(validateWorld(' 388 '), true);
  assert.strictEqual(validateWorld('38'), false);
  assert.strictEqual(validateWorld('3888'), false);
  assert.strictEqual(validateWorld('abc'), false);
  assert.strictEqual(validateWorld(''), false);
});

test('parseRaidLevel accepts numbers only', () => {
  assert.strictEqual(parseRaidLevel('250'), 250);
  assert.strictEqual(parseRaidLevel('0'), 0);
  assert.strictEqual(parseRaidLevel('abc'), null);
  assert.strictEqual(parseRaidLevel('-5'), null);
  assert.strictEqual(parseRaidLevel(''), null);
});

test('parseSizeInput respects fixed, range, and mass', () => {
  assert.deepStrictEqual(parseSizeInput('ba', ''), { size: 5 });
  assert.deepStrictEqual(parseSizeInput('yama', ''), { size: 2 });
  assert.deepStrictEqual(parseSizeInput('toa', '4'), { size: 4 });
  assert.ok(parseSizeInput('toa', '9').error);
  assert.ok(parseSizeInput('toa', '0').error);
  assert.deepStrictEqual(parseSizeInput('venenatis', 'mass'), { size: null });
  assert.deepStrictEqual(parseSizeInput('venenatis', 'MASS'), { size: null });
  assert.deepStrictEqual(parseSizeInput('venenatis', '8'), { size: 8 });
  assert.ok(parseSizeInput('toa', 'mass').error); // toa does not allow mass
  assert.deepStrictEqual(parseSizeInput('wintertodt', ''), { size: null });
});

test('rolesFor returns the right role sets', () => {
  assert.deepStrictEqual(rolesFor('tob', '5s'), ['Mage', 'North FZ', 'RDPS', 'MDPS 1', 'MDPS 2']);
  assert.deepStrictEqual(rolesFor('tob', '4s'), ['Mage', 'North FZ', 'RDPS', 'MDPS']);
  assert.deepStrictEqual(rolesFor('tob_hard', '5s'), ['Mage', 'North FZ', 'RDPS', 'MDPS 1', 'MDPS 2']);
  assert.deepStrictEqual(rolesFor('ba', null), ['Attacker', 'Defender', 'Collector', 'Healer', 'Flex']);
  assert.deepStrictEqual(rolesFor('yama', null), ['Mage', 'Melee']);
  assert.strictEqual(rolesFor('toa', null), null);
  assert.strictEqual(rolesFor('tob', 'bogus'), null);
  assert.strictEqual(roleModeFor('tob'), 'exclusive');
  assert.strictEqual(roleModeFor('tob_hard'), 'exclusive');
  assert.strictEqual(roleModeFor('ba'), 'exclusive');
  assert.strictEqual(roleModeFor('yama'), 'pick');
  assert.strictEqual(roleModeFor('toa'), null);
});

test('nmSizeAndPing splits team and mass', () => {
  assert.deepStrictEqual(nmSizeAndPing('team'), { size: 5, fillPing: true });
  assert.deepStrictEqual(nmSizeAndPing('mass'), { size: null, fillPing: false });
});

// ─── State transitions ──────────────────────────────────────────

function headcountTeam(size = 4) {
  return {
    activity: 'toa', status: 'open', size, roleMode: null, roles: null,
    members: {}, memberNames: {}, fillPing: true, messageId: 'm1',
  };
}

test('applyJoin adds members and reports fill', () => {
  const t = headcountTeam(2);
  let r = applyJoin(t, 'u1');
  assert.ok(r.ok && !r.filled);
  r = applyJoin(t, 'u2');
  assert.ok(r.ok && r.filled);
  assert.strictEqual(memberCount(t), 2);
});

test('applyJoin rejects duplicates, full teams, closed teams, role mode', () => {
  const t = headcountTeam(1);
  applyJoin(t, 'u1');
  assert.strictEqual(applyJoin(t, 'u1').ok, false);
  assert.strictEqual(applyJoin(t, 'u2').error, 'Team is full.');
  t.status = 'closed';
  assert.strictEqual(applyJoin(t, 'u3').ok, false);
  const rt = { ...headcountTeam(4), roleMode: 'exclusive', roles: ['Mage'] };
  assert.strictEqual(applyJoin(rt, 'u1').error, 'Pick a role button to join this team.');
});

test('open/mass teams never report full', () => {
  const t = headcountTeam(null);
  for (let i = 0; i < 30; i++) applyJoin(t, `u${i}`);
  assert.strictEqual(isTeamFull(t), false);
});

test('applyLeave removes members', () => {
  const t = headcountTeam(4);
  applyJoin(t, 'u1');
  assert.ok(applyLeave(t, 'u1').ok);
  assert.strictEqual(memberCount(t), 0);
  assert.strictEqual(applyLeave(t, 'u1').ok, false);
});

function exclusiveTeam() {
  return {
    activity: 'tob', status: 'open', size: 4, roleMode: 'exclusive',
    roles: ['Mage', 'North FZ', 'RDPS', 'MDPS'],
    members: {}, memberNames: {}, fillPing: true, messageId: 'm1',
  };
}

test('exclusive role claim: claim, taken, release, switch, fill', () => {
  const t = exclusiveTeam();
  let r = applyRoleClaim(t, 'u1', 0);
  assert.ok(r.ok && !r.filled);
  assert.strictEqual(applyRoleClaim(t, 'u2', 0).error, 'That role is taken.');
  r = applyRoleClaim(t, 'u1', 0); // tap again releases
  assert.strictEqual(r.action, 'released');
  assert.strictEqual(memberCount(t), 0);
  applyRoleClaim(t, 'u1', 1);
  r = applyRoleClaim(t, 'u1', 2); // switch roles
  assert.strictEqual(t.members.u1, 'RDPS');
  assert.strictEqual(applyRoleClaim(t, 'u9', 9).error, 'That role does not exist.');
  // fill it
  applyRoleClaim(t, 'u1', 0);
  applyRoleClaim(t, 'u2', 1);
  applyRoleClaim(t, 'u3', 2);
  r = applyRoleClaim(t, 'u4', 3);
  assert.ok(r.filled);
  assert.ok(isTeamFull(t));
});

test('pick mode (yama): both can pick mage, full at 2', () => {
  const t = {
    activity: 'yama', status: 'open', size: 2, roleMode: 'pick',
    roles: ['Mage', 'Melee'], members: {}, memberNames: {}, fillPing: false, messageId: 'm1',
  };
  let r = applyRoleClaim(t, 'u1', 0);
  assert.ok(r.ok && !r.filled);
  r = applyRoleClaim(t, 'u2', 0); // both mage
  assert.ok(r.ok && r.filled);
  assert.ok(isTeamFull(t));
  assert.strictEqual(applyRoleClaim(t, 'u3', 1).error, 'Team is full.');
  r = applyRoleClaim(t, 'u1', 0); // tap again leaves
  assert.strictEqual(r.action, 'released');
  assert.ok(!isTeamFull(t));
});

// ─── Step data -> team object ───────────────────────────────────────

const org = { id: 'org1', displayName: 'Alex' };

test('buildTeamFromData builds a valid ToA team', () => {
  const { team, error } = buildTeamFromData(
    'toa', null,
    { note: 'learners welcome' },
    org
  );
  assert.ok(!error, error);
  assert.strictEqual(team.size, null, 'size starts open');
  assert.strictEqual(team.raidLevel, null);
  assert.strictEqual(team.world, null);
  assert.strictEqual(team.region, null, 'no default region in tests');
  assert.strictEqual(team.hub, null);
  assert.strictEqual(team.fillPing, true);
});

test('buildTeamFromData builds ToA Expert with invo', () => {
  const { team, error } = buildTeamFromData('toa_expert', null, { invo: 'High Invo', note: '' }, org);
  assert.ok(!error, error);
  assert.strictEqual(team.raidLevel, 'High Invo');
});

test('buildTeamFromData requires invo for ToA Expert', () => {
  const { error } = buildTeamFromData('toa_expert', null, { note: '' }, org);
  assert.ok(error);
});

test('buildTeamFromData builds CoX scale from raiders and scalers', () => {
  const { team, error } = buildTeamFromData(
    'cox', null,
    { raiders: 3, scalers: 2, layout: 'Full', note: '' },
    org
  );
  assert.ok(!error, error);
  assert.strictEqual(team.size, 3);
  assert.deepStrictEqual(team.scale, { raiders: 3, scalers: 2 });
  assert.strictEqual(team.layout, 'Full');
});

test('buildTeamFromData builds CoX CM with no layout', () => {
  const { team, error } = buildTeamFromData(
    'cox_cm', null,
    { raiders: 5, scalers: 0 },
    org
  );
  assert.ok(!error, error);
  assert.deepStrictEqual(team.scale, { raiders: 5, scalers: 0 });
  assert.strictEqual(team.layout, null);
  assert.strictEqual(team.world, null);
});

test('buildTeamFromData requires raiders for CoX', () => {
  const { error } = buildTeamFromData('cox', null, { note: '' }, org);
  assert.ok(error);
});

test('buildTeamFromData builds ToB with 5s roles', () => {
  const { team, error } = buildTeamFromData(
    'tob', '5s',
    { note: '' },
    org
  );
  assert.ok(!error, error);
  assert.deepStrictEqual(team.roles, ['Mage', 'North FZ', 'RDPS', 'MDPS 1', 'MDPS 2']);
  assert.strictEqual(team.roleMode, 'exclusive');
});

test('buildTeamFromData builds ToB Hard Mode with 4s roles', () => {
  const { team, error } = buildTeamFromData('tob_hard', '4s', { note: '' }, org);
  assert.ok(!error, error);
  assert.deepStrictEqual(team.roles, ['Mage', 'North FZ', 'RDPS', 'MDPS']);
});

test('buildTeamFromData builds BA with fixed size and roles', () => {
  const { team, error } = buildTeamFromData(
    'ba', null,
    { region: 'US', world: '388', hub: 'oath1', note: '' },
    org
  );
  assert.ok(!error, error);
  assert.strictEqual(team.size, 5);
  assert.ok(team.roles.includes('Flex'));
});

test('buildTeamFromData builds Yama duo with optional contract', () => {
  const { team, error } = buildTeamFromData(
    'yama', null,
    { region: 'US', world: '388', hub: 'oath1', contract: 'Oathplate', note: '' },
    org
  );
  assert.ok(!error, error);
  assert.strictEqual(team.size, 2);
  assert.strictEqual(team.contract, 'Oathplate');
  assert.strictEqual(team.fillPing, false);
});

test('buildTeamFromData builds Nightmare mass as open with mass flag', () => {
  const { team, error } = buildTeamFromData(
    'nm', 'mass',
    { region: 'US', world: '388', hub: 'oath1', note: '' },
    org
  );
  assert.ok(!error, error);
  assert.strictEqual(team.size, null);
  assert.strictEqual(team.mass, true);
  assert.strictEqual(team.fillPing, false);
});

test('buildTeamFromData builds Nightmare team with fixed size 5', () => {
  const { team, error } = buildTeamFromData(
    'nm', 'team',
    { region: 'US', world: '388', hub: 'oath1', note: '' },
    org
  );
  assert.ok(!error, error);
  assert.strictEqual(team.size, 5);
  assert.strictEqual(team.mass, false);
  assert.strictEqual(team.fillPing, true);
});

test('buildTeamFromData builds skilling mass without hub', () => {
  const { team, error } = buildTeamFromData(
    'wintertodt', null,
    { region: 'US', world: '388', note: '' },
    org
  );
  assert.ok(!error, error);
  assert.strictEqual(team.size, null);
  assert.strictEqual(team.hub, null);
  assert.strictEqual(team.fillPing, false);
});

test('buildTeamFromData starts Nex and Hueycoatl open (mass is post-creation)', () => {
  for (const [key, pre] of [['nex', null], ['huey', 'public']]) {
    const { team, error } = buildTeamFromData(key, pre, { note: '' }, org);
    assert.ok(!error, error);
    assert.strictEqual(team.size, null, `${key} starts open`);
    assert.strictEqual(team.mass, false, `${key} mass not set at creation`);
  }
});

test('buildTeamEmbed shows Mass for mass teams', () => {
  const team = {
    activity: 'nex', status: 'open', size: null, mass: true, roleMode: null,
    members: { u1: true, u2: true }, memberNames: { u1: 'Alex', u2: 'Suga', org1: 'Alex' },
    organizerId: 'org1', region: 'US', messageId: 'm1',
  };
  const desc = buildTeamEmbed(team).toJSON().description;
  assert.ok(desc.includes('· Mass'), `expected Mass in embed, got: ${desc}`);
  assert.ok(!/\d+\/\d+/.test(desc), 'mass team should not show a fill count like 2/4');
  assert.ok(!/\d+ in/.test(desc), 'mass team should not show an open count like 2 in');
});

test('buildTeamEmbed shows region only when world is skipped', () => {
  const team = {
    activity: 'toa_expert', status: 'open', size: 4, roleMode: null,
    members: { org1: true }, memberNames: { org1: 'Alex' },
    organizerId: 'org1', region: 'UK', raidLevel: 'Expert', messageId: 'm1',
  };
  const desc = buildTeamEmbed(team).toJSON().description;
  assert.ok(desc.includes('Region:** UK') || desc.includes('Region: UK'), `expected region line, got: ${desc}`);
  assert.ok(desc.includes('Raid level: Expert (300-349)'), `expected invo line, got: ${desc}`);
});

test('buildTeamEmbed hides world/region/hub lines when unset', () => {
  const team = {
    activity: 'toa', status: 'open', size: null, roleMode: null,
    members: { org1: true }, memberNames: { org1: 'Alex' },
    organizerId: 'org1', world: null, region: null, hub: null, messageId: 'm1',
  };
  const desc = buildTeamEmbed(team).toJSON().description;
  assert.ok(!desc.includes('World:'), 'no world line');
  assert.ok(!desc.includes('Region:'), 'no region line');
  assert.ok(!desc.includes('Party hub:'), 'no hub line');
});

test('buildTeamEmbed shows world with region in parentheses', () => {
  const team = {
    activity: 'toa', status: 'open', size: 4, roleMode: null,
    members: { org1: true }, memberNames: { org1: 'Alex' },
    organizerId: 'org1', region: 'US', world: '420', raidLevel: 'Entry', messageId: 'm1',
  };
  const desc = buildTeamEmbed(team).toJSON().description;
  assert.ok(desc.includes('420 (US)'), `expected world with region, got: ${desc}`);
});

// ─── Embed + components ───────────────────────────────────────────

test('buildTeamEmbed uses Zamorak red and has no em dashes', () => {
  const team = {
    activity: 'toa_expert', status: 'open', size: 4, roleMode: null, roles: null,
    members: { u1: true }, memberNames: { u1: 'Alex', org1: 'Alex' },
    organizerId: 'org1', world: '388', region: 'US', hub: 'oath1', note: 'learners welcome',
    raidLevel: 'High Invo', messageId: 'm1',
  };
  const embed = buildTeamEmbed(team);
  const json = embed.toJSON();
  assert.strictEqual(json.color, ZAMORAK_RED);
  assert.ok(!json.description.includes('—'), 'em dash found in embed');
  assert.ok(!json.title.includes('—'), 'em dash found in title');
  assert.ok(json.description.includes('Raid level: High Invo (350+)'), 'raid level invo label missing');
  assert.ok(json.description.includes('1/4'));
});

test('buildTeamEmbed shows ToB pre label in the title', () => {
  const team = {
    activity: 'tob', status: 'open', pre: '5s', roleMode: 'exclusive',
    roles: ['Mage', 'North FZ', 'RDPS', 'MDPS 1', 'MDPS 2'],
    members: {}, memberNames: { org1: 'Alex' }, organizerId: 'org1',
    world: '388', hub: 'oath1', note: null, size: 5, messageId: 'm1',
  };
  const json = buildTeamEmbed(team).toJSON();
  assert.ok(json.title.includes('(5s)'), `title was: ${json.title}`);
});

test('buildTeamEmbed titles the split raid modes', () => {
  for (const [key, short] of [['toa_expert', 'ToA Expert'], ['cox_cm', 'CoX CM'], ['tob_hard', 'ToB Hard Mode']]) {
    const team = {
      activity: key, status: 'open', roleMode: null,
      members: { org1: true }, memberNames: { org1: 'Alex' },
      organizerId: 'org1', messageId: 'm1',
    };
    const title = buildTeamEmbed(team).toJSON().title;
    assert.ok(title.includes(`${short} - Find a Team`), `${key} title was: ${title}`);
  }
});

test('buildListingComponents: role mode gets role buttons plus organizer row', () => {
  const team = {
    activity: 'tob', status: 'open', pre: '4s', roleMode: 'exclusive',
    roles: ['Mage', 'North FZ', 'RDPS', 'MDPS'],
    members: { u1: 'Mage' }, memberNames: { u1: 'Alex' },
    messageId: 'm1',
  };
  const rows = buildListingComponents(team);
  assert.strictEqual(rows.length, 3);
  const roleRow = rows[0].toJSON();
  assert.strictEqual(roleRow.components.length, 4);
  assert.ok(roleRow.components[0].custom_id === 'team:role:m1:0');
  assert.ok(roleRow.components[0].label.includes('Alex'), 'claimed role shows holder');
  const orgRow = rows[1].toJSON();
  assert.deepStrictEqual(orgRow.components.map((c) => c.custom_id), ['team:close:m1', 'team:delete:m1', 'team:specshow:m1']);
  const manageRow = rows[2].toJSON();
  assert.deepStrictEqual(manageRow.components.map((c) => c.custom_id), ['team:teamworld:m1', 'team:teamregion:m1', 'team:teamhub:m1'], 'tob has no Size button');
});

test('buildListingComponents: headcount gets Join/Leave plus organizer row', () => {
  const team = { activity: 'nex', status: 'open', roleMode: null, members: {}, messageId: 'm2' };
  const rows = buildListingComponents(team);
  assert.strictEqual(rows.length, 3);
  assert.deepStrictEqual(
    rows[0].toJSON().components.map((c) => c.custom_id),
    ['team:join:m2', 'team:leave:m2']
  );
  assert.deepStrictEqual(
    rows[2].toJSON().components.map((c) => c.custom_id),
    ['team:teamsize:m2', 'team:teamworld:m2', 'team:teamregion:m2', 'team:teamhub:m2'],
    'nex gets the full manage row'
  );
});

test('buildListingComponents: closed teams get no buttons', () => {
  const team = { activity: 'nex', status: 'closed', roleMode: null, members: {}, messageId: 'm2' };
  assert.deepStrictEqual(buildListingComponents(team), []);
});

test('teamPanelPayload has a red Create Team button', () => {
  const payload = teamPanelPayload();
  const btn = payload.components[0].toJSON().components[0];
  assert.strictEqual(btn.custom_id, 'team:create');
  assert.strictEqual(btn.label, 'Create Team');
  assert.strictEqual(btn.style, 4); // Danger
  const desc = payload.embeds[0].toJSON().description;
  assert.ok(!desc.includes('—'));
  assert.ok(!/clean|stale/i.test(desc));
});

// ─── Sweep predicate ──────────────────────────────────────────────

test('shouldSweepTeam expires unfilled and closed listings after 24h', () => {
  const now = Date.now();
  const H = 3600 * 1000;
  const open = { status: 'open', size: 4, roleMode: null, members: {}, createdAt: now - 25 * H };
  assert.strictEqual(shouldSweepTeam(open, now), true);
  assert.strictEqual(shouldSweepTeam({ ...open, createdAt: now - 23 * H }, now), false);
  const closed = { status: 'closed', closedAt: now - 25 * H };
  assert.strictEqual(shouldSweepTeam(closed, now), true);
  assert.strictEqual(shouldSweepTeam({ ...closed, closedAt: now - 23 * H }, now), false);
  // Filled teams survive until closed.
  const filled = { status: 'open', size: 1, roleMode: null, members: { u1: true }, createdAt: now - 48 * H };
  assert.strictEqual(shouldSweepTeam(filled, now), false);
});

test('shouldAutoClose fires for filled open teams older than 24h', () => {
  const now = Date.now();
  const H = 3600 * 1000;
  const old = { status: 'open', size: 2, roleMode: null, members: { u1: true, u2: true }, createdAt: now - 25 * H };
  assert.strictEqual(shouldAutoClose(old, now), true);
  assert.strictEqual(shouldAutoClose({ ...old, createdAt: now - 23 * H }, now), false);
  // Unfilled, closed, or role teams without full state do not auto-close.
  assert.strictEqual(shouldAutoClose({ ...old, members: { u1: true } }, now), false);
  assert.strictEqual(shouldAutoClose({ ...old, status: 'closed' }, now), false);
});

test('buildTeamFromData auto-adds the organizer on headcount teams', () => {
  const { team, error } = buildTeamFromData(
    'toa', null,
    { size: 4, tier: 'Normal', region: 'US', world: '388', hub: 'oath1', note: '' },
    org
  );
  assert.ok(!error, error);
  assert.ok(team.members['org1'], 'organizer is in members');
  assert.strictEqual(memberCount(team), 1);
});

test('buildTeamFromData does not auto-add the organizer on role teams', () => {
  const { team, error } = buildTeamFromData(
    'tob', '4s',
    { region: 'US', world: '388', hub: 'oath1', note: '' },
    org
  );
  assert.ok(!error, error);
  assert.deepStrictEqual(team.members, {}, 'organizer picks a role button instead');
});

test('buildTeamEmbed shows role count as 2/4 for ToB', () => {
  const team = {
    activity: 'tob', status: 'open', pre: '4s', roleMode: 'exclusive',
    roles: ['Mage', 'North FZ', 'RDPS', 'MDPS'],
    members: { u1: 'Mage', u2: 'RDPS' },
    memberNames: { u1: 'Alex', u2: 'Suga', org1: 'Alex' },
    organizerId: 'org1', world: '388',
  };
  const desc = buildTeamEmbed(team).toJSON().description;
  assert.ok(desc.includes('2/4'), `expected 2/4 in embed, got: ${desc}`);
});

// ─── Party board ──────────────────────────────────────────────────

test('boardApplies: all PvM yes (incl. role teams), skilling no', () => {
  assert.ok(boardApplies({ activity: 'toa' }), 'toa');
  assert.ok(boardApplies({ activity: 'nex' }), 'nex');
  assert.ok(boardApplies({ activity: 'cox' }), 'cox');
  assert.ok(boardApplies({ activity: 'tob', roleMode: 'exclusive' }), 'tob roles');
  assert.ok(!boardApplies({ activity: 'ba', roleMode: 'exclusive' }), 'ba is skilling-category');
  assert.ok(boardApplies({ activity: 'yama', roleMode: 'pick' }), 'yama roles');
  assert.ok(!boardApplies({ activity: 'wintertodt' }), 'wintertodt');
  assert.ok(!boardApplies({ activity: 'zalcano' }), 'zalcano');
  assert.ok(!boardApplies({ activity: 'wag' }), 'wag');
  assert.ok(!boardApplies({ activity: 'nope' }), 'unknown activity');
});

test('specsForActivity: relevance per boss (wiki strategy pages)', () => {
  assert.deepEqual(
    specsForActivity('toa'),
    ['bgs', 'dwh', 'eldermaul', 'soulflame', 'zcb', 'voidwaker', 'dragonclaws', 'burningclaws', 'bonedagger', 'eyeofayak'],
    'toa'
  );
  assert.deepEqual(specsForActivity('toa_expert'), specsForActivity('toa'), 'toa_expert');
  assert.deepEqual(
    specsForActivity('cox'),
    ['bgs', 'dwh', 'eldermaul', 'tonalztics', 'zcb', 'voidwaker', 'dragonclaws', 'bonedagger', 'zgs'],
    'cox'
  );
  assert.deepEqual(specsForActivity('cox_cm'), specsForActivity('cox'), 'cox_cm');
  assert.deepEqual(
    specsForActivity('tob'),
    ['bgs', 'dwh', 'eldermaul', 'tonalztics', 'zcb', 'voidwaker', 'dragonclaws', 'burningclaws'],
    'tob'
  );
  assert.deepEqual(specsForActivity('tob_hard'), specsForActivity('tob'), 'tob_hard');
  assert.deepEqual(
    specsForActivity('yama'),
    ['bgs', 'dwh', 'eldermaul', 'accursed', 'soulflame', 'voidwaker', 'dragonclaws', 'burningclaws', 'sgs', 'emberlight', 'eyeofayak'],
    'yama'
  );
  assert.deepEqual(specsForActivity('nex'), ['zcb', 'voidwaker', 'burningclaws'], 'nex');
  assert.deepEqual(specsForActivity('huey'), ['dragonclaws', 'burningclaws'], 'huey');
  assert.deepEqual(specsForActivity('venenatis'), ['dwh', 'eldermaul', 'webweaver', 'dinhs'], 'venenatis');
  assert.deepEqual(specsForActivity('wintertodt'), [], 'skilling');
  assert.deepEqual(specsForActivity('nope'), [], 'unknown activity');
});

test('kcMetricForTeam: split raid modes map directly', () => {
  assert.equal(kcMetricForTeam({ activity: 'toa' }), 'tombs_of_amascut');
  assert.equal(kcMetricForTeam({ activity: 'toa_expert' }), 'tombs_of_amascut_expert');
  assert.equal(kcMetricForTeam({ activity: 'cox' }), 'chambers_of_xeric');
  assert.equal(kcMetricForTeam({ activity: 'cox_cm' }), 'chambers_of_xeric_challenge_mode');
  assert.equal(kcMetricForTeam({ activity: 'tob' }), 'theatre_of_blood');
  assert.equal(kcMetricForTeam({ activity: 'tob_hard' }), 'theatre_of_blood_hard_mode');
  assert.equal(kcMetricForTeam({ activity: 'yama' }), 'yama');
  assert.equal(kcMetricForTeam({ activity: 'nex' }), 'nex');
  assert.equal(kcMetricForTeam({ activity: 'nm' }), 'nightmare');
  assert.equal(kcMetricForTeam({ activity: 'huey' }), 'the_hueycoatl');
  assert.equal(kcMetricForTeam({ activity: 'royals' }), 'the_royal_titans');
  assert.equal(kcMetricForTeam({ activity: 'venenatis' }), 'venenatis');
});

test('bossIconKey strips raid mode suffixes', () => {
  assert.equal(bossIconKey('tombs_of_amascut_expert'), 'tombs_of_amascut');
  assert.equal(bossIconKey('chambers_of_xeric_challenge_mode'), 'chambers_of_xeric');
  assert.equal(bossIconKey('theatre_of_blood_hard_mode'), 'theatre_of_blood');
  assert.equal(bossIconKey('yama'), 'yama');
  assert.equal(bossIconKey('the_hueycoatl'), 'the_hueycoatl');
});

test('renderPartyBoard accepts a kc per row', () => {
  const { renderPartyBoard } = require('../src/party-board');
  const buf = renderPartyBoard(
    [{ name: 'PTstud', stats: [124, 99, 99, 99, 99, 98, 99, 85], specs: [], kc: 1240 }],
    0
  );
  assert.ok(Buffer.isBuffer(buf) && buf.length > 1000, 'renders with kc');
  const buf2 = renderPartyBoard(
    [{ name: 'Nobody', stats: null, specs: [], kc: null }],
    0
  );
  assert.ok(Buffer.isBuffer(buf2), 'renders without kc');
});

test('SPECS has seventeen weapons in three categories with unique ids', () => {
  assert.equal(SPECS.length, 17);
  assert.equal(new Set(SPECS.map((s) => s.id)).size, 17);
  for (const s of SPECS) assert.ok(s.label && s.name && s.cat, s.id);
  const cats = new Set(SPECS.map((s) => s.cat));
  assert.deepEqual([...cats].sort(), ['def', 'off', 'util'], 'three categories');
  assert.equal(SPECS.filter((s) => s.cat === 'def').length, 8, 'defense lowering');
  assert.equal(SPECS.filter((s) => s.cat === 'off').length, 6, 'offensive');
  assert.equal(SPECS.filter((s) => s.cat === 'util').length, 3, 'utility');
});

test('toggleOwnedSpec adds, removes, and ignores bad ids', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const file = path.join(__dirname, '..', 'data', 'specs.json');
  const backup = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
  try {
    if (fs.existsSync(file)) fs.unlinkSync(file);
    const u = 'test-user-specs';
    assert.deepEqual(getOwnedSpecs(u), [], 'starts empty');
    assert.deepEqual(toggleOwnedSpec(u, 'dwh'), ['dwh'], 'add dwh');
    assert.deepEqual(toggleOwnedSpec(u, 'bgs'), ['dwh', 'bgs'], 'add bgs');
    assert.deepEqual(getOwnedSpecs(u), ['dwh', 'bgs'], 'persists');
    assert.deepEqual(toggleOwnedSpec(u, 'dwh'), ['bgs'], 'remove dwh');
    assert.deepEqual(toggleOwnedSpec(u, 'nope'), ['bgs'], 'bad id ignored');
    assert.deepEqual(loadSpecs()[u].owned, ['bgs'], 'stored');
  } finally {
    if (backup !== null) fs.writeFileSync(file, backup);
    else if (fs.existsSync(file)) fs.unlinkSync(file);
  }
});

test('spec store migrates the old flat array shape', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const file = path.join(__dirname, '..', 'data', 'specs.json');
  const backup = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
  try {
    fs.writeFileSync(file, JSON.stringify({ 'test-user-mig': ['dwh', 'bgs'] }));
    assert.deepEqual(getOwnedSpecs('test-user-mig'), ['dwh', 'bgs'], 'old shape reads as owned');
  } finally {
    if (backup !== null) fs.writeFileSync(file, backup);
    else if (fs.existsSync(file)) fs.unlinkSync(file);
  }
});

test('getShownSpecs defaults to owned and relevant; toggleShownSpec narrows it', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const file = path.join(__dirname, '..', 'data', 'specs.json');
  const backup = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
  try {
    if (fs.existsSync(file)) fs.unlinkSync(file);
    const u = 'test-user-show';
    toggleOwnedSpec(u, 'dwh');
    toggleOwnedSpec(u, 'bgs');
    toggleOwnedSpec(u, 'accursed');
    toggleOwnedSpec(u, 'zcb');
    // Default: owned ∩ relevant.
    assert.deepEqual(getShownSpecs(u, 'toa').sort(), ['bgs', 'dwh', 'zcb'].sort(), 'toa default');
    assert.deepEqual(getShownSpecs(u, 'yama').sort(), ['accursed', 'bgs', 'dwh'].sort(), 'yama default');
    assert.deepEqual(getShownSpecs(u, 'nex'), ['zcb'], 'nex default');
    // Narrow the ToA pick; other bosses unaffected.
    toggleShownSpec(u, 'toa', 'zcb');
    assert.deepEqual(getShownSpecs(u, 'toa').sort(), ['bgs', 'dwh'].sort(), 'toa narrowed');
    assert.deepEqual(getShownSpecs(u, 'yama').sort(), ['accursed', 'bgs', 'dwh'].sort(), 'yama untouched');
    toggleShownSpec(u, 'toa', 'zcb');
    assert.deepEqual(getShownSpecs(u, 'toa').sort(), ['bgs', 'dwh', 'zcb'].sort(), 'toa restored');
    // Irrelevant or unowned ids are ignored.
    toggleShownSpec(u, 'nex', 'bgs');
    assert.deepEqual(getShownSpecs(u, 'nex'), ['zcb'], 'bgs not relevant on nex');
    // Dropping ownership clears it from per-boss picks.
    toggleOwnedSpec(u, 'zcb');
    assert.deepEqual(getShownSpecs(u, 'toa').sort(), ['bgs', 'dwh'].sort(), 'ownership drop clears picks');
  } finally {
    if (backup !== null) fs.writeFileSync(file, backup);
    else if (fs.existsSync(file)) fs.unlinkSync(file);
  }
});

test('buildTeamEmbed hides the signed-up line when the board shows', () => {
  const team = {
    activity: 'toa', status: 'open', pre: null,
    members: { u1: true }, memberNames: { u1: 'Alex', org1: 'Alex' },
    organizerId: 'org1', size: 4,
  };
  const withText = buildTeamEmbed(team).toJSON().description;
  assert.ok(withText.includes('**Signed up:**'), 'signed-up line present by default');
  const withBoard = buildTeamEmbed(team, { hideSignedUp: true }).toJSON().description;
  assert.ok(!withBoard.includes('**Signed up:**'), 'signed-up line hidden with board');
});

test('team panel has a Link RSN button', () => {
  const payload = teamPanelPayload();
  const ids = payload.components.flatMap((r) => r.components.map((b) => b.toJSON().custom_id));
  assert.ok(ids.includes('team:rsn'), `expected team:rsn button, got ${ids.join(',')}`);
});

test('team panel is one row of four (settings holds the defaults)', () => {
  const payload = teamPanelPayload();
  assert.strictEqual(payload.components.length, 1, 'single button row');
  const ids = payload.components[0].components.map((b) => b.toJSON().custom_id);
  assert.deepEqual(ids, ['team:create', 'team:rsn', 'team:specs', 'team:settings']);
  const desc = payload.embeds[0].toJSON().description;
  assert.ok(!desc.includes('Account Badge'), 'no badge section in panel copy');
  assert.ok(!desc.includes('⛧ Region ⛧'), 'no region section in panel copy');
  assert.ok(desc.includes('⛧ Settings ⛧'), 'settings section present');
});

test('settings panel shows current defaults and four buttons', () => {
  const payload = settingsPanelPayload('test-user-no-defaults');
  const ids = payload.components[0].components.map((b) => b.toJSON().custom_id);
  assert.deepEqual(ids, ['team:defregion', 'team:defhub', 'team:defworld', 'team:boardmode']);
  const desc = payload.embeds[0].toJSON().description;
  assert.ok(desc.includes('not set'), 'unset values shown');
  assert.ok(desc.includes('Board: Complex'), 'complex is the default board mode');
  const boardBtn = payload.components[0].components[3].toJSON();
  assert.strictEqual(boardBtn.label, 'Board: Complex');
});

test('renderPartyBoard compact mode skips spec rows', () => {
  const rows = [
    { name: 'PTstud', stats: [126, 99, 99, 99, 99, 99, 99, 99], specs: ['bgs', 'voidwaker'], kc: 10, badge: 'ironman' },
  ];
  const full = renderPartyBoard(rows, 0, {});
  const compact = renderPartyBoard(rows, 0, { compact: true });
  assert.ok(Buffer.isBuffer(compact) && compact.length > 1000, 'renders');
  assert.ok(compact.length < full.length, 'compact is smaller than full');
});

test('combatLevel matches the OSRS formula', () => {
  const maxed = { attack: 99, strength: 99, defence: 99, ranged: 99, magic: 99, hitpoints: 99, prayer: 99 };
  assert.strictEqual(combatLevel(maxed), 126);
  const mid = { attack: 75, strength: 80, defence: 70, ranged: 60, magic: 65, hitpoints: 75, prayer: 70 };
  assert.strictEqual(combatLevel(mid), 95);
  const pure = { attack: 99, strength: 99, defence: 1, ranged: 1, magic: 1, hitpoints: 99, prayer: 99 };
  assert.strictEqual(combatLevel(pure), 101);
});

test('parseStats reads a WOM snapshot defensively', () => {
  const skills = {};
  const lvls = { attack: 99, strength: 99, defence: 99, ranged: 99, magic: 99, hitpoints: 99, prayer: 99 };
  for (const [k, v] of Object.entries(lvls)) skills[k] = { rank: 1, level: v, experience: 13034431 };
  const st = parseStats({ latestSnapshot: { data: { skills } } });
  assert.ok(st, 'parsed');
  assert.strictEqual(st.combat, 126);
  assert.strictEqual(st.attack, 99);
  assert.strictEqual(parseStats({}), null, 'garbage -> null');
  assert.strictEqual(parseStats({ latestSnapshot: {} }), null, 'empty snapshot -> null');
});

test('renderPartyBoard produces a valid PNG', () => {
  const buf = renderPartyBoard(
    [{ name: 'Alex', stats: [126, 99, 99, 99, 99, 99, 99, 99] }, { name: 'NoLink', stats: null }],
    0
  );
  assert.ok(Buffer.isBuffer(buf), 'returns a buffer');
  assert.deepStrictEqual(buf.subarray(0, 8), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), 'PNG signature');
  assert.strictEqual(renderPartyBoard([], 0), null, 'no rows -> null');
});

test('boardHeight grows with rows and caps', () => {
  assert.ok(boardHeight(20) === boardHeight(15), 'capped at MAX_ROWS');
  assert.ok(boardHeight(4) < boardHeight(8), 'grows with rows');
  assert.ok(boardHeight(12) < boardHeight(13), '+N more footer appears past the cap');
});

test('shortDisplayName truncates long names', () => {
  assert.strictEqual(shortDisplayName('Alex'), 'Alex');
  assert.ok(shortDisplayName('averylongdisplaynameindeed').endsWith('…'), 'truncates with ellipsis');
});

test('getBadge: manual beats WOM beats role', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const file = path.join(__dirname, '..', 'data', 'badges.json');
  const backup = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
  try {
    if (fs.existsSync(file)) fs.unlinkSync(file);
    const u = 'test-user-badge';
    const ironMember = { roles: { cache: new Map([['1558540424048803860', {}]]) } };
    const mainMember = { roles: { cache: new Map([['1558540434652008569', {}]]) } };
    // Role fallback.
    assert.strictEqual(getBadge(u, ironMember, null), 'ironsworn', 'iron sworn role');
    assert.strictEqual(getBadge(u, mainMember, null), 'main', 'unbound role');
    assert.strictEqual(getBadge(u, null, null), null, 'no info, no badge');
    // WOM beats role.
    assert.strictEqual(getBadge(u, mainMember, { accountType: 'hardcore' }), 'hc', 'wom hardcore');
    assert.strictEqual(getBadge(u, ironMember, { accountType: 'ultimate' }), 'ult', 'wom ultimate');
    assert.strictEqual(getBadge(u, null, { accountType: 'ironman' }), 'ironman', 'wom ironman');
    assert.strictEqual(getBadge(u, null, { accountType: 'regular' }), 'main', 'wom regular');
    // Manual beats everything.
    setManualBadge(u, 'gim');
    assert.strictEqual(getManualBadge(u), 'gim');
    assert.strictEqual(getBadge(u, ironMember, { accountType: 'hardcore' }), 'gim', 'manual wins');
    setManualBadge(u, null);
    assert.strictEqual(getManualBadge(u), null, 'cleared');
    assert.strictEqual(getBadge(u, ironMember, null), 'ironsworn', 'back to auto');
  } finally {
    if (backup !== null) fs.writeFileSync(file, backup);
    else if (fs.existsSync(file)) fs.unlinkSync(file);
  }
});

test('renderPartyBoard draws badges and stacked spec groups', () => {
  const rows = [
    { name: 'Irons', stats: [126, 99, 99, 99, 99, 99, 99, 99], specs: ['bgs', 'voidwaker', 'sgs'], kc: 10, badge: 'ironman' },
    { name: 'Mains', stats: [100, 70, 70, 70, 70, 70, 70, 60], specs: [], kc: null, badge: 'main' },
  ];
  const buf = renderPartyBoard(rows, 0, {});
  assert.ok(Buffer.isBuffer(buf) && buf.length > 1000, 'renders a board');
});

test('mutateTeams serializes concurrent mutations (no lost updates)', async () => {
  // Simulate two interleaved read-modify-writes. Without the queue the
  // second write would clobber the first.
  const order = [];
  const slow = mutateTeams(() => {
    order.push('slow-start');
    return new Promise((resolve) => setTimeout(() => {
      order.push('slow-end');
      resolve('slow');
    }, 30));
  });
  const fast = mutateTeams(() => {
    order.push('fast');
    return 'fast';
  });
  const [slowRes, fastRes] = await Promise.all([slow, fast]);
  assert.strictEqual(slowRes, 'slow');
  assert.strictEqual(fastRes, 'fast');
  assert.deepEqual(order, ['slow-start', 'slow-end', 'fast'], 'second waits for first');
});

test('mutateTeams chain survives a failure', async () => {
  await mutateTeams(() => { throw new Error('boom'); }).catch(() => {});
  const res = await mutateTeams(() => 'recovered');
  assert.strictEqual(res, 'recovered', 'queue keeps working after a throw');
});

// ─── Report ───────────────────────────────────────────────────────

console.log('==================================================');
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log('Failures:');
  for (const f of failures) console.log(`  - ${f.name}: ${f.error}`);
  process.exit(1);
} else {
  console.log('All team finder tests passed!');
}

test('normalizeRsnEntry handles old single-RSN and new multi-RSN shapes', () => {
  assert.deepEqual(normalizeRsnEntry({ rsn: 'Zezima' }), { rsns: ['Zezima'], active: 'Zezima' });
  assert.deepEqual(
    normalizeRsnEntry({ rsns: ['A', 'B'], active: 'B' }),
    { rsns: ['A', 'B'], active: 'B' }
  );
  // Unknown active falls back to first.
  assert.deepEqual(
    normalizeRsnEntry({ rsns: ['A', 'B'], active: 'Z' }),
    { rsns: ['A', 'B'], active: 'A' }
  );
  assert.strictEqual(normalizeRsnEntry(null), null);
  assert.strictEqual(normalizeRsnEntry({}), null);
});

test('settings panel shows RSN row and Switch RSN button', () => {
  const payload = settingsPanelPayload('test-user-no-rsn');
  const desc = payload.embeds[0].toJSON().description;
  assert.ok(desc.includes('RSN: not set'), 'rsn row present');
  assert.strictEqual(payload.components.length, 2, 'two button rows');
  const row2 = payload.components[1].components.map((b) => b.toJSON().custom_id);
  assert.deepEqual(row2, ['team:rsnswitch']);
});

test('rsnSwitchPayload lists names with active checkmarked', () => {
  const payload = rsnSwitchPayload('test-user-no-rsn');
  assert.ok(payload.content.includes('No names linked yet'));
  const labels = payload.components[0].components.map((b) => b.toJSON().label);
  assert.deepEqual(labels, ['Link new']);
});

test('default world skips skilling activities with world types', () => {
  const org = { id: 'org-1', displayName: 'Org' };
  // Mock defaults by writing directly (buildTeamFromData reads user-defaults).
  const { team: raidTeam } = buildTeamFromData('toa', null, {}, org);
  assert.ok(raidTeam, 'raid team builds');
  const { team: wagTeam } = buildTeamFromData('wag', 'mass', {}, org);
  assert.ok(wagTeam, 'wag team builds');
  assert.strictEqual(wagTeam.world, null, 'wag never takes a numeric world');
});
