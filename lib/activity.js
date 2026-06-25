const { appendFileSync, mkdirSync, readFileSync, existsSync } = require('fs');
const { join } = require('path');

const LOG_DIR = join(__dirname, '..', 'data', 'logs');
const LOG_PATH = join(LOG_DIR, 'activity.jsonl');

mkdirSync(LOG_DIR, { recursive: true });

function logActivity(entry) {
  const row = {
    id: entry.id || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    ts: Date.now(),
    event: entry.event,
    userId: entry.userId || null,
    username: entry.username || null,
    room: entry.room || null,
    meta: entry.meta || {},
  };
  appendFileSync(LOG_PATH, `${JSON.stringify(row)}\n`, 'utf8');
  return row;
}

function readActivity({ room, limit = 80 } = {}) {
  if (!existsSync(LOG_PATH)) return [];
  const lines = readFileSync(LOG_PATH, 'utf8').trim().split('\n').filter(Boolean);
  let rows = lines.map((line) => {
    try {
      return JSON.parse(line);
    } catch {
      return null;
    }
  }).filter(Boolean);

  if (room) rows = rows.filter((r) => r.room === room || r.meta?.fromRoom === room || r.meta?.toRoom === room);
  return rows.slice(-limit).reverse();
}

module.exports = { logActivity, readActivity, LOG_PATH };
