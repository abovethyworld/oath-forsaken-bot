#!/usr/bin/env bash
# Starts the bot container from the pinned image ref.
# Pin file: /opt/oath-forsaken-bot/image-pin (one line, e.g. image@sha256:...).
# Missing or empty pin file -> fall back to the :latest tag.
set -u

PIN_FILE=/opt/oath-forsaken-bot/image-pin
DEFAULT_REF=ghcr.io/abovethyworld/oath-forsaken-bot:latest

ref=""
if [ -s "$PIN_FILE" ]; then
  ref=$(head -n 1 "$PIN_FILE" | tr -d '[:space:]')
fi
[ -n "$ref" ] || ref=$DEFAULT_REF

echo "oath-forsaken-run: starting image $ref"
exec /usr/bin/docker run --rm --init --name oath-forsaken-bot \
  --env-file /opt/oath-forsaken-bot/.env \
  -v /opt/oath-forsaken-bot/data:/app/data \
  --log-driver none \
  "$ref"
