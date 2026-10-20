// !-prefixed show-off commands: !kc <activity> [name], !clog <activity|total> [name].
// Needs the Message Content privileged intent (code + portal toggle).
const { EmbedBuilder } = require('discord.js');
const { getStats } = require('./wom');
const { getClogPage, getClogTotal } = require('./runeprofile');
const { ACTIVITIES, kcColumnsForTeam, getRsn, clogPageForActivity } = require('./teams');
const { ZAMORAK_RED } = require('./utils');

const RSN_RE = /^[A-Za-z0-9 ]{1,12}$/;

function prettyMetric(key) {
  return key.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

function fmtKc(n) {
  return typeof n === 'number' ? `${n.toLocaleString('en-US')} KC` : '-';
}

// Name: explicit arg wins, else the author's linked RSN.
function resolveName(args, authorId) {
  const named = args.join(' ').trim().replace(/\s+/g, ' ');
  if (named) {
    if (!RSN_RE.test(named)) return { error: 'That name has characters RuneScape does not allow. Try again.' };
    return { rsn: named };
  }
  const linked = getRsn(authorId);
  if (!linked) return { error: 'Link your RSN first with the Link RSN button, or pass a name: `!kc yama PTstud`.' };
  return { rsn: linked };
}

async function handleKcCommand(message, args) {
  const activity = (args.shift() || '').toLowerCase();
  if (!activity || !ACTIVITIES[activity]) {
    const list = Object.keys(ACTIVITIES).join(', ');
    await message.reply(`Pick an activity: \`!kc <activity> [name]\`\nActivities: ${list}`).catch(() => {});
    return;
  }
  const { rsn, error } = resolveName(args, message.author.id);
  if (error) {
    await message.reply(error).catch(() => {});
    return;
  }
  let st;
  try {
    st = await getStats(rsn);
  } catch (err) {
    await message.reply('Could not reach the stats service right now. Try again in a bit.').catch(() => {});
    return;
  }
  if (!st) {
    await message.reply('Could not reach the stats service right now. Try again in a bit.').catch(() => {});
    return;
  }
  if (st.notFound) {
    await message.reply(`Could not find the RuneScape name **${rsn}**. Check the spelling and try again.`).catch(() => {});
    return;
  }
  const cols = kcColumnsForTeam({ activity });
  const lines = cols.map((c) => `**${c.label || prettyMetric(c.metric)}:** ${fmtKc(st.kc ? st.kc[c.metric] : null)}`);
  const embed = new EmbedBuilder()
    .setColor(ZAMORAK_RED)
    .setTitle(`${rsn} — ${ACTIVITIES[activity].name}`)
    .setDescription(lines.join('\n'));
  await message.reply({ embeds: [embed] }).catch(() => {});
}

function progressBar(obtained, total) {
  const filled = total > 0 ? Math.round((obtained / total) * 10) : 0;
  const pct = total > 0 ? Math.round((obtained / total) * 100) : 0;
  return `${'█'.repeat(filled)}${'░'.repeat(10 - filled)} ${obtained}/${total} (${pct}%)`;
}

const RP_GUIDE = 'No RuneProfile profile found for that name. Run the RuneProfile plugin ([runeprofile.com/info/guide](https://runeprofile.com/info/guide)) and it syncs on its own.';

async function handleClogCommand(message, args) {
  const key = (args.shift() || '').toLowerCase();
  if (!key) {
    await message.reply('Usage: `!clog <activity|total> [name]` — activities: wintertodt, gotr, tempoross, zalcano.').catch(() => {});
    return;
  }
  const { rsn, error } = resolveName(args, message.author.id);
  if (error) {
    await message.reply(error).catch(() => {});
    return;
  }
  let res, label;
  if (key === 'total') {
    label = 'Collection Log';
    res = await getClogTotal(rsn).catch(() => null);
  } else {
    const page = clogPageForActivity(key);
    if (!page) {
      await message.reply('Usage: `!clog <activity|total> [name]` — activities: wintertodt, gotr, tempoross, zalcano.').catch(() => {});
      return;
    }
    label = page[1];
    res = await getClogPage(rsn, page[0], page[1]).catch(() => null);
  }
  if (!res) {
    await message.reply('Could not reach the collection log service right now. Try again in a bit.').catch(() => {});
    return;
  }
  if (res.notFound) {
    await message.reply(RP_GUIDE).catch(() => {});
    return;
  }
  const embed = new EmbedBuilder()
    .setColor(ZAMORAK_RED)
    .setTitle(`${rsn} — ${label}`)
    .setDescription(progressBar(res.obtained, res.total));
  await message.reply({ embeds: [embed] }).catch(() => {});
}

module.exports = { handleKcCommand, handleClogCommand, progressBar, prettyMetric };
