#!/usr/bin/env bash
# CI port of the local pre-commit and commit-msg privacy guards.
#
# Usage:
#   ci-guard.sh --diff FILE [--messages FILE]
#   ci-guard.sh --range REV_RANGE [--messages FILE]   (run inside a git checkout)
#   (with --range and no --messages, commit messages come from git log)
#
# Blocklist: path in the BLOCKLIST_FILE env var. If unset or missing, a loud
# warning is printed, the name scan is skipped, and every other check still
# runs (degraded mode). Exit status is non-zero if anything is blocked.
#
# Checks (added lines only): blocklist names, secret-shaped strings, banned
# added files (*.bak *.old *.db *.sqlite, .env), absolute home paths, plus an
# AI co-author trailer in commit messages. The sanctioned clan domain and the
# clan Ko-fi page URL are stripped before the name scan; nothing else is.
# The sk- pattern needs 16+ token characters so words like "mask-image" pass.
set -u

diff_file=""
range=""
msg_file=""
while [ $# -gt 0 ]; do
  case "$1" in
    --diff)     diff_file=${2:-}; shift 2 ;;
    --range)    range=${2:-}; shift 2 ;;
    --messages) msg_file=${2:-}; shift 2 ;;
    *) echo "ci-guard: unknown argument: $1" >&2; exit 2 ;;
  esac
done

fail=0
say() { printf '%s\n' "$*" >&2; }

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

if [ -n "$range" ]; then
  git diff -U0 --no-color "$range" > "$tmp/range.diff" || { say "ci-guard: git diff failed for $range"; exit 2; }
  diff_file=$tmp/range.diff
  if [ -z "$msg_file" ]; then
    git log --format='%B' "$range" > "$tmp/range.msgs" 2>/dev/null || true
    msg_file=$tmp/range.msgs
  fi
fi
if [ -z "$diff_file" ] || [ ! -f "$diff_file" ]; then
  say "ci-guard: need --diff FILE or --range REV_RANGE"
  exit 2
fi

# ---------- blocklist ----------
patterns_file=""
if [ -n "${BLOCKLIST_FILE:-}" ] && [ -f "$BLOCKLIST_FILE" ]; then
  patterns_file=$tmp/patterns
  sed -e 's/\r$//' -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' \
      -e '/^$/d' -e '/^#/d' "$BLOCKLIST_FILE" > "$patterns_file"
else
  say "ci-guard: WARNING - blocklist missing (BLOCKLIST_FILE=${BLOCKLIST_FILE:-unset}); name scan skipped (degraded mode), other checks still run."
fi

strip_exceptions() {
  sed -e 's/oath''forsaken[.]cc//gi' -e 's|ko-fi[.]com/oath''forsaken||gi'
}

secret_re='gh''p_|gh''o_|github''_pat_|sk-[A-Za-z0-9_-]{16,}|xox[baprs]-|AK''IA|--''---BEGIN|discord[.]com/api/web''hooks/'

scan_file() {
  local f=$1 added_file=$2
  [ -s "$added_file" ] || return 0

  if grep -qE "$secret_re" "$added_file"; then
    say "ci-guard: BLOCKED - secret-shaped string in added lines: $f"
    fail=1
  fi
  if grep -oE '/home/[A-Za-z0-9._+-]+' "$added_file" | grep -qvx '/home/user'; then
    say "ci-guard: BLOCKED - absolute home path in added lines: $f"
    fail=1
  fi
  if grep -qiE 'C:\\Users\\' "$added_file"; then
    say "ci-guard: BLOCKED - absolute home path in added lines: $f"
    fail=1
  fi
  if [ -n "$patterns_file" ]; then
    if strip_exceptions < "$added_file" | grep -qiF -f "$patterns_file"; then
      say "ci-guard: BLOCKED - blocklisted name in added lines: $f"
      fail=1
    fi
  fi
}

# ---------- walk the unified diff ----------
cur_file=""
is_new=0
in_hunk=0
added=$tmp/added
: > "$added"
flush() {
  if [ -n "$cur_file" ]; then
    scan_file "$cur_file" "$added"
  fi
  : > "$added"
}
while IFS= read -r line || [ -n "$line" ]; do
  if [ "${line#diff --git }" != "$line" ]; then
    flush
    cur_file=""; is_new=0; in_hunk=0
    continue
  fi
  if [ "$in_hunk" -eq 0 ]; then
    case "$line" in
      "--- /dev/null") is_new=1 ;;
      "+++ b/"*)
        cur_file=${line#+++ b/}
        cur_file=${cur_file%%$'\t'*}
        if [ "$is_new" -eq 1 ]; then
          case "$(basename "$cur_file")" in
            *.bak|*.old|*.db|*.sqlite)
              say "ci-guard: BLOCKED - banned file type added: $cur_file"; fail=1 ;;
            .env)
              say "ci-guard: BLOCKED - .env file added: $cur_file (only .env.example may be committed)"; fail=1 ;;
          esac
        fi
        ;;
      "@@"*) in_hunk=1 ;;
    esac
    continue
  fi
  case "$line" in
    "@@"*) ;;
    "+"*) printf '%s\n' "${line:1}" >> "$added" ;;
  esac
done < "$diff_file"
flush

# ---------- commit messages ----------
if [ -n "$msg_file" ] && [ -f "$msg_file" ]; then
  if [ -n "$patterns_file" ]; then
    if strip_exceptions < "$msg_file" | grep -qiF -f "$patterns_file"; then
      say "ci-guard: BLOCKED - blocklisted name in commit message."
      fail=1
    fi
  fi
  if grep -iE '^[[:space:]]*co-authored-by:' "$msg_file" | grep -qiE 'claude|\bai\b'; then
    say "ci-guard: BLOCKED - AI co-author trailer in commit message."
    fail=1
  fi
fi

if [ "$fail" -eq 0 ]; then
  echo "ci-guard: OK"
fi
exit $fail
