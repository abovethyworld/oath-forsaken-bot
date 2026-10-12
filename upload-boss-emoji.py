import json, time, base64, urllib.request, urllib.error, os

env = open('/home/hatch/workspace/osrs-clan-bot/.env').read()
token = [l.split('=', 1)[1].strip() for l in env.splitlines() if l.startswith('DISCORD_TOKEN')][0]
GUILD = '1558390769746845718'
H = {'Authorization': f'Bot {token}', 'Content-Type': 'application/json', 'User-Agent': 'OathbreakersBot/1.0'}
D = '/home/hatch/workspace/osrs-clan-bot/assets/boss-icons'

NAMES = ['fracturedarchive', 'toa', 'cox', 'tob', 'hueycoatl', 'royaltitans',
         'barbarianassault', 'yama', 'zalcano', 'tempoross', 'wintertodt',
         'wildyagility', 'gotr', 'venenatis', 'callisto', 'vetion', 'nex', 'nightmare']

def api(method, path, body=None):
    data = json.dumps(body).encode() if body else None
    req = urllib.request.Request(f'https://discord.com/api/v10{path}', method=method, headers=H, data=data)
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            raw = r.read()
            return (r.status, json.loads(raw) if raw else None)
    except urllib.error.HTTPError as e:
        eb = e.read()[:300].decode(errors='replace')
        if e.code == 429:
            retry = float(e.headers.get('Retry-After', '5'))
            print(f'429 — waiting {retry + 2}s', flush=True); time.sleep(retry + 2)
            return api(method, path, body)
        return (e.code, eb)

s, existing = api('GET', f'/guilds/{GUILD}/emojis')
have = {e['name']: e['id'] for e in (existing or [])}
print(f'{len(have)} emoji already', flush=True)

out = {}
for name in NAMES:
    if name in have:
        out[name] = have[name]
        print(f'exists: {name}', flush=True)
        continue
    p = os.path.join(D, f'{name}.png')
    with open(p, 'rb') as f:
        b64 = base64.b64encode(f.read()).decode()
    s, r = api('POST', f'/guilds/{GUILD}/emojis', {'name': name, 'image': f'data:image/png;base64,{b64}'})
    if s in (200, 201) and r:
        out[name] = r['id']
        print(f'uploaded: {name} -> {r["id"]}', flush=True)
    else:
        print(f'FAILED: {name} -> {s}', flush=True)
    time.sleep(3)

json.dump(out, open(os.path.join(D, 'emoji-ids.json'), 'w'), indent=1)
print('DONE', len(out), 'emoji mapped')
