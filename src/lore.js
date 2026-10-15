// /lore — random Zamorak-themed story drop.
// Remixes content from the seniority rank-up stories. Reinforces the clan
// theme without staff effort. No AI generation — all lines are hand-written
// from existing clan copy.
const { EmbedBuilder, SlashCommandBuilder } = require('discord.js');
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

async function loreCommand(interaction) {
  const drop = LORE_DROPS[Math.floor(Math.random() * LORE_DROPS.length)];
  const embed = new EmbedBuilder()
    .setTitle(`⛧ ${drop.title} ⛧`)
    .setDescription(drop.text)
    .setColor(ZAMORAK_RED);
  await interaction.reply({ embeds: [embed] });
}

const commands = [
  {
    data: new SlashCommandBuilder()
      .setName('lore')
      .setDescription('A random drop of Zamorak lore'),
    run: loreCommand,
  },
];

module.exports = { commands, LORE_DROPS };
