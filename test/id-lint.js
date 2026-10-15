// Lint test: no hardcoded Discord IDs in src/ (except config-adjacent files).
// All 17-19 digit IDs must live in config.json. utils.js may have fallbacks.
// Run with: node test/id-lint.js
const fs = require('node:fs');
const path = require('node:path');

const SRC_DIR = path.join(__dirname, '..', 'src');
// Files allowed to contain hardcoded IDs (config-adjacent, fallbacks, or one-time setup scripts)
const ALLOWLIST = new Set(['config.js', 'utils.js', 'setup-phase2.js', 'setup-structure.js']);

const ID_PATTERN = /\b\d{17,19}\b/g;

let violations = [];

for (const file of fs.readdirSync(SRC_DIR)) {
  if (!file.endsWith('.js')) continue;
  if (ALLOWLIST.has(file)) continue;
  const content = fs.readFileSync(path.join(SRC_DIR, file), 'utf8');
  const lines = content.split('\n');
  lines.forEach((line, i) => {
    // Skip comments
    const code = line.split('//')[0];
    const matches = code.match(ID_PATTERN);
    if (matches) {
      violations.push(`${file}:${i + 1}: ${matches.join(', ')}`);
    }
  });
}

if (violations.length > 0) {
  console.log('HARDCODED ID VIOLATIONS:');
  violations.forEach((v) => console.log(`  ${v}`));
  console.log(`\n${violations.length} violation(s). Move these IDs to config.json.`);
  process.exit(1);
} else {
  console.log('ID lint passed: no hardcoded Discord IDs in src/.');
}
