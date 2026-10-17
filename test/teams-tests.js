// Tests for the team finder (src/teams.js).
// Run with: node test/teams-tests.js
// Pure logic + light mocks. No Discord connection needed.

const assert = require('node:assert');
const {
  ACTIVITIES,
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
  buildTeamFromModal,
  buildTeamEmbed,
  buildListingComponents,
  teamPanelPayload,
  shouldSweepTeam,
  shouldAutoClose,
} = require('../src/teams');
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

test('all 17 activities defined with name, category, and config role', () => {
  const keys = Object.keys(ACTIVITIES);
  assert.strictEqual(keys.length, 17, `expected 17 activities, got ${keys.length}`);
  for (const [key, a] of Object.entries(ACTIVITIES)) {
    assert.ok(a.name, `${key} missing name`);
    assert.ok(['raids', 'skilling', 'bosses'].includes(a.category), `${key} bad category`);
    assert.ok(
      config.teams && config.teams.activityRoles && config.teams.activityRoles[key],
      `${key} missing config.teams.activityRoles`
    );
  }
});

test('every activity has at most 5 modal fields', () => {
  for (const [key, a] of Object.entries(ACTIVITIES)) {
    assert.ok((a.fields || []).length <= 5, `${key} has ${(a.fields || []).length} modal fields`);
  }
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
  assert.strictEqual(toaModeForLevel(600), 'Expert');
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
  assert.deepStrictEqual(rolesFor('tob', '5s-hard'), ['Mage', 'North FZ', 'RDPS', 'MDPS 1', 'MDPS 2']);
  assert.deepStrictEqual(rolesFor('tob', '4s'), ['Mage', 'North FZ', 'RDPS', 'MDPS']);
  assert.deepStrictEqual(rolesFor('ba', null), ['Attacker', 'Defender', 'Collector', 'Healer', 'Flex']);
  assert.deepStrictEqual(rolesFor('yama', null), ['Mage', 'Melee']);
  assert.strictEqual(rolesFor('toa', null), null);
  assert.strictEqual(rolesFor('tob', 'bogus'), null);
  assert.strictEqual(roleModeFor('tob'), 'exclusive');
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

// ─── Modal -> team object ─────────────────────────────────────────

function mockFields(values) {
  return {
    getTextInputValue: (id) => {
      if (!(id in values)) throw new Error('missing field');
      return values[id];
    },
  };
}

const org = { id: 'org1', displayName: 'Gavin' };

test('buildTeamFromModal builds a valid ToA team', () => {
  const { team, error } = buildTeamFromModal(
    'toa', null,
    mockFields({ 'team:size': '4', 'team:raidLevel': '250', 'team:world': '388', 'team:hub': 'oath1', 'team:note': 'learners welcome' }),
    org
  );
  assert.ok(!error, error);
  assert.strictEqual(team.size, 4);
  assert.strictEqual(team.raidLevel, 250);
  assert.strictEqual(team.world, '388');
  assert.strictEqual(team.hub, 'oath1');
  assert.strictEqual(team.fillPing, true);
});

test('buildTeamFromModal rejects a bad world', () => {
  const { error } = buildTeamFromModal(
    'toa', null,
    mockFields({ 'team:size': '4', 'team:raidLevel': '250', 'team:world': 'abc', 'team:hub': 'oath1', 'team:note': '' }),
    org
  );
  assert.ok(error);
});

test('buildTeamFromModal parses CoX scale into size', () => {
  const { team, error } = buildTeamFromModal(
    'cox', 'large',
    mockFields({ 'team:scale': '3+2', 'team:world': '388', 'team:hub': 'oath1', 'team:note': '' }),
    org
  );
  assert.ok(!error, error);
  assert.strictEqual(team.size, 3);
  assert.deepStrictEqual(team.scale, { raiders: 3, scalers: 2 });
  assert.strictEqual(team.pre, 'large');
});

test('buildTeamFromModal rejects a bad CoX scale', () => {
  const { error } = buildTeamFromModal(
    'cox', 'normal',
    mockFields({ 'team:scale': 'lots', 'team:world': '388', 'team:hub': 'oath1', 'team:note': '' }),
    org
  );
  assert.ok(error);
});

test('buildTeamFromModal builds ToB with 5s roles', () => {
  const { team, error } = buildTeamFromModal(
    'tob', '5s-hard',
    mockFields({ 'team:world': '388', 'team:hub': 'oath1', 'team:note': '' }),
    org
  );
  assert.ok(!error, error);
  assert.deepStrictEqual(team.roles, ['Mage', 'North FZ', 'RDPS', 'MDPS 1', 'MDPS 2']);
  assert.strictEqual(team.roleMode, 'exclusive');
});

test('buildTeamFromModal builds BA with fixed size and roles', () => {
  const { team, error } = buildTeamFromModal(
    'ba', null,
    mockFields({ 'team:world': '388', 'team:hub': 'oath1', 'team:note': '' }),
    org
  );
  assert.ok(!error, error);
  assert.strictEqual(team.size, 5);
  assert.ok(team.roles.includes('Flex'));
});

test('buildTeamFromModal builds Yama duo with optional contract', () => {
  const { team, error } = buildTeamFromModal(
    'yama', null,
    mockFields({ 'team:contract': 'Oathplate', 'team:world': '388', 'team:hub': 'oath1', 'team:note': '' }),
    org
  );
  assert.ok(!error, error);
  assert.strictEqual(team.size, 2);
  assert.strictEqual(team.contract, 'Oathplate');
  assert.strictEqual(team.fillPing, false);
});

test('buildTeamFromModal builds Nightmare mass as open', () => {
  const { team, error } = buildTeamFromModal(
    'nm', 'mass',
    mockFields({ 'team:size': '', 'team:world': '388', 'team:hub': 'oath1', 'team:note': '' }),
    org
  );
  assert.ok(!error, error);
  assert.strictEqual(team.size, null);
  assert.strictEqual(team.fillPing, false);
});

test('buildTeamFromModal builds Nightmare team with a valid size', () => {
  const { team, error } = buildTeamFromModal(
    'nm', 'team',
    mockFields({ 'team:size': '3', 'team:world': '388', 'team:hub': 'oath1', 'team:note': '' }),
    org
  );
  assert.ok(!error, error);
  assert.strictEqual(team.size, 3);
  assert.strictEqual(team.fillPing, true);
});

test('buildTeamFromModal caps Nightmare team at 5', () => {
  const { error } = buildTeamFromModal(
    'nm', 'team',
    mockFields({ 'team:size': '8', 'team:world': '388', 'team:hub': 'oath1', 'team:note': '' }),
    org
  );
  assert.ok(error);
});

test('buildTeamFromModal builds skilling mass without hub', () => {
  const { team, error } = buildTeamFromModal(
    'wintertodt', null,
    mockFields({ 'team:world': '388', 'team:note': '' }),
    org
  );
  assert.ok(!error, error);
  assert.strictEqual(team.size, null);
  assert.strictEqual(team.hub, null);
  assert.strictEqual(team.fillPing, false);
});

// ─── Embed + components ───────────────────────────────────────────

test('buildTeamEmbed uses Zamorak red and has no em dashes', () => {
  const team = {
    activity: 'toa', status: 'open', size: 4, roleMode: null, roles: null,
    members: { u1: true }, memberNames: { u1: 'Gavin', org1: 'Gavin' },
    organizerId: 'org1', world: '388', hub: 'oath1', note: 'learners welcome',
    raidLevel: 250, messageId: 'm1',
  };
  const embed = buildTeamEmbed(team);
  const json = embed.toJSON();
  assert.strictEqual(json.color, ZAMORAK_RED);
  assert.ok(!json.description.includes('—'), 'em dash found in embed');
  assert.ok(!json.title.includes('—'), 'em dash found in title');
  assert.ok(json.description.includes('Normal'), 'raid level mode label missing');
  assert.ok(json.description.includes('2/4') === false, 'count should be 1/4');
  assert.ok(json.description.includes('1/4'));
});

test('buildTeamEmbed shows ToB pre label in the title', () => {
  const team = {
    activity: 'tob', status: 'open', pre: '5s-hard', roleMode: 'exclusive',
    roles: ['Mage', 'North FZ', 'RDPS', 'MDPS 1', 'MDPS 2'],
    members: {}, memberNames: { org1: 'Gavin' }, organizerId: 'org1',
    world: '388', hub: 'oath1', note: null, size: 5, messageId: 'm1',
  };
  const json = buildTeamEmbed(team).toJSON();
  assert.ok(json.title.includes('5s Hard Mode'), `title was: ${json.title}`);
});

test('buildListingComponents: role mode gets role buttons plus organizer row', () => {
  const team = {
    activity: 'tob', status: 'open', pre: '4s', roleMode: 'exclusive',
    roles: ['Mage', 'North FZ', 'RDPS', 'MDPS'],
    members: { u1: 'Mage' }, memberNames: { u1: 'Gavin' },
    messageId: 'm1',
  };
  const rows = buildListingComponents(team);
  assert.strictEqual(rows.length, 2);
  const roleRow = rows[0].toJSON();
  assert.strictEqual(roleRow.components.length, 4);
  assert.ok(roleRow.components[0].custom_id === 'team:role:m1:0');
  assert.ok(roleRow.components[0].label.includes('Gavin'), 'claimed role shows holder');
  const orgRow = rows[1].toJSON();
  assert.deepStrictEqual(orgRow.components.map((c) => c.custom_id), ['team:close:m1']);
});

test('buildListingComponents: headcount gets Join/Leave plus organizer row', () => {
  const team = { activity: 'nex', status: 'open', roleMode: null, members: {}, messageId: 'm2' };
  const rows = buildListingComponents(team);
  assert.strictEqual(rows.length, 2);
  assert.deepStrictEqual(
    rows[0].toJSON().components.map((c) => c.custom_id),
    ['team:join:m2', 'team:leave:m2']
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

test('buildTeamFromModal auto-adds the organizer on headcount teams', () => {
  const { team, error } = buildTeamFromModal(
    'toa', null,
    mockFields({ 'team:size': '4', 'team:raidLevel': '250', 'team:world': '388', 'team:hub': 'oath1', 'team:note': '' }),
    org
  );
  assert.ok(!error, error);
  assert.ok(team.members['org1'], 'organizer is in members');
  assert.strictEqual(memberCount(team), 1);
});

test('buildTeamFromModal does not auto-add the organizer on role teams', () => {
  const { team, error } = buildTeamFromModal(
    'tob', '4s',
    mockFields({ 'team:world': '388', 'team:hub': 'oath1', 'team:note': '' }),
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
    memberNames: { u1: 'Gavin', u2: 'Suga', org1: 'Gavin' },
    organizerId: 'org1', world: '388',
  };
  const desc = buildTeamEmbed(team).toJSON().description;
  assert.ok(desc.includes('2/4'), `expected 2/4 in embed, got: ${desc}`);
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
