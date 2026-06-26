#!/usr/bin/env node
/**
 * Blocks accidental commits of secrets. Run manually or as a pre-commit hook:
 *   node scripts/check-secrets.js
 */
const { execSync } = require('child_process');

const BLOCKED_PATTERNS = [
  /^\.env$/,
  /^\.env\./,
  /^data\//,
  /^users\.json$/,
  /^secrets\//,
  /\.pem$/,
  /\.key$/,
  /^credentials(\..*)?\.json$/,
];

const ALLOWED = new Set(['.env.example', 'data/.gitkeep']);

function listStagedFiles() {
  try {
    const out = execSync('git diff --cached --name-only --diff-filter=ACMR', {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

const staged = listStagedFiles();
const blocked = staged.filter((file) => {
  if (ALLOWED.has(file)) return false;
  return BLOCKED_PATTERNS.some((re) => re.test(file.replace(/\\/g, '/')));
});

if (blocked.length) {
  console.error('Commit blocked — sensitive files must not be committed:');
  for (const file of blocked) console.error(`  - ${file}`);
  console.error('\nRemove them from the index: git reset HEAD -- <file>');
  process.exit(1);
}

console.log('Secret check passed.');
