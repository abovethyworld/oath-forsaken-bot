'use strict';

// Builds src/clue-rates.json from the OSRS Wiki reward casket pages:
// per clue tier, item name -> drop probability (smallest fraction in the
// item's drop-table row). Used by the !clog clues summary card to pick a
// player's rarest unlocked items per tier. Re-run when Jagex adds clue
// rewards:  node tools/build-clue-rates.js
const fs = require('fs');
const path = require('path');

const TIERS = ['beginner', 'easy', 'medium', 'hard', 'elite', 'master'];

function parseRates(html) {
  const map = {};
  for (const row of html.split('<tr')) {
    const title = row.match(/<a [^>]*title="([^"]+)"/);
    if (!title) continue;
    const name = title[1].replace(/&amp;/g, '&');
    const fracs = [...row.matchAll(/(\d+(?:\.\d+)?)\s*\/\s*([0-9][0-9,]*)/g)]
      .map((m) => parseFloat(m[1]) / parseFloat(m[2].replace(/,/g, '')))
      .filter((p) => p > 0 && p <= 1);
    if (!fracs.length) continue;
    const p = Math.min(...fracs);
    if (map[name] === undefined || p < map[name]) map[name] = p;
  }
  return map;
}

(async () => {
  const out = {};
  for (const tier of TIERS) {
    const res = await fetch(`https://oldschool.runescape.wiki/w/Reward_casket_(${tier})`, {
      headers: { 'User-Agent': 'oathforsaken-bot clue rates builder' },
    });
    if (!res.ok) throw new Error(`casket (${tier}) fetch ${res.status}`);
    out[tier] = parseRates(await res.text());
    console.log(tier, Object.keys(out[tier]).length, 'items');
  }
  const dest = process.env.CLUE_RATES_OUT || path.join(__dirname, '..', 'src', 'clue-rates.json');
  fs.writeFileSync(dest, JSON.stringify(out, null, 1));
  console.log('wrote', dest);
})().catch((e) => { console.error(e); process.exit(1); });
