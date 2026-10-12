import json, time, subprocess, urllib.request, urllib.error

BASE_DIR = '/home/hatch/workspace/osrs-clan-bot'
env = open(f'{BASE_DIR}/.env').read()
token = [l.split('=', 1)[1].strip() for l in env.splitlines() if l.startswith('DISCORD_TOKEN')][0]
BOT_ID = '1558391167413129216'
H = {'Authorization': f'Bot {token}', 'Content-Type': 'application/json', 'User-Agent': 'OathbreakersBot/1.0'}
STYLE = {'Primary': 1, 'Secondary': 2, 'Success': 3}

def api(method, path, body=None):
    data = json.dumps(body).encode() if body else None
    req = urllib.request.Request(f'https://discord.com/api/v10{path}', method=method, headers=H, data=data)
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            raw = r.read()
            return (r.status, json.loads(raw) if raw else None)
    except urllib.error.HTTPError as e:
        if e.code == 429:
            retry = float(e.headers.get('Retry-After', '5')); time.sleep(retry + 2)
            return api(method, path, body)
        return (e.code, None)

emoji_ids = json.load(open(f'{BASE_DIR}/assets/boss-icons/emoji-ids.json'))
cfg = json.load(open(f'{BASE_DIR}/config.json'))
CH = cfg['channels']['roles']

# ---- 1. swap grouping buttons to custom emoji ----
LABEL2EMOJI = {
    'The Fractured Archive': 'fracturedarchive', 'Tombs of Amascut (ToA)': 'toa',
    'Chambers of Xeric (CoX)': 'cox', 'Theatre of Blood (ToB)': 'tob',
    'The Hueycoatl': 'hueycoatl', 'Royal Titans': 'royaltitans',
    'Barbarian Assault': 'barbarianassault', 'Yama': 'yama', 'Zalcano': 'zalcano',
    'Tempoross': 'tempoross', 'Wintertodt': 'wintertodt',
    'Wilderness Agility': 'wildyagility', 'Guardians of the Rift': 'gotr',
    'Venenatis': 'venenatis', 'Callisto': 'callisto', "Vet'ion": 'vetion',
    'Nex': 'nex', 'Nightmare': 'nightmare',
}
gp = next(p for p in cfg['rolePanels'] if 'GROUPING' in p['title'])
for b in gp['buttons']:
    ename = LABEL2EMOJI[b['label']]
    b['emoji'] = {'id': emoji_ids[ename], 'name': ename}
json.dump(cfg, open(f'{BASE_DIR}/config.json', 'w'), indent=1)
print('config: grouping buttons -> custom emoji', flush=True)

# ---- 2. clear #roles ----
s, msgs = api('GET', f'/channels/{CH}/messages?limit=100')
mine = [m for m in (msgs or []) if m.get('author', {}).get('id') == BOT_ID]
print(f'{len(mine)} messages to clear', flush=True)
for m in mine:
    api('DELETE', f"/channels/{CH}/messages/{m['id']}"); time.sleep(1)
print('cleared', flush=True)

# ---- 3. post banner + panel x4 ----
BANNERS = {
    'GENERAL': 'media-generation-banner-general-0-83b8c1fe-e95a-4e27-bda2-52ab406725cd.webp',
    'GROUPING': 'media-generation-banner-grouping-0-e6618bef-ca41-474a-9da0-74d2df6a3698.webp',
    'TYPE OF IRON': 'media-generation-banner-iron-0-ccd39641-b340-4d7c-81b1-5d9ca9c7c451.webp',
    'PREFERRED GAME SERVER': 'media-generation-banner-server-0-e6d2714a-f063-4b93-9db3-d2c7366f1e7d.webp',
}

def post_banner(fname):
    p = f'{BASE_DIR}/assets/role-banners/{fname}'
    r = subprocess.run(['curl', '-s', '-o', '/dev/null', '-w', '%{http_code}',
        '-X', 'POST', '-H', f'Authorization: Bot {token}',
        '-F', f'file=@{p}',
        '-F', 'payload_json={"content":""}',
        f'https://discord.com/api/v10/channels/{CH}/messages'],
        capture_output=True, text=True, timeout=60)
    print(f'banner {fname[:30]} -> {r.stdout.strip()}', flush=True)
    time.sleep(2)

def chunk(buttons):
    rows = []
    for i in range(0, len(buttons), 5):
        comps = []
        for b in buttons[i:i + 5]:
            e = b['emoji']
            emoji = {'id': e['id'], 'name': e['name']} if isinstance(e, dict) else {'name': e}
            comps.append({'type': 2, 'style': STYLE[b['style']], 'label': b['label'],
                          'custom_id': f"role:{b['roleId']}", 'emoji': emoji})
        rows.append({'type': 1, 'components': comps})
    return rows

for p in cfg['rolePanels']:
    key = next(k for k in BANNERS if k in p['title'])
    post_banner(BANNERS[key])
    s, _ = api('POST', f'/channels/{CH}/messages', {
        'embeds': [{'title': p['title'], 'description': p['description'], 'color': p['color']}],
        'components': chunk(p['buttons'])})
    print(f"panel {p['title']} -> {s}", flush=True)
    time.sleep(2)

print('DONE')
