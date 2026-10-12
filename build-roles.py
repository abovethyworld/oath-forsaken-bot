import json, time, urllib.request, urllib.error

env = open('/home/hatch/workspace/osrs-clan-bot/.env').read()
token = [l.split('=', 1)[1].strip() for l in env.splitlines() if l.startswith('DISCORD_TOKEN')][0]
GUILD = '1558390769746845718'
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
        eb = e.read()[:300].decode(errors='replace')
        if e.code == 429:
            retry = float(e.headers.get('Retry-After', '5'))
            print(f'429 on {method} {path} — waiting {retry + 2}s', flush=True)
            time.sleep(retry + 2)
            return api(method, path, body)
        print(f'HTTP {e.code} on {method} {path}: {eb}', flush=True)
        return (e.code, None)

# ---- 1. existing roles ----
s, roles = api('GET', f'/guilds/{GUILD}/roles')
by_name = {r['name']: r['id'] for r in roles}
print(f'{len(roles)} roles on server', flush=True)

NEW_ROLES = [
    # general
    'Raid Of The Week', 'Minigames', 'Other Games', 'Movies, Shows, and Games',
    'Milestone Parties', 'Free to Play',
    # grouping
    'Tombs of Amascut (ToA)', 'Chambers of Xeric (CoX)', 'Theatre of Blood (ToB)',
    'The Hueycoatl', 'Royal Titans', 'Barbarian Assault', 'Yama', 'Zalcano',
    'Tempoross', 'Wintertodt', 'Wilderness Agility', 'Guardians of the Rift',
    'Venenatis', 'Callisto', "Vet'ion", 'Nex', 'Nightmare',
    # iron
    'Standard Iron', 'Hardcore Iron', 'Ultimate Iron', 'Group Iron',
    'Unranked Group Iron', 'Hardcore Group Iron',
    # region
    'US East', 'US West', 'United Kingdom', 'Germany', 'Australia',
]
RETIRE = ['Event Pings', 'Raids', 'Slayer', 'Clue Scrolls', 'Ironman', 'Hardcore Ironman',
          'Ultimate Ironman', 'Group Ironman', 'NA East', 'NA Central', 'NA West', 'EU', 'OCE']

ids = {}
for name in NEW_ROLES:
    if name in by_name:
        ids[name] = by_name[name]
        print(f'exists: {name}', flush=True)
        continue
    s, r = api('POST', f'/guilds/{GUILD}/roles', {'name': name, 'mentionable': True})
    if s in (200, 201) and r:
        ids[name] = r['id']
        print(f'created: {name}', flush=True)
    else:
        print(f'FAILED: {name}', flush=True)
    time.sleep(3)

for name in RETIRE:
    if name in by_name:
        s, _ = api('DELETE', f'/guilds/{GUILD}/roles/{by_name[name]}')
        print(f'deleted: {name} -> {s}', flush=True)
        time.sleep(2)

# ---- 2. rebuild config.rolePanels ----
def B(label, emoji, role_name, style):
    return {'label': label, 'emoji': emoji, 'roleId': ids.get(role_name) or by_name[role_name], 'style': style}

panels = [
    {'title': 'GENERAL', 'color': 16766720,
     'description': 'Ping roles for clan activities. Click a button below to opt in or out of pings for that category.',
     'buttons': [
         B('General Events', '📅', 'General Events', 'Primary'),
         B('Boss of the Week', '🛡️', 'Boss of the Week', 'Primary'),
         B('Skill of the Week', '⛏️', 'Skill of the Week', 'Primary'),
         B('Raid Of The Week', '🧙', 'Raid Of The Week', 'Primary'),
         B('Minigames', '🎲', 'Minigames', 'Primary'),
         B('PVM', '💀', 'PvM', 'Primary'),
         B('Giveaways', '🎁', 'Giveaways', 'Primary'),
         B('Other Games', '🎮', 'Other Games', 'Primary'),
         B('Movies, Shows, and Games', '🎨', 'Movies, Shows, and Games', 'Primary'),
         B('Milestone Parties', '🎉', 'Milestone Parties', 'Primary'),
         B('Free to Play', '🌚', 'Free to Play', 'Primary'),
     ]},
    {'title': 'PVM, MINIGAME, AND SKILLING — GROUPING', 'color': 5763719,
     'description': 'Ping roles for grouping up. Opt into the bosses and activities you actually run.',
     'buttons': [
         B('Tombs of Amascut (ToA)', '🏛️', 'Tombs of Amascut (ToA)', 'Success'),
         B('Chambers of Xeric (CoX)', '🗝️', 'Chambers of Xeric (CoX)', 'Success'),
         B('Theatre of Blood (ToB)', '🩸', 'Theatre of Blood (ToB)', 'Success'),
         B('The Hueycoatl', '🐍', 'The Hueycoatl', 'Success'),
         B('Royal Titans', '👑', 'Royal Titans', 'Success'),
         B('Barbarian Assault', '🎖️', 'Barbarian Assault', 'Success'),
         B('Yama', '😈', 'Yama', 'Success'),
         B('Zalcano', '⛏️', 'Zalcano', 'Success'),
         B('Tempoross', '🌊', 'Tempoross', 'Success'),
         B('Wintertodt', '🔥', 'Wintertodt', 'Success'),
         B('Wilderness Agility', '🏃', 'Wilderness Agility', 'Success'),
         B('Guardians of the Rift', '🌀', 'Guardians of the Rift', 'Success'),
         B('Venenatis', '🕷️', 'Venenatis', 'Success'),
         B('Callisto', '🐻', 'Callisto', 'Success'),
         B("Vet'ion", '💀', "Vet'ion", 'Success'),
         B('Nex', '❄️', 'Nex', 'Success'),
         B('Nightmare', '🌙', 'Nightmare', 'Success'),
     ]},
    {'title': 'TYPE OF IRON', 'color': 9807270,
     'description': 'What type of iron are you?',
     'buttons': [
         B('Standard Iron', '⛓️', 'Standard Iron', 'Secondary'),
         B('Hardcore Iron', '❤️‍🔥', 'Hardcore Iron', 'Secondary'),
         B('Ultimate Iron', '🎒', 'Ultimate Iron', 'Secondary'),
         B('Group Iron', '👥', 'Group Iron', 'Secondary'),
         B('Unranked Group Iron', '🧑‍🤝‍🧑', 'Unranked Group Iron', 'Secondary'),
         B('Hardcore Group Iron', '💀', 'Hardcore Group Iron', 'Secondary'),
     ]},
    {'title': 'PREFERRED GAME SERVER', 'color': 9807270,
     'description': 'What game server do you play on?',
     'buttons': [
         B('US East', '🗽', 'US East', 'Secondary'),
         B('US West', '🌉', 'US West', 'Secondary'),
         B('United Kingdom', '🇬🇧', 'United Kingdom', 'Secondary'),
         B('Germany', '🇩🇪', 'Germany', 'Secondary'),
         B('Australia', '🇦🇺', 'Australia', 'Secondary'),
     ]},
]

cfg = json.load(open('/home/hatch/workspace/osrs-clan-bot/config.json'))
cfg['rolePanels'] = panels
json.dump(cfg, open('/home/hatch/workspace/osrs-clan-bot/config.json', 'w'), indent=1)
print('config.rolePanels rebuilt', flush=True)
ROLES_CH = cfg['channels']['roles']

# ---- 3. clear old bot messages in #roles ----
s, msgs = api('GET', f'/channels/{ROLES_CH}/messages?limit=100')
mine = [m for m in (msgs or []) if m.get('author', {}).get('id') == BOT_ID]
print(f'{len(mine)} old bot messages to clear', flush=True)
for m in mine:
    s, _ = api('DELETE', f'/channels/{ROLES_CH}/messages/{m["id"]}')
    time.sleep(1)
print('cleared', flush=True)

# ---- 4. post new panels ----
def chunk(buttons):
    rows = []
    for i in range(0, len(buttons), 5):
        rows.append({'type': 1, 'components': [
            {'type': 2, 'style': STYLE[b['style']], 'label': b['label'],
             'custom_id': f"role:{b['roleId']}", 'emoji': {'name': b['emoji']}}
            for b in buttons[i:i + 5]]})
    return rows

for p in panels:
    s, r = api('POST', f'/channels/{ROLES_CH}/messages', {
        'embeds': [{'title': p['title'], 'description': p['description'], 'color': p['color']}],
        'components': chunk(p['buttons'])})
    print(f"posted {p['title']} -> {s}", flush=True)
    time.sleep(2)

print('DONE')
