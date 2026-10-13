# Bot Ideas — Brainstorm (2026-10-12)

Gavin's ideas, fleshed out. No actions taken — all need his go-ahead.

## 1. Welcome ping in welcome chat

**Idea:** When someone joins, bot posts in a welcome channel and pings the Staff role so someone reviews them.

**Notes:**
- Need a dedicated #welcome channel (or reuse #joins-and-leaves?)
- Ping should be Staff role, not @everyone
- Could include their join date, account age (alt detection)
- Risk: ping fatigue if lots of joins. Consider only pinging during certain hours or batching.

## 2. Revisit the auto DM

**Idea:** Review what the bot DMs to new members on join.

**Notes:**
- Need to see current DM text first (check src/)
- Should match the new "New here?" flow: apply → approve → grab roles
- Keep it short. Link #rules, #apply-here.
- Don't duplicate what's already in #apply-here welcome panel.

## 3. Auto-announce rank ups in general

**Idea:** When someone ranks up (total level), bot announces in #general. Only for ranks above the first one (so no announcement for Wizard, but yes for Necromancer+).

**Notes:**
- "Above the first time rank" = skip Wizard [0-499], announce everything else
- Could include their old rank → new rank, total level
- Cooldown to avoid spam if someone jumps multiple ranks at once
- This is great for engagement — people love public recognition

## 4. Ticket transcripts

**Idea:** When a ticket closes, export the transcript.

**Notes:**
- Options: HTML file, plain text, or post to a staff-only #transcripts channel
- Should include timestamps, usernames, all messages
- Useful for appeals, disputes, accountability
- discord-html-transcripts is the standard npm package for this

## 5. WOM total level → auto role

**Idea:** Bot checks Wise Old Man API for a member's total level and auto-assigns the matching rank role.

**Notes:**
- This is the big one. WOM API is free: https://api.wiseoldman.net/v2/players/{username}
- Flow: member links RSN → bot polls WOM periodically → assigns role based on total level brackets
- Need to handle: name changes, unranked players, API downtime
- Should it remove old rank when they level up? Yes, keep only current.
- Frequency: daily check is probably enough (not real-time)
- This replaces manual rank assignment entirely

## 6. Multi-type ticket buttons (like EG)

**Idea:** #contact-staff gets three buttons: Report, Inquiry, Claim Reward — instead of one generic ticket.

**Notes:**
- Report → for rule violations, goes to mods (Inquisitor+)
- Inquiry → general questions, goes to all staff
- Claim Reward → for event/bingo winnings, goes to Ritualist+
- Each creates a differently-labeled ticket channel
- Deferred from earlier — needs bot code changes + testing
- This is a bigger build. Probably after the GitHub migration so Ashton/Nick can help.

## 7. Hidden main channels

**Idea:** When someone applies as a main (Unbound), they get access to hidden main-only channels. One would be for gear collateral/lending.

**Notes:**
- Need a "Main" flag on the user (from application type)
- Channels: #main-gear-collat, maybe #main-chat?
- Gear collat channel: for mains to coordinate lending with collateral (ties into Rule 2)
- Permissions: only visible to Unbound role holders + staff
- Could also gate by verification (linked RSN is actually a main?)

## 8. Comp history tracker

**Idea:** Record every SOTW/BOTW/ROTW comp with its time period so staff don't repeat events.

**Notes:**
- Auto-log when comp ends: type, skill/boss/raid, start/end dates, winners
- `/comp-history` to browse, `/comp-history search [skill]` for "when did we last do X?"
- Warn when starting a comp if that skill/boss ran recently
- Open question: auto-log vs manual `/comp-log`? Auto is cleaner, manual is simpler v1

## 9. Ko-fi donations (Ashton's idea 2026-10-12)

**Idea:** Ko-fi page for clan donations → PayPal. Use for bonds (bingo prizes), server costs, event rewards.

**Notes:**
- Ko-fi takes 0% on tips (PayPal/Stripe take their normal cut)
- Separate clan PayPal account recommended — keeps clan money clean, trust/transparency
- ko-fi.com/features

## 10. Test bot + branch workflow (Ashton's idea 2026-10-12)

**Idea:** Test branch + test bot so changes get verified before hitting the real bot.

**Notes:**
- Workflow: feature branch → PR review → merge to `test` → test bot → merge to `main` → real bot
- Needs: second bot app in Discord Developer Portal (test bot token), `test` branch, Ashton's Dockerfile + CI
- AI coding agent handles code + pushes; Gavin approves merges; Ashton handles infra

## 11. Google Calendar → Discord event embed (Gavin's idea 2026-10-12)

**Idea:** Bot reads the "Oath Forsaken Event Calendar" from Google Calendar and posts an auto-updating embed in #event-calendar, like RW's Raven bot does.

**Notes:**
- Pulls events for next 2 weeks: name, start/end dates, description
- Zamorak-themed embed (not RW's purple look), "View Calendar" button
- Auto-updates daily or on `/calendar-sync`
- Calendar API key obtained 2026-10-12 (restricted to Calendar API only)
- Needs: Calendar API wired into bot code, embed template, scheduled job
- V2 — after core bot ideas are done

**Idea:** Test branch + test bot so changes get verified before hitting the real bot.

**Notes:**
- Workflow: feature branch → PR review → merge to `test` → test bot → merge to `main` → real bot
- Needs: second bot app in Discord Developer Portal (test bot token), `test` branch, Ashton's Dockerfile + CI
- AI coding agent handles code + pushes; Gavin approves merges; Ashton handles infra

---

## 12. CC rank-up checklist (designed 2026-10-13, not built)

**Idea:** Staff can't be expected to remember who needs an in-game CC rank update. The bot keeps a persistent checklist.

**Finalized design (2026-10-13):** The bot's automatic Discord age-rank promotion is the trigger. When tenure crosses a threshold, the bot promotes the member in Discord AND drops a checklist entry in a staff channel: name, RSN (from their application), old rank → new rank. Staff updates the rank in-game, hits a button to clear the entry. A hold button covers exceptions (staff can hold someone so they don't get listed). The bot can't see in-game CC state (no API), so every Discord promotion creates an entry and staff clears it.

**Notes:**
- Persistent staff-only embed, staff-controlled hold button (simple button, not dropdown — Gavin's call)
- Awaiting go-ahead to build

---

## 13. WOM-verified total level on approval (tentative 2026-10-13, NOT approved)

**Idea:** When staff approves an ironman application, the bot checks the applicant's total level via Wise Old Man and assigns the right total-level rank automatically.

**Notes:**
- Tentative only — Gavin has not approved this
- May be dead if the clan moves to age ranks only (Ashton's one-rank-system push 2026-10-13)

---

## Gavin's Todo — For Ashton & Nick (Bot)

Things Gavin needs to do to unblock the dev team:

- [x] Create private GitHub repo for the bot (done 2026-10-12)
- [x] Invite Ashton as collaborator (done 2026-10-12)
- [x] Invite Nick as collaborator (done 2026-10-12)
- [x] Push current bot code to the repo (done 2026-10-12)
- [x] Share bot token with Ashton/Nick via Discord DM (done 2026-10-12)
- [ ] Create test bot application in Discord Developer Portal (for test branch workflow) — app created 2026-10-12, on oathbreakers team (token + invite URL pending)
- [x] Create `test` branch in repo (done 2026-10-12)
- [ ] Get clan-holder alt to total level 150 (for CC ownership transfer)
- [x] Create clan Google account (done 2026-10-12 — Drive + Calendar working, "Oath Forsaken Event Calendar" created, Ashton added as Editor)
- [x] Set up Ko-fi page + separate clan PayPal account (done 2026-10-12 — page live at ko-fi.com/oathforsaken, PayPal + Stripe connected, Google Voice number for Stripe, separate PayPal deferred until donations come in)
- [ ] Scope bot permissions down from Administrator to read/write text only
- [ ] Optional: purchase oathforsaken.cc domain

Once the repo is up, Ashton can start the Dockerfile + CI pipeline, and Nikolai can set up hosting.

## CC rank-up tracking — decision 2026-10-13

Gavin picked the **persistent checklist** approach for tracking in-game CC rank-ups:
- Bot detects total level rank-up via WOM, updates Discord role, announces in #general
- Bot adds entry to a persistent checklist embed in a staff channel
- Staff updates the CC rank in-game, marks it done, bot removes the entry
- One glance shows everything pending — no hunting through old messages
- Alternatives considered: per-message button, reaction ✅, threads, daily digest, escalation pings, no tracking

- **Rank hold (2026-10-13):** staff-controlled. If a member wants to stay at their current rank, staff marks them as "held" in the checklist and the bot stops listing them for promotion. Staff can unhold later if they change their mind.

- **Hold UI (2026-10-13):** simple "Hold" button per checklist entry (not a dropdown). Holds are rare, so no need for the extra complexity. Staff clicks Hold, bot stops listing them.

## Onboarding: WOM-verified total level rank on approval (2026-10-13)

Gavin's idea (tentative): during the application, bot does a WOM API lookup on the applicant's RSN. When staff clicks approve, bot auto-assigns the total level rank based on WOM data — not what the applicant typed. Catches liars. If the RSN doesn't exist on WOM, flag it for staff.

- **Build timing (2026-10-13):** Gavin wants the WOM onboarding integration built early while volume is low, so it's tested and ready before applications pick up. Not yet approved to build — waiting on his go-ahead.
