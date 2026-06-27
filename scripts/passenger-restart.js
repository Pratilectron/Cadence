#!/usr/bin/env node
'use strict';

const { existsSync, mkdirSync, writeFileSync } = require('fs');
const { join } = require('path');

function isPassengerProcess() {
  return Boolean(process.env.PASSENGER_APP_ENV)
    || typeof globalThis.PhusionPassenger !== 'undefined';
}

function isManagedNodeHosting(cwd = process.cwd()) {
  if (isPassengerProcess()) return true;
  if (process.env.PASSENGER_APP_ROOT) return true;
  if (process.env.PASSENGER_LISTEN_PORT) return true;
  if (/[\\/]domains[\\/][^\\/]+[\\/]public_html/i.test(cwd)) return true;
  return false;
}

function requestPassengerRestart(root = process.cwd()) {
  const tmpDir = join(root, 'tmp');
  mkdirSync(tmpDir, { recursive: true });
  writeFileSync(join(tmpDir, 'restart.txt'), String(Date.now()), 'utf8');
}

module.exports = {
  isPassengerProcess,
  isManagedNodeHosting,
  requestPassengerRestart,
};
