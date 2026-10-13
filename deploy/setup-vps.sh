#!/bin/bash
# OathBreakers bot — VPS setup script.
# Run as root on a fresh Ubuntu 22.04/24.04 machine (e.g. Oracle Cloud Always Free).
set -e

APP_DIR=/opt/oathbreakers-bot

echo "==> Installing Docker..."
apt-get update
apt-get install -y docker.io
systemctl enable --now docker
docker --version

echo "==> Creating $APP_DIR..."
mkdir -p "$APP_DIR/data"
chown "$SUDO_USER:$SUDO_USER" "$APP_DIR" 2>/dev/null || true

echo ""
echo "=== Next steps ==="
echo "1. Log in to GHCR so Docker can pull the private image. Use a GitHub PAT"
echo "   (classic) with only the read:packages scope:"
echo "     echo <PAT> | docker login ghcr.io -u <github-username> --password-stdin"
echo "2. Create $APP_DIR/.env (plain KEY=value lines, no quotes):"
echo "     printf 'DISCORD_TOKEN=<paste-token>\nCLIENT_ID=1558391167413129216\n' > $APP_DIR/.env"
echo "3. From your own computer, upload the service file:"
echo "     scp deploy/oathbreakers-bot.service <user>@<vps-ip>:/tmp/"
echo "   Then on this machine:"
echo "     cp /tmp/oathbreakers-bot.service /etc/systemd/system/"
echo "     systemctl daemon-reload"
echo "     systemctl enable --now oathbreakers-bot"
echo "4. Check it's alive:"
echo "     systemctl status oathbreakers-bot"
echo "     journalctl -u oathbreakers-bot -f"
echo ""
echo "To deploy a new version after GitHub Actions finishes: systemctl restart oathbreakers-bot"
