// Boost thank-you tests: stub messages, no Discord connection.
// Run: node test/boost-thanks-tests.js
const assert = require('node:assert');
const { MessageType } = require('discord.js');
const config = require('../src/config');
const { handleBoostMessage, boostThanksText } = require('../src/boost-thanks');

const GENERAL_ID = config.channels.general;
let passed = 0;
const ok = (name) => { passed += 1; console.log(`ok - ${name}`); };

function stubMessage({ type, authorBot = false } = {}) {
  const sent = [];
  const generalChannel = { id: GENERAL_ID, send: async (text) => { sent.push(text); } };
  const message = {
    type,
    guild: { channels: { cache: { get: (id) => (id === GENERAL_ID ? generalChannel : undefined) } } },
    client: { channels: { fetch: async () => null } },
    author: { id: '424242', bot: authorBot },
  };
  return { message, sent };
}

(async () => {
  // Exact approved wording.
  assert.strictEqual(
    boostThanksText('424242'),
    '⛧ **Server Boost** ⛧\nThe Forsaken grow stronger. <@424242> just boosted the server. Thank you.'
  );
  ok('wording matches the approved text');

  // Plain boost posts one thank-you in General.
  {
    const { message, sent } = stubMessage({ type: MessageType.GuildBoost });
    assert.strictEqual(await handleBoostMessage(message), true);
    assert.strictEqual(sent.length, 1);
    assert.strictEqual(sent[0], boostThanksText('424242'));
    ok('GuildBoost posts the thank-you');
  }

  // Tier-up boost messages count too.
  for (const type of [MessageType.GuildBoostTier1, MessageType.GuildBoostTier2, MessageType.GuildBoostTier3]) {
    const { message, sent } = stubMessage({ type });
    assert.strictEqual(await handleBoostMessage(message), true);
    assert.strictEqual(sent.length, 1);
  }
  ok('tier 1/2/3 boost messages post the thank-you');

  // Ordinary chat messages are ignored.
  {
    const { message, sent } = stubMessage({ type: MessageType.Default });
    assert.strictEqual(await handleBoostMessage(message), false);
    assert.strictEqual(sent.length, 0);
    ok('normal messages are ignored');
  }

  // Bot authors never trigger it.
  {
    const { message, sent } = stubMessage({ type: MessageType.GuildBoost, authorBot: true });
    assert.strictEqual(await handleBoostMessage(message), false);
    assert.strictEqual(sent.length, 0);
    ok('bot authors are ignored');
  }

  console.log(`\n${passed} boost-thanks checks passed`);
})().catch((e) => { console.error(e); process.exit(1); });
