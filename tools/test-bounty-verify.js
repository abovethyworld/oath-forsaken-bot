// Offline smoke test for the bounty proof checker (fake data only).
// Run: node tools/test-bounty-verify.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { _internals } = require('../src/bounty-verify');
const { itemIdsForName, slugFor, kcKeysFor, kcTotal, xpFor, findDropSince, clogHasInPages } = _internals;

// Item resolution: a real scored item resolves to at least one id.
const fangIds = itemIdsForName('Magic fang');
assert(fangIds.length >= 1, 'Magic fang should resolve to an item id');
assert.deepStrictEqual(itemIdsForName(''), []);
assert.strictEqual(slugFor('IronVale'), 'ptstud');
assert.strictEqual(slugFor('Go Far'), 'go-run');

// Drops: only drops strictly after the claim count.
const CLAIM_AT = Date.parse('2026-11-01T00:00:00Z');
const lines = [
  { source: 'Zulrah', kind: 'npc', items: [{ id: fangIds[0], qty: 1 }], at: '2026-10-31T23:00:00+00:00' },
  { source: 'Zulrah', kind: 'npc', items: [{ id: 999999, qty: 1 }], at: '2026-11-01T01:00:00+00:00' },
  { source: 'Zulrah', kind: 'npc', items: [{ id: fangIds[0], qty: 1 }], at: '2026-11-01T02:00:00+00:00' },
];
const hit = findDropSince(lines, fangIds, CLAIM_AT);
assert(hit && hit.at === Date.parse('2026-11-01T02:00:00Z'), 'should find the post-claim fang, not the pre-claim one');
assert.strictEqual(findDropSince(lines.slice(0, 2), fangIds, CLAIM_AT), null, 'pre-claim drop alone must not prove');

// KC resolution: "tombs of amascut" covers normal + expert keys.
const stats = {
  kc: { zulrah: 704, tombs_of_amascut: 125, tombs_of_amascut_expert: 130 },
  skills: { woodcutting: { level: 90, xp: 5000000 }, overall: { level: 2205, xp: 300000000 } },
};
assert.deepStrictEqual(kcKeysFor(stats, 'zulrah'), ['zulrah']);
assert.deepStrictEqual(kcKeysFor(stats, 'Tombs of Amascut').sort(), ['tombs_of_amascut', 'tombs_of_amascut_expert']);
assert.strictEqual(kcTotal(stats, ['tombs_of_amascut', 'tombs_of_amascut_expert']), 255);
assert.strictEqual(kcTotal(stats, []), 0);

// XP resolution.
assert.deepStrictEqual(xpFor(stats, 'Woodcutting'), { label: 'Woodcutting', xp: 5000000 });
assert.strictEqual(xpFor(stats, 'overall').xp, 300000000);
assert.strictEqual(xpFor(stats, 'nonexistentskill'), null);

// Clog appearance: obtained items only, matched by id or name.
const pages = { Zulrah: { tab: 'Bosses', items: [{ id: fangIds[0], name: 'Magic fang' }] } };
assert.strictEqual(clogHasInPages(pages, 'Magic fang', fangIds), true);
assert.strictEqual(clogHasInPages(pages, 'Tanzanite fang', []), false);
assert.strictEqual(clogHasInPages({}, 'Magic fang', fangIds), false);

// End to end on the drop path with a fabricated drops file: a drop that
// lands after the claim proves the claim with no other source involved.
(async () => {
  const { verifyProof } = require('../src/bounty-verify');
  const dir = path.join(__dirname, '..', 'data', 'plugin-sync', 'drops');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'test-hunter.jsonl');
  fs.writeFileSync(file, lines.map((l) => JSON.stringify({ ...l, rsn: 'Test Hunter' })).join('\n') + '\n');
  try {
    const res = await verifyProof({
      rsn: 'Test Hunter',
      proof: { type: 'drop', target: 'Magic fang', amount: null },
      snapshot: { at: CLAIM_AT, rsn: 'Test Hunter', clogHas: false },
      claimedAt: CLAIM_AT,
    });
    assert.strictEqual(res.status, 'proven', `expected proven, got ${res.status}: ${res.lines.join(' | ')}`);
    console.log('drop path:', res.lines[0]);
  } finally {
    fs.unlinkSync(file);
  }
  console.log('bounty-verify smoke test: all assertions passed');
})().catch((err) => {
  console.error('TEST FAILED:', err.message);
  process.exit(1);
});
