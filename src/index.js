// Entry point. Wires up the client, registers slash commands, routes interactions.
require('dotenv').config();

// Crash recovery: log and keep running instead of dying silently.
// unhandledRejection: a promise failed with no .catch — log it, don't crash.
// uncaughtException: something threw outside try/catch — log it, then exit
//   cleanly so systemd/Docker restarts us with a fresh state.
process.on('unhandledRejection', (reason) => {
  console.error('[CRASH-GUARD] Unhandled promise rejection:', reason?.message || reason);
});

process.on('uncaughtException', (err) => {
  console.error('[CRASH-GUARD] Uncaught exception:', err.message);
  console.error(err.stack);
  // Exit with failure so the process manager restarts us cleanly.
  // A half-corrupted in-memory state is worse than a restart.
  process.exit(1);
});

const { Client, Events, GatewayIntentBits, REST, Routes } = require('discord.js');
const config = require('./config'); // validates config.json on load
const { commands, handleCommand } = require('./commands');
const { handleButton } = require('./buttons');
const { handleWelcome } = require('./welcome');
const { syncReminders } = require('./calendar');
const { syncSeniority } = require('./seniority');
const { syncCalendar } = require('./event-calendar');
const { backfill, recordJoin } = require('./join-dates');
const { checkDrift } = require('./permissions');
const { getPingRole } = require('./utils');
const { onMemberJoin, handleModalSubmit, handleTotalSelect, handleAgeSelect } = require('./recruit');

// Command cooldowns: userId:commandName -> timestamp
const cooldowns = new Map();
// tickets handled via buttons.js; member select needs direct wiring
const { handleMemberSelect } = require('./tickets');

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

  // Startup sweep: single shared guild fetch, then run all one-time jobs.
  // Previously 5 staggered jobs each fetched guild data independently.
  setTimeout(async () => {
    const guild = client.guilds.cache.get(config.guildId);
    if (!guild) return;
    try {
      const { getMembers } = require('./guild-cache');
      const members = await getMembers(guild, true); // force fresh, populates cache

      // Backfill join dates (uses shared member list)
      const n = await backfill(guild, members);
      if (n) console.log(`Join dates: backfilled ${n} member(s).`);

      // Seniority sync (uses cached members)
      await syncSeniority(client);

      // Other one-time checks (don't need member list)
      await syncReminders(client);
      await checkDrift(client);
      await syncCalendar(client);
    } catch (err) {
      console.error('[startup] Sweep failed:', err.message);
    }
  }, 30 * 1000);

  // Recurring loops (use cached data where possible)
  setInterval(() => syncReminders(client), 5 * 60 * 1000);
  setInterval(() => syncSeniority(client), 24 * 3600 * 1000);
  setInterval(() => checkDrift(client), 24 * 3600 * 1000);
  setInterval(() => syncCalendar(client), 24 * 3600 * 1000);
});

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (interaction.isChatInputCommand()) {
      // Cooldown: 3s per user per command (prevents spam)
      const cooldownKey = `${interaction.user.id}:${interaction.commandName}`;
      const now = Date.now();
      const lastUsed = cooldowns.get(cooldownKey) || 0;
      if (now - lastUsed < 3000) {
        await interaction.reply({
          content: 'Slow down a moment.',
          ephemeral: true,
        }).catch(() => {});
        return;
      }
      cooldowns.set(cooldownKey, now);
      // Clean up old entries periodically (prevent memory leak)
      if (cooldowns.size > 1000) {
        for (const [k, t] of cooldowns) {
          if (now - t > 60000) cooldowns.delete(k);
        }
      }
      await handleCommand(interaction);
    } else if (interaction.isButton()) {
      // Button cooldown: 2s per user (prevents button spam)
      const btnKey = `${interaction.user.id}:button`;
      const btnNow = Date.now();
      if (btnNow - (cooldowns.get(btnKey) || 0) < 2000) return;
      cooldowns.set(btnKey, btnNow);
      await handleButton(interaction);
    } else if (interaction.isStringSelectMenu()) {
      if (interaction.customId === 'member:select') {
        await handleMemberSelect(interaction);
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
      await interaction.reply({ content: 'Something went wrong.', ephemeral: true }).catch((e) => console.error("[index.js] Silent failure:", e.message));
    }
  }
});

client.on(Events.GuildMemberAdd, async (member) => {
  recordJoin(member.id, member.joinedAt);
  // Everyone-ping role: assign on join so announcements reach all members
  try {
    const pingRole = getPingRole(member.guild);
    if (pingRole && !member.roles.cache.has(pingRole.id)) {
      await member.roles.add(pingRole);
    }
  } catch (e) {
    console.error('Oath Forsakers auto-assign failed:', e.message);
  }
  await handleWelcome(member);
  // Join/leave logging handled by Sapphire (2026-10-11)
  await onMemberJoin(member).catch((e) => console.error('Application channel failed:', e.message));
});

// Member leave logging handled by Sapphire (2026-10-11)

client.login(process.env.DISCORD_TOKEN);
