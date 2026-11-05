// Sims for the membership + tenure rework (Nov 5, 2026): seniority
// counts time in the clan chat only, banked across leaves, and
// membership is any linked RSN on the WOM group list.
// Run: node tools/sim-tenure.js  (exit 1 on any failure)
const assert = require('assert');
const tenure = require('../src/tenure');
const membership = require('../src/membership');
const { rankForMonths } = require('../src/seniority');
const { MONTH_MS } = require('../src/utils');

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log(`PASS ${name}`);
}

const T0 = Date.parse('2026-01-01T00:00:00.000Z');
const months = (rec, at) => tenure.accruedMs(rec, at) / MONTH_MS;
const rankName = (rec, at) => {
  const r = rankForMonths(months(rec, at));
  return r ? r.name.split(' ')[0] : null;
};
const blank = () => ({ bankedMs: 0, stretchStart: null, stretches: [] });

// (a) 6 months in, leave, 12 months out, rejoin: accrued stays 6
// months and the rank matches 6 months, not 18.
check('(a) leave freezes tenure; the gap counts for nothing', () => {
  const rec = blank();
  tenure.applyStart(rec, T0);
  tenure.applyEnd(rec, T0 + 6 * MONTH_MS);
  assert.strictEqual(rec.stretchStart, null);
  assert.strictEqual(rec.stretches.length, 1);
  assert.strictEqual(rec.stretches[0].end, new Date(T0 + 6 * MONTH_MS).toISOString());
  const back = T0 + 18 * MONTH_MS;
  assert.strictEqual(months(rec, back), 6);
  tenure.applyStart(rec, back);
  assert.strictEqual(months(rec, back), 6);
  assert.strictEqual(rankName(rec, back), 'Zealot'); // 6-8 months
  assert.strictEqual(months(rec, back + 1 * MONTH_MS), 7); // resumes accruing
});

// (b) Two stretches bank correctly: 2 months + 3 months = 5.
check('(b) stretches bank additively', () => {
  const rec = blank();
  tenure.applyStart(rec, T0);
  tenure.applyEnd(rec, T0 + 2 * MONTH_MS);
  tenure.applyStart(rec, T0 + 4 * MONTH_MS);
  tenure.applyEnd(rec, T0 + 7 * MONTH_MS);
  assert.strictEqual(months(rec, T0 + 7 * MONTH_MS), 5);
  assert.strictEqual(rankName(rec, T0 + 7 * MONTH_MS), 'Devout'); // 3-5 months
  assert.strictEqual(rec.stretches.length, 2);
});

// (c) Multi-RSN member: still a member while any linked RSN is in the
// group; out only when all are out.
check('(c) membership survives one RSN leaving', () => {
  const links = { '1001': { rsns: ['Sim Alpha', 'Sim Beta'], active: 'Sim Alpha' } };
  assert.strictEqual(membership.computeMemberIds(links, ['Sim Alpha', 'Sim Beta']).has('1001'), true);
  assert.strictEqual(membership.computeMemberIds(links, ['Sim Beta']).has('1001'), true);
  assert.strictEqual(membership.computeMemberIds(links, ['sim_alpha']).has('1001'), true); // loose name match
  assert.strictEqual(membership.computeMemberIds(links, []).has('1001'), false);
  assert.strictEqual(membership.computeMemberIds(links, ['Someone Else']).has('1001'), false);
});

// (d) A never-member gets no rank: membership ignores roles entirely,
// so an account holding any Discord role but with no linked RSN on the
// group list is not a member, accrues nothing, and (in the sync) is
// stripped like any other non-member.
check('(d) no linked RSN on the list, no membership, no tenure', () => {
  const links = {
    '1002': { rsns: ['Sim Outsider'], active: 'Sim Outsider' },
    '1003': { rsn: 'Sim Legacy' }, // legacy single-name link shape
  };
  const ids = membership.computeMemberIds(links, ['Sim Member']);
  assert.strictEqual(ids.has('1002'), false);
  assert.strictEqual(ids.has('1003'), false);
  assert.strictEqual(tenure.accruedMs(null, T0), 0);
  assert.strictEqual(tenure.accruedMs(links['1002'].tenure, T0), 0);
});

// Seed shape: earliest in-group date wins per person, banked zero.
check('(e) seed picks the earliest WOM date per person', () => {
  const links = { '1004': { rsns: ['Sim One', 'Sim Two'], active: 'Sim One' } };
  const owners = membership.computeOwnerMap(links);
  assert.strictEqual(owners.get('sim one'), '1004');
  assert.strictEqual(owners.get('sim two'), '1004');
});

console.log(`\n${passed} sim(s) passed.`);
