"""Fetch boss/activity icons from oldschool.runescape.wiki for button emoji."""
import json, time, urllib.request, urllib.parse
from io import BytesIO
from PIL import Image

API = 'https://oldschool.runescape.wiki/api.php'

# emoji_name -> candidate File: titles (first hit wins)
TARGETS = {
    'fracturedarchive': ['The Fractured Archive.png', 'Fractured Archive logo.png'],
    'toa': ['Tombs of Amascut.png', 'ToA logo.png'],
    'cox': ['Chambers of Xeric.png', 'CoX logo.png'],
    'tob': ['Theatre of Blood.png', 'ToB logo.png'],
    'hueycoatl': ['Hueycoatl.png'],
    'royaltitans': ['Royal Titans.png'],
    'barbarianassault': ['Barbarian Assault.png', 'Attacker icon.png'],
    'yama': ['Yama.png'],
    'zalcano': ['Zalcano.png'],
    'tempoross': ['Tempoross.png'],
    'wintertodt': ['Wintertodt.png'],
    'wildyagility': ['Agility icon.png', 'Wilderness Agility Course.png'],
    'gotr': ['Guardians of the Rift.png', 'GotR logo.png'],
    'venenatis': ['Venenatis.png'],
    'callisto': ['Callisto.png'],
    'vetion': ["Vet'ion.png"],
    'nex': ['Nex.png'],
    'nightmare': ['The Nightmare.png', 'Nightmare.png'],
}

def wiki_file_url(title):
    q = urllib.parse.urlencode({
        'action': 'query', 'titles': f'File:{title}',
        'prop': 'imageinfo', 'iiprop': 'url|size', 'format': 'json', 'formatversion': 2})
    req = urllib.request.Request(f'{API}?{q}', headers={'User-Agent': 'OathbreakersClanBot/1.0'})
    with urllib.request.urlopen(req, timeout=30) as r:
        data = json.load(r)
    pages = data.get('query', {}).get('pages', [])
    if pages and not pages[0].get('missing') and pages[0].get('imageinfo'):
        return pages[0]['imageinfo'][0]['url']
    return None

results = {}
for ename, candidates in TARGETS.items():
    url = None
    for c in candidates:
        try:
            url = wiki_file_url(c)
        except Exception as e:
            print(f'  err {c}: {e}', flush=True)
        if url:
            print(f'{ename}: {c}', flush=True)
            break
        time.sleep(0.5)
    if not url:
        print(f'{ename}: NOT FOUND', flush=True)
    else:
        results[ename] = url
    time.sleep(0.5)

json.dump(results, open('/home/hatch/workspace/osrs-clan-bot/assets/boss-icons/urls.json', 'w'), indent=1)

# download + resize to 128x128 PNG
for ename, url in results.items():
    try:
        req = urllib.request.Request(url, headers={'User-Agent': 'OathbreakersClanBot/1.0'})
        with urllib.request.urlopen(req, timeout=30) as r:
            raw = r.read()
        img = Image.open(BytesIO(raw)).convert('RGBA')
        img.thumbnail((128, 128), Image.LANCZOS)
        out = Image.new('RGBA', (128, 128), (0, 0, 0, 0))
        out.paste(img, ((128 - img.width) // 2, (128 - img.height) // 2), img)
        p = f'/home/hatch/workspace/osrs-clan-bot/assets/boss-icons/{ename}.png'
        out.save(p, 'PNG')
        import os
        print(f'{ename}: saved {os.path.getsize(p)//1024}KB', flush=True)
    except Exception as e:
        print(f'{ename}: download failed: {e}', flush=True)
    time.sleep(0.5)

print('DONE')
