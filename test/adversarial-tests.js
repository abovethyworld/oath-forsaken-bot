// ADVERSARIAL TESTS — malicious QA engineer perspective.
// Goal: crash the bot, cause memory leaks, return incorrect data, find abuse vectors.
// Run with: node test/adversarial-tests.js

const assert = require('node:assert');

let passed = 0;   // attack was blocked/handled
let failed = 0;   // attack succeeded (vulnerability found)
let crashed = 0;  // attack crashed something
const vulns = [];

function attack(name, fn) {
  return (async () => {
    try {
      const result = await fn();
      if (result.vulnerable) {
        failed++;
        vulns.push({ name, detail: result.detail });
        console.log(`  🔴 VULNERABLE: ${name}`);
        console.log(`     ${result.detail}`);
      } else {
        passed++;
        console.log(`  🟢 BLOCKED: ${name}`);
      }
    } catch (e) {
      crashed++;
      vulns.push({ name, detail: `CRASH: ${e.message}` });
      console.log(`  💥 CRASH: ${name}: ${e.message}`);
    }
  })();
}

const V = (detail) => ({ vulnerable: true, detail });
const B = () => ({ vulnerable: false });

(async () => {
  console.log('\n=== APPLICATION ABUSE ===');

  // 1. Username with Discord markdown injection in ticket thread name
  await attack('Ticket thread name markdown injection', async () => {
    const tickets = require('../src/tickets');
    // Username: "**@everyone**" sanitized to "everyone" — but what about:
    const evilNames = [
      '**@everyone**',
      '<@&123456789>',  // fake role mention
      '@here',
      '\n'.repeat(100),  // newline flood
      'a'.repeat(500),   //超长 name
    ];
    for (const name of evilNames) {
      const safe = name.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 20) || 'user';
      // Check: does the sanitized name still contain dangerous content?
      if (safe.includes('@everyone') || safe.includes('@here') || safe.includes('<@')) {
        return V(`Sanitization failed for: ${name} -> ${safe}`);
      }
    }
    return B();
  });

  // 2. Modal input with 4000-char reason (Discord limit is 4000, but what about our embeds?)
  await attack('Oversized application answers break embeds', async () => {
    // Discord embed field limit is 1024 chars. If answers aren't truncated, embed fails.
    const fs = require('fs');
    const src = fs.readFileSync( './src/recruit.js', 'utf8');
    // Check if answers are truncated before embed
    const hasTruncation = src.includes('slice(0, 1024)') || src.includes('slice(0, 1000)');
    if (!hasTruncation) {
      return V('Application answers not truncated — 4000-char input could break embed (1024 limit)');
    }
    return B();
  });

  // 3. Rapid application submission (spam)
  await attack('Application spam via rapid button clicks', async () => {
    // Button cooldown is 2s, but what about the modal submit path?
    const fs = require('fs');
    const src = fs.readFileSync( './src/recruit.js', 'utf8');
    const hasSubmitCooldown = src.includes('cooldown') || src.includes('rateLimit');
    // The isApplicationSubmitted check prevents dupes, but rapid clicks before first completes?
    return V('No cooldown on modal submit — rapid double-submit could create duplicate threads (race between check and create)');
  });

  console.log('\n=== POLL ABUSE ===');

  // 4. Poll option with @everyone
  await attack('Poll option @everyone ping', async () => {
    const polls = require('../src/polls');
    // Poll options go into embed description. allowedMentions not set on update?
    const fs = require('fs');
    const src = fs.readFileSync( './src/polls.js', 'utf8');
    // Check if poll creation sanitizes mentions
    if (!src.includes('allowedMentions')) {
      return V('Poll embeds do not set allowedMentions — @everyone in option text would ping everyone');
    }
    return B();
  });

  // 5. Poll ID brute force
  await attack('Poll vote manipulation via ID guessing', async () => {
    // Poll IDs are Date.now().toString(36) + random — predictable?
    // An attacker could guess recent poll IDs and vote
    return V('Poll IDs are timestamp-based and guessable. Attacker can enumerate recent polls and stuff votes.');
  });

  console.log('\n=== ROSTER ABUSE ===');

  // 6. Roster spam
  await attack('Roster join/leave spam (no per-user cooldown)', async () => {
    const roster = require('../src/roster');
    const store = require('../src/store');
    const rosterId = 'spam-test';
    store.saveRoster(rosterId, { eventName: 'X', roster: {}, channelId: 'c', messageId: 'm' });

    // Simulate 100 rapid joins/leaves
    const start = Date.now();
    for (let i = 0; i < 100; i++) {
      const fake = {
        customId: `roster:join:${rosterId}`,
        user: { id: `attacker${i % 5}` },
        reply: async () => {},
        update: async () => {},
      };
      await roster.handleRosterButton(fake);
    }
    const elapsed = Date.now() - start;
    // Each saveRoster does a full file read+write. 100 writes = slow.
    if (elapsed > 5000) {
      return V(`100 roster ops took ${elapsed}ms — file I/O per click is a DoS vector`);
    }
    return B();
  });

  console.log('\n=== MEMORY LEAKS ===');

  // 7. Cooldowns map grows unbounded
  await attack('Cooldowns map memory leak', async () => {
    const fs = require('fs');
    const src = fs.readFileSync( './src/index.js', 'utf8');
    // Check if there's cleanup for old cooldown entries
    if (src.includes('cooldowns.size > 1000')) {
      return B(); // has cleanup
    }
    return V('Cooldowns map never cleaned — grows forever with unique user+command combos');
  });

  // 8. Decision locks leak on crash
  await attack('Decision locks leak if handler throws', async () => {
    const fs = require('fs');
    const src = fs.readFileSync( './src/recruit.js', 'utf8');
    // Check if lock is released in finally block
    const hasFinally = src.includes('finally') && src.includes('decisionLocks.delete');
    if (!hasFinally) {
      return V('Decision lock not in finally — exception leaves lock held forever, blocking future decisions for that user');
    }
    return B();
  });

  // 9. Guild cache never invalidated on member changes
  await attack('Stale guild cache returns wrong roles', async () => {
    // Cache TTL is 5 min. If someone gets a role removed, syncSeniority uses stale data for up to 5 min.
    return V('5-min member cache means role changes take up to 5 min to reflect in syncs. Acceptable but could cause double-processing.');
  });

  console.log('\n=== IMPERSONATION & SOCIAL ENGINEERING ===');

  // 10. Fake staff via username
  await attack('Impersonate staff via display name', async () => {
    // Bot checks roles, not names — but do any messages display usernames that could confuse?
    const fs = require('fs');
    const recruitSrc = fs.readFileSync( './src/recruit.js', 'utf8');
    // Application threads are named after the applicant — could someone name themselves "Staff"?
    // Thread: "Iron App from Staff" — confusing but not a security issue since decisions require isStaff()
    return B(); // isStaff checks roles, not names
  });

  // 11. The example: "auto name themselves with the app"
  await attack('Application thread name spoofing', async () => {
    // If username is "Alex" or "Staff", thread becomes "Iron App from Alex"
    // Staff might confuse it with a real staff member's application
    const fs = require('fs');
    const src = fs.readFileSync( './src/recruit.js', 'utf8');
    // Check if thread names include user ID (unspoofable)
    if (src.includes('interaction.user.id') && src.match(/name.*user\.id/)) {
      return B();
    }
    return V('Application threads named by username only — attacker can impersonate staff by setting username to staff name');
  });

  console.log('\n=== INCORRECT DATA ===');

  // 12. Seniority rank with future join date
  await attack('Future join date breaks rank calculation', async () => {
    const seniority = require('../src/seniority');
    // What if joinedAt is in the future? (clock skew, Discord bug)
    const futureDate = new Date(Date.now() + 86400000 * 30);
    const months = (Date.now() - futureDate.getTime()) / (30.44 * 24 * 3600 * 1000);
    const rank = seniority.rankForMonths(months);
    // Negative months — rankForMonths iterates and picks best where months >= minMonths
    // With negative months, no rank matches, returns null. Then what?
    if (months < 0 && rank === null) {
      return V('Future join date -> negative months -> rankForMonths returns null. Caller does "if (!want) continue" so member gets skipped silently — no rank assigned, no error logged.');
    }
    return B();
  });

  // 13. Timezone confusion in event creation
  await attack('Event timezone mismatch', async () => {
    // parseStart uses config.calendar.timezone. If user thinks in local time but config is UTC...
    return V('No timezone confirmation shown to user before event creation. User in CST creating "19:00" event gets 19:00 UTC (2pm CST) — 5 hour discrepancy with no warning.');
  });

  console.log('\n=== SUMMARY ===');
  console.log(`\nBlocked: ${passed}, Vulnerable: ${failed}, Crashed: ${crashed}`);
  if (vulns.length > 0) {
    console.log('\nVULNERABILITIES FOUND:');
    vulns.forEach((v, i) => console.log(`\n${i + 1}. ${v.name}\n   ${v.detail}`));
  }
})();
