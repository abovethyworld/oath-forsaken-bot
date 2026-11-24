#!/usr/bin/env bash
# Pulls the newest bot image; if its digest differs from the pinned/running
# one, pins it, restarts the service and health-checks the new boot.
# A failed health check restores the previous pin and restarts again.
set -u

IMAGE=ghcr.io/abovethyworld/oath-forsaken-bot
LATEST="$IMAGE:latest"
PIN_FILE=/opt/oath-forsaken-bot/image-pin
PREV_FILE=/opt/oath-forsaken-bot/image-pin.prev
BLOCKED_FILE=/opt/oath-forsaken-bot/image-blocked
LOCK_FILE=/run/bot-deploy.lock
SETTLE=90
SERVICE=oath-forsaken-bot
CONTAINER=oath-forsaken-bot
TIMEOUT=120

log() { echo "bot-deploy: $*"; }

# One deploy at a time: manual and timer runs must not overlap.
exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  log "another deploy is running ($LOCK_FILE); exiting"
  exit 0
fi

# Prints the repo digest ref (image@sha256:...) of a local image, or nothing.
digest_ref_of() {
  docker image inspect --format '{{range .RepoDigests}}{{println .}}{{end}}' "$1" 2>/dev/null \
    | grep "^${IMAGE}@" | head -n 1
}

restarts() { systemctl show -p NRestarts --value "$SERVICE" 2>/dev/null; }

# Passes only when the new boot logs in, stays up for SETTLE more seconds
# with NRestarts unchanged, and logged in exactly once since the deploy began.
# $2 is the NRestarts value read right after the restart command.
health_check() {
  local since=$1 base_restarts=$2 waited=0 logged_in=0
  while [ "$waited" -lt "$TIMEOUT" ]; do
    if journalctl -u "$SERVICE" --since "$since" --no-pager 2>/dev/null | grep -q "Logged in as" \
       && [ "$(docker inspect --format '{{.State.Running}}' "$CONTAINER" 2>/dev/null)" = "true" ]; then
      logged_in=1
      break
    fi
    sleep 3
    waited=$((waited + 3))
  done
  [ "$logged_in" -eq 1 ] || return 1

  log "logged in; watching for ${SETTLE}s"
  sleep "$SETTLE"
  if [ "$(restarts)" != "$base_restarts" ]; then
    log "service restarted during the settle window"
    return 1
  fi
  if [ "$(docker inspect --format '{{.State.Running}}' "$CONTAINER" 2>/dev/null)" != "true" ]; then
    log "container not running after the settle window"
    return 1
  fi
  local count
  count=$(journalctl -u "$SERVICE" --since "$since" --no-pager 2>/dev/null | grep -c "Logged in as")
  if [ "$count" -ne 1 ]; then
    log "expected exactly one 'Logged in as' since deploy start, saw $count"
    return 1
  fi
  return 0
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

if [ -s "$BLOCKED_FILE" ] && grep -qxF "$new_digest" "$BLOCKED_FILE"; then
  log "candidate $new_digest is in $BLOCKED_FILE (rejected earlier); not deploying"
  exit 0
fi

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
base_restarts=$(restarts)

if health_check "$since" "$base_restarts"; then
  echo "deployed $new_digest"
  exit 0
fi

echo "deploy failed, rolling back"
echo "$new_digest" >> "$BLOCKED_FILE"
log "blocked $new_digest in $BLOCKED_FILE"
if [ -s "$PREV_FILE" ]; then
  cp "$PREV_FILE" "$PIN_FILE"
  since=$(date '+%Y-%m-%d %H:%M:%S')
  systemctl restart "$SERVICE"
  if health_check "$since" "$(restarts)"; then
    log "rollback healthy"
  else
    log "WARNING: previous version also failed its health check; manual attention needed"
  fi
else
  log "WARNING: no previous pin to restore; manual attention needed"
fi
exit 1
