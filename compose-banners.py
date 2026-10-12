"""Compose 4 OSRS-art banners (1200x300) with Zamorak/Oathplate theme."""
from PIL import Image, ImageFilter, ImageDraw
import os

D = '/home/hatch/workspace/osrs-clan-bot/assets/banner-art'
W, H = 1200, 300

def load(n):
    return Image.open(f'{D}/{n}').convert('RGBA')

def dark_base(glow_x=600, glow_color=(120, 10, 10)):
    """Near-black canvas with deep-red radial glow."""
    img = Image.new('RGB', (W, H), (6, 6, 9))
    glow = Image.new('RGB', (W, H), (0, 0, 0))
    gd = ImageDraw.Draw(glow)
    gd.ellipse([glow_x - 420, -160, glow_x + 420, H + 160], fill=glow_color)
    glow = glow.filter(ImageFilter.GaussianBlur(90))
    img = Image.blend(img, Image.blend(img, glow, 0.55), 0.5)
    # vignette: darken edges
    vig = Image.new('L', (W, H), 0)
    vd = ImageDraw.Draw(vig)
    vd.ellipse([-260, -220, W + 260, H + 220], fill=255)
    vig = vig.filter(ImageFilter.GaussianBlur(70))
    black = Image.new('RGB', (W, H), (0, 0, 0))
    img = Image.composite(img, black, vig)
    return img.convert('RGBA')

def place(canvas, img, target_h, cx, cy=H // 2, opacity=1.0):
    s = target_h / img.height
    r = img.resize((round(img.width * s), round(img.height * s)), Image.LANCZOS)
    if opacity < 1.0:
        a = r.split()[3].point(lambda v: int(v * opacity))
        r.putalpha(a)
    canvas.alpha_composite(r, (round(cx - r.width / 2), round(cy - r.height / 2)))
    return canvas

def save(canvas, name):
    p = f'{D}/final-{name}.png'
    canvas.convert('RGB').save(p, 'PNG')
    print(f'{name}: {os.path.getsize(p)//1024}KB', flush=True)

# ---- 1. GENERAL: K'ril + Oathplate helm, Zamorak's wrath ----
c = dark_base(glow_x=850)
helm = load('oathplate-helm-hd.png')
kril = load('kril.png')
c = place(c, helm, 250, 210)
c = place(c, kril, 330, 880)   # K'ril dominates right
save(c, 'banner-general')

# ---- 2. GROUPING: boss-rush lineup ----
c = dark_base(glow_x=600, glow_color=(100, 12, 12))
order = [('verzik-hd.png', 280), ('nex-hd.png', 260), ('nightmare-hd.png', 230),
         ('venenatis-hd.png', 210), ('olm-hd.png', 190)]
xs = [130, 380, 620, 860, 1080]
for (fn, th), x in zip(order, xs):
    c = place(c, load(fn), th, x)
save(c, 'banner-grouping')

# ---- 3. TYPE OF IRON: ironman + oathplate chest backdrop ----
c = dark_base(glow_x=600, glow_color=(90, 20, 14))
chest = load('oathplate-chest-hd.png')
armor = load('ironman-armor.png')
c = place(c, chest, 420, 600, opacity=0.35)  # ghosted backdrop
c = place(c, armor, 295, 600)
save(c, 'banner-iron')

# ---- 4. GAME SERVER: Gielinor world map ----
wm = load('world-map.png')
# crop a 4:1 region around the map's heart
cw, ch = wm.width, wm.height
crop_w, crop_h = int(ch * 1.2), int(ch * 0.30)
cx, cy = cw // 2, int(ch * 0.52)
box = (cx - crop_w // 2, cy - crop_h // 2, cx + crop_w // 2, cy + crop_h // 2)
region = wm.crop(box).resize((W, H), Image.LANCZOS)
# darken + red tint
dark = Image.new('RGBA', (W, H), (8, 4, 6, 255))
region = Image.blend(region, dark, 0.45)
c = region
# vignette
vig = Image.new('L', (W, H), 0)
vd = ImageDraw.Draw(vig)
vd.ellipse([-260, -220, W + 260, H + 220], fill=255)
vig = vig.filter(ImageFilter.GaussianBlur(70))
c = Image.composite(c, Image.new('RGBA', (W, H), (0, 0, 0, 255)), vig)
save(c, 'banner-server')

print('DONE')
