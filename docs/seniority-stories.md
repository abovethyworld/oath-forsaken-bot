# Oath Forsaken — Seniority Rank-Up Stories

Status: DRAFT (approved "for now" 2026-10-13, not yet wired into bot)

Each seniority rank-up triggers a story ping. Separate arcs for iron and main.
No time references. Quiet menace, not shouting. Each rank = an oath forsaken.

## IRON

- **Initiate:** "Welcome, initiate. You stand before the clan with empty hands. No Grand Exchange. No trading. No one to carry you. Kneel."
- **Acolyte:** "You've learned the first truth: everything you own, you bled for. The easy path is still there, waiting. You walk past it every day. That is comfort, forsaken."
- **Bloodsworn:** "Your bank is a graveyard of hours. Every bar smelted, every herb cleaned, every drop prayed for. Your blood is on the altar — not as sacrifice, but as proof."
- **Revenant:** "You've gone a thousand kills dry. You've farmed the same boss for months for one drop. Most people would have quit. You're still here. That's what revenants do — they don't stay down."
- **Heretic:** "You don't just play ironman. You believe in it. The old gods of convenience mean nothing to you now."
- **Godslayer:** "Zamorak was a general who looked at eternity under Zaros and chose treachery, a staff, and godhood. You chose the harder path and walked it. The gods should be afraid."

## MAIN

- **Initiate:** "Welcome, initiate. Zamorak never cared about bloodlines — only strength. You're one of us now. That's all that matters."
- **Acolyte:** "The novelty wore off. You're still here. That's when it counts."
- **Bloodsworn:** "You've earned your place the same way everyone does here — by staying. The mode never mattered."
- **Revenant:** "You've watched people leave. Mains who got bored. Irons who burned out. You stayed."
- **Heretic:** "Someone asked why a main stays in an ironman clan. You didn't have an answer. You didn't need one."
- **Godslayer:** "No mode bound you. No rule chained you. You stayed because you chose to. The gods should be afraid."

## Implementation notes

- Wire into the seniority rank-up loop (currently assigns roles silently on a daily check).
- On rank-up: post story embed in #general (or designated channel), pinging the member.
- Iron vs main determined by member's application type / role (Iron Sworn vs Unbound).
- Guests don't get seniority ranks, no story needed.
