#!/usr/bin/env bash
# Starts the bot container from the pinned image ref.
# Pin file: /opt/oathbreakers-bot/image-pin (one line, e.g. image@sha256:...).
# Missing or empty pin file -> fall back to the :latest tag.
set -u

PIN_FILE=/opt/oathbreakers-bot/image-pin
DEFAULT_REF=ghcr.io/abovethyworld/oath-forsaken-bot:latest

ref=""
if [ -s "$PIN_FILE" ]; then
  ref=$(head -n 1 "$PIN_FILE" | tr -d '[:space:]')
fi
[ -n "$ref" ] || ref=$DEFAULT_REF

echo "oathbreakers-run: starting image $ref"
exec /usr/bin/docker run --rm --init --name oathbreakers-bot \
  --env-file /opt/oathbreakers-bot/.env \
  -v /opt/oathbreakers-bot/data:/app/data \
  --log-driver none \
  "$ref"
