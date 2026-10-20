// Slow icon warmer: downloads a small batch of collection-log item icons
// per run so the full set builds up over time without hammering the wiki.
//
// Dedup rule (twice over): the item list is deduped by id, and any item
// whose icon file already exists on disk is skipped — never re-downloaded.
// getItemIcon itself also returns early when the file exists.
//
// Env:
//   WARM_USER   account whose collection-log index lists every item (default pgn)
//   WARM_LIMIT  max icons per run (default 40)
//   WARM_GAP_MS pause between wiki requests (default 1500)
//
// Run from the repo root: node tools/warm-item-icons.js
// Prints one summary line; exits 1 only on a hard failure.

const fs = require('node:fs');
const { getClogIndex } = require('../src/runeprofile');
const { getItemIcon, iconPath } = require('../src/item-icons');

const USER = process.env.WARM_USER || 'pgn';
const LIMIT = Number(process.env.WARM_LIMIT || 40);
const GAP_MS = Number(process.env.WARM_GAP_MS || 1500);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const index = await getClogIndex(USER);
  if (!index || index.notFound || !Array.isArray(index.items)) {
    console.error('warm: could not load the collection log index');
    process.exit(1);
  }
  const missing = index.items.filter((it) => !fs.existsSync(iconPath(it.id)));
  if (!missing.length) {
    console.log(`warm: complete — all ${index.items.length} item icons are on disk`);
    return;
  }
  const batch = missing.slice(0, LIMIT);
  let fetched = 0;
  let failed = 0;
  for (const it of batch) {
    const p = await getItemIcon(it.id, it.name);
    if (p) fetched += 1;
    else failed += 1;
    await sleep(GAP_MS);
  }
  console.log(
    `warm: fetched ${fetched}, failed ${failed}, ${missing.length - fetched} remaining of ${index.items.length} total`,
  );
}

main().catch((err) => {
  console.error('warm: failed:', err.message);
  process.exit(1);
});
