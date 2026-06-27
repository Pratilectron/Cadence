const crypto = require('crypto');
const {
  insertAuthSession,
  getAuthSession,
  deleteAuthSession,
  deleteAuthSessionsForUser,
  countAuthSessions,
  clearAuthSessions,
  getUserById,
} = require('./db');

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const now = Date.now();
  insertAuthSession(token, userId, now, now + SESSION_TTL_MS);
  return token;
}

function getSessionUser(token) {
  if (!token) return null;
  const row = getAuthSession(token);
  if (!row) return null;
  if (row.expires_at <= Date.now()) {
    deleteAuthSession(token);
    return null;
  }
  const user = getUserById(row.user_id);
  return user ? { id: user.id, username: user.username } : null;
}

function revokeSession(token) {
  if (token) deleteAuthSession(token);
}

function revokeAllUserSessions(userId) {
  if (userId) deleteAuthSessionsForUser(userId);
}

function getSessionRecord(token) {
  const row = getAuthSession(token);
  if (!row || row.expires_at <= Date.now()) return null;
  return { userId: row.user_id, createdAt: row.created_at };
}

const sessions = {
  get size() {
    return countAuthSessions();
  },
  get(token) {
    return getSessionRecord(token);
  },
  set(token, value) {
    if (!token || !value?.userId) return;
    insertAuthSession(token, value.userId, value.createdAt || Date.now(), Date.now() + SESSION_TTL_MS);
  },
  clear() {
    clearAuthSessions();
  },
  delete(token) {
    deleteAuthSession(token);
  },
};

module.exports = {
  createSession,
  getSessionUser,
  revokeSession,
  revokeAllUserSessions,
  sessions,
};
