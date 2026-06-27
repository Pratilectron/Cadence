const { spawnSync } = require('child_process');
const { join } = require('path');

const ROOT = join(__dirname, '..');
const NATIVE_MODULES = ['better-sqlite3', 'sharp'];

function rebuild(moduleName) {
  const result = spawnSync(
    process.platform === 'win32' ? 'npm.cmd' : 'npm',
    ['rebuild', moduleName, '--build-from-source=false'],
    { cwd: ROOT, stdio: 'inherit' },
  );
  if (result.status !== 0) {
    console.warn(`[postinstall] ${moduleName} rebuild skipped (sql.js fallback available for SQLite)`);
  }
}

function main() {
  for (const moduleName of NATIVE_MODULES) {
    try {
      require.resolve(moduleName);
    } catch {
      continue;
    }
    rebuild(moduleName);
  }
}

main();
