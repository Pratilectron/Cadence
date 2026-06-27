const { spawnSync } = require('child_process');
const { existsSync } = require('fs');
const { join } = require('path');

const ROOT = join(__dirname, '..');
const NATIVE_MODULES = ['better-sqlite3', 'sharp'];

function npmCmd() {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

function rebuild(moduleName) {
  console.log(`[install-native] rebuilding ${moduleName} for Node ${process.version} (${process.platform}/${process.arch})`);
  const result = spawnSync(npmCmd(), ['rebuild', moduleName, '--build-from-source=false'], {
    cwd: ROOT,
    stdio: 'inherit',
    env: process.env,
  });
  if (result.status !== 0) {
    console.warn(`[install-native] ${moduleName} rebuild failed (exit ${result.status || 1})`);
    return false;
  }
  return true;
}

function verify(moduleName) {
  try {
    if (moduleName === 'better-sqlite3') {
      const Database = require('better-sqlite3');
      const db = new Database(':memory:');
      db.close();
      console.log(`[install-native] ${moduleName}: OK`);
      return true;
    }
    require(moduleName);
    console.log(`[install-native] ${moduleName}: OK`);
    return true;
  } catch (err) {
    console.warn(`[install-native] ${moduleName}: ${err.message}`);
    return false;
  }
}

function main() {
  process.chdir(ROOT);
  console.log(`[install-native] app root: ${ROOT}`);
  console.log(`[install-native] node: ${process.version}`);

  const nodeModules = join(ROOT, 'node_modules');
  if (!existsSync(nodeModules)) {
    console.error('[install-native] node_modules missing — run npm install first.');
    process.exit(1);
  }

  let ok = 0;
  for (const moduleName of NATIVE_MODULES) {
    try {
      require.resolve(moduleName);
    } catch {
      console.warn(`[install-native] ${moduleName} not installed — run npm install`);
      continue;
    }
    if (rebuild(moduleName)) ok += 1;
    verify(moduleName);
  }

  if (!ok) {
    console.warn('[install-native] no native modules rebuilt; bundled sql.js will be used for SQLite.');
  }
}

main();
