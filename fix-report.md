# Security audit fix batch: report

Branch `job/security-audit-fixes` off main (6d30462). Not merged, not deployed.
All changes are inside the Joint Sheet touch list.

## Per item

| # | Finding | Status | Notes |
|---|---|---|---|
| 1 | H1+M1 mentions | Done | Client default `allowedMentions: { parse: ['users'] }` in index.js. `sendFillPing` now sends `{content, allowedMentions: { users: <team member ids> }}`. |
| 2 | M6 npm audit | Done | `npm audit fix`: 0 vulnerabilities left. Lockfile only, package.json unchanged. qs 6.16.0 -> 6.17.1, undici 6.29.0 -> 6.29.1. |
| 3 | H2 deploy gate | Done, one deviation | guards, smoke and docker are now jobs in `docker.yml`; `docker` has `needs: [guards, smoke]`. `guards.yml` and `smoke.yml` deleted. Same image tags. **Deviation:** the brief says keep triggers push-to-main + workflow_dispatch. Doing that literally would drop the guards check on pull requests and feature-branch pushes (the old guards.yml ran on every push and PR). So the workflow triggers on `push`, `pull_request`, `workflow_dispatch`; guards runs on all of them, while smoke and docker run only on push to main and dispatch (same as before). To follow the brief literally, change the `on:` block and drop the `if:` lines. Docker job concurrency (cancel-in-progress) is now job-level so it cannot cancel guards. |
| 4 | H3 rollback sticks | Done | Rollback appends the rejected digest to `/opt/oath-forsaken-bot/image-blocked`; deploy exits 0 if the candidate digest is in it. A failed auto-deploy also blocks its digest. Pinning a digest via rollback removes it from the blocked file, so running rollback twice still swaps back. flock on `/run/bot-deploy.lock`: deploy takes it non-blocking and exits 0 if busy; rollback waits up to 300s on the same lock. |
| 5 | M4 health check | Done | After "Logged in as", waits 90s more (`SETTLE`), then requires NRestarts unchanged (baseline read right after the restart), container running, and exactly one "Logged in as" since deploy start. Applies to the deploy and its rollback restart. A good deploy now takes about 90s longer. `bot-rollback.sh`'s own health check is unchanged (not in the brief). Only `bash -n` checked; not run against real systemd/docker. |
| 6 | M2 stores | Done | Empty state only on ENOENT, otherwise throw, in teams.js (teams, rsn-links), bounty.js, plugin-connect.js, bump-tool.js, website-controls.js, store.js. store.js no longer renames bad files to `.corrupt-*`. Side effect: read-only callers of those loaders (not just mutations) now throw on a corrupt file instead of seeing empty data. |
| 7 | M3 pinning | Done | All six actions pinned to full commit SHAs with `# vN` comments, resolved from the tag refs (all lightweight tags, type `commit`). The `node:22-alpine` base is pinned by manifest-list digest `sha256:1314fb30...` in both FROM lines. Tags are floating majors, so the comments say v4/v3/v5/v6. `gh api` was very slow here, so the last SHAs were read with the same API via curl. |
| 8 | M7 team spam | Done | index.js: wizard steps stay exempt; `team:join:` and `team:leave:` are under the 2s cooldown. Exempt taps no longer stamp the cooldown clock, so a wizard tap does not block a following join. teams.js: `refreshListing` coalesces per message (one in flight, at most one queued, newest snapshot wins). The wrapper now swallows and logs render errors (returns null) instead of propagating. |
| 9 | L1 tenure | **Skipped** | Implemented (count only RSNs in `entry.verified`; link records carry no staff-linked marker), then reverted. It broke the smoke suite: `standing: backfill seeds the WOM-derived member` fails, because the smoke fixture's rsn-links entries have no `verified`. The fixture generator and test are in `tools/`, outside the touch list. With the new H2 gate a failing smoke blocks image builds, so I did not ship it. **Needs:** a `verified: [...]` entry for the WOM member in `tools/smoke-fixtures.js`, then re-apply the membership.js change in `computeMemberIds`. Note `seedBackfill` and `isMember` use the same function. |
| 10 | L2 handler checks | Done | `/roster` and `/setup-team-panel`: isStaff check. `/setup-cc-checklist`: isStaff OR CC Updater role (same gate as its buttons). |
| 11 | L3 bounty proof | Done | Public-thread fallback removed. If the private thread fails the member gets the existing "Could not open a proof thread. Tell staff." |
| 12 | L4 client error | Done | `client.on(Events.Error, ...)` logs. |
| 13 | L5 showoff | Done | `Object.hasOwn` on ACTIVITIES, and also on KC_ACTIVITIES (same prototype issue on the second lookup). |
| 14 | L6 races/spam | Done | tickets.js: in-memory claim set per guild+user around ticket creation, released in `finally`. polls.js: one pending draft per user, refused politely; this needed a small `findPendingPolls` helper in store.js (touch list). suggestions.js: cooldown rechecked at modal submit. |
| 15 | Bump button gate | Done | Only staff or `BUMP_TOOL_PING_USER_ID` can use I-bumped; others get an ephemeral refusal. |

## Verification

**Smoke recipe** (`node tools/smoke-fixtures.js`, card stub on 127.0.0.1:8799, `node tools/smoke-cards.js`):
- Final branch (L1 reverted): `RESULT: 461 pass, 0 fail`.
- Untouched main (origin/main in a temp worktree): `RESULT: 461 pass, 0 fail`.
- The first branch run, with L1 in, failed 1 test (`standing: backfill seeds the WOM-derived member`). Main does not fail it, so L1 caused it. That is why L1 was skipped.
- The suite takes about 5.5 minutes. My first run hit my own 300s timeout (exit 124) and is not a result.
- Not run: the `node test/*.js` suites (not in the brief), and nothing was run against a live Discord connection. The edited handlers were only syntax-checked, apart from what the smoke suite covers.

**VibeDrift** (`npx -y @vibedrift/cli scan --json --no-codedna`, branch vs main):
- 126 findings on both. After normalising line numbers and counts, no new finding types: 2 rolled-up findings differ only in which files they list.
- Composite score 83.2 (main) -> 81.6 (branch). Architectural consistency 13.9 -> 13.4. The "throws on error vs null sentinels" return-shape drift finding now counts 8 files that throw, which now includes plugin-connect.js. This is a direct result of M2, which the brief asks for.

**Secret-pattern grep** (staged diff, added lines; `sk-`, `ghp_`, `xox`, `AKIA`, `-----BEGIN`, `DISCORD_TOKEN=<value>`): no matches.

**Diff stat vs origin/main:** 20 files, 324 insertions, 153 deletions. All on the touch list, and package.json is untouched.
```
 .github/workflows/docker.yml | 110 +++++++--
 .github/workflows/guards.yml |  55 -----
 .github/workflows/smoke.yml  |  46 -----
 Dockerfile                   |   4 +-
 deploy/bot-deploy.sh         |  52 ++++-
 deploy/bot-rollback.sh       |  25 +++
 package-lock.json            |  12 +-
 src/bounty.js                |  10 +-
 src/bump-tool.js             |  11 +-
 src/cc-checklist.js          |   7 +
 src/index.js                 |  13 +-
 src/plugin-connect.js        |   5 +-
 src/polls.js                 |   8 +
 src/roster.js                |   6 +-
 src/showoff.js               |   4 +-
 src/store.js                 |  14 +-
 src/suggestions.js           |   9 +
 src/teams.js                 |  63 ++++-
 src/tickets.js               |  18 +++
 src/website-controls.js      |   5 +-
```
(plus this report, fix-report.md, added in the same commit)

## Follow-ups for the lead
- Item 9 (L1) as above.
- With guards and smoke merged into the docker workflow, any branch protection that requires the old `privacy-guards` or `smoke` check names will need updating to the new job names (`guards`, `smoke`).
- Audit items not in this brief and untouched: M5 (plugin verification), the recruit.js `@everyone` instance (now covered by the client default), Dependabot security updates, backups.
