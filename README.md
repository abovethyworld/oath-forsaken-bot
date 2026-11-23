# Oath Forsaken Bot

Discord bot for the Oath Forsaken Old School RuneScape clan. It runs the
server's panels and applications, tracks strikes and tenure ranks, posts
Wise Old Man competition and profile cards, runs the team finder, and
publishes roster data for the clan website.

State lives in JSON files under `data/`. Secrets come from a `.env` file
and are never committed. `config.json` holds the server's IDs and panel
copy and is validated on startup.

## Features

- **Panels** — rules, ranks, button roles, strikes, tickets, applications,
  and the team finder, all posted by setup commands and edited in place
- **Applications** — apply buttons with a modal form, staff review, and an
  automatic welcome and rank assignment on approval
- **Strikes** — three-strike moderation with a full audit log and ban
  appeals by email
- **Tenure ranks** — seniority roles assigned daily from accrued time in
  the clan chat (Initiate through Godslayer); the sync only ever assigns
  or advances, never removes
- **Competitions** — Skill of the Week and Raid of the Week polls and
  Wise Old Man competitions, plus bounty postings
- **Profile cards** — KC, collection log, leaderboard, compare, gains,
  and luck cards rendered from Wise Old Man data
- **Team finder** — members post group PvM listings and build teams from
  the panel
- **Event calendar** — a Google Calendar is mirrored into a Discord embed;
  events are managed in Google Calendar only
- **Website data** — roster, ranks, and friends lists published as JSON
  for the clan site

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

Copy `.env.example` to `.env` and fill in the bot token and any optional
integrations (Google Calendar OAuth, Wise Old Man, SMTP, website hooks).
Everything else lives in `config.json`:

- `guildId` — your server ID (Developer Mode: Settings > Advanced > Developer Mode ON, then right-click server > Copy Server ID)
- `channels`, `roles`, `botIds` — server IDs the bot acts on
- `rankInfo`, `rules`, `strikeSystem`, `rolePanels`, `welcome`, `tickets`
  — panel copy and layout
- `seniority` and `seniorityRanks` — tenure rank roles and brackets
- `calendar` — timezone (IANA name like `America/New_York`) and the
  events channel

The bot refuses to start while `config.json` has placeholder values or
fails validation, and prints what is wrong.

## Setup Commands

Run these once in your server to post the panels:

| Command | What it posts |
|---|---|
| `/setup-roles` | Button-role panels |
| `/setup-rules` | Rules embed |
| `/setup-ranks` | Clan ranks embed |
| `/setup-strikes` | Strike system embed |
| `/setup-tickets` | Ticket panel (Report, Inquiry, Claim Reward, Become a Member) |
| `/setup-applications` | Application panel |
| `/setup-cc-checklist` | CC Rank Checklist tracker |
| `/setup-team-panel` | Find-a-team panel |

## Commands

Member commands:

| Command | What it does |
|---|---|
| `/profile` | A member's profile card |
| `/kc` | Boss kill-count card |
| `/clog` | Collection log card |
| `/leaderboard` | Clan leaderboard card |
| `/compare` | Compare two members |
| `/gains` | XP gains card |
| `/skills` | Skill levels card |
| `/pb` | Personal bests card |
| `/bounty` | Current bounties |
| `/poll` | Create a poll with live button voting |
| `/roster` | Clan roster |
| `/lore` | Clan lore entries |
| `/connect`, `/unlink` | Link or unlink a RuneScape name |
| `/help` | Command help |

Staff commands:

| Command | What it does |
|---|---|
| `/warn` | Add a strike and log it to the mod channel |
| `/strikes` | Show a member's strikes |
| `/clear-strikes` | Clear a member's strikes |
| `/sync-seniority` | Re-run the tenure rank sync now |
| `/seniority-hold` | Exempt a member from the tenure sync |
| `/reset-application` | Reset an application so the member can reapply |
| `/comp-roster` | Show or trim the competition roster |
| `/calendar-sync` | Refresh the event calendar embed now |
| `/check-permissions` | Audit channel permissions against the rules |
| `/bot-status` | Bot health and version |
| `/staff-help` | Staff command help |

## Deployment

Every push to `main` triggers a GitHub Actions build
(`.github/workflows/docker.yml`) that builds the image for amd64 + arm64
and pushes `ghcr.io/abovethyworld/oath-forsaken-bot`.

The server runs a pinned image digest, not a floating tag:

- `deploy/bot-deploy.sh` verifies a new image (config validation, module
  load, smoke tests) before pinning it
- An autodeploy timer checks for a new pin and restarts the bot onto it
- `deploy/bot-rollback.sh` returns to the previous pin
- Old pins are kept so any recent version can be restored

**Running with Docker:**

```bash
docker run -d --name oath-forsaken-bot \
  --env-file /path/to/.env \
  -v /path/to/data:/app/data \
  ghcr.io/abovethyworld/oath-forsaken-bot:latest
```

- Secrets come from `--env-file` (bot token, Google credentials)
- `/app/data` is mounted as a volume so membership, tenure, tickets,
  strikes, and checklist state survive updates
- `config.json` and `src/` are baked into the image, so config edits ship
  the same way as code

systemd units for the bot and the autodeploy timer are in `deploy/`.

## Google Calendar Setup

1. [Google Cloud Console](https://console.cloud.google.com) > new project > enable **Google Calendar API**
2. **OAuth consent screen** > External > fill in app name + your email > add yourself as a test user
3. **Credentials** > Create Credentials > **OAuth client ID** > Desktop app. Add redirect URI: `http://localhost:53682/callback`
4. Copy client ID + secret into `.env` as `GCAL_CLIENT_ID` / `GCAL_CLIENT_SECRET`
5. Run `node src/gcal-auth.js` > open the printed URL > approve. Tokens save to `data/gcal-tokens.json`

After that, the calendar in `config.calendar.calendarId` is mirrored
into the events channel embed. Events are created and edited in Google
Calendar; the bot never writes back.

## Data Storage

All state lives in `data/` as JSON files. Back up this folder if you
move hosts. The load-bearing files:

| File | Contents |
|---|---|
| `membership.json` | Member standing recorded at approval |
| `tenure.json` | Accrued time in the clan chat per member |
| `seniority.json` | Published ranks, read by the website |
| `seniority-assigned.json` | Every member the rank sync has ranked |
| `strikes.json` | Strike records |
| `tickets.json` | Open ticket state |
| `cc-checklist.json` | Pending CC rank updates |
| `polls.json` | Active poll state |
| `teams.json` | Team finder listings |
| `gcal-tokens.json` | Google Calendar OAuth tokens |

## Troubleshooting

- **Role buttons do nothing when clicked** — the bot's role sits below the role it's trying to assign. In Server Settings > Roles, drag the bot's role above every role it hands out.
- **Slash commands don't appear** — they register per-server on startup. Restart the bot and wait a minute, then type `/` in your server.
- **No welcome message** — Server Members Intent isn't enabled (Developer Portal > Bot > Privileged Gateway Intents), or the welcome channel ID is wrong.
- **"Config problems found" on startup** — a `PASTE_*` placeholder is still in `config.json`, or a rank ID does not match the rank brackets. The error tells you which one.

## Contributing

Pull requests are welcome. Keep commits focused and messages professional.

## License

MIT. See [LICENSE](LICENSE).
