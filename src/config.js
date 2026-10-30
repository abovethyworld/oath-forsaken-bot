// Loads and lightly validates config.json. Fails fast with a clear message
// if something is missing, instead of crashing mid-command.
const fs = require('node:fs');
const path = require('node:path');

const configPath = path.join(__dirname, '..', 'config.json');

let config;
try {
  config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
} catch (err) {
  console.error(`\nCould not read config.json: ${err.message}`);
  console.error('Make sure config.json exists next to package.json and is valid JSON.\n');
  process.exit(1);
}

const looksPlaceholder = (v) => typeof v !== 'string' || v.includes('PASTE_');

const problems = [];
if (looksPlaceholder(config.guildId)) problems.push('config.guildId is not set');
for (const [name, id] of Object.entries(config.channels || {})) {
  if (looksPlaceholder(id)) problems.push(`config.channels.${name} is not set`);
}
for (const panel of config.rolePanels || []) {
  for (const btn of panel.buttons || []) {
    if (looksPlaceholder(btn.roleId)) problems.push(`role panel "${panel.title}" button "${btn.label}" has no roleId`);
  }
}
const t = config.tickets || {};
for (const [name, id] of Object.entries({
  panelChannelId: t.panelChannelId,
  categoryId: t.categoryId,
  logChannelId: t.logChannelId,
})) {
  if (looksPlaceholder(id)) problems.push(`config.tickets.${name} is not set`);
}
for (const rid of t.staffRoleIds || []) {
  if (looksPlaceholder(rid)) problems.push('config.tickets.staffRoleIds has an unset role');
}
const cal = config.calendar || {};
for (const [name, id] of Object.entries({
  eventsChannelId: cal.eventsChannelId,
  pingRoleId: cal.pingRoleId,
})) {
  if (looksPlaceholder(id)) problems.push(`config.calendar.${name} is not set`);
}
if (!cal.timezone) problems.push('config.calendar.timezone is not set');
const sen = config.seniority || {};
for (const [name, id] of Object.entries({
  ironRoleId: sen.ironRoleId,
  mainRoleId: sen.mainRoleId,
})) {
  if (looksPlaceholder(id)) problems.push(`config.seniority.${name} is not set`);
}

// The sync assigns roles from seniorityRanks while rank-up stories mention
// roles from seniority.rankIds, so the two lists must name the same roles.
// rankIds may carry one extra entry (the hand-picked Ascendant rank, which
// has no bracket because the sync never assigns it).
const rankIdValues = new Set(Object.values(sen.rankIds || {}));
const bracketIds = new Set((config.seniorityRanks || []).map((r) => r.roleId));
for (const id of bracketIds) {
  if (!rankIdValues.has(id)) problems.push('config.seniority.rankIds is missing a roleId from config.seniorityRanks');
}
const rankIdExtras = [...rankIdValues].filter((id) => !bracketIds.has(id));
if (rankIdExtras.length > 1) problems.push('config.seniority.rankIds has roleIds not in config.seniorityRanks (only the Ascendant extra is allowed)');

// Validate seniority rank brackets: must be sorted, non-overlapping, no gaps at start
const ranks = [...(config.seniorityRanks || [])].sort((a, b) => a.minMonths - b.minMonths);
if (ranks.length > 0) {
  for (const r of ranks) {
    if (!Number.isFinite(r.minMonths)) {
      problems.push(`config.seniorityRanks "${r.name}" minMonths (${r.minMonths}) is not a number`);
    }
  }
  if (ranks[0].minMonths !== 0) {
    problems.push(`config.seniorityRanks: first bracket must start at minMonths 0 (got ${ranks[0].minMonths})`);
  }
  for (let i = 1; i < ranks.length; i++) {
    if (ranks[i].minMonths <= ranks[i - 1].minMonths) {
      problems.push(`config.seniorityRanks: "${ranks[i].name}" minMonths (${ranks[i].minMonths}) overlaps "${ranks[i-1].name}" (${ranks[i-1].minMonths})`);
    }
  }
  const seenIds = new Set();
  for (const r of ranks) {
    if (looksPlaceholder(r.roleId)) problems.push(`config.seniorityRanks "${r.name}" has no roleId`);
    if (seenIds.has(r.roleId)) problems.push(`config.seniorityRanks: duplicate roleId ${r.roleId}`);
    seenIds.add(r.roleId);
  }
}

if (problems.length > 0) {
  console.error('\nConfig problems found (edit config.json):');
  for (const p of problems) console.error(`  - ${p}`);
  console.error('');
  process.exit(1);
}

module.exports = config;
