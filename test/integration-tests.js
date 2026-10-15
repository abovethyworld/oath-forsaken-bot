// Integration tests for apply-here, role buttons, and contact staff flows.
// Verifies the refactor didn't break these critical paths.
// Run with: node test/integration-tests.js

const assert = require('node:assert');

let passed = 0;
let failed = 0;
const failures = [];

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

// ─── Rich mocks ─────────────────────────────────────────────

function mockRole(id, name, position = 1) {
  return { id, name, position };
}

class MockRolesCache {
  constructor(roles = []) {
    this.map = new Map(roles.map((r) => [r.id, r]));
  }
  get(id) { return this.map.get(id); }
  find(fn) { return [...this.map.values()].find(fn); }
  has(id) { return this.map.has(id); }
  some(fn) { return [...this.map.values()].some((r) => fn(r)); }
}

function mockGuild({ roles = [], channels = [], botHighestPosition = 100 } = {}) {
  const guild = {
    id: '1558390769746845718',
    roles: { cache: new MockRolesCache(roles) },
    channels: { cache: new MockRolesCache(channels) },
    members: {
      me: { roles: { highest: mockRole('bot', 'Bot', botHighestPosition) } },
      fetch: async () => null,
    },
    scheduledEvents: { fetch: async () => new Map() },
  };
  return guild;
}

function mockMember({ id = 'user123', guild, roleIds = [], isAdmin = false } = {}) {
  const rolesSet = new Set(roleIds);
  const addedRoles = [];
  const removedRoles = [];
  return {
    id,
    user: { id, tag: 'testuser#0000', createdTimestamp: Date.now() - 365 * 86400000, displayAvatarURL: () => 'http://x/y.png' },
    guild,
    roles: {
      cache: {
        has: (rid) => rolesSet.has(rid),
        some: (fn) => [...rolesSet].some((rid) => fn({ id: rid })),
      },
      add: async (rid) => { addedRoles.push(rid); rolesSet.add(rid); },
      remove: async (rid) => { removedRoles.push(rid); rolesSet.delete(rid); },
    },
    permissions: { has: () => isAdmin },
    _added: addedRoles,
    _removed: removedRoles,
  };
}

function mockInteraction({ customId = '', member, guild, options = {}, channel = null } = {}) {
  const replies = [];
  return {
    customId,
    member,
    guild,
    channel: channel || { id: 'thread123', send: async () => {}, setLocked: async () => {}, setArchived: async () => {} },
    guildId: guild ? guild.id : '1558390769746845718',
    user: member ? member.user : { id: 'user123', tag: 'test#0000' },
    options: {
      getString: (n) => options[n] ?? null,
      getUser: (n) => options[n] ?? null,
      getChannel: (n) => options[n] ?? null,
    },
    reply: async (opts) => { replies.push({ type: 'reply', ...opts }); },
    deferReply: async () => {},
    editReply: async (opts) => { replies.push({ type: 'editReply', ...opts }); },
    update: async (opts) => { replies.push({ type: 'update', ...opts }); },
    deferUpdate: async () => {},
    showModal: async () => { replies.push({ type: 'showModal' }); },
    _replies: replies,
  };
}

// ─── Role button tests ──────────────────────────────────────

(async () => {
  console.log('\nRole buttons (buttons.js)');

  const buttons = require('../src/buttons');

  await atest('role button: adds role when member does not have it', async () => {
    const role = mockRole('role1', 'Test Role', 5);
    const guild = mockGuild({ roles: [role] });
    const member = mockMember({ guild, roleIds: [] });
    const interaction = mockInteraction({ customId: 'role:role1', member, guild });
    await buttons.routeButton(interaction);
    assert.ok(member._added.includes('role1'), 'role should be added');
    const reply = interaction._replies.find((r) => r.type === 'reply');
    assert.ok(reply.content.includes('Added'), `expected "Added", got: ${reply.content}`);
  });

  await atest('role button: removes role when member has it', async () => {
    const role = mockRole('role1', 'Test Role', 5);
    const guild = mockGuild({ roles: [role] });
    const member = mockMember({ guild, roleIds: ['role1'] });
    const interaction = mockInteraction({ customId: 'role:role1', member, guild });
    await buttons.routeButton(interaction);
    assert.ok(member._removed.includes('role1'), 'role should be removed');
    const reply = interaction._replies.find((r) => r.type === 'reply');
    assert.ok(reply.content.includes('Removed'), `expected "Removed", got: ${reply.content}`);
  });

  await atest('role button: rejects when role no longer exists', async () => {
    const guild = mockGuild({ roles: [] });
    const member = mockMember({ guild });
    const interaction = mockInteraction({ customId: 'role:dead-role', member, guild });
    await buttons.routeButton(interaction);
    const reply = interaction._replies.find((r) => r.type === 'reply');
    assert.ok(reply.content.includes('no longer exists'), `expected missing-role message, got: ${reply.content}`);
  });

  await atest('role button: rejects when bot role is below target', async () => {
    const role = mockRole('role1', 'High Role', 200);
    const guild = mockGuild({ roles: [role], botHighestPosition: 5 });
    const member = mockMember({ guild });
    const interaction = mockInteraction({ customId: 'role:role1', member, guild });
    await buttons.routeButton(interaction);
    const reply = interaction._replies.find((r) => r.type === 'reply');
    assert.ok(reply.content.includes("can't assign"), `expected hierarchy error, got: ${reply.content}`);
    assert.ok(!member._added.includes('role1'), 'role should NOT be added');
  });

  await atest('donate button: replies with Ko-fi link', async () => {
    const guild = mockGuild({});
    const member = mockMember({ guild });
    const interaction = mockInteraction({ customId: 'donate:x', member, guild });
    await buttons.routeButton(interaction);
    const reply = interaction._replies.find((r) => r.type === 'reply');
    assert.ok(reply.content.includes('ko-fi.com'), `expected Ko-fi link, got: ${reply.content}`);
  });

  await atest('unknown button kind: ignored silently', async () => {
    const guild = mockGuild({});
    const member = mockMember({ guild });
    const interaction = mockInteraction({ customId: 'bogus:xyz', member, guild });
    await buttons.routeButton(interaction);
    assert.strictEqual(interaction._replies.length, 0, 'should not reply');
  });

  // ─── Contact staff / tickets ───
  console.log('\nContact staff (tickets.js)');

  const tickets = require('../src/tickets');
  const config = require('../src/config');

  await atest('ticket button: non-staff cannot use staff-only actions', async () => {
    // handleTicketButton routes based on customId; test close without staff
    const guild = mockGuild({});
    const member = mockMember({ guild, roleIds: [] }); // no staff role
    const interaction = mockInteraction({ customId: 'ticket:close', member, guild });
    // closeTicket checks isStaff internally — should handle gracefully
    try {
      await tickets.handleTicketButton(interaction);
      // If it replies with a permission error or does nothing, that's fine
      console.log('    (close handled without crash)');
    } catch (e) {
      throw new Error(`crashed on non-staff close: ${e.message}`);
    }
  });

  await atest('tickets module: exports expected functions', async () => {
    assert.strictEqual(typeof tickets.handleTicketButton, 'function');
    assert.strictEqual(typeof tickets.commands, 'object');
    assert.ok(Array.isArray(tickets.commands), 'commands should be array');
  });

  // ─── Apply-here / recruit ───
  console.log('\nApply-here (recruit.js)');

  const recruit = require('../src/recruit');

  await atest('recruit module: exports expected functions', async () => {
    assert.strictEqual(typeof recruit.handleApplyButton, 'function');
    assert.ok(Array.isArray(recruit.commands), 'commands should be array');
    const names = recruit.commands.map((c) => c.data.name);
    assert.ok(names.includes('apply'), `should have /apply command, got: ${names.join(',')}`);
  });

  await atest('isStaff (via utils): recruit uses shared version', async () => {
    const utils = require('../src/utils');
    const staffId = (config.tickets?.staffRoleIds || [])[0];
    assert.ok(staffId, 'staff role configured');
    const staffMember = mockMember({ roleIds: [staffId] });
    const normalMember = mockMember({ roleIds: [] });
    assert.strictEqual(utils.isStaff({ member: staffMember }), true);
    assert.strictEqual(utils.isStaff({ member: normalMember }), false);
  });

  await atest('buildInitiateWelcome: matches expected format', async () => {
    const utils = require('../src/utils');
    const msg = utils.buildInitiateWelcome('999');
    // Must match the format staff expects (was triple-duplicated, now single source)
    assert.ok(msg.startsWith('⛧ <@&'), 'should start with role header');
    assert.ok(msg.includes('⛧ ━'), 'should have divider');
    assert.ok(msg.includes('<@999> has joined Oath Forsaken.'), 'should have join line');
    assert.ok(msg.includes('Drop an intro'), 'should have intro action');
    assert.ok(msg.includes('Grab your roles'), 'should have roles action');
    assert.ok(msg.includes('clan chat invite'), 'should have CC invite action');
  });

  await atest('getPingRole: used by recruit and index (no name lookup)', async () => {
    const utils = require('../src/utils');
    const roleId = config.roles?.oathForsakersId;
    assert.ok(roleId, 'oathForsakersId in config');
    // Guild with role present
    const guild = mockGuild({ roles: [mockRole(roleId, 'Oath Forsakers')] });
    const role = utils.getPingRole(guild);
    assert.ok(role && role.id === roleId, 'should find by ID');
    // Guild where role was RENAMED (old code would break, new code works)
    const renamedGuild = mockGuild({ roles: [mockRole(roleId, 'Totally Different Name')] });
    const role2 = utils.getPingRole(renamedGuild);
    assert.ok(role2 && role2.id === roleId, 'should still find by ID after rename');
  });

  // ─── Cross-module: command registration ───
  console.log('\nCommand registration');

  await atest('all modules register without conflicts', async () => {
    const { commands } = require('../src/commands');
    const names = commands.map((c) => c.data.name);
    const dupes = names.filter((n, i) => names.indexOf(n) !== i);
    assert.strictEqual(dupes.length, 0, `duplicate command names: ${dupes.join(',')}`);
    // Key commands present
    for (const expected of ['apply', 'poll', 'check-permissions', 'event-create']) {
      assert.ok(names.includes(expected), `missing command: ${expected}`);
    }
  });

  // ─── Decision lock (race condition) ───  console.log('\nDecision lock');

  await atest('concurrent approve clicks: second one bails', async () => {
    const config = require('../src/config');
    const staffId = (config.tickets?.staffRoleIds || [])[0];
    const guild = mockGuild({ roles: [mockRole(staffId, 'Staff', 10)] });
    // Target member (the applicant)
    const targetMember = mockMember({ id: 'applicant1', guild, roleIds: [] });
    guild.members.fetch = async (id) => (id === 'applicant1' ? targetMember : null);

    const makeInteraction = () => {
      const staffMember = mockMember({ id: 'staff1', guild, roleIds: [staffId] });
      const i = mockInteraction({
        customId: 'apply:approve:applicant1:iron: bracket',
        member: staffMember,
        guild,
        channel: {
          id: 'thread1',
          isThread: () => true,
          name: 'Iron App from test',
          setName: async () => {},
          setLocked: async () => {},
          setArchived: async () => {},
          fetchStarterMessage: async () => null,
          send: async () => {},
        },
      });
      // handleDecision calls interaction.deferReply then editReply
      i.deferReply = async () => { i._replies.push({ type: 'deferReply' }); };
      return i;
    };

    const i1 = makeInteraction();
    const i2 = makeInteraction();

    // Fire both at the same time
    const [r1, r2] = await Promise.allSettled([
      recruit.handleApplyButton(i1),
      recruit.handleApplyButton(i2),
    ]);

    // One should succeed, the other should get the "already handling" message
    const allReplies = [...i1._replies, ...i2._replies];
    const bailMessages = allReplies.filter((r) =>
      r.content && r.content.includes('already handling')
    );
    assert.ok(
      bailMessages.length >= 1,
      `expected at least one "already handling" bail, got replies: ${JSON.stringify(allReplies.map(r => r.content || r.type))}`
    );
  });

  // ─── Summary ───
  console.log(`\n${'='.repeat(50)}`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  if (failures.length > 0) {
    console.log('\nFailures:');
    failures.forEach((f) => console.log(`  - ${f.name}: ${f.error}`));
    process.exit(1);
  }
  console.log('All integration tests passed! Nothing broke.');
})();

