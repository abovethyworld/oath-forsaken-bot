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
const { routeButton } = require('./buttons');
const { handleWelcome } = require('./welcome');
const { syncReminders } = require('./calendar');
const { syncSeniority } = require('./seniority');
const { syncCalendar } = require('./event-calendar');
const { backfill, recordJoin } = require('./join-dates');
const { syncDrift } = require('./permissions');
const { getPingRole } = require('./utils');
const { handleModalSubmit, handleAgeSelect } = require('./recruit');
const { handleSuggestModal } = require('./suggestions');
const { sweepExpiredBounties } = require('./bounty');
const { handleTeamModal, handleTeamSelect, handleTeamStepSelect, sweepExpiredTeams, sweepPendingButtons } = require('./teams');

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

  // Heartbeat for Docker HEALTHCHECK — proves the event loop is alive and logged in
  const heartbeat = () => {
    try {
      require('node:fs').writeFileSync('/tmp/bot-heartbeat', String(Date.now()));
    } catch {}
  };
  heartbeat();
  setInterval(heartbeat, 60 * 1000);

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
      await syncDrift(client);
      await syncCalendar(client);
      await sweepExpiredBounties(client);
      await sweepExpiredTeams(client);
      await sweepPendingButtons(client);
    } catch (err) {
      console.error('[startup] Sweep failed:', err.message);
    }
  }, 30 * 1000);

  // Recurring loops (use cached data where possible)
  setInterval(() => syncReminders(client), 5 * 60 * 1000);
  setInterval(() => syncSeniority(client), 24 * 3600 * 1000);
  setInterval(() => syncDrift(client), 24 * 3600 * 1000);
  setInterval(() => syncCalendar(client), 24 * 3600 * 1000);
  setInterval(() => sweepExpiredBounties(client), 24 * 3600 * 1000);
  setInterval(() => sweepExpiredTeams(client), 3600 * 1000);
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
      // Button cooldown: 2s per user (prevents button spam).
      // Team finder is a guided wizard with rapid taps — skip the cooldown there.
      const btnKey = `${interaction.user.id}:button`;
      const btnNow = Date.now();
      if (!interaction.customId.startsWith('team:') && btnNow - (cooldowns.get(btnKey) || 0) < 2000) return;
      cooldowns.set(btnKey, btnNow);
      await routeButton(interaction);
    } else if (interaction.isStringSelectMenu()) {
      if (interaction.customId === 'member:select') {
        await handleMemberSelect(interaction);
      } else if (interaction.customId === 'team:pick') {
        await handleTeamSelect(interaction);
      } else if (interaction.customId.startsWith('team:mksel:')) {
        await handleTeamStepSelect(interaction);
      } else if (interaction.customId.startsWith('team:teamcontractsel:')) {
        const { handleTeamContractSelect } = require('./teams');
        await handleTeamContractSelect(interaction, interaction.customId.split(':')[2]);
      } else if (interaction.customId.startsWith('apply:age:')) {
        await handleAgeSelect(interaction);
      } else {
        // Unknown select menu — ignore
        console.warn(`[index.js] Unhandled select menu: ${interaction.customId}`);
      }
    } else if (interaction.isModalSubmit()) {
      const [modalKind] = interaction.customId.split(':');
      if (modalKind === 'suggest') {
        await handleSuggestModal(interaction);
      } else if (modalKind === 'team') {
        await handleTeamModal(interaction);
      } else {
        await handleModalSubmit(interaction);
      }
    }
  } catch (err) {
    console.error('Interaction error:', err);
    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({ content: 'Something went wrong.', ephemeral: true }).catch((e) => console.error("[index.js] Silent failure:", e.message));
    }
  }
});

// Invalidate the member cache when roles change so syncs use fresh data.
// Only on role changes — nicknames/avatar updates fire this event constantly
// and would thrash the cache for no benefit.
client.on(Events.GuildMemberUpdate, (oldMember, newMember) => {
  const oldRoles = oldMember.roles.cache;
  const newRoles = newMember.roles.cache;
  if (oldRoles.size === newRoles.size && oldRoles.every((r) => newRoles.has(r.id))) return;
  const { invalidateCache } = require('./guild-cache');
  invalidateCache();
});

client.on(Events.GuildMemberAdd, async (member) => {
  // Invalidate cached member list so syncs see the new member immediately
  const { invalidateCache } = require('./guild-cache');
  invalidateCache();
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
});

// Member leave logging handled by Sapphire (2026-10-11)

client.login(process.env.DISCORD_TOKEN);
