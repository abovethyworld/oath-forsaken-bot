// Bounty board: staff posts contracts from the bounty pool (synced from
// the bounty sheet). No sign-up: anyone hunts, gets the drop while the
// contract is live, and opens a proof thread with a screenshot. The bot
// checks the timestamped feeds (plugin drops log, clan chat relay) for
// the drop after the post date and advises; staff cross-check and
// grant or reject. Two lanes run at once, PvM and Skilling, each with
// its own title role: the first winner of a contract takes the lane
// title, and a contract can allow several winners (the sheet's Winners
// column) before it closes.
const {
  SlashCommandBuilder,
  EmbedBuilder,
  AttachmentBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  PermissionFlagsBits,
} = require('discord.js');
const fs = require('fs');
const path = require('path');
const config = require('./config');
const { verifyProof, resolveRsn } = require('./bounty-verify');
const { atomicWrite } = require('./store');
const { isStaff, ZAMORAK_RED, getRoleById, clampDesc, DAY_MS } = require('./utils');

const STATE_FILE = path.join(__dirname, '..', 'data', 'bounties.json');
const CLAIM_ARCHIVE_MIN = 4320; // 3 days
// Time limit is set by threat level, not by hand.
const DAYS_BY_THREAT = { Easy: 7, Medium: 14, Hard: 21, Extreme: 21 };
// Clan member roles allowed to claim: Iron Sworn, Unbound, Friend of the Clan.
const GUILD_MEMBER_ROLES = (config.bounty && config.bounty.memberRoleIds) || [];
const LANE_TITLES = { PvM: 'Reaper of Chaos', Skilling: 'Artisan of Chaos' };

// The pool lives in the data dir so staff edits land without a rebuild:
// the sync drops a fresh bounty-pool.json there and the next read picks it
// up. The bundled copy is only a first-boot fallback.
const POOL_FILE = path.join(__dirname, '..', 'data', 'bounty-pool.json');
let POOL = [];
let poolMtime = 0;
function loadPool() {
  try {
    const st = fs.statSync(POOL_FILE);
    if (st.mtimeMs !== poolMtime) {
      POOL = JSON.parse(fs.readFileSync(POOL_FILE, 'utf8')).contracts || [];
      poolMtime = st.mtimeMs;
      console.log(`Bounty pool loaded from data dir: ${POOL.length} contracts`);
    }
  } catch {
    if (!POOL.length) {
      try {
        POOL = require('./bounty-pool.json').contracts || [];
      } catch {
        POOL = [];
      }
    }
  }
  return POOL;
}
loadPool();

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return { bounties: {}, claims: {} };
  }
}

function saveState(state) {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  atomicWrite(STATE_FILE, state);
}

// Serializes state mutations (same pattern as teams' mutateTeams): one
// load-mutate-save cycle runs to completion before the next starts, so two
// handlers can never load the same state and save over each other's changes.
let stateQueue = Promise.resolve();
function mutateBounty(fn) {
  const run = stateQueue.then(() => fn());
  stateQueue = run.catch(() => {});
  return run;
}

function bountyConfig() {
  return config.bounty || {};
}

// The title role for a lane. PvM falls back to the legacy bounty role
// config (the original champion role, renamed Reaper of Chaos).
function laneRole(guild, lane) {
  const cfg = bountyConfig();
  const laneCfg = (cfg.laneRoles && cfg.laneRoles[lane]) || {};
  if (lane === 'Skilling') {
    return getRoleById(guild, laneCfg.id, laneCfg.name || LANE_TITLES.Skilling);
  }
  return getRoleById(guild, laneCfg.id || cfg.roleId, laneCfg.name || LANE_TITLES.PvM);
}

function isMember(member) {
  return member.roles.cache.some((r) => GUILD_MEMBER_ROLES.includes(r.id));
}

function bountyLane(bounty) {
  return bounty.lane === 'Skilling' ? 'Skilling' : 'PvM';
}

function bountyCap(bounty) {
  const cap = parseInt(bounty.winners, 10);
  return Number.isFinite(cap) && cap > 1 ? cap : 1;
}

function proofLine(proof) {
  if (!proof || !proof.type) return null;
  const label = { drop: 'Drop', kc: 'KC', xp: 'XP', clog: 'Collection log' }[proof.type] || proof.type;
  const amount = proof.amount ? ` x${proof.amount}` : '';
  return `**Proof:** ${label}: ${proof.target}${amount} (the drop must land after the post date)`;
}

function bountyEmbed({ target, location, threat, days, image, rewardMention, lane, winners, proof }) {
  const lines = [
    `Chaos demands tribute. A new contract is nailed to the board.`,
    ``,
    `**Target:** ${target}`,
    `**Location:** ${location}`,
    `**Threat Level:** ${threat}`,
    `**Lane:** ${lane}`,
    `**Time Limit:** ${days} day${days === 1 ? '' : 's'}`,
    `**Reward:** ${rewardMention}`,
  ];
  if (winners > 1) lines.push(`**Winners:** First ${winners} hunters to prove it. First takes the title.`);
  const pl = proofLine(proof);
  if (pl) lines.push(pl);
  lines.push(``, `First back with the drop takes the title.`);
  const embed = new EmbedBuilder()
    .setColor(ZAMORAK_RED)
    .setTitle('📜 Bounty Contract Available')
    .setDescription(clampDesc(lines.join('\n')))
    .setTimestamp();
  if (image) embed.setThumbnail(image);
  return embed;
}

const CARD_API = 'https://oathforsaken.cc/api/cards';
const thumbCache = new Map();

async function thumbB64(url) {
  if (thumbCache.has(url)) return thumbCache.get(url);
  let out = null;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15000);
    const res = await fetch(url, {
      headers: { 'User-Agent': 'OathForsaken-Bot/1.0 (https://oathforsaken.cc)' },
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (res.ok) out = Buffer.from(await res.arrayBuffer()).toString('base64');
  } catch {
    out = null;
  }
  thumbCache.set(url, out);
  return out;
}

function posterProofText(proof) {
  if (!proof || !proof.type) return null;
  const label = { drop: 'Drop', kc: 'KC', xp: 'XP', clog: 'Collection log' }[proof.type] || proof.type;
  const amount = proof.amount ? ` x${proof.amount}` : '';
  return `Proof: ${label}: ${proof.target}${amount}, must land after the post date.`;
}

// Wanted-poster render from the card service. Null on any failure;
// callers fall back to the text embed so posting never breaks.
async function fetchPoster(bounty, hunters, statusText) {
  try {
    const lane = bountyLane(bounty);
    const daysLeft = bounty.expiresAt
      ? Math.max(0, Math.ceil((bounty.expiresAt - Date.now()) / DAY_MS))
      : bounty.days;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 20000);
    const res = await fetch(CARD_API + '/bounty', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'OathForsaken-Bot/1.0 (https://oathforsaken.cc)' },
      body: JSON.stringify({
        target: bounty.target,
        location: bounty.location,
        tier: bounty.threat,
        hunterWord: bounty.pet ? 'pet hunter' : (lane === 'Skilling' ? 'skiller' : 'hunter'),
        postedText: bounty.createdAt
          ? new Date(bounty.createdAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })
          : null,
        lane,
        rewardTitle: LANE_TITLES[lane],
        daysLeft,
        proofText: posterProofText(bounty.proof),
        hunters,
        bottomLine: { text: 'First back with the drop takes the title.', kind: 'voice' },
        statusText: statusText || null,
        image: bounty.image ? await thumbB64(bounty.image) : null,
      }),
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    return Buffer.from(await res.arrayBuffer());
  } catch {
    return null;
  }
}

// Re-render a board post as a poster. Returns false when the render
// failed and the caller should use the legacy embed edit instead.
async function boardPosterEdit(msg, bounty, state, { statusText = null, close = false } = {}) {
  const hunters = Object.values(state.claims || {}).filter(
    (c) => c.bountyId === msg.id && c.status === 'pending'
  ).length;
  const png = await fetchPoster(bounty, hunters, statusText);
  if (!png) return false;
  const edit = { embeds: [], files: [new AttachmentBuilder(png, { name: 'bounty-poster.png' })] };
  if (close) {
    edit.components = [];
    edit.content = '';
  }
  await msg.edit(edit);
  return true;
}

async function refreshBoard(client, bountyId, state, opts = {}) {
  const bounty = state.bounties[bountyId];
  if (!bounty) return false;
  try {
    const chan = await client.channels.fetch(bounty.channelId).catch(() => null);
    if (!chan || !chan.isTextBased()) return false;
    const msg = await chan.messages.fetch(bountyId).catch(() => null);
    if (!msg) return false;
    return await boardPosterEdit(msg, bounty, state, opts);
  } catch (err) {
    console.warn('Bounty board refresh failed:', err.message);
    return false;
  }
}

function reviewButtons(threadId) {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`bounty:done:${threadId}`)
        .setLabel('Done - Check My Proof')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(`bounty:grant:${threadId}`)
        .setLabel('Grant Winnings')
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`bounty:reject:${threadId}`)
        .setLabel('Reject')
        .setStyle(ButtonStyle.Danger),
      new ButtonBuilder()
        .setCustomId(`bounty:lock:${threadId}`)
        .setLabel('Lock & Archive Thread')
        .setStyle(ButtonStyle.Primary)
    ),
  ];
}

function findContract(query) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return null;
  const pool = loadPool();
  return (
    pool.find((c) => c.name.toLowerCase() === q) ||
    pool.find((c) => c.name.toLowerCase().startsWith(q)) ||
    pool.find((c) => c.name.toLowerCase().includes(q)) ||
    null
  );
}

// "Next" for a lane: the earliest sheet row in that lane that has never
// been posted; once the whole lane has run, the least recently posted.
function nextContract(lane, state) {
  const posted = state.poolPosted || {};
  const inLane = loadPool().filter((c) => (c.lane === 'Skilling' ? 'Skilling' : 'PvM') === lane);
  return (
    inLane.find((c) => !posted[c.name]) ||
    inLane.sort((a, b) => (posted[a.name] || 0) - (posted[b.name] || 0))[0] ||
    null
  );
}

function bountyAutocompleteChoices(focused) {
  const q = String(focused || '').toLowerCase();
  const all = [
    { name: 'Next PvM contract', value: 'next:PvM' },
    { name: 'Next Skilling contract', value: 'next:Skilling' },
    ...loadPool().map((c) => ({ name: `${c.name} (${c.tier}, ${c.lane})`.slice(0, 100), value: c.name })),
  ];
  return all.filter((c) => !q || c.name.toLowerCase().includes(q) || c.value.toLowerCase().includes(q)).slice(0, 25);
}

async function postCommand(interaction) {
  if (!isStaff(interaction)) {
    await interaction.reply({ content: 'Staff only.', ephemeral: true }).catch(() => {});
    return;
  }
  const channelId = bountyConfig().channelId;
  if (!channelId) {
    await interaction.reply({ content: 'Bounty board is not set up yet. Tell staff.', ephemeral: true }).catch(() => {});
    return;
  }
  const channel = await interaction.client.channels.fetch(channelId).catch(() => null);
  if (!channel) {
    await interaction.reply({ content: 'Could not find the bounty board channel.', ephemeral: true }).catch(() => {});
    return;
  }
  const query = interaction.options.getString('contract', true).trim();
  const daysOverride = interaction.options.getInteger('days');
  const proofType = interaction.options.getString('proof_type');
  const proofTarget = interaction.options.getString('proof_target')?.trim();
  const proofAmount = interaction.options.getInteger('proof_amount');
  if ((proofType && !proofTarget) || (!proofType && proofTarget)) {
    await interaction
      .reply({ content: 'Proof needs both a type and a target, or neither.', ephemeral: true })
      .catch(() => {});
    return;
  }
  const proof = proofType ? { type: proofType, target: proofTarget, amount: proofAmount || null } : null;

  await interaction.deferReply({ ephemeral: true });

  return mutateBounty(async () => {
    const state = loadState();
    state.poolPosted = state.poolPosted || {};
    let contract = null;
    if (query.startsWith('next:')) {
      contract = nextContract(query.split(':')[1] === 'Skilling' ? 'Skilling' : 'PvM', state);
    } else {
      contract = findContract(query);
    }
    if (!contract) {
      await interaction.editReply({ content: `No pool contract matches "${query}".` }).catch(() => {});
      return;
    }
    const lane = contract.lane === 'Skilling' ? 'Skilling' : 'PvM';
    const role = laneRole(interaction.guild, lane);
    if (!role) {
      await interaction
        .editReply({ content: `The ${lane} title role (${LANE_TITLES[lane]}) is not set up yet.` })
        .catch(() => {});
      return;
    }
    const days = daysOverride || DAYS_BY_THREAT[contract.tier] || 14;
    const winners = contract.winners > 1 ? contract.winners : 1;

    // Retire the active bounty in this lane only; the other lane runs on.
    for (const [id, b] of Object.entries(state.bounties)) {
      if (b.active && bountyLane(b) === lane) {
        b.active = false;
        try {
          const oldMsg = await channel.messages.fetch(id);
          const applied = await boardPosterEdit(oldMsg, b, state, {
            statusText: 'Contract closed',
            close: true,
          }).catch(() => false);
          if (!applied && oldMsg.embeds[0]) {
            const oldEmbed = EmbedBuilder.from(oldMsg.embeds[0]).setFooter({ text: 'Contract closed.' });
            await oldMsg.edit({ embeds: [oldEmbed], components: [] });
          }
        } catch (err) {
          console.warn('Bounty retire edit failed:', err.message);
        }
      }
    }

    const wikiUrl = `https://oldschool.runescape.wiki/w/${encodeURIComponent(contract.name.replace(/ /g, '_'))}`;
    const nowTs = Date.now();
    const record = {
      channelId: channel.id,
      target: contract.name,
      location: contract.content,
      threat: contract.tier,
      lane,
      winners,
      proof,
      poolId: contract.id,
      pet: contract.pet || false,
      blurb: contract.blurb || null,
      winLine: contract.winLine || null,
      days,
      wiki: wikiUrl,
      image: contract.thumbnail || null,
      active: true,
      winnerId: null,
      winnerIds: [],
      createdAt: nowTs,
      expiresAt: nowTs + days * DAY_MS,
      createdBy: interaction.user.id,
    };
    const poster = await fetchPoster(record, 0, null);
    const embed = bountyEmbed({
      target: contract.name,
      location: contract.content,
      threat: contract.tier,
      days,
      image: contract.thumbnail,
      rewardMention: `<@&${role.id}>`,
      lane,
      winners,
      proof,
    });
    const postContent = [
      '━━━━━━ ⛧ ━━━━━━',
      bountyConfig().notifyRoleId ? `<@&${bountyConfig().notifyRoleId}>` : null,
      `⛧ **A new contract: ${contract.name}** ⛧`,
      record.blurb ||
        `Get it while the contract is live. First ${contract.pet ? 'pet hunter' : lane === 'Skilling' ? 'skiller' : 'hunter'} back with the drop takes the title.`,
      `Reward: <@&${role.id}>`,
      `⏳ Closes <t:${Math.floor(record.expiresAt / 1000)}:R>`,
    ]
      .filter(Boolean)
      .join('\n');
    let msg;
    try {
      msg = await channel.send({
        content: postContent,
        ...(bountyConfig().notifyRoleId
          ? { allowedMentions: { roles: [bountyConfig().notifyRoleId] } }
          : {}),
        ...(poster
          ? { files: [new AttachmentBuilder(poster, { name: 'bounty-poster.png' })] }
          : { embeds: [embed] }),
        components: [
          new ActionRowBuilder().addComponents(
            new ButtonBuilder()
              .setCustomId('bounty:claim:pending')
              .setLabel('Submit Proof')
              .setStyle(ButtonStyle.Danger)
              .setEmoji({ id: '1558477037537329182', name: 'zamorak' }),
            new ButtonBuilder().setLabel('Wiki Link').setStyle(ButtonStyle.Link).setURL(wikiUrl).setEmoji('📖')
          ),
        ],
      });
    } catch (err) {
      console.error('Bounty post failed:', err.message);
      await interaction.editReply({ content: 'Could not post the bounty.' }).catch(() => {});
      return;
    }
    // Patch the claim button with the real bounty id now that we have it.
    await msg
      .edit({
        components: [
          new ActionRowBuilder().addComponents(
            new ButtonBuilder()
              .setCustomId(`bounty:claim:${msg.id}`)
              .setLabel('Submit Proof')
              .setStyle(ButtonStyle.Danger)
              .setEmoji({ id: '1558477037537329182', name: 'zamorak' }),
            new ButtonBuilder().setLabel('Wiki Link').setStyle(ButtonStyle.Link).setURL(wikiUrl).setEmoji('📖')
          ),
        ],
      })
      .catch((err) => console.warn('Bounty button patch failed:', err.message));

    state.bounties[msg.id] = record;
    state.poolPosted[contract.name] = Date.now();
    saveState(state);
    await interaction.editReply({ content: `Bounty posted (${lane}): ${contract.name}` }).catch(() => {});
  });
}

async function handleClaim(interaction, bountyId) {
  const state = loadState();
  const bounty = state.bounties[bountyId];
  if (!bounty || !bounty.active) {
    await interaction.reply({ content: 'This bounty is no longer active.', ephemeral: true }).catch(() => {});
    return;
  }
  if (!isMember(interaction.member)) {
    await interaction.reply({ content: 'Clan members only. Join the clan first.', ephemeral: true }).catch(() => {});
    return;
  }
  // One pending claim per member per bounty, and a past winner cannot
  // claim the same contract twice.
  const existing = Object.entries(state.claims).find(
    ([, c]) => c.bountyId === bountyId && c.claimerId === interaction.user.id && c.status === 'pending'
  );
  if (existing) {
    await interaction
      .reply({ content: 'You already have an open proof thread. Post your proof there.', ephemeral: true })
      .catch(() => {});
    return;
  }
  if ((bounty.winnerIds || []).includes(interaction.user.id)) {
    await interaction
      .reply({ content: 'You already won this contract. Let another hunter take a shot.', ephemeral: true })
      .catch(() => {});
    return;
  }

  // The checks above are a fast path only. The authoritative checks run
  // inside the queue on a fresh load: two fast taps both pass the early
  // pending check before either saves, so without this the second tap
  // would open a duplicate claim thread.
  return mutateBounty(async () => {
    const state = loadState();
    const bounty = state.bounties[bountyId];
    if (!bounty || !bounty.active) {
      await interaction.reply({ content: 'This bounty is no longer active.', ephemeral: true }).catch(() => {});
      return;
    }
    const dup = Object.values(state.claims).some(
      (c) => c.bountyId === bountyId && c.claimerId === interaction.user.id && c.status === 'pending'
    );
    if (dup) {
      await interaction
        .reply({ content: 'You already have an open proof thread. Post your proof there.', ephemeral: true })
        .catch(() => {});
      return;
    }
    if ((bounty.winnerIds || []).includes(interaction.user.id)) {
      await interaction
        .reply({ content: 'You already won this contract. Let another hunter take a shot.', ephemeral: true })
        .catch(() => {});
      return;
    }

    await interaction.deferReply({ ephemeral: true });
    // Claim threads live in #contact-staff as standalone private threads,
    // the same way ticket threads are made. A thread started from the
    // board post makes Discord drop a thread-created system message in
    // the board channel; a standalone thread does not.
    const contactChannel = await interaction.client.channels
      .fetch(config.tickets.panelChannelId)
      .catch(() => null);
    if (!contactChannel || !contactChannel.threads) {
      await interaction.editReply({ content: 'Could not open a proof thread. Tell staff.' }).catch(() => {});
      return;
    }
    const name = `Bounty Proof - ${interaction.user.displayName}`.slice(0, 100);
    let thread;
    try {
      thread = await contactChannel.threads.create({
        name,
        autoArchiveDuration: CLAIM_ARCHIVE_MIN,
        type: ChannelType.PrivateThread,
        invitable: false,
        reason: `Bounty proof by ${interaction.user.tag}`,
      });
    } catch {
      thread = await contactChannel.threads
        .create({ name, autoArchiveDuration: CLAIM_ARCHIVE_MIN })
        .catch(() => null);
    }
    if (!thread) {
      await interaction.editReply({ content: 'Could not open a proof thread. Tell staff.' }).catch(() => {});
      return;
    }
    await thread.members.add(interaction.user.id).catch(() => {});

    const claim = { bountyId, claimerId: interaction.user.id, status: 'pending', createdAt: Date.now() };
    state.claims[thread.id] = claim;
    saveState(state);
    try {
      const pl = proofLine(bounty.proof);
      await thread.send({
        content:
          `<@${interaction.user.id}> is submitting proof for **${bounty.target}**.\n` +
          `Post your screenshot here. The drop has to be from after the contract was posted.` +
          (pl ? `\n${pl.replace(/\*\*/g, '')}` : '') +
          `\nPress Done - Check My Proof and the bot checks the clan feeds for the drop. Staff cross-check and make the final call.`,
        components: reviewButtons(thread.id),
      });
    } catch {
      delete state.claims[thread.id];
      saveState(state);
      await interaction.editReply({ content: 'Could not open a proof thread. Tell staff.' }).catch(() => {});
      return;
    }
    await refreshBoard(interaction.client, bountyId, state, {}).catch(() => {});
    await interaction.editReply({ content: `Proof thread opened: ${thread.url}` }).catch(() => {});
  });
}

async function handleGrant(interaction, threadId) {
  if (!isStaff(interaction)) {
    await interaction.reply({ content: 'Staff only.', ephemeral: true }).catch(() => {});
    return;
  }
  return mutateBounty(async () => {
    const state = loadState();
    const claim = state.claims[threadId];
    if (!claim || claim.status !== 'pending') {
      await interaction.reply({ content: 'Nothing to grant here.', ephemeral: true }).catch(() => {});
      return;
    }
    const bounty = state.bounties[claim.bountyId];
    if (!bounty || !bounty.active) {
      await interaction.reply({ content: 'This bounty is no longer active.', ephemeral: true }).catch(() => {});
      return;
    }
    const guild = interaction.guild;
    const lane = bountyLane(bounty);
    const role = laneRole(guild, lane);
    if (!role) {
      await interaction.reply({ content: `${lane} title role is not set up.`, ephemeral: true }).catch(() => {});
      return;
    }
    await interaction.deferReply({ ephemeral: true });

    const winner = await guild.members.fetch(claim.claimerId).catch(() => null);
    if (!winner) {
      await interaction.editReply({ content: 'Winner is no longer in the server.' }).catch(() => {});
      return;
    }

    bounty.winnerIds = bounty.winnerIds || (bounty.winnerId ? [bounty.winnerId] : []);
    const isFirstWinner = bounty.winnerIds.length === 0;
    const cap = bountyCap(bounty);

    // The title changes hands on the first winner only. Later winners
    // inside the cap count as winners but do not strip the title.
    let retained = false;
    if (isFirstWinner) {
      retained = winner.roles.cache.has(role.id);
      if (!retained) {
        try {
          await winner.roles.add(role);
        } catch (err) {
          console.error('Bounty grant failed:', err.message);
          await interaction.editReply({ content: 'Could not grant the role. Check my permissions.' }).catch(() => {});
          return;
        }
      }
      const prevHolders = [...role.members.values()].filter((m) => m.id !== claim.claimerId);
      for (const m of prevHolders) {
        await m.roles.remove(role).catch((err) => console.warn('Bounty strip failed:', err.message));
      }
    }

    claim.status = 'granted';
    claim.titleHolder = isFirstWinner;
    // Winners log for the website hall: one record per grant, in order.
    try {
      const winnersFile = path.join(__dirname, '..', 'data', 'bounty-winners.json');
      let log = [];
      try {
        const parsed = JSON.parse(fs.readFileSync(winnersFile, 'utf8'));
        if (Array.isArray(parsed)) log = parsed;
      } catch {}
      log.push({
        target: bounty.target,
        lane,
        tier: bounty.threat || null,
        winnerId: winner.id,
        winnerName: winner.displayName,
        rsn: resolveRsn(winner.id) || null,
        titleHolder: isFirstWinner,
        proof: bounty.proof ? `${bounty.proof.type}: ${bounty.proof.target}` : 'screenshot',
        at: Date.now(),
      });
      atomicWrite(winnersFile, log);
    } catch (err) {
      console.warn('Bounty winners log failed:', err.message);
    }
    bounty.winnerIds.push(claim.claimerId);
    if (!bounty.winnerId) bounty.winnerId = claim.claimerId;
    const winnersNow = bounty.winnerIds.length;
    const closesContract = winnersNow >= cap;

    if (closesContract) {
      bounty.active = false;
      for (const c of Object.values(state.claims)) {
        if (c !== claim && c.bountyId === claim.bountyId && c.status === 'pending') c.status = 'superseded';
      }
      try {
        const chan = await guild.channels.fetch(bounty.channelId).catch(() => null);
        const msg = chan ? await chan.messages.fetch(claim.bountyId).catch(() => null) : null;
        if (msg) {
          const names = bounty.winnerIds.map((id) => `<@${id}>`).join(', ');
          const stamp = `Claimed by ${winner.displayName}${winnersNow > 1 ? ` and ${winnersNow - 1} more` : ''}`;
          const applied = await boardPosterEdit(msg, bounty, state, {
            statusText: stamp,
            close: true,
          }).catch(() => false);
          if (!applied && msg.embeds[0]) {
            const done = EmbedBuilder.from(msg.embeds[0]).setFooter({ text: stamp });
            await msg.edit({ embeds: [done], components: [] });
          }
          if (chan && chan.isTextBased()) {
            await chan
              .send(
                bounty.winLine
                  ? `🩸 ${bounty.winLine} ${names} ${winnersNow === 1 ? 'takes' : 'take'} the title. A new contract will be nailed to the board soon.`
                  : `🩸 Contract complete. **${bounty.target}** goes to ${names}. A new contract will be nailed to the board soon.`
              )
              .catch(() => {});
          }
        }
      } catch (err) {
        console.warn('Bounty close edit failed:', err.message);
      }
    }
    saveState(state);

    const thread = await guild.channels.fetch(threadId).catch(() => null);
    if (thread && thread.isThread()) {
      let note;
      if (isFirstWinner) {
        note = retained
          ? `👑 Bounty Confirmed! <@${winner.id}> retains the title ${role.name}.`
          : `👑 Bounty Confirmed! <@${winner.id}> has been granted the title ${role.name}.`;
        if (!closesContract) note += ` The contract stays open: ${cap - winnersNow} winner slot${cap - winnersNow === 1 ? '' : 's'} left.`;
      } else {
        note = closesContract
          ? `👑 Bounty Confirmed! <@${winner.id}> takes the final winner slot on this contract.`
          : `👑 Bounty Confirmed! <@${winner.id}> is a winner on this contract. ${cap - winnersNow} slot${cap - winnersNow === 1 ? '' : 's'} left. The title stays with the first winner.`;
      }
      await thread.send(note).catch(() => {});
      if (closesContract) {
        await thread.setLocked(true).catch(() => {});
        await thread.setArchived(true).catch(() => {});
      }
    }
    await interaction.editReply({ content: `Granted to ${winner.displayName}.` }).catch(() => {});
  });
}


// Flatten recent clan chat relay messages (TrackScape) into text lines
// the proof checker can search. Pages back until it covers the time
// since the contract was posted, capped so a long contract stays cheap.
async function fetchFeedLines(client, sinceMs) {
  const channelId = config.channels && config.channels.clanChat;
  if (!channelId) return [];
  const chan = await client.channels.fetch(channelId).catch(() => null);
  if (!chan || !chan.isTextBased()) return [];
  const lines = [];
  let before;
  for (let page = 0; page < 6; page += 1) {
    const batch = await chan.messages
      .fetch({ limit: 100, ...(before ? { before } : {}) })
      .catch(() => null);
    if (!batch || !batch.size) break;
    let oldest = Infinity;
    for (const m of batch.values()) {
      oldest = Math.min(oldest, m.createdTimestamp);
      const parts = [m.content || ''];
      for (const e of m.embeds || []) {
        if (e.title) parts.push(e.title);
        if (e.description) parts.push(e.description);
        if (e.author && e.author.name) parts.push(e.author.name);
        if (e.footer && e.footer.text) parts.push(e.footer.text);
        for (const f of e.fields || []) parts.push(`${f.name} ${f.value}`);
      }
      lines.push({ text: parts.filter(Boolean).join(' | '), at: m.createdTimestamp });
    }
    if (oldest <= sinceMs) break;
    before = batch.last().id;
  }
  return lines;
}

// The Done button: run the proof checker and post the verdict into the
// thread as evidence. Staff still grant or reject.
async function handleDone(interaction, threadId) {
  const state = loadState();
  const claim = state.claims[threadId];
  if (!claim || claim.status !== 'pending') {
    await interaction.reply({ content: 'Nothing to check here.', ephemeral: true }).catch(() => {});
    return;
  }
  if (interaction.user.id !== claim.claimerId && !isStaff(interaction)) {
    await interaction.reply({ content: 'Only the claimant or staff can run the check.', ephemeral: true }).catch(() => {});
    return;
  }
  const bounty = state.bounties[claim.bountyId];
  if (!bounty || !bounty.proof) {
    await interaction
      .reply({ content: 'This contract has no proof target. Post a screenshot and staff will judge it.', ephemeral: true })
      .catch(() => {});
    return;
  }
  await interaction.deferReply();
  const rsn = resolveRsn(claim.claimerId);
  const feedLines = await fetchFeedLines(interaction.client, bounty.createdAt);
  const result = await verifyProof({
    rsn,
    proof: bounty.proof,
    postedAt: bounty.createdAt,
    feedLines,
  }).catch((err) => ({ status: 'unknown', lines: [`Checker failed: ${err.message}`] }));
  const header =
    result.status === 'proven'
      ? '✅ **Proof check: the bot believes this is good.**'
      : result.status === 'not'
        ? '❌ **Proof check: not found.**'
        : '⚠️ **Proof check: could not confirm.**';
  await interaction
    .editReply({ content: `${header}\n${result.lines.join('\n')}\nStaff cross-check and make the final call.` })
    .catch(() => {});
}

async function handleReject(interaction, threadId) {
  if (!isStaff(interaction)) {
    await interaction.reply({ content: 'Staff only.', ephemeral: true }).catch(() => {});
    return;
  }
  return mutateBounty(async () => {
    const state = loadState();
    const claim = state.claims[threadId];
    if (!claim || claim.status !== 'pending') {
      await interaction.reply({ content: 'Nothing to reject here.', ephemeral: true }).catch(() => {});
      return;
    }
    claim.status = 'rejected';
    saveState(state);
    await refreshBoard(interaction.client, claim.bountyId, state, {}).catch(() => {});
    const thread = await interaction.guild.channels.fetch(threadId).catch(() => null);
    if (thread && thread.isThread()) {
      await thread.send('Proof rejected. Post better proof if you have it.').catch(() => {});
    }
    await interaction.reply({ content: 'Proof rejected.', ephemeral: true }).catch(() => {});
  });
}

async function handleLock(interaction, threadId) {
  if (!isStaff(interaction)) {
    await interaction.reply({ content: 'Staff only.', ephemeral: true }).catch(() => {});
    return;
  }
  const thread = await interaction.guild.channels.fetch(threadId).catch(() => null);
  if (thread && thread.isThread()) {
    await thread.setLocked(true).catch(() => {});
    await thread.setArchived(true).catch(() => {});
  }
  await interaction.reply({ content: 'Thread locked and archived.', ephemeral: true }).catch(() => {});
}

const LAST_CALL_MS = 48 * 3600 * 1000;

// Periodic sweep with a pulse. Inside the final 48 hours a contract
// gets one last call: the board post is marked, a notice lands on the
// board, and every open claim thread is pinged. At expiry the claims
// flip to expired and the closing post says what actually happened
// (no claims, claims that never proved, or winners before the close).
// Idempotent across restarts: lastCallAt is stamped once.
async function sweepExpiredBounties(client) {
  return mutateBounty(async () => {
    const state = loadState();
    const now = Date.now();
    let changed = false;
    for (const [id, b] of Object.entries(state.bounties)) {
      if (!b.active) continue;
      const expiresAt = b.expiresAt || (b.createdAt || 0) + (b.days || 14) * DAY_MS;

      if (expiresAt > now) {
        // Last call window.
        if (!b.lastCallAt && expiresAt - now <= LAST_CALL_MS) {
          b.lastCallAt = now;
          changed = true;
          try {
            const chan = await client.channels.fetch(b.channelId).catch(() => null);
            if (chan && chan.isTextBased()) {
              const msg = await chan.messages.fetch(id).catch(() => null);
              if (msg) {
                const applied = await boardPosterEdit(msg, b, state, {
                  statusText: 'Last call',
                }).catch(() => false);
                if (!applied && msg.embeds[0]) {
                  const marked = EmbedBuilder.from(msg.embeds[0]).setFooter({
                    text: 'Last call: this contract closes in under 48 hours.',
                  });
                  await msg.edit({ embeds: [marked] }).catch(() => {});
                }
              }
              await chan
                .send(`⏳ Last call on **${b.target}** (${bountyLane(b)} lane): the contract closes in under 48 hours.`)
                .catch(() => {});
            }
            for (const [threadId, c] of Object.entries(state.claims)) {
              if (c.bountyId !== id || c.status !== 'pending') continue;
              const thread = await client.channels.fetch(threadId).catch(() => null);
              if (thread && thread.isThread()) {
                await thread
                  .send(`<@${c.claimerId}> Last call: this contract closes in under 48 hours. Press Done - Check My Proof if you have the proof.`)
                  .catch(() => {});
              }
            }
          } catch (err) {
            console.warn('Bounty last call failed:', err.message);
          }
        }
        continue;
      }

      // Expiry.
      b.active = false;
      changed = true;
      let pendingCount = 0;
      for (const c of Object.values(state.claims)) {
        if (c.bountyId === id && c.status === 'pending') {
          c.status = 'expired';
          pendingCount += 1;
        }
      }
      const winners = (b.winnerIds || []).length;
      const outcome =
        winners > 0
          ? `⌛ The contract on **${b.target}** closed with ${winners} winner${winners === 1 ? '' : 's'} on the board.`
          : pendingCount > 0
            ? `⌛ The contract on **${b.target}** expired mid-grind: ${pendingCount} proof thread${pendingCount === 1 ? '' : 's'} never proved in time.`
            : `⌛ The contract on **${b.target}** expired with no proof sent in.`;
      try {
        const chan = await client.channels.fetch(b.channelId).catch(() => null);
        if (!chan || !chan.isTextBased()) continue;
        const msg = await chan.messages.fetch(id).catch(() => null);
        if (msg) {
          const applied = await boardPosterEdit(msg, b, state, {
            statusText: 'Contract expired',
            close: true,
          }).catch(() => false);
          if (!applied && msg.embeds[0]) {
            const expired = EmbedBuilder.from(msg.embeds[0]).setFooter({ text: 'Contract expired.' });
            await msg.edit({ embeds: [expired], components: [] });
          }
        }
        await chan.send(`${outcome} A new contract will be nailed to the board soon.`).catch(() => {});
      } catch (err) {
        console.warn('Bounty expiry sweep failed:', err.message);
      }
    }
    if (changed) saveState(state);
  });
}

async function handleBountyButton(interaction) {
  // customId: 'bounty:claim:<msgId>' | 'bounty:grant:<threadId>' | 'bounty:reject:<threadId>' | 'bounty:lock:<threadId>'
  const [, action, id] = interaction.customId.split(':');
  if (action === 'claim') return handleClaim(interaction, id);
  if (action === 'done') return handleDone(interaction, id);
  if (action === 'grant') return handleGrant(interaction, id);
  if (action === 'reject') return handleReject(interaction, id);
  if (action === 'lock') return handleLock(interaction, id);
}

const commands = [
  {
    data: new SlashCommandBuilder()
      .setName('bounty')
      .setDescription('Manage bounty contracts')
      .addSubcommand((s) =>
        s
          .setName('post')
          .setDescription('Post a contract from the bounty pool (staff)')
          .addStringOption((o) =>
            o
              .setName('contract')
              .setDescription('Pool contract name, or pick a Next option')
              .setRequired(true)
              .setAutocomplete(true)
          )
          .addIntegerOption((o) =>
            o.setName('days').setDescription('Day limit override (default comes from the tier)').setMinValue(1).setMaxValue(90)
          )
          .addStringOption((o) =>
            o
              .setName('proof_type')
              .setDescription('What proves the bounty (optional)')
              .addChoices(
                { name: 'Drop', value: 'drop' },
                { name: 'KC', value: 'kc' },
                { name: 'XP', value: 'xp' },
                { name: 'Collection log', value: 'clog' }
              )
          )
          .addStringOption((o) => o.setName('proof_target').setDescription('Item, boss, or skill the proof is about'))
          .addIntegerOption((o) => o.setName('proof_amount').setDescription('How many (KC or XP targets)').setMinValue(1))
      ),
    run: async (interaction) => {
      if (interaction.options.getSubcommand() === 'post') return postCommand(interaction);
    },
  },
];

module.exports = { commands, handleBountyButton, sweepExpiredBounties, bountyAutocompleteChoices };
