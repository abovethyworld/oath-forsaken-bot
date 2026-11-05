// Offline smoke test for the bounty proof checker (fake data only).
// Run: node tools/test-bounty-verify.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { verifyProof, _internals } = require('../src/bounty-verify');
const { itemIdsForName, slugFor, findDropSince, findFeedHit } = _internals;

// Item resolution: a real scored item resolves to at least one id.
const fangIds = itemIdsForName('Magic fang');
assert(fangIds.length >= 1, 'Magic fang should resolve to an item id');
assert.deepStrictEqual(itemIdsForName(''), []);
assert.strictEqual(slugFor('TestUser'), 'testuser');
assert.strictEqual(slugFor('Test Alt'), 'test-alt');

const POSTED = Date.parse('2026-11-01T00:00:00Z');
// Drops: only drops strictly after the post date count.
const entries = [
  { source: 'Zulrah', kind: 'npc', items: [{ id: fangIds[0], qty: 1 }], at: '2026-10-31T23:00:00+00:00' },
  { source: 'Zulrah', kind: 'npc', items: [{ id: 999999, qty: 1 }], at: '2026-11-01T01:00:00+00:00' },
  { source: 'Zulrah', kind: 'npc', items: [{ id: fangIds[0], qty: 1 }], at: '2026-11-01T02:00:00+00:00' },
];
const hit = findDropSince(entries, fangIds, POSTED);
assert(hit && hit.at === Date.parse('2026-11-01T02:00:00Z'), 'should find the post-date fang, not the earlier one');
assert.strictEqual(findDropSince(entries.slice(0, 2), fangIds, POSTED), null, 'pre-post drop alone must not prove');

// Feed: a line naming player and item after the post date proves it.
const feed = [
  { text: 'Someone Else received a Magic fang', at: POSTED + 1000 },
  { text: 'Checker Toon received a drop: Magic fang', at: POSTED - 1000 },
  { text: 'Checker Toon received a drop: Magic fang', at: POSTED + 2000 },
];
const fh = findFeedHit(feed, 'Checker Toon', 'Magic fang', POSTED);
assert(fh && fh.at === POSTED + 2000, 'feed hit must be this player, this item, after the post date');
assert.strictEqual(findFeedHit(feed.slice(0, 2), 'Checker Toon', 'Magic fang', POSTED), null, 'pre-post feed line must not prove');

// End to end against a fake drops log on disk.
(async () => {
  const dir = path.join(__dirname, '..', 'data', 'plugin-sync', 'drops');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'checker-toon.jsonl');
  fs.writeFileSync(file, entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
  try {
    const proven = await verifyProof({
      rsn: 'Checker Toon',
      proof: { type: 'drop', target: 'Magic fang', amount: null },
      postedAt: POSTED,
      feedLines: [],
    });
    assert.strictEqual(proven.status, 'proven', 'drops log hit after post date should prove');

    const feedProven = await verifyProof({
      rsn: 'Checker Toon',
      proof: { type: 'drop', target: 'Golden tench', amount: null },
      postedAt: POSTED,
      feedLines: [{ text: 'Checker Toon has added the Golden tench to the collection log', at: POSTED + 5000 }],
    });
    assert.strictEqual(feedProven.status, 'proven', 'feed hit should prove an item outside the scored table');

    const missed = await verifyProof({
      rsn: 'Checker Toon',
      proof: { type: 'drop', target: 'Magic fang', amount: null },
      postedAt: Date.parse('2026-12-01T00:00:00Z'),
      feedLines: [],
    });
    assert.notStrictEqual(missed.status, 'proven', 'nothing after the post date must not prove');

    const noRsn = await verifyProof({ rsn: null, proof: { type: 'drop', target: 'Magic fang' }, postedAt: POSTED, feedLines: [] });
    assert.strictEqual(noRsn.status, 'unknown', 'unlinked account cannot be checked');
  } finally {
    try { fs.unlinkSync(file); } catch {}
  }
  console.log('bounty-verify smoke test: all assertions passed');
})().catch((err) => { console.error(err); process.exit(1); });
