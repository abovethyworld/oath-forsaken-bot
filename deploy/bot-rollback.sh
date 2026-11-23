#!/usr/bin/env bash
# Swaps image-pin and image-pin.prev, restarts and health-checks.
# Running it twice swaps back (intended).
set -u

PIN_FILE=/opt/oath-forsaken-bot/image-pin
PREV_FILE=/opt/oath-forsaken-bot/image-pin.prev
SERVICE=oath-forsaken-bot
CONTAINER=oath-forsaken-bot
TIMEOUT=120

log() { echo "bot-rollback: $*"; }

health_check() {
  local since=$1 waited=0
  while [ "$waited" -lt "$TIMEOUT" ]; do
    if journalctl -u "$SERVICE" --since "$since" --no-pager 2>/dev/null | grep -q "Logged in as" \
       && [ "$(docker inspect --format '{{.State.Running}}' "$CONTAINER" 2>/dev/null)" = "true" ]; then
      return 0
    fi
    sleep 3
    waited=$((waited + 3))
  done
  return 1
}

if [ ! -s "$PREV_FILE" ]; then
  log "no previous version recorded ($PREV_FILE missing); cannot roll back"
  exit 1
fi

prev_ref=$(head -n 1 "$PREV_FILE" | tr -d '[:space:]')
current_ref=""
[ -s "$PIN_FILE" ] && current_ref=$(head -n 1 "$PIN_FILE" | tr -d '[:space:]')

echo "$prev_ref" > "$PIN_FILE"
if [ -n "$current_ref" ]; then
  echo "$current_ref" > "$PREV_FILE"
else
  rm -f "$PREV_FILE"
fi
log "pinned $prev_ref (was ${current_ref:-unpinned})"

since=$(date '+%Y-%m-%d %H:%M:%S')
systemctl restart "$SERVICE"
if health_check "$since"; then
  echo "rolled back to $prev_ref"
  exit 0
fi
echo "rollback failed: no healthy boot within ${TIMEOUT}s"
exit 1
