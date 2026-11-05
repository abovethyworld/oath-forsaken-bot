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

const fs = require('fs');
const path = require('path');
const { addRsn, verifiedOwnerOf } = require('./teams');

const REQ_DIR = path.join(__dirname, '..', 'data', 'plugin-sync', 'link-requests');
const RSN_RE = /^[A-Za-z0-9 ]{1,12}$/;

function drop(file, name, why) {
  console.error(`Link request merge: dropping ${name}: ${why}`);
  try { fs.unlinkSync(file); } catch { /* already gone */ }
}

function mergeSiteLinkRequests() {
  let names;
  try {
    names = fs.readdirSync(REQ_DIR);
  } catch {
    return 0; // no request folder yet = nothing pending
  }
  let merged = 0;
  for (const name of names.filter((n) => n.endsWith('.json')).sort()) {
    const file = path.join(REQ_DIR, name);
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
    const owner = verifiedOwnerOf(rsn);
    if (owner && owner !== did) {
      drop(file, name, 'RSN is verified to another member');
      continue;
    }
    try {
      addRsn(did, rsn);
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
