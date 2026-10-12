#!/bin/bash
# OathBreakers bot — VPS setup script.
# Run as root on a fresh Ubuntu 22.04/24.04 machine (e.g. Oracle Cloud Always Free).
set -e

APP_DIR=/opt/oathbreakers-bot

echo "==> Installing Node.js 22..."
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt-get install -y nodejs
node --version

echo "==> Creating $APP_DIR..."
mkdir -p "$APP_DIR"
chown "$SUDO_USER:$SUDO_USER" "$APP_DIR" 2>/dev/null || true

echo ""
echo "=== Next steps ==="
echo "1. From your own computer, upload the tarball:"
echo "     scp deploy/oathbreakers-bot.tar.gz <user>@<vps-ip>:/tmp/"
echo "   Then on this machine:"
echo "     tar -xzf /tmp/oathbreakers-bot.tar.gz -C $APP_DIR"
echo "2. Create $APP_DIR/.env :"
echo "     printf 'DISCORD_TOKEN=<paste-token>\nCLIENT_ID=1558391167413129216\n' > $APP_DIR/.env"
echo "3. Install dependencies:"
echo "     cd $APP_DIR && npm install --omit=dev --no-audit --no-fund"
echo "4. Install and start the service:"
echo "     cp $APP_DIR/deploy/oathbreakers-bot.service /etc/systemd/system/"
echo "     systemctl daemon-reload"
echo "     systemctl enable --now oathbreakers-bot"
echo "5. Check it's alive:"
echo "     systemctl status oathbreakers-bot"
echo "     journalctl -u oathbreakers-bot -f"
