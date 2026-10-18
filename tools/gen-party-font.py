#!/usr/bin/env python3
"""Regenerate assets/party-board/font-atlas.png + .json.

Renders DejaVu Sans Bold at 44px with true baseline alignment: every
glyph records `dy`, its ink-top offset from the shared line top, so
lowercase letters sit on the baseline instead of floating at cap height.
Run from the repo root:  python3 tools/gen-party-font.py
"""
import json
from PIL import Image, ImageDraw, ImageFont

FONT_PATH = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"
SIZE = 44
CHARS = sorted(" !%&'()+,-./0123456789:?ABCDEFGHIJKLMNOPQRSTUVWXYZ[]_abcdefghijklmnopqrstuvwxyz·…")
OUT_PNG = "assets/party-board/font-atlas.png"
OUT_JSON = "assets/party-board/font-atlas.json"
ATLAS_W = 1024
PAD = 4


def main():
    font = ImageFont.truetype(FONT_PATH, SIZE)
    ascent, descent = font.getmetrics()
    tiles = []
    for ch in CHARS:
        if ch == " ":
            tiles.append({"ch": ch, "w": 0, "h": 0, "adv": round(font.getlength(ch)), "dy": 0, "img": None})
            continue
        x0, y0, x1, y1 = font.getbbox(ch, anchor="ls")
        w, h = x1 - x0, y1 - y0
        tile = Image.new("RGBA", (w, h), (0, 0, 0, 0))
        d = ImageDraw.Draw(tile)
        d.text((-x0, -y0), ch, font=font, anchor="ls", fill=(255, 255, 255, 255))
        # Tighten the dotted i/j: nudge the dot 2px closer to the stem.
        if ch in ("i", "j"):
            px = tile.load()
            rows = [r for r in range(h) if any(px[c, r][3] > 128 for c in range(w))]
            gap = next((r for r in range(rows[0], h) if not any(px[c, r][3] > 128 for c in range(w))), None)
            if gap:
                for r in range(gap - 1, rows[0] - 1, -1):
                    for c in range(w):
                        px[c, r + 2] = px[c, r]
                        if r < rows[0] + 2:
                            px[c, r] = (0, 0, 0, 0)
        tiles.append({
            "ch": ch, "w": w, "h": h,
            "adv": round(font.getlength(ch)),
            "dy": y0 + ascent,  # ink top relative to the shared line top
            "img": tile,
        })

    # Shelf-pack.
    atlas_h = PAD
    x = PAD
    row_h = 0
    positions = []
    for t in tiles:
        if t["img"] is None:
            positions.append(None)
            continue
        if x + t["w"] + PAD > ATLAS_W:
            atlas_h += row_h + PAD
            x, row_h = PAD, 0
        positions.append((x, atlas_h))
        x += t["w"] + PAD
        row_h = max(row_h, t["h"])
    atlas_h += row_h + PAD

    atlas = Image.new("RGBA", (ATLAS_W, atlas_h), (0, 0, 0, 0))
    glyphs = {}
    for t, pos in zip(tiles, positions):
        if pos is None:
            glyphs[t["ch"]] = {"x": 0, "y": 0, "w": 0, "h": 0, "adv": t["adv"], "dy": 0}
            continue
        atlas.paste(t["img"], pos, t["img"])
        glyphs[t["ch"]] = {"x": pos[0], "y": pos[1], "w": t["w"], "h": t["h"],
                           "adv": t["adv"], "dy": t["dy"]}
    atlas.save(OUT_PNG)
    with open(OUT_JSON, "w") as f:
        json.dump({"glyphs": glyphs, "size": SIZE, "ascent": ascent, "descent": descent}, f)
    print(f"wrote {OUT_PNG} ({ATLAS_W}x{atlas_h}), {len(glyphs)} glyphs, ascent={ascent} descent={descent}")


if __name__ == "__main__":
    main()
