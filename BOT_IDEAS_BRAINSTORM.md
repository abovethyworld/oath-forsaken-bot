# Bot Ideas — Brainstorm (2026-10-12)

Gavin's ideas, fleshed out. No actions taken — all need his go-ahead.

## 1. Welcome ping in welcome chat — PARTIALLY LIVE (2026-10-13)

**Status:** Welcome embed posts in #general on join (live). Oath Forsakers role auto-assign on join (live). BUT the Staff ping on join is NOT live: `logMembership()` in welcome.js has the code (join/leave embed + Staff ping in #joins-and-leaves) but index.js never calls it — it defers to Sapphire, and Sapphire's #joins-and-leaves logs do NOT ping Staff (verified 2026-10-13: 10 recent Sapphire join/leave embeds, zero pings).

**To finish:** wire `logMembership(member, true)` into the GuildMemberAdd handler in index.js (one line). Then Staff gets pinged on every join.

**DECLINED 2026-10-13 (Gavin):** he doesn't want join pings — staff already gets pinged when someone submits an application, so a join ping is redundant noise. Leaving as-is.

**Notes:**
- Ping should be Staff role, not @everyone
- Could include their join date, account age (alt detection) — already in the embed
- Risk: ping fatigue if lots of joins. Consider only pinging during certain hours or batching.

## 2. Revisit the auto DM — DONE (2026-10-13)

**Outcome:** Reworked by simplification. The welcome DM is now unified across all types and minimal: "⛧ Welcome to Oath Forsaken ⛧ / Your application was approved." The #general post carries the channel links and impact instead.

**Standing rule (Gavin's words):** the bot never DMs anyone without his explicit permission. Approved DMs: application-approved welcome, deny-with-reason. (Saved to MEMORY.md Boundaries.)

## 3. Auto-announce rank ups in general — DEAD (2026-10-13)

**Killed by the age-ranks-only decision.** No gem ranks, no announcements for them.

## 4. Ticket transcripts

**Idea:** When a ticket closes, export the transcript.

**Notes:**
- Options: HTML file, plain text, or post to a staff-only #transcripts channel
- Should include timestamps, usernames, all messages
- Useful for appeals, disputes, accountability
- discord-html-transcripts is the standard npm package for this

## 5. WOM total level → auto role — DEAD (2026-10-13)

**Killed by the age-ranks-only decision.** No WOM polling, no total-level roles.

## 6. Multi-type ticket buttons (like EG) — DONE (built 2026-10-11)

**Live:** #contact-staff panel has four buttons (Report, Inquiry, Claim Reward, Become a Member). Each opens a private thread; a category dropdown inside the thread labels it (Report a Member, General Query, Bot/Plugin Help) and renames the thread.

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

## 13. WOM-verified total level on approval — DEAD (2026-10-13)

**Killed by the age-ranks-only decision.**

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
- Bot detects seniority (age) rank-up, updates the Discord role, announces in #general with the rank story
- Bot adds entry to a persistent checklist embed in a staff channel
- Staff updates the CC rank in-game, marks it done, bot removes the entry
- One glance shows everything pending — no hunting through old messages
- Alternatives considered: per-message button, reaction ✅, threads, daily digest, escalation pings, no tracking

- **Rank hold (2026-10-13):** staff-controlled. If a member wants to stay at their current rank, staff marks them as "held" in the checklist and the bot stops listing them for promotion. Staff can unhold later if they change their mind.

- **Hold UI (2026-10-13):** simple "Hold" button per checklist entry (not a dropdown). Holds are rare, so no need for the extra complexity. Staff clicks Hold, bot stops listing them.

## Onboarding: WOM-verified total level rank on approval (2026-10-13)

Gavin's idea (tentative): during the application, bot does a WOM API lookup on the applicant's RSN. When staff clicks approve, bot auto-assigns the total level rank based on WOM data — not what the applicant typed. Catches liars. If the RSN doesn't exist on WOM, flag it for staff.

- **Build timing (2026-10-13):** Gavin wants the WOM onboarding integration built early while volume is low, so it's tested and ready before applications pick up. Not yet approved to build — waiting on his go-ahead.

## 14. Auto-nickname on approval — BUILT (2026-10-14, Gavin's idea)

**Live:** when staff approves an application, the bot auto-sets the member's nickname to `{nickname} [{first RSN}]` (e.g. `Gavin [PTstud]`). Answers are saved at submit time and read on approval. Trims the nickname part if the combo exceeds Discord's 32-char limit; fails silently if the bot can't rename (owner, higher roles).
- **Emoji fix 2026-10-14:** the ❌ (U+274C) on the Deny button rendered as invisible text on some clients. Adding U+FE0F made Discord's API reject it outright (broke the apply button with Invalid Form Body). Switched both spots to ✖️ (U+2716+FE0F), which Discord accepts and renders as a proper X. Tested via API before deploying.

## 15. Staff pings on applications + tickets — BUILT, QUIET UNTIL LAUNCH (2026-10-14, Gavin's call)

- New application submitted → bot posts "@Staff New Ironman application from @user" in the forum thread.
- Ticket opened → @Staff added to the ticket ping list (was already pinging Lord of Chaos + Warmonger). Staff role added to tickets.staffRoleIds, so Staff members also get added to ticket threads and count as staff for ticket buttons.
- **Quiet until launch (Gavin 2026-10-14):** no legit (notifying) pings till live. The mentions render in the messages but allowedMentions doesn't parse roles, so nobody gets buzzed. At launch, flip allowedMentions to include roles for real pings.

## Application flow testing — ALL PASS (2026-10-14)

Tested with turtlepace7 alt, all 3 types:
- Ironman → Accept: roles (Iron Sworn + Initiate) assigned, Initiate welcome in #general, auto-nickname set (gavin [ptstud])
- Main → Deny with Reason: reason stamped on post, DM sent to applicant, thread locked/archived
- Guest → Deny: quiet deny, no DM
- Quiet Staff pings render in forum threads without notifying

## Ticket theming — BUILT (2026-10-14, Gavin's call)

Every ticket is themed to the button clicked:
- Report → "⚠️ Report", thread named "Report — user", intro asks for names/dates/proof
- Inquiry → "💬 Inquiry", thread named "Inquiry — user"
- Claim Reward → "🏆 Reward Claim", thread named "Reward Claim — user", intro asks what event
- Become a Member → "⬆️ Membership Request", thread named "Membership Request — user", intro asks ironman or main, skips the category picker

## Ticket patch 2026-10-14 (after testing all 4 types)

- Category picker removed from all ticket types (redundant now that the button picks the type). Dead handleTicketSelect code cleaned out.
- Membership Request now guides the user: "Reply with: Your in-game name / Ironman or main / How you found us"
- Close Ticket button fixed: was silently swallowing archive errors after a 3s delay. Now archives immediately and reports errors.
- Closing is staff-only (Gavin's call 2026-10-14). Ticket owners can no longer close their own.

## Become a Member direct promotion — BUILT (2026-10-14, Gavin's call)

No ticket. Guest clicks Become a Member → dropdown (Ironman/Main) → bot strips Guest, adds Iron Sworn/Unbound + Initiate, posts Initiate welcome in #general. Staff sees the #general post and meets them in-game for the CC invite. Non-guests get told they're already members. If someone plays both, they pick their primary; staff can add the second role by hand.
- Guest welcome now ends: "Like what you see? To become an official member, hit Become a Member in #contact-staff"
- #contact-staff panel rewritten in his voice (straightforward lines, no ticket language for Become a Member)

## Guest seniority bug — FIXED (2026-10-14, Gavin caught it)

The seniority sync was assigning Initiate to guests based on join date. Guests should never have seniority roles. Fixed syncSeniority to skip anyone with the Guest role. Cleaned the one affected guest (turtlepace7).

## Become a Member promotion testing — ALL PASS (2026-10-14)

- Main path: Guest → Unbound + Initiate, #general welcome posted ✓
- Ironman path: Guest → Iron Sworn + Initiate, #general welcome posted ✓
- Dropdown uses Iron Sworn / Unbound custom emojis ✓
- Warm verbiage: "so we can get to meet you" (Gavin's call — warmth over tightness in welcomes)

## Ticket system testing — ALL PASS (2026-10-14)

- All 4 buttons open themed threads, no category picker ✓
- Close button: staff-only, posts "Staff has closed this ticket. Don't be afraid to reach out if you need anything else." in thread, archives/locks, staff gets quiet "Ticket closed." ✓
- Become a Member: direct promotion, no ticket (iron → Iron Sworn, main → Unbound, both + Initiate, #general welcome) ✓
- Test threads cleaned up ✓
