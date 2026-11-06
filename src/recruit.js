// Recruitment applications — three types: ironman, main, guest.
// On member join: opens a private application channel with three buttons.
// Applicants fill a modal (RSN, nickname, how they heard). On submit the
// bot checks every RSN on Wise Old Man, shows the found names back for a
// confirm tap (the double ask), asks the account type in the same flow,
// and only then opens a forum post in the applications forum titled
// "<Type> App from <username>" with the answers, so staff can discuss in
// the thread. Approve / Deny buttons live on the post's starter message.
// Approve assigns the right member role (Iron Sworn/Unbound/Guest) +
// Initiate seniority, pre-links the confirmed RSNs and their stated
// types, renames the post to "... - Approved", and locks it.
const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  EmbedBuilder,
  ModalBuilder,
  PermissionFlagsBits,
  TextInputBuilder,
  TextInputStyle,
} = require('discord.js');
const config = require('./config');
const store = require('./store');
const { buildInitiateWelcome, buildGuestWelcome, isStaff, safeRoleAdd, getPingRole, ZAMORAK_RED } = require('./utils');
const { getStats } = require('./wom');
const { addRsn, setActiveRsn, verifiedOwnerOf, setStatedBadge, syncModeRoles, BADGES } = require('./teams');

const DAY_MS = 24 * 3600 * 1000;

// In-progress decision locks: userId -> true. Prevents double-decision races
// when two staff click approve/deny on the same application simultaneously.
const decisionLocks = new Set();

// In-progress submit locks: prevents double-submit race on modal submission.
const submitLocks = new Set();

function accountAgeDays(user) {
  return Math.floor((Date.now() - user.createdAt.getTime()) / DAY_MS);
}

// ─── Application pre-link (Nov 5, 2026) ─────────────────────────────
// Pending flow state: userId -> staged application between the RSN
// check and the final submit. In-memory only: if the bot restarts
// mid-flow the applicant simply reapplies. Confirm is the point of no
// return: it persists the staged names and badge picks into the
// stored application answers, the record approval reads.
const pendingApps = new Map();
const PENDING_TTL_MS = 15 * 60 * 1000;

function setPending(userId, state) {
  pendingApps.set(userId, { ...state, expiresAt: Date.now() + PENDING_TTL_MS });
}

function getPending(userId) {
  const p = pendingApps.get(userId);
  if (!p) return null;
  if (Date.now() > p.expiresAt) {
    pendingApps.delete(userId);
    return null;
  }
  return p;
}

// Same shape rule as the Link RSN flow in teams.js.
const RSN_SHAPE = /^[A-Za-z0-9 ]{1,12}$/;

// Parse the username(s) answer the way the approval nickname code
// does (commas and slashes), deduped case-insensitively, capped at 5.
function parseRsnList(raw) {
  const seen = new Set();
  const out = [];
  for (const piece of String(raw || '').split(/[,/]/)) {
    const name = piece.trim().replace(/\s+/g, ' ');
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(name);
    if (out.length >= 5) break;
  }
  return out;
}

// Check every name on Wise Old Man. Returns found names (with the
// canonical spelling WOM holds), dropped names with a reason, and
// whether any lookup failed outright. A failed lookup never blocks
// the application: the name goes forward unverified and approval
// retries the check. statsFn is injectable for the smoke sim.
async function checkApplicationRsns(names, statsFn = getStats) {
  const found = [];
  const dropped = [];
  let lookupFailed = false;
  for (const typed of names) {
    if (!RSN_SHAPE.test(typed)) {
      dropped.push({ typed, reason: 'invalid' });
      continue;
    }
    let stats = null;
    try {
      stats = await statsFn(typed);
    } catch {
      stats = null;
    }
    if (stats && stats.notFound) {
      dropped.push({ typed, reason: 'notFound' });
      continue;
    }
    if (!stats) {
      lookupFailed = true;
      found.push({ typed, canonical: typed, verified: false });
      continue;
    }
    found.push({ typed, canonical: stats.displayName || stats.username || typed, verified: true });
  }
  return { found, dropped, lookupFailed };
}

function linkStateOf(check) {
  if (check.lookupFailed) return 'unchecked';
  if (check.dropped.length) return 'partial';
  return 'verified';
}

function linkStateFieldText(linkState, droppedCount) {
  if (linkState === 'unchecked') return 'Unchecked: Wise Old Man unreachable at submit';
  if (linkState === 'partial') return `Partial: ${droppedCount} name(s) dropped at check`;
  return 'Links on approval';
}

// The staff ping for a young account at join (index.js GuildMemberAdd
// posts it to the staff log). Returns null when the account is at or
// past the 30 day mark. Pure and exported for the smoke checks.
function youngAccountFlag(user, nowMs = Date.now()) {
  const ageDays = Math.floor((nowMs - user.createdAt.getTime()) / DAY_MS);
  if (ageDays >= 30) return null;
  return {
    ageDays,
    text: `New account flagged: <@${user.id}> (${user.tag}). Discord account is ${ageDays} days old, under the 30 day mark. Flagged at join.`,
  };
}

function appTypes() {
  return config.recruit?.types || {};
}

// (member-join application channels removed 2026-10-11;
// users apply via #apply-here or /apply — no join hook needed)

// Posts the 3-button application panel to a channel.
// Used by /setup-applications and for the #apply-here channel.
async function postApplicationPanel(channel) {
  const types = appTypes();
  const guild = channel.guild;

  const embed = new EmbedBuilder()
    .setTitle('⛧ Clan Application ⛧')
    .setDescription(
      `To join **${guild.name}**, pick the application that fits you.\n\n` +
        `**Ironman** - you play an ironman.\n` +
        `**Main** - you play a main.\n` +
        `**Guest** - you're just visiting or here for a friend.\n\n` +
        `Staff review every application.`
    )
    .setColor(ZAMORAK_RED);

  const row = new ActionRowBuilder();
  for (const [key, t] of Object.entries(types)) {
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(`apply:type:${key}`)
        .setLabel(t.buttonLabel || t.label)
        .setStyle(ButtonStyle.Danger)
        .setEmoji(t.emoji || '📝')
    );
  }
  await channel.send({ embeds: [embed], components: [row] }).catch((e) => console.error("[recruit.js] Non-fatal error:", e.message));
}

async function setupApplications(interaction) {
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
    await interaction.reply({ content: 'Staff only.', ephemeral: true });
    return;
  }
  await interaction.deferReply({ ephemeral: true });
  const channel = interaction.channel;
  await postApplicationPanel(channel);
  await interaction.editReply(`Application panel posted in ${channel}.`);
}

async function applyCommand(interaction) {
  const types = appTypes();
  const embed = new EmbedBuilder()
    .setTitle('⛧ Clan Application ⛧')
    .setDescription(
      `Pick the application that fits you.\n\n` +
        `**Ironman** - you play an ironman.\n` +
        `**Main** - you play a main.\n` +
        `**Guest** - just visiting or here for a friend.`
    )
    .setColor(ZAMORAK_RED);

  const row = new ActionRowBuilder();
  for (const [key, t] of Object.entries(types)) {
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(`apply:type:${key}`)
        .setLabel(t.buttonLabel || t.label)
        .setStyle(ButtonStyle.Danger)
        .setEmoji(t.emoji || '📝')
    );
  }
  await interaction.reply({ embeds: [embed], components: [row], ephemeral: true });
}

async function showApplicationModal(interaction, type, totalBracket) {
  const types = appTypes();
  const t = types[type];
  if (!t) return;
  // customId: apply:modal:<type>:<bracket|none>  (keep under 100 chars)
  const modal = new ModalBuilder()
    .setCustomId(`apply:modal:${type}:${totalBracket || 'none'}`)
    .setTitle(`${t.label} Application`);
  for (const q of t.questions || []) {
    modal.addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId(q.id)
          .setLabel(q.label)
          .setStyle(q.style === 'paragraph' ? TextInputStyle.Paragraph : TextInputStyle.Short)
          .setRequired(!!q.required)
          .setMaxLength(q.style === 'paragraph' ? 500 : 100)
      )
    );
  }
  await interaction.showModal(modal);
}

async function handleModalSubmit(interaction) {
  // customId: apply:modal:<type>:<bracket|none>:<age|none> OR apply:denyreasonmodal:<userId>:<type>:<bracket>
  const parts = interaction.customId.split(':');
  if (parts[0] !== 'apply') return;

  // Deny-with-reason modal from staff
  if (parts[1] === 'denyreasonmodal') {
    return handleDenyReasonSubmit(interaction);
  }

  if (parts[1] !== 'modal') return;

  // Prevent multiple submissions (in-memory lock for race between check and write)
  const submitKey = `submit:${interaction.user.id}`;
  if (submitLocks.has(submitKey)) {
    await interaction.reply({ content: 'Your application is already being submitted.', ephemeral: true }).catch(() => {});
    return;
  }
  submitLocks.add(submitKey);
  try {
  // Prevent multiple submissions
  if (store.isApplicationSubmitted(interaction.guildId, interaction.user.id)) {
    await interaction.reply({ content: 'You already have an application submitted. Staff will review it soon.', ephemeral: true }).catch((e) => console.error("[recruit.js] Non-fatal error:", e.message));
    return;
  }

  const [, , type, bracket] = parts;
  const types = appTypes();
  const t = types[type];
  if (!t) return;

  const answers = {};
  for (const q of t.questions || []) {
    answers[q.id] = interaction.fields.getTextInputValue(q.id);
  }

  await interaction.deferReply({ ephemeral: true });

  const rc = config.recruit;
  const forum = interaction.guild.channels.cache.get(rc.applicationsChannelId);
  if (!forum || forum.type !== ChannelType.GuildForum) {
    await interaction.editReply('Applications forum is not set up. Tell staff.');
    return;
  }

  // Pre-link check: every name is looked up on Wise Old Man before the
  // application goes anywhere. A typo is fixed here, by the applicant,
  // and never reaches staff.
  const names = parseRsnList(answers.rsn);
  const check = await checkApplicationRsns(names);
  if (!check.found.length) {
    pendingApps.delete(interaction.user.id);
    await interaction.editReply(notFoundPayload(answers.rsn, type, check.dropped)).catch((e) => console.error("[recruit.js] Non-fatal error:", e.message));
    return;
  }

  setPending(interaction.user.id, {
    userId: interaction.user.id,
    guildId: interaction.guildId,
    type,
    bracket: bracket || 'none',
    answers,
    found: check.found,
    dropped: check.dropped,
    linkState: linkStateOf(check),
    askIndex: 0,
    askStage: null,
  });
  await interaction.editReply(confirmPayload(getPending(interaction.user.id))).catch((e) => console.error("[recruit.js] Non-fatal error:", e.message));
  } finally {
    submitLocks.delete(submitKey);
  }
}

// Every checked name failed: the application stops here. The restart
// button reopens the modal so the applicant can fix the spelling.
function notFoundPayload(rawTyped, type, dropped) {
  const allInvalid = dropped.length > 0 && dropped.every((d) => d.reason === 'invalid');
  const content = allInvalid
    ? 'That name has characters RuneScape does not allow. Try again.\nYour application has not been sent yet.'
    : `That name is not on Wise Old Man. Check the spelling and try again.\nYou typed: ${String(rawTyped || '').trim()}\nYour application has not been sent yet.`;
  return {
    content,
    components: [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`apply:restart:${type}`).setLabel('Fix name').setStyle(ButtonStyle.Danger)
      ),
    ],
  };
}

// The double ask: the found names, spelled the way Wise Old Man
// spells them, with Confirm and Fix. Nothing is stored or sent
// until Confirm.
function confirmPayload(p) {
  const lines = ['Found on Wise Old Man:'];
  for (const f of p.found) lines.push(`**${f.canonical}**`);
  lines.push('Every name shown exactly the way Wise Old Man spells it.');
  lines.push('If your application is approved, these names get linked to you.');
  if (p.dropped.length) {
    lines.push(`Not going forward: ${p.dropped.map((d) => d.typed).join(', ')}. Fix the spelling and apply again to add ${p.dropped.length === 1 ? 'it' : 'them'}.`);
  }
  if (p.linkState === 'unchecked') {
    lines.push('Wise Old Man could not be checked just now. The names above are as you typed them, and the application goes to staff marked unchecked.');
  }
  return {
    content: lines.join('\n'),
    components: [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('apply:confirm').setLabel('Confirm').setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId('apply:fix').setLabel('Fix').setStyle(ButtonStyle.Secondary)
      ),
    ],
  };
}

async function handleConfirm(interaction) {
  const p = getPending(interaction.user.id);
  if (!p) {
    await interaction.reply({ content: 'That step expired. Start again from the application panel.', ephemeral: true }).catch(() => {});
    return;
  }
  // Persist the staged record now: approval reads the names and badge
  // picks from the stored answers, not from this in-memory state.
  const record = {
    ...p.answers,
    rsn: p.found.map((f) => f.canonical).join(', '),
    prelink: {
      names: p.found.map((f) => ({ name: f.canonical, badge: null })),
      linkState: p.linkState,
      dropped: p.dropped.map((d) => d.typed),
    },
  };
  p.record = record;
  store.setApplicationAnswers(interaction.guildId, interaction.user.id, record);
  await advanceTypeAsk(interaction, p);
}

async function handleFix(interaction) {
  const p = getPending(interaction.user.id);
  pendingApps.delete(interaction.user.id);
  await interaction.update({
    content: 'Nothing was sent. Fix the names and submit again.',
    components: [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`apply:restart:${p ? p.type : 'iron'}`).setLabel('Start again').setStyle(ButtonStyle.Danger)
      ),
    ],
  }).catch((e) => console.error("[recruit.js] Non-fatal error:", e.message));
}

// What the flow still has to ask about the name at askIndex, if
// anything. Main applications never ask: the type is already known.
// Guests ask main-or-iron per name first; an iron answer leads to
// the flavour ask for the same name.
function nextAsk(p) {
  if (p.type === 'main' || p.askIndex >= p.found.length) return { kind: 'done' };
  const name = p.found[p.askIndex].canonical;
  if (p.type === 'guest' && p.askStage !== 'flavour') return { kind: 'kind', name };
  return { kind: 'flavour', name };
}

function flavourRow() {
  const row1 = new ActionRowBuilder();
  const row2 = new ActionRowBuilder();
  BADGES.filter((b) => b.id !== 'main').forEach((b, i) => {
    const btn = new ButtonBuilder().setCustomId(`apply:flavour:${b.id}`).setLabel(b.label).setStyle(ButtonStyle.Secondary);
    (i < 4 ? row1 : row2).addComponents(btn);
  });
  row2.addComponents(
    new ButtonBuilder().setCustomId('apply:flavour:auto').setLabel('AUTO (Wise Old Man decides)').setStyle(ButtonStyle.Secondary)
  );
  return [row1, row2];
}

function askPayload(p, ask) {
  if (ask.kind === 'kind') {
    return {
      content: `One more ask, inside the flow.\n\nIs **${ask.name}** a main or an iron?`,
      components: [
        new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId('apply:kind:main').setLabel('Main').setStyle(ButtonStyle.Danger),
          new ButtonBuilder().setCustomId('apply:kind:iron').setLabel('Iron').setStyle(ButtonStyle.Secondary)
        ),
      ],
    };
  }
  return {
    content: `One more ask, inside the flow.\n\nWhat kind of iron is **${ask.name}**?`,
    components: flavourRow(),
  };
}

async function advanceTypeAsk(interaction, p) {
  // Main applications record main for every name with no ask at all.
  if (p.type === 'main') {
    for (const n of p.record.prelink.names) n.badge = 'main';
    store.setApplicationAnswers(p.guildId, p.userId, p.record);
  }
  const ask = nextAsk(p);
  if (ask.kind === 'done') {
    pendingApps.delete(p.userId);
    return finalizeApplication(interaction, p);
  }
  await interaction.update(askPayload(p, ask)).catch((e) => console.error("[recruit.js] Non-fatal error:", e.message));
}

async function handleKindPick(interaction, pick) {
  const p = getPending(interaction.user.id);
  if (!p || !p.record) {
    await interaction.reply({ content: 'That step expired. Start again from the application panel.', ephemeral: true }).catch(() => {});
    return;
  }
  if (pick === 'main') {
    p.record.prelink.names[p.askIndex].badge = 'main';
    store.setApplicationAnswers(p.guildId, p.userId, p.record);
    p.askIndex++;
    p.askStage = null;
  } else {
    p.askStage = 'flavour';
  }
  await advanceTypeAsk(interaction, p);
}

async function handleFlavourPick(interaction, pick) {
  const p = getPending(interaction.user.id);
  if (!p || !p.record) {
    await interaction.reply({ content: 'That step expired. Start again from the application panel.', ephemeral: true }).catch(() => {});
    return;
  }
  const badge = pick === 'auto' ? null : pick;
  if (badge !== null && !BADGES.some((b) => b.id === badge)) return;
  p.record.prelink.names[p.askIndex].badge = badge;
  store.setApplicationAnswers(p.guildId, p.userId, p.record);
  p.askIndex++;
  p.askStage = null;
  await advanceTypeAsk(interaction, p);
}

// Final step of the flow: the forum thread staff review, carrying the
// same card as before plus the Link state field. The sidebar is house
// red on every card now (the orange under-30 flip is gone).
async function finalizeApplication(interaction, p) {
  const t = appTypes()[p.type] || {};
  const guild = interaction.guild;
  const rc = config.recruit;
  const forum = guild.channels.cache.get(rc.applicationsChannelId);
  if (!forum || forum.type !== ChannelType.GuildForum) {
    await interaction.update({ content: 'Applications forum is not set up. Tell staff.', components: [] }).catch(() => {});
    return;
  }

  const ageDays = accountAgeDays(interaction.user);
  const ageOk = ageDays >= (rc.minAccountAgeDays || 30);
  const lines = [`**Application type:** ${t.label}`];
  for (const q of t.questions || []) {
    // Truncate answers to prevent embed overflow (description limit 4096)
    const answer = String(p.answers[q.id] || '').slice(0, 500);
    lines.push(`**${q.label}:** ${answer}`);
  }
  const embed = new EmbedBuilder()
    .setTitle(`Application — ${interaction.user.tag}`)
    .setDescription(lines.join('\n').slice(0, 4000))
    .addFields(
      {
        name: 'User',
        value: `<@${interaction.user.id}> (${interaction.user.tag})`,
      },
      {
        name: 'Account age',
        value: ageOk ? `✅ ${ageDays} days (meets ${rc.minAccountAgeDays}-day minimum)` : `⚠️ **${ageDays} days** — under the ${rc.minAccountAgeDays}-day minimum`,
      },
      {
        name: 'Link state',
        value: linkStateFieldText(p.linkState, p.dropped.length),
      }
    )
    .setColor(ZAMORAK_RED)
    .setTimestamp();

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`apply:approve:${interaction.user.id}:${p.type}:${p.bracket || 'none'}`).setLabel('Accept').setStyle(ButtonStyle.Danger).setEmoji('✅'),
    new ButtonBuilder().setCustomId(`apply:denyreason:${interaction.user.id}:${p.type}:${p.bracket || 'none'}`).setLabel('Deny with Reason').setStyle(ButtonStyle.Secondary).setEmoji('📝'),
    new ButtonBuilder().setCustomId(`apply:deny:${interaction.user.id}:${p.type}:${p.bracket || 'none'}`).setLabel('Deny').setStyle(ButtonStyle.Danger).setEmoji('✖️')
  );

  // Anti-spoof: user ID is unspoofable, username alone can impersonate staff
  const threadName = `${t.label} App from ${interaction.user.username} [${interaction.user.id}]`;
  const thread = await forum.threads
    .create({
      name: threadName.slice(0, 100),
      message: { embeds: [embed], components: [row] },
      reason: `Application from ${interaction.user.tag}`,
    })
    .catch(() => null);

  if (thread) {
    // Staff ping on new applications — quiet until launch.
    // The mention renders but doesn't notify; flip allowedMentions to ping for real at launch.
    await thread.send({
      content: `<@&${config.tickets.staffRoleIds[0]}> New ${t.label} application from ${interaction.user}.`,
      allowedMentions: { users: [interaction.user.id] },
    }).catch((e) => console.error("[recruit.js] Non-fatal error:", e.message));
    await interaction.update({ content: 'Application submitted! Staff will review it soon.', components: [] }).catch((e) => console.error("[recruit.js] Non-fatal error:", e.message));
    // Mark this application as submitted so it isn't reused
    store.setApplicationSubmitted(interaction.guildId, interaction.user.id);
  } else {
    await interaction.update({ content: 'Could not open your application thread. Tell staff.', components: [] }).catch((e) => console.error("[recruit.js] Non-fatal error:", e.message));
  }
}

// isStaff imported from utils.js

async function handleDenyReasonPrompt(interaction) {
  // customId: apply:denyreason:<userId>:<type>:<bracket>
  const [, , userId, type, bracket] = interaction.customId.split(':');
  if (!isStaff(interaction)) {
    await interaction.reply({ content: 'Staff only.', ephemeral: true });
    return;
  }
  // Same guards as handleDecision: don't even open the modal when another
  // staff member is deciding this application or it was already decided.
  if (decisionLocks.has(`decision:${userId}`)) {
    await interaction.reply({ content: 'Someone else is already handling this application.', ephemeral: true });
    return;
  }
  const thread = interaction.channel;
  if (thread && thread.isThread() && / - (Approved|Denied)/.test(thread.name)) {
    await interaction.reply({ content: 'This application was already decided.', ephemeral: true });
    return;
  }
  const modal = new ModalBuilder()
    .setCustomId(`apply:denyreasonmodal:${userId}:${type}:${bracket || 'none'}`)
    .setTitle('Deny with Reason');
  modal.addComponents(
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('reason')
        .setLabel('Reason for denial')
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(true)
        .setMaxLength(500)
    )
  );
  await interaction.showModal(modal);
}

async function handleDenyReasonSubmit(interaction) {
  // customId: apply:denyreasonmodal:<userId>:<type>:<bracket>
  const [, , userId, type, bracket] = interaction.customId.split(':');
  if (!isStaff(interaction)) {
    await interaction.reply({ content: 'Staff only.', ephemeral: true });
    return;
  }
  // Same race + idempotency guards as handleDecision: a deny-with-reason
  // submitted after another staff member already decided must do nothing.
  const lockKey = `decision:${userId}`;
  if (decisionLocks.has(lockKey)) {
    await interaction.reply({ content: 'Someone else is already handling this application.', ephemeral: true });
    return;
  }
  const thread = interaction.channel;
  if (thread && thread.isThread() && / - (Approved|Denied)/.test(thread.name)) {
    await interaction.reply({ content: 'This application was already decided.', ephemeral: true });
    return;
  }
  decisionLocks.add(lockKey);
  try {
  const reason = interaction.fields.getTextInputValue('reason');
  // Reuse handleDecision by faking a deny interaction customId, then add reason
  await interaction.deferReply({ ephemeral: true });
  const guild = interaction.guild;
  const target = await guild.members.fetch(userId).catch(() => null);
  const types = appTypes();
  const t = types[type] || {};

  if (thread && thread.isThread()) {
    const base = thread.name.replace(/ - (Approved|Denied)$/, '');
    await thread.setName(`${base} - Denied`.slice(0, 100)).catch((e) => console.error("[recruit.js] Non-fatal error:", e.message));
    try {
      const starter = await thread.fetchStarterMessage().catch(() => null);
      if (starter && starter.embeds.length > 0) {
        const orig = starter.embeds[0];
        const updated = EmbedBuilder.from(orig).addFields(
          { name: 'Denied', value: `by ${interaction.user.tag}` },
          { name: 'Reason', value: reason }
        );
        await starter.edit({ embeds: [updated], components: [] }).catch((e) => console.error("[recruit.js] Non-fatal error:", e.message));
      }
    } catch {}
    await thread.setLocked(true).catch((e) => console.error("[recruit.js] Non-fatal error:", e.message));
    await thread.setArchived(true).catch((e) => console.error("[recruit.js] Non-fatal error:", e.message));
  }

  // DM the applicant with the reason
  if (target) {
    await target.send(`Your **${t.label || type}** application to **${guild.name}** was denied.\n\nReason: ${reason}`).catch((e) => console.error("[recruit.js] Non-fatal error:", e.message));
  }

  await interaction.editReply(`Denied <@${userId}> with reason.`);
  } finally {
    decisionLocks.delete(lockKey);
  }
}

// Approval pre-link: link the application's confirmed names and set
// their stated types. A name verified to another member is skipped,
// never stolen. An application stored as unchecked (Wise Old Man was
// unreachable at submit) gets a fresh lookup per name here. Failures
// are collected, logged, and reported to staff in the thread; they
// never fail the approval itself.
async function runApprovalPrelink(client, target, appAnswers) {
  const result = { attempted: false, linked: [], failed: [] };
  const pre = appAnswers && appAnswers.prelink;
  if (!pre || !Array.isArray(pre.names) || !pre.names.length) return result;
  result.attempted = true;
  const userId = target.id;
  const fail = (rsn, reason) => {
    console.error(`[recruit-prelink] link failed for ${userId}: ${rsn} (${reason})`);
    result.failed.push({ rsn, reason });
  };
  for (const item of pre.names) {
    const rsn = item.name;
    try {
      if (pre.linkState === 'unchecked') {
        const stats = await getStats(rsn).catch(() => null);
        if (!stats || stats.notFound) {
          fail(rsn, stats && stats.notFound ? 'not found on Wise Old Man' : 'Could not reach Wise Old Man');
          continue;
        }
      }
      const owner = verifiedOwnerOf(rsn);
      if (owner && owner !== userId) {
        fail(rsn, 'verified to another member');
        continue;
      }
      addRsn(userId, rsn);
      if (item.badge) setStatedBadge(userId, rsn, item.badge);
      result.linked.push(rsn);
    } catch (e) {
      console.error(`[recruit-prelink] link write failed for ${userId}: ${rsn} (${e.message})`);
      result.failed.push({ rsn, reason: 'link write failed' });
    }
  }
  if (result.linked.length) {
    // The primary name is the first one the applicant listed.
    setActiveRsn(userId, pre.names[0].name);
    if (pre.names.some((n) => n.badge)) {
      await syncModeRoles(client, userId).catch((e) => console.error('[recruit-prelink] mode role sync failed:', e.message));
    }
  }
  return result;
}

function approvalDmText(prelink) {
  const head = '⛧ Welcome to Oath Forsaken ⛧\n\nYour application was approved.';
  const tail = 'One thing left: run /connect if you use the clan plugin. One code covers every account you play.';
  if (!prelink.attempted) return head;
  if (!prelink.failed.length) {
    return `${head}\n\nYour names are already linked and their types are set: ${prelink.linked.join(', ')}.\n${tail}`;
  }
  const linkedLine = prelink.linked.length ? `Linked and set: ${prelink.linked.join(', ')}.\n` : '';
  return `${head}\n\n${linkedLine}Your link needs a hand for: ${prelink.failed.map((f) => f.rsn).join(', ')}. Staff have been told and will sort it with you.\n${tail}`;
}

async function handleDecision(interaction) {
  // customId: apply:approve:<userId>:<type>:<bracket> or apply:deny:<userId>:<type>:<bracket>
  const [, decision, userId, type, bracket] = interaction.customId.split(':');
  if (!isStaff(interaction)) {
    await interaction.reply({ content: 'Staff only.', ephemeral: true });
    return;
  }

  // Race guard: if another staff is already deciding this application, bail.
  // Prevents double role-assignment when two staff click within the same second.
  const lockKey = `decision:${userId}`;
  if (decisionLocks.has(lockKey)) {
    await interaction.reply({ content: 'Someone else is already handling this application.', ephemeral: true });
    return;
  }
  // Idempotency: if the thread was already decided (e.g. bot restarted mid-decision),
  // don't process again. The verdict is in the thread name.
  const thread = interaction.channel;
  if (thread && thread.isThread() && / - (Approved|Denied)/.test(thread.name)) {
    await interaction.reply({ content: 'This application was already decided.', ephemeral: true });
    return;
  }
  decisionLocks.add(lockKey);
  try {
  const types = appTypes();
  const t = types[type] || {};
  const guild = interaction.guild;
  const target = await guild.members.fetch(userId).catch(() => null);

  await interaction.deferReply({ ephemeral: true });

  // If the applicant left the server, warn staff instead of silently doing nothing
  if (decision === 'approve' && !target) {
    await interaction.editReply(`⚠️ <@${userId}> has left the server. Cannot assign roles. Thread renamed to Denied.`);
    // Still rename the thread so it's not stuck
    if (thread && thread.isThread()) {
      const base = thread.name.replace(/ - (Approved|Denied)$/, '');
      await thread.setName(`${base} - Denied (left)`.slice(0, 100)).catch((e) => console.error('[recruit.js] Non-fatal error:', e.message));
      await thread.setLocked(true).catch((e) => console.error('[recruit.js] Non-fatal error:', e.message));
      await thread.setArchived(true).catch((e) => console.error('[recruit.js] Non-fatal error:', e.message));
    }
    return;
  }

  if (decision === 'approve' && target) {
    if (t.roleId) await target.roles.add(t.roleId).catch((e) => console.error("[recruit.js] Non-fatal error:", e.message));
    // Everyone-ping role: added on every approval regardless of application type
    try {
      const pingRole = getPingRole(guild);
      if (pingRole && !target.roles.cache.has(pingRole.id)) {
        await target.roles.add(pingRole, 'Everyone-ping role on approval');
      }
    } catch (e) {
      console.error('[recruit.js] Ping role assign failed:', e.message);
    }
    // Total-level ranks removed 2026-10-13 (age-ranks-only overhaul).
    // New members start at the bottom of the tenure ladder (not guests).
    if (type !== 'guest') {
      const entry = (config.seniorityRanks || []).find((r) => r.minMonths === 0);
      if (entry) await target.roles.add(entry.roleId, 'New member tenure rank').catch((e) => console.error("[recruit.js] Non-fatal error:", e.message));
    }
    // Auto-nickname: "Nickname [RSN]" (all 3 application types)
    const appAnswers = store.getApplicationAnswers(guild.id, userId);
    if (appAnswers && appAnswers.nickname && appAnswers.rsn) {
      const nick = String(appAnswers.nickname).trim();
      const firstRsn = String(appAnswers.rsn).split(/[,/]/)[0].trim();
      if (nick && firstRsn) {
        const rsnPart = ` [${firstRsn}]`;
        const newNick = nick.length + rsnPart.length > 32
          ? nick.slice(0, 32 - rsnPart.length).trimEnd() + rsnPart
          : nick + rsnPart;
        await target.setNickname(newNick, 'Auto-nickname on approval').catch((e) => console.error("[recruit.js] Non-fatal error:", e.message));
      }
    }
    // Pre-link the confirmed names before the welcome DM, so the DM
    // can say plainly what is done and what still needs a hand.
    const prelink = await runApprovalPrelink(interaction.client, target, appAnswers);
    if (prelink.failed.length && thread && thread.isThread()) {
      for (const f of prelink.failed) {
        await thread.send(`Link failed for <@${userId}>. Name given: ${f.rsn}. Reason: ${f.reason}. Approval still went through.`).catch((e) => console.error('[recruit-prelink] staff notice failed:', e.message));
      }
    }

    // Welcome DM on approval
    await target.send(approvalDmText(prelink)).catch((e) => console.error("[recruit.js] Non-fatal error:", e.message));

    // Public welcome in #general - plain text (finalized 2026-10-13)
    // Guest gets the guest welcome; iron/main get the Initiate announcement.
    // This also handles guest-to-member promotions (they get the Initiate post).
    const linkedNames = prelink.attempted && !prelink.failed.length ? prelink.linked : null;
    const generalChan = guild.channels.cache.get(config.recruit?.generalChannelId || config.channels?.general);
    if (generalChan) {
      let welcomeMsg;
      if (type === 'guest') {
        welcomeMsg = buildGuestWelcome(target.id, linkedNames);
      } else {
        welcomeMsg = buildInitiateWelcome(target.id, linkedNames);
      }
      await generalChan.send({ content: welcomeMsg, allowedMentions: { parse: ['users'] } }).catch((e) => console.error("[recruit.js] Non-fatal error:", e.message));
    }
  } else if (target) {
    // Simple deny: no DM sent (2026-10-13)
  }

  // Rename the post: "<Type> App from <user> - Approved"
  // and stamp "Approved/Denied by <staff>" on the original post.
  if (thread && thread.isThread()) {
    const base = thread.name.replace(/ - (Approved|Denied)$/, '');
    const verdict = decision === 'approve' ? 'Approved' : 'Denied';
    await thread.setName(`${base} - ${verdict}`.slice(0, 100)).catch((e) => console.error("[recruit.js] Non-fatal error:", e.message));

    // Edit the starter message to show who decided.
    try {
      const starter = await thread.fetchStarterMessage().catch(() => null);
      if (starter && starter.embeds.length > 0) {
        const orig = starter.embeds[0];
        const updated = EmbedBuilder.from(orig).addFields({
          name: verdict,
          value: `by ${interaction.user.tag}`,
        });
        // Remove the approve/deny buttons so it can't be decided twice.
        await starter.edit({ embeds: [updated], components: [] }).catch((e) => console.error("[recruit.js] Non-fatal error:", e.message));
      }
    } catch {}

    await thread.setLocked(true).catch((e) => console.error("[recruit.js] Non-fatal error:", e.message));
    await thread.setArchived(true).catch((e) => console.error("[recruit.js] Non-fatal error:", e.message));
  }

  await interaction.editReply(decision === 'approve' ? `Approved <@${userId}> as ${t.label || type}.` : `Denied <@${userId}>.`);

  // Close their private application channel
  const appChannelId = store.getApplication(guild.id, userId);
  if (appChannelId) {
    const ch = guild.channels.cache.get(appChannelId);
    store.removeApplication(guild.id, userId);
    if (ch) setTimeout(() => ch.delete('Application decided').catch((e) => console.error("[recruit.js] Non-fatal error:", e.message)), 5000);
  }

  const log = guild.channels.cache.get(config.tickets.logChannelId);
  if (log) {
    await log.send(`Application **${decision}d** (${t.label || type}): <@${userId}> by ${interaction.user.tag}`).catch((e) => console.error("[recruit.js] Non-fatal error:", e.message));
  }

  // Record for /apply-stats
  const appData = store.getApplicationFull(interaction.guildId, userId);
  store.recordApplicationDecision(interaction.guildId, {
    userId,
    type: type || 'unknown',
    decision,
    decidedBy: interaction.user.id,
    submittedAt: appData?.submittedAt || null,
  });
  } finally {
    decisionLocks.delete(lockKey);
  }
}

async function handleApplyButton(interaction) {
  // customId: apply:type:<type> | apply:approve:... | apply:deny:...
  const parts = interaction.customId.split(':');
  const action = parts[1];
  if (action === 'type') {
    // Prevent members and staff from applying (IDs from config, not names —
    // name lookups break silently on rename)
    const types = appTypes();
    const memberRoleIds = [
      types.iron?.roleId,
      types.main?.roleId,
      types.guest?.roleId,
      config.seniority?.friendOfClanRoleId,
      ...(config.tickets?.staffRoleIds || []),
    ].filter(Boolean);
    const member = interaction.member;
    const hasBlockedRole = member.roles.cache.some((r) => memberRoleIds.includes(r.id)) || isStaff(interaction);
    if (hasBlockedRole) {
      await interaction.reply({ content: 'You are already a member of the clan.', ephemeral: true }).catch((e) => console.error("[recruit.js] Non-fatal error:", e.message));
      return;
    }
    // Prevent starting a second application
    if (store.isApplicationSubmitted(interaction.guildId, interaction.user.id)) {
      await interaction.reply({ content: 'You already have an application submitted. Staff will review it soon.', ephemeral: true }).catch((e) => console.error("[recruit.js] Non-fatal error:", e.message));
      return;
    }
    const type = parts[2];
    return showApplicationModal(interaction, type, null);
  }
  if (action === 'restart') return showApplicationModal(interaction, parts[2], null);
  if (action === 'confirm') return handleConfirm(interaction);
  if (action === 'fix') return handleFix(interaction);
  if (action === 'kind') return handleKindPick(interaction, parts[2]);
  if (action === 'flavour') return handleFlavourPick(interaction, parts[2]);
  if (action === 'approve' || action === 'deny') return handleDecision(interaction);
  if (action === 'denyreason') return handleDenyReasonPrompt(interaction);
}

const { SlashCommandBuilder, PermissionFlagsBits: PFB } = require('discord.js');

const commands = [
  {
    data: new SlashCommandBuilder()
      .setName('apply')
      .setDescription('Start a clan application'),
    run: applyCommand,
  },
  {
    data: new SlashCommandBuilder()
      .setName('setup-applications')
      .setDescription('Post the application panel here (Admin only)')
      .setDefaultMemberPermissions(PFB.Administrator),
    run: setupApplications,
  },
  {
    data: new SlashCommandBuilder()
      .setName('reset-application')
      .setDescription('Clear someone\'s application so they can reapply (Admin only)')
      .setDefaultMemberPermissions(PFB.Administrator)
      .addUserOption((o) => o.setName('user').setDescription('Who to reset').setRequired(true)),
    run: async (interaction) => {
      if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
        await interaction.reply({ content: 'Staff only.', ephemeral: true });
        return;
      }
      const target = interaction.options.getUser('user');
      store.removeApplication(interaction.guildId, target.id);
      await interaction.reply({ content: `Cleared application for ${target.tag}. They can apply again.`, ephemeral: true });
    },
  },
  {
    data: new SlashCommandBuilder()
      .setName('apply-stats')
      .setDescription('Application funnel stats (Manage Roles only)')
      .setDefaultMemberPermissions(PFB.ManageRoles)
      .addIntegerOption((o) => o.setName('days').setDescription('Look back N days (default 30)')),
    run: applyStatsCommand,
  },
];

async function applyStatsCommand(interaction) {
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageRoles)) {
    await interaction.reply({ content: 'Staff only.', ephemeral: true });
    return;
  }
  const days = interaction.options.getInteger('days') || 30;
  const since = Date.now() - days * 24 * 3600 * 1000;
  const stats = store.getApplicationStats(interaction.guildId, since);

  if (stats.length === 0) {
    await interaction.reply({ content: `No application decisions in the last ${days} days.`, ephemeral: true });
    return;
  }

  const approved = stats.filter((s) => s.decision === 'approve').length;
  const denied = stats.filter((s) => s.decision === 'deny').length;
  const rate = Math.round((approved / stats.length) * 100);

  const byType = {};
  for (const s of stats) {
    byType[s.type] = byType[s.type] || { approve: 0, deny: 0 };
    byType[s.type][s.decision === 'approve' ? 'approve' : 'deny']++;
  }
  const typeLines = Object.entries(byType)
    .map(([t, v]) => `  ${t}: ${v.approve} approved, ${v.deny} denied`)
    .join('\n');

  // Average time from submit to decision
  const withTimes = stats.filter((s) => s.submittedAt && s.decidedAt);
  let avgTime = 'n/a';
  if (withTimes.length) {
    const avgMs = withTimes.reduce((sum, s) => sum + (s.decidedAt - s.submittedAt), 0) / withTimes.length;
    const hours = Math.round(avgMs / 3600000);
    avgTime = hours < 1 ? '<1 hour' : `${hours} hour${hours === 1 ? '' : 's'}`;
  }

  const { EmbedBuilder } = require('discord.js');
  const { ZAMORAK_RED } = require('./utils');
  const embed = new EmbedBuilder()
    .setTitle(`⛧ Application Stats — last ${days} days ⛧`)
    .setDescription(
      `**${stats.length}** decisions: **${approved}** approved, **${denied}** denied (${rate}% approval)\n\n` +
      `By type:\n${typeLines}\n\n` +
      `Avg time to decision: **${avgTime}**`
    )
    .setColor(ZAMORAK_RED);

  await interaction.reply({ embeds: [embed], ephemeral: true });
}

module.exports = {
  handleApplyButton,
  handleModalSubmit,
  commands,
  // Exported for the smoke checks and the local flow sim.
  parseRsnList,
  checkApplicationRsns,
  linkStateOf,
  linkStateFieldText,
  confirmPayload,
  notFoundPayload,
  nextAsk,
  askPayload,
  runApprovalPrelink,
  approvalDmText,
  youngAccountFlag,
  accountAgeDays,
  pendingApps,
};
