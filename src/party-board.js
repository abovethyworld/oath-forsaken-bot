// Party board renderer: draws the OSRS-style combat-stat board as a PNG
// with zero native dependencies (pure JS, keeps the Docker build portable).
// Assets in assets/party-board/: 8 real OSRS skill icons + a pre-rendered
// bitmap font atlas (generated once with PIL, see /tmp/party-mockups/gen-atlas.py).
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ASSET_DIR = path.join(__dirname, '..', 'assets', 'party-board');

// Column order: combat, attack, strength, ranged, magic, defence, hitpoints, prayer.
const COLUMNS = ['combat', 'attack', 'strength', 'ranged', 'magic', 'defence', 'hitpoints', 'prayer'];

const BOARD_W = 1630;
const NAME_W = 520;
const COL_W = 106;
const KC_COL_W = 220;
const HEADER_H = 96;
const ICON_SIZE = 60;


// Crop an icon to its ink bounding box (+pad) so thin shapes like weapons
// fill the box they're drawn in instead of floating in empty canvas.
function inkCrop(icon, pad = 2) {
  const { w, h, rgba } = icon;
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (rgba[(y * w + x) * 4 + 3] > 10) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  if (x1 < 0) return icon; // fully transparent: leave alone
  x0 = Math.max(0, x0 - pad); y0 = Math.max(0, y0 - pad);
  x1 = Math.min(w - 1, x1 + pad); y1 = Math.min(h - 1, y1 + pad);
  const cw = x1 - x0 + 1, ch = y1 - y0 + 1;
  const out = Buffer.alloc(cw * ch * 4);
  for (let y = 0; y < ch; y++) {
    rgba.copy(out, y * cw * 4, ((y0 + y) * w + x0) * 4, ((y0 + y) * w + x0 + cw) * 4);
  }
  return { w: cw, h: ch, rgba: out };
}
const MAX_ROWS = 12;
const MAX_NAME_CHARS = 14;

// ─── CRC32 ──────────────────────────────────────────────────────────
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

// ─── Minimal PNG encode (8-bit RGBA, filter 0) ──────────────────────
function encodePng(w, h, rgba) {
  const stride = w * 4;
  const raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 6 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
  return png;
}

// ─── Minimal PNG decode (8-bit, RGBA or RGB, non-interlaced) ────────
function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

function decodePng(buf) {
  let pos = 8;
  let w, h, colorType;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      w = data.readUInt32BE(0);
      h = data.readUInt32BE(4);
      if (data[8] !== 8) throw new Error('Only 8-bit PNG supported');
      colorType = data[9];
      if (data[12] !== 0) throw new Error('Interlaced PNG not supported');
      if (colorType !== 6 && colorType !== 2) throw new Error(`Unsupported color type ${colorType}`);
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
    pos += 12 + len;
  }
  const bpp = colorType === 6 ? 4 : 3;
  const stride = w * bpp;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const out = Buffer.alloc(w * h * 4);
  let p = 0;
  for (let y = 0; y < h; y++) {
    const filter = raw[p++];
    // prev(yy, xx): already-decoded byte at scanline yy, byte offset xx.
    const prev = (yy, xx) => (yy < 0 ? 0 : out[yy * stride + xx]);
    for (let x = 0; x < stride; x++) {
      const cur = raw[p++];
      const aV = x >= bpp ? prev(y, x - bpp) : 0;
      const bV = prev(y - 1, x);
      const cV = x >= bpp ? prev(y - 1, x - bpp) : 0;
      let v;
      if (filter === 0) v = cur;
      else if (filter === 1) v = cur + aV;
      else if (filter === 2) v = cur + bV;
      else if (filter === 3) v = cur + ((aV + bV) >> 1);
      else v = cur + paeth(aV, bV, cV);
      out[y * stride + x] = v & 0xff;
    }
  }
  // Expand RGB to RGBA.
  let rgba;
  if (bpp === 4) {
    rgba = out;
  } else {
    rgba = Buffer.alloc(w * h * 4);
    for (let i = 0; i < w * h; i++) {
      rgba[i * 4] = out[i * 3];
      rgba[i * 4 + 1] = out[i * 3 + 1];
      rgba[i * 4 + 2] = out[i * 3 + 2];
      rgba[i * 4 + 3] = 255;
    }
  }
  return { w, h, rgba };
}

// ─── Asset loading (lazy, cached) ───────────────────────────────────
let atlas = null; // { img, glyphs }
let atlasSmall = null; // 22px variant for labels

const SPEC_LABELS = {
  bgs: 'BGS', dwh: 'DWH', eldermaul: 'ELDER MAUL', tonalztics: 'TONALZTICS',
  accursed: 'ACCURSED', emberlight: 'EMBERLIGHT', crystalhalberd: 'C HALBERD',
  eyeofayak: 'EYE OF AYAK', soulflame: 'SOULFLAME', zcb: 'ZCB',
  voidwaker: 'VOIDWAKER', dragonclaws: 'D CLAWS', burningclaws: 'B CLAWS',
  webweaver: 'WEBWEAVER', crimsonkisten: 'KISTEN', sgs: 'SGS', zgs: 'ZGS', dinhs: "DINH'S",
};
const icons = {}; // name -> { w, h, rgba }
const specIcons = {}; // spec id -> { w, h, rgba }
const bossIcons = {}; // WOM metric -> { w, h, rgba }
const badgeIcons = {}; // badge id -> { w, h, rgba }
// Badge ids: iron, hc, ult, gim, hcgim, main, ironsworn.
const BADGE_IDS = ['ironman', 'hc', 'ult', 'gim', 'hcgim', 'main', 'ironsworn'];
const SPEC_IDS = ['bgs', 'dwh', 'eldermaul', 'tonalztics', 'accursed', 'crystalhalberd', 'emberlight', 'eyeofayak', 'soulflame', 'zcb', 'voidwaker', 'dragonclaws', 'burningclaws', 'webweaver', 'crimsonkisten', 'sgs', 'zgs', 'dinhs'];

function loadAssets() {
  if (atlas) return;
  try {
    const atlasImg = decodePng(fs.readFileSync(path.join(ASSET_DIR, 'font-atlas.png')));
    const glyphs = JSON.parse(fs.readFileSync(path.join(ASSET_DIR, 'font-atlas.json'), 'utf8')).glyphs;
    atlas = { img: atlasImg, glyphs };
  } catch (err) {
    throw new Error(`party-board: main font atlas failed to load: ${err.message}`);
  }
  try {
    const smallImg = decodePng(fs.readFileSync(path.join(ASSET_DIR, 'font-atlas-small.png')));
    const smallGlyphs = JSON.parse(fs.readFileSync(path.join(ASSET_DIR, 'font-atlas-small.json'), 'utf8')).glyphs;
    atlasSmall = { img: smallImg, glyphs: smallGlyphs };
  } catch {
    atlasSmall = null; // labels fall back to the main atlas
  }
  for (const name of COLUMNS) {
    icons[name] = decodePng(fs.readFileSync(path.join(ASSET_DIR, 'icons', `${name}.png`)));
  }
  // Skilling icons for the minigame board (single level column).
  for (const name of ['firemaking', 'runecraft', 'fishing', 'mining', 'agility']) {
    try {
      icons[name] = decodePng(fs.readFileSync(path.join(ASSET_DIR, 'icons', `${name}.png`)));
    } catch {
      // icon missing: that minigame board just won't draw
    }
  }
  for (const id of SPEC_IDS) {
    try {
      specIcons[id] = inkCrop(decodePng(fs.readFileSync(path.join(ASSET_DIR, 'spec-icons', `${id}.png`))));
    } catch {
      // icon missing: that spec just won't draw
    }
  }
  // Account badge icons (clan emojis) for the name column.
  for (const id of BADGE_IDS) {
    try {
      badgeIcons[id] = decodePng(fs.readFileSync(path.join(ASSET_DIR, 'badge-icons', `${id}.png`)));
    } catch {
      // badge missing: that badge just won't draw
    }
  }
  // WOM boss icons for the KC column header.
  try {
    for (const f of fs.readdirSync(path.join(ASSET_DIR, 'boss-icons'))) {
      if (!f.endsWith('.png')) continue;
      try {
        bossIcons[f.slice(0, -4)] = decodePng(fs.readFileSync(path.join(ASSET_DIR, 'boss-icons', f)));
      } catch {
        // icon missing: KC header falls back to text
      }
    }
  } catch {
    // no boss-icons dir: KC header falls back to text
  }
}

// WOM metric key -> boss icon key (strip raid mode suffixes).
function bossIconKey(metric) {
  // All boss icons now exist (including hard-mode variants), so the key
  // maps directly to the file name.
  return String(metric || '');
}

// ─── Drawing ────────────────────────────────────────────────────────
function newCanvas(w, h, r, g, b) {
  const buf = Buffer.alloc(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    buf[i * 4] = r; buf[i * 4 + 1] = g; buf[i * 4 + 2] = b; buf[i * 4 + 3] = 255;
  }
  return { w, h, buf };
}

function blit(dst, src, dx, dy, tint) {
  for (let y = 0; y < src.h; y++) {
    const ty = dy + y;
    if (ty < 0 || ty >= dst.h) continue;
    for (let x = 0; x < src.w; x++) {
      const tx = dx + x;
      if (tx < 0 || tx >= dst.w) continue;
      const si = (y * src.w + x) * 4;
      const sa = src.rgba[si + 3] / 255;
      if (sa === 0) continue;
      const di = (ty * dst.w + tx) * 4;
      const tr = tint ? tint[0] : 255;
      const tg = tint ? tint[1] : 255;
      const tb = tint ? tint[2] : 255;
      dst.buf[di] = Math.round((src.rgba[si] / 255 * tr) * sa + dst.buf[di] * (1 - sa));
      dst.buf[di + 1] = Math.round((src.rgba[si + 1] / 255 * tg) * sa + dst.buf[di + 1] * (1 - sa));
      dst.buf[di + 2] = Math.round((src.rgba[si + 2] / 255 * tb) * sa + dst.buf[di + 2] * (1 - sa));
    }
  }
}

// Draw an icon centered at (cx, cy), nearest-neighbor scaled so its
// largest side is `size` px.
function drawIcon(dst, icon, cx, cy, size) {
  if (!icon) return;
  const scale = size / Math.max(icon.w, icon.h);
  const dw = Math.max(1, Math.round(icon.w * scale));
  const dh = Math.max(1, Math.round(icon.h * scale));
  const scaled = { w: dw, h: dh, rgba: Buffer.alloc(dw * dh * 4) };
  for (let y = 0; y < dh; y++) {
    for (let x = 0; x < dw; x++) {
      const si = ((y / scale | 0) * icon.w + (x / scale | 0)) * 4;
      const di = (y * dw + x) * 4;
      scaled.rgba[di] = icon.rgba[si];
      scaled.rgba[di + 1] = icon.rgba[si + 1];
      scaled.rgba[di + 2] = icon.rgba[si + 2];
      scaled.rgba[di + 3] = icon.rgba[si + 3];
    }
  }
  blit(dst, scaled, Math.round(cx - dw / 2), Math.round(cy - dh / 2));
}

function drawText(dst, x, y, str, tint, a) {
  // y = top of the text line. Returns advance width.
  loadAssets();
  const at = a || atlas;
  let cx = x;
  for (const ch of str) {
    const g = at.glyphs[ch] || at.glyphs['?'];
    if (!g) { cx += 20; continue; }
    if (ch !== ' ') {
      const glyph = {
        w: g.w, h: g.h,
        rgba: Buffer.alloc(g.w * g.h * 4),
      };
      for (let gy = 0; gy < g.h; gy++) {
        for (let gx = 0; gx < g.w; gx++) {
          const si = ((g.y + gy) * at.img.w + (g.x + gx)) * 4;
          const di = (gy * g.w + gx) * 4;
          glyph.rgba[di] = at.img.rgba[si];
          glyph.rgba[di + 1] = at.img.rgba[si + 1];
          glyph.rgba[di + 2] = at.img.rgba[si + 2];
          glyph.rgba[di + 3] = at.img.rgba[si + 3];
        }
      }
      blit(dst, glyph, cx, y + (g.dy || 0), tint);
    }
    cx += g.adv;
  }
  return cx - x;
}

function textWidth(str, a) {
  loadAssets();
  const at = a || atlas;
  let w = 0;
  for (const ch of str) {
    const g = at.glyphs[ch] || at.glyphs['?'];
    w += g ? g.adv : 20;
  }
  return w;
}

function drawCentered(dst, cx, y, str, tint) {
  drawText(dst, Math.round(cx - textWidth(str) / 2), y, str, tint);
}

function hline(dst, y, x0, x1, r, g, b, thickness) {
  for (let t = 0; t < thickness; t++) {
    for (let x = x0; x < x1; x++) {
      const i = ((y + t) * dst.w + x) * 4;
      dst.buf[i] = r; dst.buf[i + 1] = g; dst.buf[i + 2] = b;
    }
  }
}

function shortDisplayName(name) {
  const s = String(name || 'member');
  return s.length > MAX_NAME_CHARS ? `${s.slice(0, MAX_NAME_CHARS - 1)}…` : s;
}

// rows: [{ name, stats: [cb,atk,str,rng,mag,def,hp,pry] | null, specs: [specId] }]
// extraCount: members beyond MAX_ROWS not shown.
// Layout: line 1 has badge + name + stats; below it, spec-weapon icons
// stacked by category (Defense Lowering, Offensive, Utility), each with
// a small header. Row height grows with the number of non-empty groups.
const SPEC_CAT_ORDER = [
  ['DEFENSE LOWERING', ['bgs', 'dwh', 'eldermaul', 'tonalztics', 'accursed', 'crystalhalberd', 'emberlight', 'eyeofayak']],
  ['OFFENSIVE', ['soulflame', 'zcb', 'voidwaker', 'dragonclaws', 'burningclaws', 'webweaver', 'crimsonkisten']],
  ['UTILITY', ['sgs', 'zgs', 'dinhs']],
];
const GROUP_H = 160;
// Compact mode (hidden for now): one short row per member, no spec
// icons. For dense teams where the full board gets too tall.
const COMPACT_ROW_H = 68;
function specGroupsFor(specs) {
  const known = (specs || []).filter((id) => specIcons[id]);
  return SPEC_CAT_ORDER
    .map(([catName, catIds]) => [catName, known.filter((id) => catIds.includes(id))])
    .filter(([, ids]) => ids.length);
}
function rowHeightFor(specs) {
  return 62 + specGroupsFor(specs).length * GROUP_H;
}
const BADGE_H = 48;
function renderPartyBoard(rows, extraCount, opts = {}) {
  loadAssets();
  if (!rows.length) return null;
  const compact = !!opts.compact;
  const shown = rows.slice(0, MAX_ROWS);
  // Skill mode (minigame boards): a single skill level column instead of the
  // combat stat columns, no spec rows. The row stats array holds one value.
  const columns = opts.skill ? [opts.skill] : COLUMNS;
  const statsW = COL_W * columns.length;
  // KC columns: [{ icon: 'metric_key' }] or [{ label: 'Text' }]. Defaults to
  // the legacy single bossIcon column.
  const kcCols = opts.kcColumns || (opts.bossIcon ? [{ icon: opts.bossIcon }] : []);
  const kcColW = kcCols.length > 1 ? 260 : KC_COL_W;
  const kcW = kcColW * kcCols.length;
  // Optional clog column (minigame boards): RuneProfile page counts.
  const clogW = opts.clogColumn ? KC_COL_W : 0;
  const gridW = NAME_W + statsW + kcW + clogW;
  // A slim board for skill mode: no wide margins, grid fills the canvas.
  const boardW = opts.skill ? gridW + 48 : BOARD_W - KC_COL_W + kcW + clogW;
  const ox = Math.round((boardW - gridW) / 2);
  const kcCx = (i) => ox + NAME_W + statsW + kcColW * i + kcColW / 2;
  const clogCx = ox + NAME_W + statsW + kcW + KC_COL_W / 2;
  const footerH = extraCount > 0 ? 56 : 24;
  const H = compact
    ? HEADER_H + COMPACT_ROW_H * shown.length + footerH
    : HEADER_H + shown.reduce((a, r) => a + rowHeightFor(r.specs), 0) + footerH;
  const cv = newCanvas(boardW, H, 26, 18, 16);

  // Icon header. Each KC column gets its boss icon (WOM's) or a text
  // label, falling back to "KC" when neither is set.
  const cy = HEADER_H / 2;
  columns.forEach((name, i) => {
    const cx = ox + NAME_W + COL_W * i + COL_W / 2;
    drawIcon(cv, icons[name], cx, cy, ICON_SIZE);
  });
  kcCols.forEach((col, i) => {
    const cx = kcCx(i);
    const icon = col.icon && bossIcons[bossIconKey(col.icon)];
    if (icon) drawIcon(cv, icon, cx, cy, 64);
    else if (col.label) drawCentered(cv, cx, Math.round(cy - 11), col.label, [180, 180, 180], atlasSmall || atlas);
    else drawCentered(cv, cx, Math.round(cy - 22), 'KC');
  });
  if (opts.clogColumn) {
    drawCentered(cv, clogCx, Math.round(cy - 22), 'CLOG', [180, 180, 180]);
  }

  let y = HEADER_H;
  hline(cv, y, ox, ox + gridW, 107, 14, 14, 3);
  const gray = [120, 120, 120];
  const smallA = atlasSmall || atlas;
  shown.forEach(({ name, stats, specs, kc, badge, clog }) => {
    const kcs = Array.isArray(kc) ? kc : [kc];
    const label = shortDisplayName(name);
    // Line 1: badge + name + stats + KC.
    const ry = y + 12;
    let nameX = ox + 20;
    const badgeIcon = badge && badgeIcons[badge];
    if (badgeIcon) {
      drawIcon(cv, badgeIcon, nameX + 24, Math.round(ry + 14), BADGE_H);
      nameX += 56;
    }
    drawText(cv, nameX, Math.round(ry), label, stats ? undefined : gray);
    columns.forEach((_, i) => {
      const cx = ox + NAME_W + COL_W * i + COL_W / 2;
      drawCentered(cv, cx, Math.round(ry), stats ? String(stats[i]) : '-', stats ? undefined : gray);
    });
    kcCols.forEach((_, i) => {
      const val = kcs[i];
      drawCentered(cv, kcCx(i), Math.round(ry),
        typeof val === 'number' ? `${val.toLocaleString('en-US')} KC` : '-',
        stats ? undefined : gray);
    });
    if (opts.clogColumn) {
      drawCentered(cv, clogCx, Math.round(ry),
        clog ? `${clog.obtained}/${clog.total}` : '-',
        stats ? undefined : gray);
    }
    if (compact) {
      y += COMPACT_ROW_H;
      hline(cv, y, ox, ox + gridW, 60, 40, 36, 1);
      return;
    }
    // Spec groups, stacked: header + icons + labels each.
    let sy = y + 62;
    for (const [catName, ids] of specGroupsFor(specs)) {
      drawText(cv, ox + 20, Math.round(sy), catName, [150, 150, 150], smallA);
      sy += 30;
      const icy = sy + 38;
      let ix = ox + 20 + 40;
      const labs = ids.map((id) => SPEC_LABELS[id] || id.toUpperCase());
      const lws = labs.map((lab) => textWidth(lab, smallA));
      ids.forEach((specId, idx) => {
        drawIcon(cv, specIcons[specId], ix, icy, 72);
        const lw = lws[idx];
        // Clamp labels inside the content area so long names never clip.
        const lx = Math.max(Math.round(ix - lw / 2), ox + 20);
        drawText(cv, lx, Math.round(icy + 40), labs[idx], undefined, smallA);
        const nextW = idx + 1 < ids.length ? lws[idx + 1] : 0;
        ix += Math.max(110, (lw + nextW) / 2 + 48);
      });
      sy = icy + 78;
    }
    y += rowHeightFor(specs);
    hline(cv, y, ox, ox + gridW, 60, 40, 36, 1);
  });
  if (extraCount > 0) {
    drawCentered(cv, boardW / 2, y + 8, `+${extraCount} more`, [150, 130, 120]);
  }
  return encodePng(boardW, H, cv.buf);
}

function boardHeight(rowCount) {
  // Estimate: base row height, no spec groups.
  const shown = Math.min(rowCount, MAX_ROWS);
  return HEADER_H + 62 * shown + (rowCount > MAX_ROWS ? 56 : 24);
}

module.exports = { renderPartyBoard, boardHeight, shortDisplayName, bossIconKey, COLUMNS, MAX_ROWS, encodePng, decodePng };
