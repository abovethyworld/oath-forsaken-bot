# Oath Forsaken Bot

A custom Discord bot for the Oath Forsaken OSRS clan. Handles onboarding, seniority ranks, tickets, events, polls, and strike tracking.

## Features

- **Button roles** — `/setup-roles` posts embed panels with clickable role buttons
- **Rules + strike system** — `/post-rules` and `/post-strikes` post themed embeds
- **Welcome messages** — automatic themed welcome when someone joins
- **Strike tracking** — `/warn`, `/strikes`, `/clear-strikes` with mod-log channel
- **Tickets** — `/setup-tickets` posts a panel with four themed ticket types: Report, Inquiry, Claim Reward, Become a Member
- **Guest-to-member flow** — guests click Become a Member and pick iron or main from a dropdown; the bot handles role assignment automatically, no ticket needed
- **Applications** — new joins get a private application channel with a modal form; staff approve/deny with buttons; nicknames auto-set to Name [RSN]
- **Seniority ranks** — automatic tenure-based progression (Initiate through Ascendant) from each member's join date; daily re-check plus `/sync-seniority`
- **CC Rank Checklist** — `/setup-cc-checklist` creates a persistent tracker; when someone ranks up on Discord, staff get pinged to update the in-game clan chat rank
- **Calendar** — `/event-create` creates a native Discord scheduled event plus announcement; `/events` lists upcoming; `/event-cancel` removes; automatic reminder pings
- **Event calendar embed** — auto-updating 2-week embed synced from Google Calendar; `/calendar-sync` forces a refresh
- **Polls** — `/poll` with live button voting
- **Google Calendar sync** — every `/event-create` also lands on a linked Google Calendar

Everything the bot posts is configured in `config.json`. No code changes needed to customize.

## Tech Stack

- Node.js 22
- discord.js
- Docker (multi-arch: amd64 + arm64)

## Prerequisites

- Node.js 22+
- A Discord application with bot token ([Discord Developer Portal](https://discord.com/developers/applications))
- Docker (for production deployment)

## Installation

```bash
git clone https://github.com/abovethyworld/oath-forsaken-bot.git
cd oath-forsaken-bot
npm install
cp .env.example .env
```

Edit `.env` with your bot token and application ID. Edit `config.json` with your server, channel, and role IDs (see Configuration below).

```bash
node src/index.js
```

You should see `Logged in as <name>` and the registered slash commands. In your server, run the setup commands below to post the panels.

## Configuration

`config.json` holds everything the bot posts. Replace every `PASTE_*` value:

- `guildId` — your server ID (Developer Mode: Settings > Advanced > Developer Mode ON, then right-click server > Copy Server ID)
- `channels.*` — right-click each channel > Copy Channel ID
- `rolePanels` — create the roles in your server first, then paste each role's ID
- `rules`, `strikeSystem`, `welcome` — your text and banner image URLs
- `tickets` — ticket category ID and staff role IDs
- `calendar` — timezone (IANA name like `America/Chicago`), events channel, ping role

## Setup Commands

Run these once in your server to post the panels:

| Command | What it posts |
|---|---|
| `/setup-roles` | Button-role panels |
| `/post-rules` | Rules embed |
| `/post-ranks` | Clan ranks embed |
| `/post-strikes` | Strike system embed |
| `/setup-tickets` | Ticket panel (Report, Inquiry, Claim Reward, Become a Member) |
| `/setup-applications` | Application panel |
| `/setup-cc-checklist` | CC Rank Checklist tracker |

## Commands

| Command | What it does | Who can use it |
|---|---|---|
| `/warn @user reason` | Adds a strike, logs it to the mod channel | Mods |
| `/strikes @user` | Shows a user's strikes | Mods |
| `/clear-strikes @user` | Clears a user's strikes | Mods |
| `/close` | Closes the current ticket (posts transcript, deletes channel) | Staff or ticket owner |
| `/event-create` | Creates a Discord scheduled event + announcement. Date `YYYY-MM-DD`, time `HH:MM` 24h in your configured timezone | Manage Events |
| `/events` | Lists upcoming events | Everyone |
| `/event-cancel` | Cancels an event by name | Manage Events |
| `/calendar-sync` | Forces a refresh of the event calendar embed | Manage Events |
| `/poll` | Creates a poll (up to 4 options) with live button voting | Everyone |
| `/sync-seniority` | Re-checks everyone's tenure rank now | Manage Roles |
| `/apply` | Starts an application manually | Everyone |
| `/reset-application @user` | Resets a user's application so they can reapply | Staff |

## Deployment

Every push to `main` triggers a GitHub Actions build (`.github/workflows/docker.yml`) that builds the image for amd64 + arm64 and pushes `ghcr.io/abovethyworld/oath-forsaken-bot:latest`.

**Running with Docker:**

```bash
docker run -d --name oath-forsaken-bot \
  --env-file /path/to/.env \
  -v /path/to/data:/app/data \
  ghcr.io/abovethyworld/oath-forsaken-bot:latest
```

- Secrets come from `--env-file` (bot token, Google credentials)
- `/app/data` is mounted as a volume so join dates, tickets, strikes, and checklist state survive updates
- `config.json` and `src/` are baked into the image, so config edits ship the same way as code

**Updating:** push to `main`, wait for the Actions build to go green, then restart the container to pull the latest image.

**systemd example** (`deploy/oathbreakers-bot.service`):

```ini
[Service]
ExecStartPre=/usr/bin/docker pull ghcr.io/abovethyworld/oath-forsaken-bot:latest
ExecStart=/usr/bin/docker run --rm --name oath-forsaken-bot \
  --env-file /opt/oathbreakers-bot/.env \
  -v /opt/oathbreakers-bot/data:/app/data \
  ghcr.io/abovethyworld/oath-forsaken-bot:latest
```

## Google Calendar Setup

1. [Google Cloud Console](https://console.cloud.google.com) > new project > enable **Google Calendar API**
2. **OAuth consent screen** > External > fill in app name + your email > add yourself as a test user
3. **Credentials** > Create Credentials > **OAuth client ID** > Desktop app. Add redirect URI: `http://localhost:53682/callback`
4. Copy client ID + secret into `.env` as `GCAL_CLIENT_ID` / `GCAL_CLIENT_SECRET`
5. Run `node src/gcal-auth.js` > open the printed URL > approve. Tokens save to `data/gcal-tokens.json`

After that, every `/event-create` is mirrored to the calendar in `config.gcal.calendarId`.

## Data Storage

All state lives in `data/` as JSON files. Back up this folder if you move hosts.

| File | Contents |
|---|---|
| `join-dates.json` | Member join dates for seniority tracking |
| `tickets.json` | Open ticket state |
| `cc-checklist.json` | Pending CC rank updates |
| `applications.json` | Application state |
| `polls.json` | Active poll state |
| `gcal-tokens.json` | Google Calendar OAuth tokens |

## Troubleshooting

- **Role buttons do nothing when clicked** — the bot's role sits below the role it's trying to assign. In Server Settings > Roles, drag the bot's role above every role it hands out.
- **Slash commands don't appear** — they register per-server on startup. Restart the bot and wait a minute, then type `/` in your server.
- **No welcome message** — Server Members Intent isn't enabled (Developer Portal > Bot > Privileged Gateway Intents), or the welcome channel ID is wrong.
- **"Config problems found" on startup** — a `PASTE_*` placeholder is still in `config.json`. The error tells you which one.

## Contributing

Pull requests are welcome. Keep commits focused and messages professional.

## License

All rights reserved. This bot is built for the Oath Forsaken clan.
