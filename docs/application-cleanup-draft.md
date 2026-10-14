# Application Flow Cleanup — DRAFT (2026-10-13)

## Rank icon mapping (FINAL - from Gavin's image 2026-10-13)
- Initiate → Necromancer icon (black hat)
- Acolyte → Imp icon
- Devout → Skulled icon (white skull)
- Zealot → Zealot icon (NOT wrath - corrected 2026-10-13)
- Heretic → Unholy icon
- Godslayer → Destroyer icon
- Ascendant → Zamorakian icon

Discord uses these icon IMAGES with Gavin's custom rank NAMES.
In-game CC uses Jagex titles (icons locked to titles by Jagex).

## 1. Remove total-level bracket from iron applications

**Current flow (iron):**
Type pick → Age dropdown → Total-level dropdown → Modal

**New flow (iron):**
Type pick → Age dropdown → Modal (straight through)

**Code changes in `src/recruit.js`:**
- `handleAgeSelect`: for iron, call `showApplicationModal(interaction, 'iron', null, ageAnswer)` directly instead of `showTotalLevelSelect`
- Deprecate (don't delete yet): `showTotalLevelSelect`, `handleTotalSelect`, `TOTAL_LEVEL_BRACKETS`, `TOTAL_LEVEL_ROLE_IDS`
- Modal customId stays `apply:modal:<type>:none:<age>` (bracket = 'none')
- Staff review embed: remove the "**Total level:**" line (line 240)

**What stays:**
- Age verification dropdown (Discord account 30+ days)
- All modal questions (RSN, etc.)
- Approval flow (type role + Oath Forsakers + Initiate)
- Welcome DM and #general welcome

---

## 3. Seniority sync verification

After deploy, run `/sync-seniority` and verify:
- Members with old Bloodsworn/Revenant roles get correctly mapped to Devout/Zealot
- No one loses their rank in the transition (role IDs unchanged, only names)
- Rank-up stories fire with new names (devout/zealot keys)
- Check bot logs for errors

**Test accounts:** Use turtle pace alt to verify a promotion triggers correctly.

---

## 4. CC rank-up checklist (bot idea #12)

**Trigger:** Bot's automatic Discord age-rank promotion

**Flow:**
1. Member gets promoted (e.g., Acolyte → Devout) by the daily seniority loop
2. Bot posts a checklist entry in staff channel (#mod-and-notes or new #rank-checklist):
   - Member: @user
   - RSN: (from their application)
   - Old rank → New rank: Acolyte → Devout
   - In-game CC title to set: (maps to Jagex title)
   - [Done] [Hold] buttons
3. Staff updates the in-game CC rank manually
4. Staff hits [Done] → entry cleared (marked complete)
5. [Hold] → entry parked for exceptions (member on break, alt, etc.)

**Notes:**
- Bot can't see in-game CC state, so EVERY Discord promotion creates an entry
- Staff is the source of truth for in-game
- Entries persist until cleared (don't auto-expire)

**In-game title mapping** (for the checklist):
- Initiate → Necromancer
- Acolyte → Imp
- Devout → Skulled
- Zealot → Wrath (or Zealot title if he prefers)
- Heretic → Unholy
- Godslayer → Destroyer
- Ascendant → Zamorakian (hand-picked)

---

## Image/title clarification (Gavin 2026-10-13)

Discord uses the Jagex icon IMAGES he picked, but the Discord role NAMES don't have to match Jagex titles.
- Discord: "Zealot" name + wrath icon image = one combined role
- In-game CC: must use actual Jagex titles (icons locked to titles)

So Discord and in-game will have different names on some rungs. That's intentional.
