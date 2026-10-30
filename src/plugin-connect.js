// /connect: hands a member the code that links the Oath Forsaken RuneLite
// plugin to their Discord account. Codes are stored hashed in
// data/plugin-sync/codes.json, the store the site plugin API reads.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { SlashCommandBuilder } = require('discord.js');
const { atomicWrite } = require('./store');
const { getRsnEntry, rsnLinkRow } = require('./teams');

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

async function connect(interaction) {
  const entry = getRsnEntry(interaction.user.id);
  if (!entry.rsns.length) {
    await interaction.reply({
      content: 'No RSN linked yet. Tap below to link yours.',
      components: rsnLinkRow(),
      ephemeral: true,
    });
    return;
  }
  const action = interaction.options.getString('action') || 'code';
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
  const wanted = interaction.options.getString('rsn');
  if (wanted && !entry.rsns.includes(wanted)) {
    await interaction.reply({ content: `"${wanted}" is not one of your linked RSNs.`, ephemeral: true });
    return;
  }
  const rsn = wanted || entry.active;
  const code = issueCode(interaction.user.id, rsn);
  await interaction.reply({
    content:
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
        o.setName('rsn').setDescription('Which linked RSN the code is for (default: your active one)')
      ),
    run: connect,
  },
];

module.exports = { commands, issueCode, revokeCodes };
