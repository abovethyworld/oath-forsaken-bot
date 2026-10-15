// Test suite for the refactored bot functions.
// Run with: node test/refactor-tests.js
// Uses lightweight mocks — no Discord connection needed.

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert');

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

async function atest(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    failures.push({ name, error: e.message });
    console.log(`  ✗ ${name}: ${e.message}`);
  }
}

// ─── Mock builders ──────────────────────────────────────────

function mockRole(id, name, position = 1) {
  return { id, name, position };
}

function mockGuild(roles = []) {
  const cache = new Map(roles.map((r) => [r.id, r]));
  return {
    id: '1558390769746845718',
    roles: { cache: { get: (id) => cache.get(id), find: (fn) => [...cache.values()].find(fn) } },
    members: { me: null },
  };
}

function mockMember({ roleIds = [], isAdmin = false, guild = null } = {}) {
  const roles = new Map(roleIds.map((id) => [id, { id }]));
  return {
    id: '123456789',
    guild,
    roles: {
      cache: {
        has: (id) => roles.has(id),
        some: (fn) => [...roles.values()].some((r) => fn({ id: r.id })),
      },
      add: async () => {},
      remove: async () => {},
    },
    permissions: { has: () => isAdmin },
  };
}

// ─── utils.js tests ─────────────────────────────────────────

console.log('\nutils.js');
const utils = require('../src/utils');

test('ZAMORAK_RED is correct hex', () => {
  assert.strictEqual(utils.ZAMORAK_RED, 0x6b0e0e);
});

test('DAY_MS = 86400000', () => {
  assert.strictEqual(utils.DAY_MS, 86400000);
});

test('MONTH_MS ≈ 30.44 days', () => {
  assert.ok(Math.abs(utils.MONTH_MS - 30.44 * 86400000) < 1);
});

test('isStaff: returns true for staff role member', () => {
  // config.tickets.staffRoleIds must contain the Staff role ID
  const config = require('../src/config');
  const staffId = (config.tickets?.staffRoleIds || [])[0];
  assert.ok(staffId, 'config.tickets.staffRoleIds should be non-empty');
  const member = mockMember({ roleIds: [staffId] });
  assert.strictEqual(utils.isStaff({ member }), true);
});

test('isStaff: returns false for non-staff', () => {
  const member = mockMember({ roleIds: ['999'] });
  assert.strictEqual(utils.isStaff({ member }), false);
});

test('isStaff: returns true for admin', () => {
  const member = mockMember({ isAdmin: true });
  assert.strictEqual(utils.isStaff({ member }), true);
});

test('getPingRole: finds role by config ID', () => {
  const config = require('../src/config');
  const roleId = config.roles?.oathForsakersId;
  assert.ok(roleId, 'config.roles.oathForsakersId should be set');
  const guild = mockGuild([mockRole(roleId, 'Oath Forsakers')]);
  const role = utils.getPingRole(guild);
  assert.ok(role, 'should find the role');
  assert.strictEqual(role.id, roleId);
});

test('getPingRole: returns null when role missing', () => {
  const guild = mockGuild([]);
  const role = utils.getPingRole(guild);
  assert.strictEqual(role, null);
});

test('buildInitiateWelcome: contains user mention and key channels', () => {
  const msg = utils.buildInitiateWelcome('123456789');
  assert.ok(msg.includes('<@123456789>'), 'should mention the user');
  assert.ok(msg.includes('1558428255940378715'), 'should link #introduce-yourself');
  assert.ok(msg.includes('1558399101454786670'), 'should link #roles');
  assert.ok(msg.includes('Oath Forsaken'), 'should mention clan name');
});

// ─── store.js atomic write tests ────────────────────────────

console.log('\nstore.js (atomic writes)');
const store = require('../src/store');

test('atomicWrite: writes valid JSON', () => {
  const tmpFile = path.join('/tmp', `test-atomic-${Date.now()}.json`);
  store.atomicWrite(tmpFile, { a: 1, b: [2, 3] });
  const read = JSON.parse(fs.readFileSync(tmpFile, 'utf8'));
  assert.deepStrictEqual(read, { a: 1, b: [2, 3] });
  fs.unlinkSync(tmpFile);
});

test('atomicWrite: no tmp files left behind', () => {
  const dir = '/tmp';
  const before = fs.readdirSync(dir).filter((f) => f.endsWith('.tmp'));
  const tmpFile = path.join(dir, `test-atomic2-${Date.now()}.json`);
  store.atomicWrite(tmpFile, { x: 1 });
  const after = fs.readdirSync(dir).filter((f) => f.endsWith('.tmp'));
  assert.deepStrictEqual(after, before, 'no stray tmp files');
  fs.unlinkSync(tmpFile);
});

test('atomicWrite: creates parent dirs', () => {
  const tmpFile = path.join('/tmp', `nested-${Date.now()}`, 'sub', 'test.json');
  store.atomicWrite(tmpFile, { y: 2 });
  assert.ok(fs.existsSync(tmpFile));
  fs.rmSync(path.dirname(path.dirname(tmpFile)), { recursive: true });
});

// ─── polls.js bounds check ──────────────────────────────────

console.log('\nrun async tests...');

(async () => {
  console.log('\nutils.js (async)');
  await atest('safeRoleAdd: returns false for missing role', async () => {
    const guild = mockGuild([]);
    const member = mockMember({ guild });
    const result = await utils.safeRoleAdd(member, 'nonexistent', 'test');
    assert.strictEqual(result, false);
  });

  await atest('safeRoleAdd: returns false when bot role is below target', async () => {
    const targetRole = mockRole('target1', 'High Role', 100);
    const botRole = mockRole('bot1', 'Bot Role', 5);
    const botMember = { roles: { highest: botRole } };
    const guild = mockGuild([targetRole]);
    guild.members.me = botMember;
    const member = mockMember({ guild });
    const result = await utils.safeRoleAdd(member, 'target1', 'test');
    assert.strictEqual(result, false);
  });

  await atest('safeRoleAdd: returns true on success', async () => {
    const targetRole = mockRole('target1', 'Low Role', 1);
    const botRole = mockRole('bot1', 'Bot Role', 100);
    const botMember = { roles: { highest: botRole } };
    const guild = mockGuild([targetRole]);
    guild.members.me = botMember;
    let added = null;
    const member = mockMember({ guild });
    member.roles.add = async (id) => { added = id; };
    const result = await utils.safeRoleAdd(member, 'target1', 'test');
    assert.strictEqual(result, true);
    assert.strictEqual(added, 'target1');
  });

  await atest('safeRoleRemove: returns true on success', async () => {
    const member = mockMember({});
    let removed = null;
    member.roles.remove = async (id) => { removed = id; };
    const result = await utils.safeRoleRemove(member, 'role1', 'test');
    assert.strictEqual(result, true);
    assert.strictEqual(removed, 'role1');
  });

  // ─── polls.js bounds check ───
  console.log('\npolls.js');
  await atest('handlePollButton: rejects out-of-bounds index', async () => {
    const polls = require('../src/polls');
    // Create a poll in the store first
    const testStore = require('../src/store');
    const pollId = 'test-poll-bounds';
    testStore.savePoll?.({
      id: pollId,
      question: 'Test?',
      options: ['A', 'B'],
      votes: {},
      authorTag: 'test#0000',
      channelId: '123',
      messageId: '456',
    });

    let replyContent = null;
    const fakeInteraction = {
      customId: `poll:${pollId}:99`, // out of bounds
      user: { id: 'user1' },
      reply: async (opts) => { replyContent = opts.content; },
      update: async () => { throw new Error('should not reach update'); },
    };
    await polls.handlePollButton(fakeInteraction);
    assert.ok(replyContent && replyContent.includes('Invalid'), `expected invalid reply, got: ${replyContent}`);
  });

  await atest('handlePollButton: rejects negative index', async () => {
    const polls = require('../src/polls');
    let replyContent = null;
    const fakeInteraction = {
      customId: 'poll:test-poll-bounds:-1',
      user: { id: 'user1' },
      reply: async (opts) => { replyContent = opts.content; },
      update: async () => { throw new Error('should not reach update'); },
    };
    await polls.handlePollButton(fakeInteraction);
    assert.ok(replyContent && replyContent.includes('Invalid'), `expected invalid reply, got: ${replyContent}`);
  });

  // ─── permissions.js (regression) ───
  console.log('\npermissions.js (regression)');
  const perms = require('../src/permissions');

  await atest('everyoneCanView: channel deny wins', async () => {
    const { PermissionFlagsBits } = require('discord.js');
    const VIEW = PermissionFlagsBits.ViewChannel;
    const guildId = 'g1';
    const channel = {
      guild: { id: guildId },
      parent: null,
      permissionOverwrites: {
        cache: new Map([
          [guildId, { deny: { has: (p) => p === VIEW }, allow: { has: () => false } }],
        ]),
      },
    };
    assert.strictEqual(perms.everyoneCanView(channel), false);
  });

  await atest('everyoneCanView: channel allow wins over category deny', async () => {
    const { PermissionFlagsBits } = require('discord.js');
    const VIEW = PermissionFlagsBits.ViewChannel;
    const guildId = 'g1';
    const channel = {
      guild: { id: guildId },
      parent: {
        permissionOverwrites: {
          cache: new Map([
            [guildId, { deny: { has: (p) => p === VIEW }, allow: { has: () => false } }],
          ]),
        },
      },
      permissionOverwrites: {
        cache: new Map([
          [guildId, { deny: { has: () => false }, allow: { has: (p) => p === VIEW } }],
        ]),
      },
    };
    assert.strictEqual(perms.everyoneCanView(channel), true);
  });

  await atest('everyoneCanView: category deny inherited', async () => {
    const { PermissionFlagsBits } = require('discord.js');
    const VIEW = PermissionFlagsBits.ViewChannel;
    const guildId = 'g1';
    const channel = {
      guild: { id: guildId },
      parent: {
        permissionOverwrites: {
          cache: new Map([
            [guildId, { deny: { has: (p) => p === VIEW }, allow: { has: () => false } }],
          ]),
        },
      },
      permissionOverwrites: { cache: new Map() },
    };
    assert.strictEqual(perms.everyoneCanView(channel), false);
  });

  await atest('everyoneCanView: default visible with no overwrites', async () => {
    const channel = {
      guild: { id: 'g1' },
      parent: null,
      permissionOverwrites: { cache: new Map() },
    };
    assert.strictEqual(perms.everyoneCanView(channel), true);
  });


  // ─── New feature tests (round 2) ───
  console.log('\nnew features');

  await atest('safeFetch: returns value on success', async () => {
    const result = await utils.safeFetch(Promise.resolve('hello'), 'test');
    assert.strictEqual(result, 'hello');
  });

  await atest('safeFetch: returns null silently on 404', async () => {
    const err = new Error('Unknown Message');
    err.code = 10008;
    const result = await utils.safeFetch(Promise.reject(err), 'test');
    assert.strictEqual(result, null);
  });

  await atest('safeFetch: returns null but logs on real error', async () => {
    const err = new Error('Rate limited');
    err.code = 0;
    const result = await utils.safeFetch(Promise.reject(err), 'test-label');
    assert.strictEqual(result, null);
  });

  test('buildGuestWelcome: contains guest role and channel links', () => {
    const msg = utils.buildGuestWelcome('777');
    assert.ok(msg.includes('<@777>'), 'should mention user');
    assert.ok(msg.includes("The door's open"), 'should have tagline');
    assert.ok(msg.includes('Become a Member'), 'should have member CTA');
  });

  // ─── Summary ───
  console.log(`\n${'='.repeat(50)}`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  if (failures.length > 0) {
    console.log('\nFailures:');
    failures.forEach((f) => console.log(`  - ${f.name}: ${f.error}`));
    process.exit(1);
  }
  console.log('All tests passed!');
})();
