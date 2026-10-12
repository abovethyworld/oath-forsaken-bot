# OSRS Clan Bot

A custom Discord bot for your clan, in the style of "the reference":

- **Button roles** — `/setup-roles` posts embed panels with clickable role buttons (like the GENERAL / PVM / MINIGAME panels)
- **Rules + strike system embeds** — `/post-rules` and `/post-strikes` post banner embeds
- **Welcome messages** — automatic embed when someone joins
- **Strike tracking** — `/warn`, `/strikes`, `/clear-strikes` with a mod-log channel
- **Tickets** — `/setup-tickets` posts an "Open a Ticket" panel; each click creates a private channel for that user + staff, with close button and transcript logging
- **Calendar** — `/event-create` creates a real Discord scheduled event (RSVP in the Events tab) + announcement; `/events` lists; `/event-cancel` removes; automatic reminder pings before each event
- **Recruitment** — new joins get a private application channel; a modal asks RSN, total level, nickname, how they heard about you; staff get Approve/Deny buttons, under-30-day accounts are flagged
- **Polls** — `/poll` with live button voting
- **Seniority ranks** — the bot assigns tenure roles automatically from each member's join date (Unsworn → … → Oathbreaker), re-checks daily, and staff can force it with `/sync-seniority`
- **Google Calendar sync** — every `/event-create` also lands on a linked Google Calendar (one-time Google setup, see below)

Everything the bot says is configured in `config.json`. No code changes needed to customize.

---

## Part 1 — Create the bot (10 min, one time)

1. Go to <https://discord.com/developers/applications> and click **New Application**. Name it whatever you want the bot to be called (you can rename it when the clan name is locked in).
2. Left sidebar → **Bot** → **Reset Token** → copy the token. **Treat it like a password.**
3. On the same Bot page, scroll to **Privileged Gateway Intents** and turn ON **Server Members Intent** (needed for welcome messages). Save.
4. Left sidebar → **General Information** → copy the **Application ID**.

## Part 2 — Invite it to your server

Build an invite link in the portal: **OAuth2 → URL Generator**, tick scopes `bot` and `applications.commands`, and tick these bot permissions:

- Manage Roles
- Manage Channels (tickets)
- Manage Events (calendar)
- Send Messages
- Embed Links
- Attach Files (ticket transcripts)
- Read Message History
- View Channels

Open the generated URL, pick your server, authorize.

> **Critical:** in Server Settings → Roles, drag the bot's role **above** every role it hands out. Discord won't let a bot assign roles above its own — this is the #1 reason role bots "don't work."

## Part 3 — Configure

```bash
cd osrs-clan-bot
npm install
cp .env.example .env
```

1. Edit `.env`: paste your bot token and application ID.
2. Edit `config.json`:
   - `guildId` — your server ID (Developer Mode: Settings → Advanced → Developer Mode ON, then right-click server → Copy Server ID).
   - `channels.*` — right-click each channel → Copy Channel ID.
   - `rolePanels` — create the ping roles in your server first, then paste each role's ID. Edit labels, emoji, and button colors freely.
   - `rules`, `strikeSystem`, `welcome` — write your actual text. `banner` is an optional image URL (upload to imgur and paste the link — Discord attachment links expire) that appears at the top of the embed, like the RULES / GENERAL banners.
   - `tickets` — create a category (e.g. "Tickets") and your staff roles first, then paste the IDs. `staffRoleIds` is a list — add all mod/admin roles.
   - `calendar` — set your timezone (IANA name like `America/Chicago`), the events announcement channel, and the role to ping for event announcements/reminders.
3. Run it:

```bash
node src/index.js
```

You should see `Logged in as <name>` and `Registered 11 slash commands`. In your server, run `/setup-roles`, `/post-rules`, `/post-strikes`, and `/setup-tickets` to post the panels.

## Part 4 — Run it 24/7

The bot only answers buttons, tickets, welcomes, and reminders while its process is running. Everything in `deploy/` preps a free VPS for that:

**Recommended: Oracle Cloud Always Free** (free forever, no catch beyond signup verification)
1. Sign up at <https://www.oracle.com/cloud/free/> — it asks for a card for verification but the Always Free tier isn't charged.
2. Create a VM: **Ampere A1** shape (4 OCPUs / 24 GB free), Ubuntu 24.04. No inbound firewall rules needed — the bot only makes outbound connections.
3. SSH in and run the setup script:
   ```bash
   curl -fsSLO https://raw.githubusercontent.com/<you>/oathbreakers-bot/main/deploy/setup-vps.sh
   # or just paste its contents — it's in deploy/setup-vps.sh
   sudo bash setup-vps.sh
   ```
   (Simplest: copy the file's contents from your workspace and paste it into the SSH session.)
4. Upload the tarball from your computer:
   ```bash
   scp deploy/oathbreakers-bot.tar.gz ubuntu@<vps-ip>:/tmp/
   ```
   Then on the VPS: `sudo tar -xzf /tmp/oathbreakers-bot.tar.gz -C /opt/oathbreakers-bot`
5. Create `/opt/oathbreakers-bot/.env` with your token (same two lines as local `.env`), then:
   ```bash
   cd /opt/oathbreakers-bot && sudo npm install --omit=dev --no-audit --no-fund
   sudo cp deploy/oathbreakers-bot.service /etc/systemd/system/
   sudo systemctl daemon-reload && sudo systemctl enable --now oathbreakers-bot
   ```
6. Verify: `systemctl status oathbreakers-bot` and `journalctl -u oathbreakers-bot -f`. It auto-restarts on crashes and on reboot.

**Alternative: Raspberry Pi** — same steps minus the Oracle signup: copy the project folder over, `npm install`, drop the `.service` file in `/etc/systemd/system/`, enable it.

## Part 5 — Run it locally for testing

`node src/index.js` runs the bot on your own machine. Fine for testing, but it dies when the PC sleeps — Part 5 above is the real 24/7 answer. (Running it from Muse's workspace doesn't work: this machine can't hold Discord's live connection.)

## Commands

| Command | What it does | Who can use it |
|---|---|---|
| `/setup-roles` | Posts the button-role panels | Admins |
| `/post-rules` | Posts the rules embed | Admins |
| `/post-strikes` | Posts the strike-system embed | Admins |
| `/warn @user reason` | Adds a strike, logs it to the mod channel | Mods (Manage Messages) |
| `/strikes @user` | Shows a user's strikes | Mods |
| `/clear-strikes @user` | Clears a user's strikes | Mods |
| `/setup-tickets` | Posts the ticket panel | Admins |
| `/close` | Closes the current ticket (posts transcript, deletes channel) | Staff or ticket owner |
| `/event-create` | Creates a Discord scheduled event + announces it. Date `YYYY-MM-DD`, time `HH:MM` 24h in your configured timezone | Manage Events |
| `/events` | Lists upcoming clan events | Everyone |
| `/event-cancel` | Cancels an event by name | Manage Events |
| `/poll` | Creates a poll (up to 4 options) with live button voting | Everyone |
| `/sync-seniority` | Re-checks everyone's tenure rank now | Manage Roles |

## Recruitment — how it works

1. Someone joins the server → the bot opens a private `#application-username` channel (just them + staff) with a **Start Application** button. The normal welcome embed still posts in `#welcome` too.
2. The button pops a form asking: OSRS username (RSN), total level, what to call them, how they heard about the clan.
3. Submitting posts the application to the staff-only `#applications` channel with Approve ✅ / Deny ❌ buttons. Accounts under 30 days old are flagged automatically (`config.recruit.minAccountAgeDays`).
4. Approve assigns the **Member** role plus the entry tenure rank (**Unsworn (Under 1 month)**), DMs them, and closes the channel. Deny DMs them and closes it. Both are logged.

## Google Calendar — one-time setup (10 min)

The code is ready; Google needs you to approve the link once:

1. <https://console.cloud.google.com> → new project → **APIs & Services** → enable **Google Calendar API**.
2. **OAuth consent screen** → External → fill in app name + your email → add yourself as a test user.
3. **Credentials** → Create Credentials → **OAuth client ID** → Desktop app. Under the new client, add Authorized redirect URI: `http://localhost:53682/callback`
4. Copy the client ID + secret into `.env` as `GCAL_CLIENT_ID` / `GCAL_CLIENT_SECRET`.
5. On your own machine (not the VPS): `node src/gcal-auth.js` → open the printed URL → approve → done. Tokens save to `data/gcal-tokens.json` (copy that file to the VPS too, or re-run auth there with a browser handy).

After that, every `/event-create` is mirrored to the calendar in `config.gcal.calendarId` (`primary` = your main calendar).

Strikes are stored in `data/strikes.json`, tickets in `data/tickets.json`, reminder state in `data/reminders.json` — back up the `data/` folder if you move hosts.

## Tickets — how it works

1. Run `/setup-tickets` once. It posts the panel wherever `tickets.panelChannelId` points.
2. A member clicks **Open a Ticket** → the bot creates a private `#ticket-username` channel under your ticket category, visible only to them and your staff roles.
3. Staff help them in the channel. Anyone with the staff role (or the ticket owner) clicks **Close Ticket** or runs `/close`.
4. The bot DMs nothing — it posts a `.txt` transcript to your log channel, then deletes the ticket channel.

One ticket per person: if they already have one open, the button just links them to it.

## Calendar — how it works

Events are **native Discord scheduled events**, so members see them in the server's Events tab with Interested/Going buttons and get Discord's own notifications.

- `/event-create name:"Friday ToA learner raid" date:2026-10-17 time:19:00 description:"Bring blowpipe..."` — creates the event, posts an announcement in your events channel with a timestamp every member sees in their own timezone, and pings your event role.
- Add the optional `voice` channel to attach it to voice (otherwise it's listed as in-game).
- `/events` shows the next 10 upcoming events. `/event-cancel name:toa` finds it by partial name.
- The bot checks every 5 minutes and pings your event role at the configured reminders before start (default 60 and 15 minutes — edit `calendar.reminders`).
- Times are interpreted in `calendar.timezone`. The announcement uses Discord timestamps, so a 19:00 Chicago event shows correctly for a member in any timezone.

## Troubleshooting

- **Role buttons do nothing when clicked** → the bot's role sits below the role it's trying to assign; check the role hierarchy fix in Part 2.
- **Slash commands don't appear** → they register per-server on startup; restart the bot and wait a minute, then type `/` in your server.
- **No welcome message** → Server Members Intent isn't enabled (Part 1, step 3), or the welcome channel ID is wrong.
- **"Config problems found" on startup** → a `PASTE_*` placeholder is still in `config.json`; the error tells you exactly which one.
