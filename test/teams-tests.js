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
  buildTeamEmbed,
  buildListingComponents,
  teamPanelPayload,
  boardApplies,
  shouldSweepTeam,
  shouldAutoClose,
} = require('../src/teams');
const { combatLevel, parseStats } = require('../src/wom');
const { renderPartyBoard, boardHeight, shortDisplayName } = require('../src/party-board');
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

test('creation steps exist for every activity and end with region/world/note', () => {
  const noRegion = ['wintertodt', 'gotr', 'tempoross', 'zalcano', 'wag'];
  const noNote = ['wintertodt', 'gotr', 'tempoross', 'zalcano'];
  for (const key of Object.keys(ACTIVITIES)) {
    const pre = ACTIVITIES[key].pre
      ? { tobScale: '4s', coxMode: 'normal', nmMode: 'team', hueyInstance: 'public', wagWorld: 'mass' }[ACTIVITIES[key].pre]
      : null;
    const steps = creationStepsFor(key, pre);
    // WAG is just a note (no region, no world, open size).
    if (key === 'wag') {
      assert.deepStrictEqual(steps.map((s) => s.id), ['note']);
      continue;
    }
    assert.ok(steps.length >= 2, `${key} has no steps`);
    const ids = steps.map((s) => s.id);
    if (!noRegion.includes(key)) {
      assert.ok(ids.includes('region'), `${key} missing region step`);
    }
    if (!noNote.includes(key)) {
      assert.ok(ids.includes('note'), `${key} missing note step`);
    }
    // No em dashes in prompts.
    for (const s of steps) assert.ok(!s.prompt.includes('—'), `${key} step ${s.id} has em dash`);
  }
});

test('skilling activities and WAG skip the party hub step', () => {
  for (const key of ['wintertodt', 'gotr', 'tempoross', 'wag']) {
    const pre = key === 'wag' ? 'mass' : null;
    const ids = creationStepsFor(key, pre).map((s) => s.id);
    assert.ok(!ids.includes('hub'), `${key} should not have a hub step`);
  }
  assert.ok(creationStepsFor('zalcano', null).map((s) => s.id).includes('hub'), 'zalcano keeps hub');
});

test('ToA steps ask specific size first, then 2-8 and tier buttons', () => {
  const steps = creationStepsFor('toa', null);
  const choice = steps.find((s) => s.id === 'sizeChoice');
  assert.strictEqual(choice.kind, 'buttons');
  assert.deepStrictEqual(choice.options.map((o) => o.id), ['specific', 'any']);
  const size = steps.find((s) => s.id === 'size');
  assert.strictEqual(size.kind, 'buttons');
  assert.deepStrictEqual(size.options.map((o) => o.id), ['2', '3', '4', '5', '6', '7', '8']);
  const tier = steps.find((s) => s.id === 'tier');
  assert.deepStrictEqual(tier.options.map((o) => o.id), ['Normal', 'Expert', 'High Invo']);
});

test('Mass button is on Nex and Hueycoatl only', () => {
  const withMass = ['nex', 'huey'];
  for (const key of withMass) {
    const pre = key === 'huey' ? 'public' : null;
    const size = creationStepsFor(key, pre).find((s) => s.id === 'size');
    assert.ok(size, `${key} missing size step`);
    assert.ok(size.options.some((o) => o.id === 'mass'), `${key} size step missing Mass button`);
  }
  // Nex: 2, 3, 5, 8, Mass (wiki strat sizes).
  const nexSize = creationStepsFor('nex', null).find((s) => s.id === 'size');
  assert.deepStrictEqual(nexSize.options.map((o) => o.id), ['2', '3', '5', '8', 'mass']);
  // Hueycoatl: 3, 4, 5 + Mass.
  const hueySize = creationStepsFor('huey', 'public').find((s) => s.id === 'size');
  assert.deepStrictEqual(hueySize.options.map((o) => o.id), ['3', '4', '5', 'mass']);
  // No one else gets a Mass button on the size step.
  for (const key of Object.keys(ACTIVITIES)) {
    if (withMass.includes(key)) continue;
    const pre = ACTIVITIES[key].pre
      ? { tobScale: '4s', coxMode: 'normal', nmMode: 'team', hueyInstance: 'public', wagWorld: 'mass' }[ACTIVITIES[key].pre]
      : null;
    const size = creationStepsFor(key, pre).find((s) => s.id === 'size');
    if (size) assert.ok(!size.options.some((o) => o.id === 'mass'), `${key} should not have a Mass button`);
  }
});

test('Venenatis, Callisto, and Vetion have no size step at all', () => {
  for (const key of ['venenatis', 'callisto', 'vetion']) {
    const ids = creationStepsFor(key, null).map((s) => s.id);
    assert.ok(!ids.includes('size'), `${key} should not have a size step`);
  }
  const { team, error } = buildTeamFromData('venenatis', null, { region: 'US', world: '388', note: '' }, { id: 'org1', displayName: 'Alex' });
  assert.ok(!error, error);
  assert.strictEqual(team.size, null);
  assert.strictEqual(team.mass, false);
});

test('CoX steps are sizeChoice, raiders, scalers, layout', () => {
  const steps = creationStepsFor('cox', 'normal');
  const sizeChoice = steps.find((s) => s.id === 'sizeChoice');
  const raiders = steps.find((s) => s.id === 'raiders');
  const scalers = steps.find((s) => s.id === 'scalers');
  const layout = steps.find((s) => s.id === 'layout');
  assert.ok(sizeChoice && raiders && scalers && layout);
  assert.deepStrictEqual(raiders.options.map((o) => o.id).slice(0, 3), ['1', '2', '3']);
  assert.strictEqual(scalers.options[0].id, '0');
  assert.strictEqual(scalers.options[0].label, 'None');
  assert.deepStrictEqual(layout.options.map((o) => o.id), ['Normal', 'Large', 'Full']);
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

// ─── Step data -> team object ───────────────────────────────────────

const org = { id: 'org1', displayName: 'Alex' };

test('buildTeamFromData builds a valid ToA team', () => {
  const { team, error } = buildTeamFromData(
    'toa', null,
    { size: 4, tier: 'Normal', region: 'US', world: '388', hub: 'oath1', note: 'learners welcome' },
    org
  );
  assert.ok(!error, error);
  assert.strictEqual(team.size, 4);
  assert.strictEqual(team.raidLevel, 'Normal');
  assert.strictEqual(team.world, '388');
  assert.strictEqual(team.region, 'US');
  assert.strictEqual(team.hub, 'oath1');
  assert.strictEqual(team.fillPing, true);
});

test('buildTeamFromData requires a ToA tier', () => {
  const { error } = buildTeamFromData(
    'toa', null,
    { size: 4, region: 'US', world: '388' },
    org
  );
  assert.ok(error);
});

test('buildTeamFromData builds CoX scale from raiders and scalers', () => {
  const { team, error } = buildTeamFromData(
    'cox', 'normal',
    { raiders: 3, scalers: 2, region: 'US', world: '388', hub: 'oath1', note: '' },
    org
  );
  assert.ok(!error, error);
  assert.strictEqual(team.size, 3);
  assert.deepStrictEqual(team.scale, { raiders: 3, scalers: 2 });
  assert.strictEqual(team.pre, 'normal');
});

test('buildTeamFromData handles CoX with no scalers', () => {
  const { team, error } = buildTeamFromData(
    'cox', 'cm',
    { raiders: 5, scalers: 0, region: 'UK' },
    org
  );
  assert.ok(!error, error);
  assert.deepStrictEqual(team.scale, { raiders: 5, scalers: 0 });
  assert.strictEqual(team.world, null);
  assert.strictEqual(team.region, 'UK');
});

test('buildTeamFromData builds ToB with 5s roles', () => {
  const { team, error } = buildTeamFromData(
    'tob', '5s-hard',
    { region: 'US', world: '388', hub: 'oath1', note: '' },
    org
  );
  assert.ok(!error, error);
  assert.deepStrictEqual(team.roles, ['Mage', 'North FZ', 'RDPS', 'MDPS 1', 'MDPS 2']);
  assert.strictEqual(team.roleMode, 'exclusive');
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

test('buildTeamFromData sets mass flag on Nex Mass pick', () => {
  const { team, error } = buildTeamFromData(
    'nex', null,
    { size: 'mass', region: 'US' },
    org
  );
  assert.ok(!error, error);
  assert.strictEqual(team.size, null);
  assert.strictEqual(team.mass, true);
  assert.strictEqual(team.fillPing, true);
});

test('buildTeamFromData sets mass flag on Hueycoatl Mass pick', () => {
  const { team, error } = buildTeamFromData(
    'huey', 'public',
    { size: 'mass', region: 'DE', world: '422' },
    org
  );
  assert.ok(!error, error);
  assert.strictEqual(team.size, null);
  assert.strictEqual(team.mass, true);
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
    activity: 'toa', status: 'open', size: 4, roleMode: null,
    members: { org1: true }, memberNames: { org1: 'Alex' },
    organizerId: 'org1', region: 'UK', raidLevel: 'Expert', messageId: 'm1',
  };
  const desc = buildTeamEmbed(team).toJSON().description;
  assert.ok(desc.includes('Region:** UK') || desc.includes('Region: UK'), `expected region line, got: ${desc}`);
  assert.ok(desc.includes('Raid level: Expert'), `expected tier line, got: ${desc}`);
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
    activity: 'toa', status: 'open', size: 4, roleMode: null, roles: null,
    members: { u1: true }, memberNames: { u1: 'Alex', org1: 'Alex' },
    organizerId: 'org1', world: '388', region: 'US', hub: 'oath1', note: 'learners welcome',
    raidLevel: 'Normal', messageId: 'm1',
  };
  const embed = buildTeamEmbed(team);
  const json = embed.toJSON();
  assert.strictEqual(json.color, ZAMORAK_RED);
  assert.ok(!json.description.includes('—'), 'em dash found in embed');
  assert.ok(!json.title.includes('—'), 'em dash found in title');
  assert.ok(json.description.includes('Raid level: Normal'), 'raid level tier label missing');
  assert.ok(json.description.includes('1/4'));
});

test('buildTeamEmbed shows ToB pre label in the title', () => {
  const team = {
    activity: 'tob', status: 'open', pre: '5s-hard', roleMode: 'exclusive',
    roles: ['Mage', 'North FZ', 'RDPS', 'MDPS 1', 'MDPS 2'],
    members: {}, memberNames: { org1: 'Alex' }, organizerId: 'org1',
    world: '388', hub: 'oath1', note: null, size: 5, messageId: 'm1',
  };
  const json = buildTeamEmbed(team).toJSON();
  assert.ok(json.title.includes('5s Hard Mode'), `title was: ${json.title}`);
});

test('buildListingComponents: role mode gets role buttons plus organizer row', () => {
  const team = {
    activity: 'tob', status: 'open', pre: '4s', roleMode: 'exclusive',
    roles: ['Mage', 'North FZ', 'RDPS', 'MDPS'],
    members: { u1: 'Mage' }, memberNames: { u1: 'Alex' },
    messageId: 'm1',
  };
  const rows = buildListingComponents(team);
  assert.strictEqual(rows.length, 2);
  const roleRow = rows[0].toJSON();
  assert.strictEqual(roleRow.components.length, 4);
  assert.ok(roleRow.components[0].custom_id === 'team:role:m1:0');
  assert.ok(roleRow.components[0].label.includes('Alex'), 'claimed role shows holder');
  const orgRow = rows[1].toJSON();
  assert.deepStrictEqual(orgRow.components.map((c) => c.custom_id), ['team:close:m1', 'team:delete:m1']);
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
