# Oath Forsaken — Standing Design Notes

Last updated: 2026-10-12

## UI Theme
- **Embed color:** #C0392B (12597547) — deep Zamorak red. ALL embeds use this.
- **Buttons:** Red (Danger/style 4). ALL buttons use this.
- **Theme:** Zamorak — dark red/black aesthetic. No blue/green/yellow.

## Banners
- **Style:** Real OSRS wiki art collaged in PIL (1200x300). NEVER AI-generated.
- **Border pattern:** Red squares, 19px squares with 31px gaps, on black. Top and bottom.
- **Treatment:** Red border lines, red glow, dark vignette on clan images.
- **Rules:** Don't crop the Wise Old Man's face. Keep Gielinor map full and centered on Lumby.
- **Current banners:**
  - #roles panels: various (bosses, wizards, map, etc.)
  - #clan-ranks CLAN CHAT RANKS: iron banner with sparkles
  - #clan-ranks MEMBER ROLES: clean symmetrical armor banner (no sparkles)
  - #clan-ranks Staff Roles: Zamorakian mages banner

## Copy Style
- **Voice:** Short, direct. Clan voice, not AI-sounding.
- **No em dashes** in member-facing text. Use periods or colons. Hyphens OK (rank ranges, compounds).
- **"competition"** spelled out, not "comp".
- **No bot command names** in public text.

## #clan-ranks Structure (2026-10-12)
1. CLAN CHAT RANKS — intro "Power is earned in Oath Forsaken. Here's how."
2. MEMBER ROLES — intro "Choose your path."
3. Staff Roles — intro "Those who lead the chaos."
- All use clickable role mentions (not bold text).
- Role colors match emoji icons (brightened for readability on dark bg).

## #roles Structure
- 6 panels: TYPE OF IRON → PREFERRED GAME SERVER → CLAN ROLES → PVM ROLES → SKILLING ROLES → WISE OLD MAN WEEKLY COMPS
- Button descriptions ("Please click the button...").

## Channel Rules
- View-only channels allow emoji reactions for @everyone (even when SEND_MESSAGES denied).

## API Rules
- Pace Discord API calls 15s+ apart. Stop on ANY 403.
- Always use `User-Agent: DiscordBot` header.
- Bot token + client ID via Discord Developer Portal only. NEVER in chat.
