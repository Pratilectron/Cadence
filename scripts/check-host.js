const { existsSync } = require('fs');
const { join } = require('path');
const { getModuleSearchPaths, getAppRoot } = require('../lib/module-paths');

const ROOT = getAppRoot();
const checks = [
  ['server.js', join(ROOT, 'server.js')],
  ['vendor/sql-asm.js', join(ROOT, 'vendor', 'sql-asm.js')],
  ['package.json', join(ROOT, 'package.json')],
];

const packages = ['busboy', 'dotenv', 'socket.io', 'better-sqlite3', 'sharp', 'sql.js'];

console.log('[check-host] app root:', ROOT);
console.log('[check-host] module paths:', getModuleSearchPaths().join('\n  '));

for (const [label, filePath] of checks) {
  console.log(`[check-host] ${label}:`, existsSync(filePath) ? 'OK' : 'MISSING');
}

for (const name of packages) {
  try {
    console.log(`[check-host] ${name}:`, require.resolve(name));
  } catch {
    console.log(`[check-host] ${name}: not installed (optional unless noted)`);
  }
}

try {
  require('../lib/sqlite-driver');
  console.log('[check-host] sqlite-driver: OK');
} catch (err) {
  console.error('[check-host] sqlite-driver FAILED:', err.message);
  process.exit(1);
}

console.log('[check-host] done');
