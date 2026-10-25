// Shared Wise Old Man API limiter, enforcing WOM's Oct 25, 2026 rate limits
// on LIVE requests only. Cached reads never touch this module.
//
// Caps (announced Oct 25, 2026, after API abuse):
//   without API key: 20/min, 500/hour, 3,000/day
//   with API key:    100/min, 20,000/day (no hourly cap announced)
// The caps adapt to the environment: presence of WOM_API_KEY selects the
// keyed caps, absence selects the keyless caps. Callers never pick caps.
//
// Behavior:
// - Requests queue (bounded): a slot waits until every window has room.
//   A wait longer than MAX_WAIT_MS fails fast with a rateLimited error
//   instead of hanging a Discord interaction for hours (day-cap case).
//   Callers already degrade to cached data on failure.
// - On a 429, the failed request is NOT retried: a block is recorded
//   (Retry-After, growing exponentially on consecutive 429s, capped at 1h)
//   and the next call re-enters the queue after the block. Never hammer.
// - Request timestamps persist to data/wom-rate.json (the bot's mounted
//   data dir, so counters survive restarts and deploys). The 429 block
//   itself is in-memory only: blocks are transient by nature.
const fs = require('fs');
const path = require('path');
const { atomicWrite } = require('./store');

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 3600 * 1000;
const DAY_MS = 24 * 3600 * 1000;
const MAX_WAIT_MS = 120 * 1000;
const MAX_BACKOFF_MS = 3600 * 1000;

function capsFor(keyed) {
  return keyed
    ? { minute: 100, hour: Infinity, day: 20000 }
    : { minute: 20, hour: 500, day: 3000 };
}

// Floor between live request starts, in addition to the window caps.
function minGapFor(keyed) {
  return keyed ? 600 : 1000;
}

function createLimiter(opts = {}) {
  const rateFile = opts.rateFile || path.join(__dirname, '..', 'data', 'wom-rate.json');
  const nowFn = opts.now || (() => Date.now());
  const sleepFn = opts.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));

  let stamps = [];
  try {
    const saved = JSON.parse(fs.readFileSync(rateFile, 'utf8'));
    if (saved && Array.isArray(saved.stamps)) {
      stamps = saved.stamps.filter((t) => typeof t === 'number');
    }
  } catch {
    stamps = [];
  }
  let lastLiveAt = 0;
  let blockedUntil = 0;
  let consecutive429 = 0;

  function caps() {
    return capsFor(Boolean(process.env.WOM_API_KEY));
  }
  function minGap() {
    return minGapFor(Boolean(process.env.WOM_API_KEY));
  }
  function prune(now) {
    const cutoff = now - DAY_MS;
    if (stamps.length && stamps[0] <= cutoff) stamps = stamps.filter((t) => t > cutoff);
  }
  function persist() {
    try {
      fs.mkdirSync(path.dirname(rateFile), { recursive: true });
      atomicWrite(rateFile, { stamps });
    } catch {
      // Counters stay in memory if the write fails; windows still hold.
    }
  }

  // Wait until a live request fits every window, then record it.
  async function takeSlot() {
    for (;;) {
      const now = nowFn();
      prune(now);
      const c = caps();
      let wait = Math.max(0, minGap() - (now - lastLiveAt), blockedUntil - now);
      const windows = [
        [MINUTE_MS, c.minute],
        [HOUR_MS, c.hour],
        [DAY_MS, c.day],
      ];
      for (const [span, cap] of windows) {
        if (!Number.isFinite(cap)) continue;
        const inWindow = stamps.filter((t) => t > now - span);
        if (inWindow.length >= cap) {
          const oldest = Math.min(...inWindow);
          wait = Math.max(wait, oldest + span - now + 50);
        }
      }
      if (wait <= 0) {
        lastLiveAt = now;
        stamps.push(now);
        persist();
        return;
      }
      if (wait > MAX_WAIT_MS) {
        const err = new Error(
          `WOM rate cap reached, skipping live request (wait ${Math.round(wait / 1000)}s)`
        );
        err.rateLimited = true;
        throw err;
      }
      await sleepFn(wait);
    }
  }

  // Record a 429: honor Retry-After, growing on consecutive 429s.
  function noteRateLimited(retryAfterSecs) {
    const base =
      Number.isFinite(retryAfterSecs) && retryAfterSecs > 0 ? retryAfterSecs * 1000 : 60 * 1000;
    consecutive429 += 1;
    const backoff = Math.min(base * Math.pow(2, consecutive429 - 1), MAX_BACKOFF_MS);
    blockedUntil = Math.max(blockedUntil, nowFn() + backoff);
  }

  function noteSuccess() {
    consecutive429 = 0;
  }

  return {
    takeSlot,
    noteRateLimited,
    noteSuccess,
    caps,
    _state: () => ({ stamps: [...stamps], blockedUntil, consecutive429 }),
  };
}

module.exports = { createLimiter, capsFor, minGapFor };
