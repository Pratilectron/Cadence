#!/usr/bin/env node
'use strict';

const { spawn } = require('child_process');
const path = require('path');

require('./free-port.js');

const serverPath = path.join(__dirname, '..', 'server.js');
const child = spawn(process.execPath, [serverPath], {
  stdio: 'inherit',
  env: process.env,
  cwd: path.join(__dirname, '..'),
});

child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 0);
});
