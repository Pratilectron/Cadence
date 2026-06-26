const { spawnSync, execSync, spawn } = require('child_process');
const { existsSync, mkdirSync, writeFileSync, appendFileSync } = require('fs');
const { join } = require('path');

const ROOT = join(__dirname, '..');
const BRANCH = process.env.DEPLOY_BRANCH || 'main';
const LOG_PATH = join(ROOT, 'data', 'logs', 'deploy.log');

function log(line) {
  const msg = `[deploy] ${new Date().toISOString()} ${line}`;
  console.log(msg);
  try {
    mkdirSync(join(ROOT, 'data', 'logs'), { recursive: true });
    appendFileSync(LOG_PATH, `${msg}\n`, 'utf8');
  } catch {
    // logging must not break deploy
  }
}

function run(cmd, args) {
  const result = spawnSync(cmd, args, {
    cwd: ROOT,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  if (result.status !== 0) {
    log(`failed: ${cmd} ${args.join(' ')}`);
    process.exit(result.status || 1);
  }
}

function gitRev(ref) {
  return execSync(`git rev-parse ${ref}`, { cwd: ROOT, encoding: 'utf8' }).trim();
}

function main() {
  process.chdir(ROOT);
  log(`starting (branch ${BRANCH})`);

  run('git', ['fetch', 'origin', BRANCH]);

  let local;
  let remote;
  try {
    local = gitRev('HEAD');
    remote = gitRev(`origin/${BRANCH}`);
  } catch (err) {
    log(`git check failed: ${err.message}`);
    process.exit(1);
  }

  if (local === remote) {
    log(`already up to date (${local.slice(0, 7)})`);
    process.exit(0);
  }

  log(`updating ${local.slice(0, 7)} -> ${remote.slice(0, 7)}`);
  run('git', ['pull', 'origin', BRANCH]);
  run('npm', ['install', '--omit=dev']);

  const tmpDir = join(ROOT, 'tmp');
  mkdirSync(tmpDir, { recursive: true });
  writeFileSync(join(tmpDir, 'restart.txt'), String(Date.now()), 'utf8');

  const head = gitRev('HEAD').slice(0, 7);
  log(`complete at ${head}`);
}

if (require.main === module) {
  main();
}

module.exports = { main, ROOT, BRANCH };
