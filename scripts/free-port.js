#!/usr/bin/env node
'use strict';

const { execSync } = require('child_process');

const port = Number(process.env.PORT) || 3000;

function log(message) {
  console.log(`[restart] ${message}`);
}

function killPid(pid) {
  if (!pid || pid === String(process.pid)) return false;
  try {
    if (process.platform === 'win32') {
      execSync(`taskkill /PID ${pid} /F`, { stdio: 'ignore' });
    } else {
      execSync(`kill -9 ${pid}`, { stdio: 'ignore' });
    }
    return true;
  } catch {
    return false;
  }
}

function pidsOnPortWin(targetPort) {
  const pids = new Set();
  try {
    const output = execSync('netstat -ano -p tcp', { encoding: 'utf8' });
    const portToken = `:${targetPort}`;
    for (const line of output.split(/\r?\n/)) {
      if (!line.includes('LISTENING')) continue;
      const cols = line.trim().split(/\s+/);
      const local = cols[1] || '';
      const pid = cols[cols.length - 1];
      if (local.endsWith(portToken) && /^\d+$/.test(pid) && pid !== '0') {
        pids.add(pid);
      }
    }
  } catch {
    // netstat unavailable
  }
  return [...pids];
}

function pidsOnPortUnix(targetPort) {
  try {
    const output = execSync(`lsof -ti tcp:${targetPort} -sTCP:LISTEN`, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return output
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter((pid) => /^\d+$/.test(pid) && pid !== String(process.pid));
  } catch {
    return [];
  }
}

function freePort(targetPort) {
  const pids = process.platform === 'win32'
    ? pidsOnPortWin(targetPort)
    : pidsOnPortUnix(targetPort);

  if (!pids.length) {
    log(`port ${targetPort} is free`);
    return;
  }

  for (const pid of pids) {
    if (killPid(pid)) log(`stopped PID ${pid} on port ${targetPort}`);
  }
}

freePort(port);
