// /connect: hands a member the code that links the Oath Forsaken RuneLite
// plugin to their Discord account. Codes are stored hashed in
// data/plugin-sync/codes.json, the store the site plugin API reads.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { SlashCommandBuilder } = require('discord.js');
const { atomicWrite } = require('./store');
const { getRsnEntry, rsnLinkRow, linkRsnQuiet } = require('./teams');

const CODES_FILE = path.join(__dirname, '..', 'data', 'plugin-sync', 'codes.json');

function loadCodes() {
  try {
    return JSON.parse(fs.readFileSync(CODES_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function saveCodes(codes) {
  atomicWrite(CODES_FILE, codes);
}

function hashCode(code) {
  return crypto.createHash('sha256').update(code).digest('hex');
}

// One live code per RSN: issuing a new one kills the old one.
function issueCode(discordId, rsn) {
  const code = crypto.randomBytes(24).toString('base64url');
  const codes = loadCodes();
  for (const h of Object.keys(codes)) {
    if (codes[h].rsn === rsn) delete codes[h];
  }
  codes[hashCode(code)] = { discordId, rsn, created: new Date().toISOString() };
  saveCodes(codes);
  return code;
}

function revokeCodes(rsns) {
  const codes = loadCodes();
  let removed = 0;
  for (const h of Object.keys(codes)) {
    if (rsns.includes(codes[h].rsn)) {
      delete codes[h];
      removed++;
    }
  }
  if (removed) saveCodes(codes);
  return removed;
}

// Links and codes are one system: a live code is proof the RSN belongs to
// the member, so every coded RSN also sits on their bot link list, with
// the active (clan) name untouched. Runs at startup so a code that landed
// in the store any other way still reconciles. Returns how many RSNs were
// newly linked.
function reconcileCodeLinks() {
  const codes = loadCodes();
  let linked = 0;
  for (const entry of Object.values(codes)) {
    if (entry.discordId && entry.rsn && linkRsnQuiet(entry.discordId, entry.rsn)) linked++;
  }
  return linked;
}

async function connect(interaction) {
  const action = interaction.options.getString('action') || 'code';
  const entry = getRsnEntry(interaction.user.id);
  if (action === 'revoke') {
    const removed = revokeCodes(entry.rsns);
    await interaction.reply({
      content: removed
        ? 'Your plugin code has been revoked. The plugin stops syncing until you get a new one.'
        : 'You have no active plugin code.',
      ephemeral: true,
    });
    return;
  }
  // A code is only ever issued for a name on the member's link list: a
  // name that is not linked yet gets linked (as an alt, active untouched)
  // in the same step, so codes and links never disagree.
  const wanted = interaction.options.getString('rsn');
  let justLinked = null;
  if (wanted && !entry.rsns.includes(wanted)) {
    linkRsnQuiet(interaction.user.id, wanted);
    justLinked = wanted;
  }
  const fresh = justLinked ? getRsnEntry(interaction.user.id) : entry;
  if (!fresh.rsns.length) {
    await interaction.reply({
      content: 'No RSN linked yet. Tap below to link yours.',
      components: rsnLinkRow(),
      ephemeral: true,
    });
    return;
  }
  const rsn = wanted || fresh.active;
  const code = issueCode(interaction.user.id, rsn);
  await interaction.reply({
    content:
      (justLinked ? `**${justLinked}** is linked to your RSNs now.\n` : '') +
      `Your plugin connect code for **${rsn}**:\n\`${code}\`\n` +
      'Paste it into the Connect Code setting in the Oath Forsaken RuneLite plugin. ' +
      'Keep it to yourself: anyone with this code can sync as you. ' +
      'Running /connect again replaces it, and the old code stops working.',
    ephemeral: true,
  });
}

const commands = [
  {
    data: new SlashCommandBuilder()
      .setName('connect')
      .setDescription('Get the code that links the clan RuneLite plugin to your account')
      .addStringOption((o) =>
        o
          .setName('action')
          .setDescription('Get a code, or revoke your current one')
          .addChoices({ name: 'Get a code', value: 'code' }, { name: 'Revoke my code', value: 'revoke' })
      )
      .addStringOption((o) =>
        o.setName('rsn').setDescription('Which RSN the code is for (default: your active one)')
      ),
    run: connect,
  },
];

module.exports = { commands, issueCode, revokeCodes, reconcileCodeLinks };
