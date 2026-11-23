#!/usr/bin/env bash
# Pulls the newest bot image; if its digest differs from the pinned/running
# one, pins it, restarts the service and health-checks the new boot.
# A failed health check restores the previous pin and restarts again.
set -u

IMAGE=ghcr.io/abovethyworld/oath-forsaken-bot
LATEST="$IMAGE:latest"
PIN_FILE=/opt/oath-forsaken-bot/image-pin
PREV_FILE=/opt/oath-forsaken-bot/image-pin.prev
SERVICE=oath-forsaken-bot
CONTAINER=oath-forsaken-bot
TIMEOUT=120

log() { echo "bot-deploy: $*"; }

# Prints the repo digest ref (image@sha256:...) of a local image, or nothing.
digest_ref_of() {
  docker image inspect --format '{{range .RepoDigests}}{{println .}}{{end}}' "$1" 2>/dev/null \
    | grep "^${IMAGE}@" | head -n 1
}

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

log "pulling $LATEST"
if ! docker pull "$LATEST"; then
  log "pull failed; nothing changed"
  exit 1
fi
new_ref=$(digest_ref_of "$LATEST")
if [ -z "$new_ref" ]; then
  log "could not resolve digest of $LATEST; nothing changed"
  exit 1
fi
new_digest=${new_ref#*@}

# Current ref: pin file, else the running container's image.
current_ref=""
if [ -s "$PIN_FILE" ]; then
  current_ref=$(head -n 1 "$PIN_FILE" | tr -d '[:space:]')
else
  running_id=$(docker inspect --format '{{.Image}}' "$CONTAINER" 2>/dev/null || true)
  [ -n "$running_id" ] && current_ref=$(digest_ref_of "$running_id")
fi
current_digest=""
if [ -n "$current_ref" ]; then
  case "$current_ref" in
    *@*) current_digest=${current_ref#*@} ;;
    *)   current_digest=$(digest_ref_of "$current_ref"); current_digest=${current_digest#*@} ;;
  esac
fi

if [ "$new_digest" = "$current_digest" ]; then
  log "already current ($new_digest)"
  exit 0
fi

log "current: ${current_ref:-none}"
log "new:     $new_ref"
if [ -n "$current_ref" ]; then
  echo "$current_ref" > "$PREV_FILE"
else
  log "WARNING: no current ref known; no rollback target will be saved"
  rm -f "$PREV_FILE"
fi
echo "$new_ref" > "$PIN_FILE"

since=$(date '+%Y-%m-%d %H:%M:%S')
log "restarting $SERVICE"
systemctl restart "$SERVICE"

if health_check "$since"; then
  echo "deployed $new_digest"
  exit 0
fi

echo "deploy failed, rolling back"
if [ -s "$PREV_FILE" ]; then
  cp "$PREV_FILE" "$PIN_FILE"
  since=$(date '+%Y-%m-%d %H:%M:%S')
  systemctl restart "$SERVICE"
  if health_check "$since"; then
    log "rollback healthy"
  else
    log "WARNING: previous version also failed its health check; manual attention needed"
  fi
else
  log "WARNING: no previous pin to restore; manual attention needed"
fi
exit 1
