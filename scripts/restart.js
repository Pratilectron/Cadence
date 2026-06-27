#!/usr/bin/env node
'use strict';

const { spawn } = require('child_process');
const { join } = require('path');
const { isManagedNodeHosting, requestPassengerRestart } = require('./passenger-restart');

const root = join(__dirname, '..');

if (isManagedNodeHosting(root)) {
  requestPassengerRestart(root);
  console.log('[restart] DirectAdmin / Passenger hosting detected.');
  console.log('[restart] Wrote tmp/restart.txt — the panel-managed app will reload.');
  console.log('[restart] If nothing changes within ~30s, click Restart in Setup Node.js App.');
  console.log('[restart] Do not start a second copy with npm start on this server.');
  process.exit(0);
}

require('./free-port.js');

const serverPath = join(root, 'server.js');
const child = spawn(process.execPath, [serverPath], {
  stdio: 'inherit',
  env: process.env,
  cwd: root,
});

child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 0);
});
