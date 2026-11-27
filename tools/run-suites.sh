#!/usr/bin/env bash
# Sandbox runner for the smoke suites.
#
#   bash tools/run-suites.sh            # card suite, then logic suite
#   bash tools/run-suites.sh card       # card suite only
#   bash tools/run-suites.sh logic      # logic suite only
#
# Builds a throwaway copy of the tree (src/, tools/, config.json,
# package.json, assets/, node_modules symlinked), generates fixture
# data into the COPY's data/ (tools/smoke-fixtures.js), starts the
# card stub on a free port, runs the requested suite(s) against the
# copy, then tears everything down. The real data/ folder is never
# an input or an output: it is checksummed before and after and the
# run FAILS LOUDLY if it changed.
#
# Exit codes: 0 all green; 1 a suite failed; 3 the real data/ changed
# (or the sandbox could not be built).
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WHICH="${1:-all}"
case "$WHICH" in all|card|logic) ;; *) echo "usage: run-suites.sh [all|card|logic]" >&2; exit 3 ;; esac
REAL_DATA="${SMOKE_REAL_DATA:-$ROOT/data}"

checksum_real() {
  if [ -d "$REAL_DATA" ]; then
    # names + contents of every file under the real data/
    ( cd "$REAL_DATA" && find . -type f -print0 | LC_ALL=C sort -z | xargs -0 -r sha256sum | sha256sum | cut -d' ' -f1 )
  else
    echo "absent"
  fi
}

SB="$(mktemp -d "${TMPDIR:-/tmp}/smoke-sandbox.XXXXXX")" || exit 3
STUB_PID=""
BEFORE="$(checksum_real)"
FINISHED=0

cleanup() {
  [ -n "$STUB_PID" ] && kill "$STUB_PID" 2>/dev/null
  rm -rf "$SB"
  AFTER="$(checksum_real)"
  if [ "$AFTER" != "$BEFORE" ]; then
    echo "RUNNER FAIL: the real data/ folder CHANGED during the run ($REAL_DATA)" >&2
    echo "  before: $BEFORE" >&2
    echo "  after:  $AFTER" >&2
    exit 3
  fi
  echo "RUNNER: real data/ unchanged ($BEFORE)"
}
trap 'cleanup' EXIT
trap 'exit 130' INT TERM

cp -r "$ROOT/src" "$ROOT/tools" "$SB/" || exit 3
for f in config.json package.json package-lock.json; do [ -f "$ROOT/$f" ] && cp "$ROOT/$f" "$SB/"; done
[ -d "$ROOT/assets" ] && cp -r "$ROOT/assets" "$SB/"
[ -d "$ROOT/node_modules" ] && ln -s "$ROOT/node_modules" "$SB/node_modules"
mkdir -p "$SB/data"
touch "$SB/data/.smoke-sandbox"

# Fixtures are generated inside the sandbox (ROOT in the generator is
# the sandbox, not the real tree).
( cd "$SB" && node "$SB/tools/smoke-fixtures.js" ) >"$SB/fixtures.log" 2>&1 || { cat "$SB/fixtures.log" >&2; echo "RUNNER FAIL: fixture generation" >&2; exit 3; }

PORT="$(node -e "const s=require('net').createServer().listen(0,'127.0.0.1',()=>{console.log(s.address().port);s.close();})")"
CARD_STUB_PORT="$PORT" node "$SB/tools/card-stub.js" >"$SB/stub.log" 2>&1 &
STUB_PID=$!
for _ in $(seq 1 50); do grep -q listening "$SB/stub.log" 2>/dev/null && break; sleep 0.1; done
export CARD_API_URL="http://127.0.0.1:$PORT"
export SMOKE_OFFLINE=1

RC=0
SUMMARY=""
run_suite() {
  local name="$1" file="$2" t0 t1 rc line
  echo "=== suite: $name ($file) ==="
  t0=$(date +%s.%N)
  ( cd "$SB" && node "$SB/tools/$file" ) 2>&1 | tee "$SB/$name.log"
  rc=${PIPESTATUS[0]}
  t1=$(date +%s.%N)
  line="$(grep '^RESULT:' "$SB/$name.log" | tail -1)"
  SUMMARY="$SUMMARY
$name: ${line:-no RESULT line (exit $rc)} | wall $(printf '%.1f' "$(echo "$t1 - $t0" | bc)")s | exit $rc"
  [ "$rc" -ne 0 ] && RC=1
  return 0
}

[ "$WHICH" = all ] || [ "$WHICH" = card ] && run_suite card smoke-cards.js
[ "$WHICH" = all ] || [ "$WHICH" = logic ] && run_suite logic smoke-logic.js

echo
echo "=== runner summary ==="
echo "$SUMMARY"
exit "$RC"
