// /lore — random Zamorak-themed story drop.
// Remixes content from the seniority rank-up stories. Reinforces the clan
// theme without staff effort. No AI generation — all lines are hand-written
// from existing clan copy.
const { AttachmentBuilder, EmbedBuilder, SlashCommandBuilder } = require('discord.js');
const { ZAMORAK_RED } = require('./utils');

const LORE_DROPS = [
  {
    title: 'The Chaos Altar',
    text: `You'd heard about the Chaos altar in south-east Varrock. Zamorak's altar. You went to see it. You knelt and took off your old god's amulet, setting it on the floor. Said 'Zamorak' out loud for the first time. The flames leaned toward you.`,
  },
  {
    title: 'The Oath',
    text: `You went down into the Chasm of Fire and found Yama on his throne. He offered you a contract. You signed. Swore to the fire, swore you'd never kneel again.`,
  },
  {
    title: "Zamorak's Law",
    text: `**Zamorak:** 'He was strong. You were stronger. That is the only law I know.'`,
  },
  {
    title: 'The Choice',
    text: `**Zamorak:** 'You did not come because I called. You came because you chose.'`,
  },
  {
    title: "K'ril Tsutsaroth",
    text: `You walked into Zamorak's fortress wearing the oathplate. Past the bloodvelds and werewolves, forty kills deep. The chamber goes dark. Then you hear him. K'ril Tsutsaroth. Zamorak's general. When he fell, you stood over his corpse with his spear in your hands.`,
  },
  {
    title: 'Devotion',
    text: `The flames stayed with you. You'd close your eyes and see them leaning toward you, the way they did at the altar. So you went back. Every night. You weren't curious anymore. You were devoted.`,
  },
  {
    title: 'The Weak Fear Chaos',
    text: `The weak fear chaos. We swear by it.`,
  },
  {
    title: 'Ascension',
    text: `The presence wraps around you like heat from a forge. Not burning. Forging.\n\n**Zamorak:** 'Ascend.'`,
  },
];

const CARD_API = 'https://oathforsaken.cc/api/cards';

// Card calls share one keep-alive agent: the card service is a
// same-machine hop, and a fresh connection setup per card was pure
// overhead on every command. If undici is ever unavailable the
// fetch simply runs without a dispatcher, as it did before.
let _cardAgent = null;
try {
  const { Agent } = require('undici');
  _cardAgent = new Agent({ keepAliveTimeout: 30000, keepAliveMaxTimeout: 60000 });
} catch { _cardAgent = null; }
const _cardDispatcher = _cardAgent ? { dispatcher: _cardAgent } : {};

// Lore card render from the card service, in the same shape as
// showoff's fetchCard. Null on any failure; the caller falls
// back to the embed so the command never breaks.
async function fetchLoreCard(title, text) {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15000);
    const res = await fetch(CARD_API + '/lore', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'DiscordBot (https://oathforsaken.cc, 1.0)' },
      body: JSON.stringify({ title, text }),
      signal: ctrl.signal,
      ..._cardDispatcher,
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    return Buffer.from(await res.arrayBuffer());
  } catch {
    return null;
  }
}

// The /lore reply: the drawn card when the card service
// answers, the original embed when it does not.
async function lorePayload(title, text) {
  const card = await fetchLoreCard(title, text);
  if (card) return { files: [new AttachmentBuilder(card, { name: 'lore.png' })] };
  const embed = new EmbedBuilder()
    .setTitle(`⛧ ${title} ⛧`)
    .setDescription(text)
    .setColor(ZAMORAK_RED);
  return { embeds: [embed] };
}

async function loreCommand(interaction) {
  const drop = LORE_DROPS[Math.floor(Math.random() * LORE_DROPS.length)];
  await interaction.reply(await lorePayload(drop.title, drop.text));
}

const commands = [
  {
    data: new SlashCommandBuilder()
      .setName('lore')
      .setDescription('A random drop of Zamorak lore'),
    run: loreCommand,
  },
];

module.exports = { commands, LORE_DROPS, lorePayload };
