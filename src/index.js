// Entry point. Wires up the client, registers slash commands, routes interactions.
require('dotenv').config();
const { Client, Events, GatewayIntentBits, REST, Routes } = require('discord.js');
const config = require('./config'); // validates config.json on load
const { commands, handleCommand } = require('./commands');
const { handleButton } = require('./buttons');
const { handleWelcome } = require('./welcome');
const { checkReminders } = require('./calendar');
const { syncSeniority } = require('./seniority');
const { onMemberJoin, handleModalSubmit, handleTotalSelect, handleAgeSelect } = require('./recruit');
const { handleTicketSelect } = require('./tickets');

if (!process.env.DISCORD_TOKEN || !process.env.CLIENT_ID) {
  console.error('\nMissing DISCORD_TOKEN or CLIENT_ID. Copy .env.example to .env and fill it in.\n');
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds, // slash commands, buttons
    GatewayIntentBits.GuildMembers, // welcome messages (enable "Server Members Intent" in portal)
  ],
});

client.once(Events.ClientReady, async (c) => {
  console.log(`Logged in as ${c.user.tag}`);
  c.user.setActivity('Serving Chaos', { type: 4 }); // custom status, Zamorak theme

  // Register guild slash commands (instant, no 1-hour global wait).
  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
  await rest.put(
    Routes.applicationGuildCommands(process.env.CLIENT_ID, config.guildId),
    { body: commands.map((cmd) => cmd.data.toJSON()) }
  );
  console.log(`Registered ${commands.length} slash commands for guild ${config.guildId}.`);
  console.log('Bot is running. Leave this process on 24/7 (see README for hosting).');

  // Event reminder loop: check every 5 minutes.
  setInterval(() => checkReminders(client), 5 * 60 * 1000);
  setTimeout(() => checkReminders(client), 30 * 1000); // one quick check after startup

  // Seniority (tenure rank) loop: check once a day, plus once after startup.
  setInterval(() => syncSeniority(client), 24 * 3600 * 1000);
  setTimeout(() => syncSeniority(client), 60 * 1000);

  // Backfill original join dates for existing members (one-time, gaps only).
  setTimeout(async () => {
    const { backfill } = require('./join-dates');
    const guild = client.guilds.cache.get(config.guildId);
    if (guild) {
      const n = await backfill(guild);
      if (n) console.log(`Join dates: backfilled ${n} member(s).`);
    }
  }, 30 * 1000);
});

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (interaction.isChatInputCommand()) {
      await handleCommand(interaction);
    } else if (interaction.isButton()) {
      await handleButton(interaction);
    } else if (interaction.isStringSelectMenu()) {
      if (interaction.customId === 'ticket:category') {
        await handleTicketSelect(interaction);
      } else if (interaction.customId.startsWith('apply:age:')) {
        await handleAgeSelect(interaction);
      } else {
        await handleTotalSelect(interaction);
      }
    } else if (interaction.isModalSubmit()) {
      await handleModalSubmit(interaction);
    }
  } catch (err) {
    console.error('Interaction error:', err);
    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({ content: 'Something went wrong.', ephemeral: true }).catch(() => {});
    }
  }
});

client.on(Events.GuildMemberAdd, async (member) => {
  const { recordJoin } = require('./join-dates');
  recordJoin(member.id, member.joinedAt);
  await handleWelcome(member);
  // Join/leave logging handled by Sapphire (2026-10-11)
  await onMemberJoin(member).catch((e) => console.error('Application channel failed:', e.message));
});

// Member leave logging handled by Sapphire (2026-10-11)

client.login(process.env.DISCORD_TOKEN);
