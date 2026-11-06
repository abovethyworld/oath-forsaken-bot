// Website link requests: the site validates an RSN link (name
// shape, verified-owner claim, Wise Old Man existence) and drops
// one small JSON file per request into data/plugin-sync/
// link-requests/. This sweep re-validates each request against the
// live link store and applies it through the same serialized
// addRsn the Discord link flow uses, then deletes the file.
// Malformed files and names a plugin sync has since verified to
// someone else are dropped with a log line, never merged. The site
// used to write rsn-links.json directly; moving the write to a
// request drop keeps the website's access inside the sync store
// (security review F1, Nov 5 2026).
//
// A request may carry "quiet": true (the staff link endpoint on
// the site sends these when staff link a name for a member). A
// quiet request applies through linkRsnQuiet instead: the name is
// appended and the member's active name does not move. Absent or
// false keeps the addRsn behaviour above, unchanged.

const fs = require('fs');
const path = require('path');
const { addRsn, linkRsnQuiet, verifiedOwnerOf } = require('./teams');

const REQ_DIR = path.join(__dirname, '..', 'data', 'plugin-sync', 'link-requests');
const RSN_RE = /^[A-Za-z0-9 ]{1,12}$/;

function drop(file, name, why) {
  console.error(`Link request merge: dropping ${name}: ${why}`);
  try { fs.unlinkSync(file); } catch { /* already gone */ }
}

// The deps are injectable for the smoke test, which drives the
// merge against a scratch folder with recording writers instead of
// the live link store. Production callers pass nothing.
function mergeSiteLinkRequests(deps = {}) {
  const dir = deps.dir || REQ_DIR;
  const applyAdd = deps.addRsn || addRsn;
  const applyQuiet = deps.linkRsnQuiet || linkRsnQuiet;
  const ownerOf = deps.verifiedOwnerOf || verifiedOwnerOf;
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return 0; // no request folder yet = nothing pending
  }
  let merged = 0;
  for (const name of names.filter((n) => n.endsWith('.json')).sort()) {
    const file = path.join(dir, name);
    let req;
    try {
      req = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) {
      drop(file, name, `unreadable (${e.message})`);
      continue;
    }
    const did = req && typeof req.discordId === 'string' ? req.discordId : '';
    const rsn = req && typeof req.rsn === 'string'
      ? req.rsn.replace(/\s+/g, ' ').trim()
      : '';
    if (!/^\d{5,25}$/.test(did) || !RSN_RE.test(rsn)) {
      drop(file, name, 'malformed discord id or RSN');
      continue;
    }
    const owner = ownerOf(rsn);
    if (owner && owner !== did) {
      drop(file, name, 'RSN is verified to another member');
      continue;
    }
    try {
      if (req.quiet === true) applyQuiet(did, rsn);
      else applyAdd(did, rsn);
      fs.unlinkSync(file);
      merged++;
    } catch (e) {
      // Leave the file in place; the next sweep retries. The
      // failure is logged, never swallowed.
      console.error(`Link request merge: failed on ${name}:`, e.message);
    }
  }
  if (merged) console.log(`Link request merge: applied ${merged} site link request(s).`);
  return merged;
}

module.exports = { mergeSiteLinkRequests };
