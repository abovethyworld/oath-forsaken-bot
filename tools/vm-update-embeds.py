#!/usr/bin/env python3
"""Run on the Oracle VM to update Discord embeds from a clean IP.

Usage: python3 vm-update-embeds.py
Reads DISCORD_TOKEN from /opt/oathbreakers-bot/.env
"""
import json, os, urllib.request, time

ENV_PATH = '/opt/oathbreakers-bot/.env'
RULES_CHANNEL = '1558393177726259241'

UPDATES = [
    # (message_id, new_image_url, label)
    ('1558536256693215234',
     'https://cdn.discordapp.com/attachments/1558458301627506788/1558667051890114590/fixed-banner-bosses.png',
     'STRIKE SYSTEM'),
    ('1558536245787893802',
     'https://cdn.discordapp.com/attachments/1558458301627506788/1558667182488027236/fixed-banner-kril.png',
     'RULES'),
]

def load_token():
    with open(ENV_PATH) as f:
        for line in f:
            if line.startswith('DISCORD_TOKEN='):
                return line.strip().split('=', 1)[1]
    raise RuntimeError('DISCORD_TOKEN not found in .env')

def api(method, path, data=None):
    req = urllib.request.Request(
        f'https://discord.com/api/v10{path}',
        data=json.dumps(data).encode() if data else None,
        method=method,
        headers={'Authorization': f'Bot {TOKEN}', 'Content-Type': 'application/json'}
    )
    return json.load(urllib.request.urlopen(req, timeout=30))

TOKEN = load_token()

for msg_id, img_url, label in UPDATES:
    msg = api('GET', f'/channels/{RULES_CHANNEL}/messages/{msg_id}')
    embed = msg['embeds'][0]
    embed['image'] = {'url': img_url}
    api('PATCH', f'/channels/{RULES_CHANNEL}/messages/{msg_id}', {'embeds': [embed]})
    print(f'{label}: updated')
    time.sleep(20)

print('done')
