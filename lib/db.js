const { existsSync, mkdirSync, readFileSync } = require('fs');
const { join } = require('path');
const { openDatabase } = require('./sqlite-driver');

const ROOT = join(__dirname, '..');
const DATA_DIR = join(ROOT, 'data');
const DB_FILE = process.env.DATABASE_PATH || join(DATA_DIR, 'cadence.db');

const LEGACY_PATHS = {
  users: join(DATA_DIR, 'users.json'),
  legacyUsers: join(ROOT, 'users.json'),
  settings: join(DATA_DIR, 'settings.json'),
  rooms: join(DATA_DIR, 'rooms.json'),
  manifest: join(DATA_DIR, 'uploads-manifest.json'),
  emojis: join(DATA_DIR, 'custom-emojis.json'),
  activity: join(DATA_DIR, 'logs', 'activity.jsonl'),
};

let db = null;
let initPromise = null;

function rowToUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    username: row.username,
    algo: row.algo,
    passwordHash: row.password_hash,
    salt: row.salt,
    superAdmin: Boolean(row.super_admin),
    displayName: row.display_name || '',
    bio: row.bio || '',
    preferences: JSON.parse(row.preferences || '{}'),
    createdAt: row.created_at,
  };
}

function userToRow(user) {
  return {
    id: user.id,
    username: user.username,
    algo: user.algo || 'scrypt',
    password_hash: user.passwordHash,
    salt: user.salt,
    super_admin: user.superAdmin ? 1 : 0,
    display_name: user.displayName || '',
    bio: user.bio || '',
    preferences: JSON.stringify(user.preferences || {}),
    created_at: user.createdAt || Date.now(),
  };
}

function initSchema() {
  const schemaSql = `
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL COLLATE NOCASE UNIQUE,
      algo TEXT NOT NULL DEFAULT 'scrypt',
      password_hash TEXT NOT NULL,
      salt TEXT NOT NULL,
      super_admin INTEGER NOT NULL DEFAULT 0,
      display_name TEXT NOT NULL DEFAULT '',
      bio TEXT NOT NULL DEFAULT '',
      preferences TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS room_meta (
      room_name TEXT PRIMARY KEY,
      roles_json TEXT NOT NULL DEFAULT '[]',
      member_roles_json TEXT NOT NULL DEFAULT '{}'
    );

    CREATE TABLE IF NOT EXISTS uploads (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      mime TEXT NOT NULL,
      size INTEGER NOT NULL,
      kind TEXT NOT NULL,
      ext TEXT NOT NULL,
      user_id TEXT,
      username TEXT,
      tag TEXT NOT NULL DEFAULT 'file',
      url TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS custom_media (
      id TEXT PRIMARY KEY,
      category TEXT NOT NULL CHECK(category IN ('emoji', 'gif')),
      sort_order INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (id) REFERENCES uploads(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS activity_log (
      id TEXT PRIMARY KEY,
      ts INTEGER NOT NULL,
      event TEXT NOT NULL,
      user_id TEXT,
      username TEXT,
      room_name TEXT,
      meta_json TEXT NOT NULL DEFAULT '{}'
    );

    CREATE INDEX IF NOT EXISTS idx_activity_ts ON activity_log(ts DESC);
    CREATE INDEX IF NOT EXISTS idx_activity_room ON activity_log(room_name, ts DESC);
    CREATE INDEX IF NOT EXISTS idx_uploads_user ON uploads(user_id);

    CREATE TABLE IF NOT EXISTS moderation_strikes (
      subject_type TEXT NOT NULL,
      subject_key TEXT NOT NULL,
      strike_count INTEGER NOT NULL DEFAULT 0,
      lockout_until INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (subject_type, subject_key)
    );

    CREATE TABLE IF NOT EXISTS auth_sessions (
      token TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_auth_sessions_user ON auth_sessions(user_id);

    CREATE TABLE IF NOT EXISTS room_messages (
      id TEXT PRIMARY KEY,
      room_name TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_room_messages_room_time ON room_messages(room_name, created_at);

    CREATE TABLE IF NOT EXISTS chat_clients (
      client_id TEXT PRIMARY KEY,
      room_name TEXT NOT NULL,
      display_name TEXT NOT NULL,
      user_id TEXT,
      updated_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_chat_clients_room ON chat_clients(room_name, updated_at);
  `;

  if (db.driver === 'better-sqlite3') {
    db.exec('PRAGMA journal_mode = WAL;');
  }
  db.exec(schemaSql);

  migrateModerationStrikes();
}

function migrateModerationStrikes() {
  const cols = db.prepare('PRAGMA table_info(moderation_strikes)').all();
  if (!cols.length) return;

  const hasSubject = cols.some((col) => col.name === 'subject_type');
  const hasKey = cols.some((col) => col.name === 'subject_key');
  if (hasSubject && hasKey) return;

  const hasUserId = cols.some((col) => col.name === 'user_id');
  if (hasUserId) {
    db.exec(`
      CREATE TABLE moderation_strikes_next (
        subject_type TEXT NOT NULL,
        subject_key TEXT NOT NULL,
        strike_count INTEGER NOT NULL DEFAULT 0,
        lockout_until INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (subject_type, subject_key)
      );
      INSERT INTO moderation_strikes_next (subject_type, subject_key, strike_count, lockout_until, updated_at)
      SELECT 'user', user_id, strike_count, lockout_until, updated_at FROM moderation_strikes;
      DROP TABLE moderation_strikes;
      ALTER TABLE moderation_strikes_next RENAME TO moderation_strikes;
    `);
    return;
  }

  db.exec(`
    DROP TABLE moderation_strikes;
    CREATE TABLE moderation_strikes (
      subject_type TEXT NOT NULL,
      subject_key TEXT NOT NULL,
      strike_count INTEGER NOT NULL DEFAULT 0,
      lockout_until INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (subject_type, subject_key)
    );
  `);
}

function readJsonFile(path, fallback) {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return fallback;
  }
}

function migrateFromJsonIfNeeded() {
  const migrated = db.prepare('SELECT value FROM settings WHERE key = ?').get('_json_migrated');
  if (migrated?.value === '1') return;

  const userCount = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  if (userCount === 0) {
    let usersPath = LEGACY_PATHS.users;
    if (!existsSync(usersPath) && existsSync(LEGACY_PATHS.legacyUsers)) {
      usersPath = LEGACY_PATHS.legacyUsers;
    }
    const data = readJsonFile(usersPath, { users: [] });
    for (const user of data.users || []) {
      upsertUser(user);
    }
  }

  const settingsCount = db.prepare(`SELECT COUNT(*) AS n FROM settings WHERE key != '_json_migrated'`).get().n;
  if (settingsCount === 0 && existsSync(LEGACY_PATHS.settings)) {
    const settings = readJsonFile(LEGACY_PATHS.settings, {});
    saveSettingsObject(settings);
  }

  const roomCount = db.prepare('SELECT COUNT(*) AS n FROM room_meta').get().n;
  if (roomCount === 0 && existsSync(LEGACY_PATHS.rooms)) {
    const store = readJsonFile(LEGACY_PATHS.rooms, {});
    saveRoomStoreObject(store);
  }

  const uploadCount = db.prepare('SELECT COUNT(*) AS n FROM uploads').get().n;
  if (uploadCount === 0 && existsSync(LEGACY_PATHS.manifest)) {
    const manifest = readJsonFile(LEGACY_PATHS.manifest, { files: {} });
    for (const record of Object.values(manifest.files || {})) {
      insertUploadRecord(record);
    }
    const custom = readJsonFile(LEGACY_PATHS.emojis, { emojis: [], gifs: [] });
    (custom.emojis || []).forEach((entry, i) => {
      db.prepare('INSERT OR IGNORE INTO custom_media (id, category, sort_order) VALUES (?, ?, ?)').run(entry.id, 'emoji', i);
    });
    (custom.gifs || []).forEach((entry, i) => {
      db.prepare('INSERT OR IGNORE INTO custom_media (id, category, sort_order) VALUES (?, ?, ?)').run(entry.id, 'gif', i);
    });
  }

  const activityCount = db.prepare('SELECT COUNT(*) AS n FROM activity_log').get().n;
  if (activityCount === 0 && existsSync(LEGACY_PATHS.activity)) {
    const lines = readFileSync(LEGACY_PATHS.activity, 'utf8').trim().split('\n').filter(Boolean);
    for (const line of lines) {
      try {
        const row = JSON.parse(line);
        insertActivityRow(row);
      } catch {
        // skip bad lines
      }
    }
  }

  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('_json_migrated', '1');
  console.log('[db] JSON migration complete (if legacy files existed)');
}

async function initDb() {
  if (db) return db;
  if (!initPromise) {
    initPromise = (async () => {
      mkdirSync(DATA_DIR, { recursive: true });
      mkdirSync(join(DATA_DIR, 'logs'), { recursive: true });
      db = await openDatabase(DB_FILE);
      console.log(`[db] using ${db.driver} at ${DB_FILE}`);
      initSchema();
      migrateFromJsonIfNeeded();
      return db;
    })();
  }
  return initPromise;
}

function getDb() {
  if (!db) {
    throw new Error('Database not initialized. Call await initDb() before handling requests.');
  }
  return db;
}

// --- Users ---

function listUsers() {
  const rows = getDb().prepare('SELECT * FROM users ORDER BY created_at ASC').all();
  return rows.map(rowToUser);
}

function getUserById(id) {
  return rowToUser(getDb().prepare('SELECT * FROM users WHERE id = ?').get(id));
}

function getUserByUsername(username) {
  return rowToUser(getDb().prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE').get(username));
}

function upsertUser(user) {
  const row = userToRow(user);
  getDb().prepare(`
    INSERT INTO users (id, username, algo, password_hash, salt, super_admin, display_name, bio, preferences, created_at)
    VALUES (@id, @username, @algo, @password_hash, @salt, @super_admin, @display_name, @bio, @preferences, @created_at)
    ON CONFLICT(id) DO UPDATE SET
      username = excluded.username,
      algo = excluded.algo,
      password_hash = excluded.password_hash,
      salt = excluded.salt,
      super_admin = excluded.super_admin,
      display_name = excluded.display_name,
      bio = excluded.bio,
      preferences = excluded.preferences,
      created_at = excluded.created_at
  `).run(row);
}

function deleteUserById(id) {
  getDb().prepare('DELETE FROM users WHERE id = ?').run(id);
}

function replaceAllUsers(users) {
  const run = getDb().transaction((list) => {
    getDb().prepare('DELETE FROM users').run();
    for (const user of list) upsertUser(user);
  });
  run(users);
}

function countUsers() {
  return getDb().prepare('SELECT COUNT(*) AS n FROM users').get().n;
}

// --- Settings ---

function loadSettingsObject() {
  const rows = getDb().prepare('SELECT key, value FROM settings WHERE key != ?').all('_json_migrated');
  const out = {};
  for (const row of rows) {
    try {
      out[row.key] = JSON.parse(row.value);
    } catch {
      out[row.key] = row.value;
    }
  }
  return out;
}

function saveSettingsObject(obj) {
  const stmt = getDb().prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
  const run = getDb().transaction((settings) => {
    for (const [key, value] of Object.entries(settings)) {
      if (key.startsWith('_')) continue;
      stmt.run(key, JSON.stringify(value));
    }
  });
  run(obj);
}

function saveSettingsPatch(patch) {
  const current = loadSettingsObject();
  saveSettingsObject({ ...current, ...patch });
}

// --- Room meta ---

function loadRoomStoreObject() {
  const rows = getDb().prepare('SELECT room_name, roles_json, member_roles_json FROM room_meta').all();
  const store = {};
  for (const row of rows) {
    store[row.room_name] = {
      roles: JSON.parse(row.roles_json || '[]'),
      memberRoles: JSON.parse(row.member_roles_json || '{}'),
    };
  }
  return store;
}

function saveRoomStoreObject(store) {
  const del = getDb().prepare('DELETE FROM room_meta');
  const ins = getDb().prepare(`
    INSERT INTO room_meta (room_name, roles_json, member_roles_json) VALUES (?, ?, ?)
  `);
  const run = getDb().transaction((data) => {
    del.run();
    for (const [roomName, meta] of Object.entries(data)) {
      ins.run(roomName, JSON.stringify(meta.roles || []), JSON.stringify(meta.memberRoles || {}));
    }
  });
  run(store);
}

function upsertRoomMeta(roomName, meta) {
  getDb().prepare(`
    INSERT INTO room_meta (room_name, roles_json, member_roles_json) VALUES (?, ?, ?)
    ON CONFLICT(room_name) DO UPDATE SET
      roles_json = excluded.roles_json,
      member_roles_json = excluded.member_roles_json
  `).run(roomName, JSON.stringify(meta.roles || []), JSON.stringify(meta.memberRoles || {}));
}

function deleteRoomMeta(roomName) {
  getDb().prepare('DELETE FROM room_meta WHERE room_name = ?').run(roomName);
}

function clearRoomMeta() {
  getDb().prepare('DELETE FROM room_meta').run();
}

// --- Uploads ---

function insertUploadRecord(record) {
  getDb().prepare(`
    INSERT OR REPLACE INTO uploads (id, name, mime, size, kind, ext, user_id, username, tag, url, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    record.id,
    record.name,
    record.mime,
    record.size,
    record.kind,
    record.ext,
    record.userId || null,
    record.username || null,
    record.tag || 'file',
    record.url,
    record.createdAt || Date.now(),
  );
}

function getUploadRecord(id) {
  const row = getDb().prepare('SELECT * FROM uploads WHERE id = ?').get(id);
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    mime: row.mime,
    size: row.size,
    kind: row.kind,
    ext: row.ext,
    userId: row.user_id,
    username: row.username,
    tag: row.tag,
    url: row.url,
    createdAt: row.created_at,
  };
}

function listUploadRecords() {
  return getDb().prepare('SELECT * FROM uploads ORDER BY created_at DESC').all().map((row) => ({
    id: row.id,
    name: row.name,
    mime: row.mime,
    size: row.size,
    kind: row.kind,
    ext: row.ext,
    userId: row.user_id,
    username: row.username,
    tag: row.tag,
    url: row.url,
    createdAt: row.created_at,
  }));
}

function deleteUploadRecord(id) {
  getDb().prepare('DELETE FROM custom_media WHERE id = ?').run(id);
  getDb().prepare('DELETE FROM uploads WHERE id = ?').run(id);
}

function getUploadStorageStats() {
  const row = getDb().prepare('SELECT COALESCE(SUM(size), 0) AS bytes, COUNT(*) AS n FROM uploads').get();
  return { totalBytes: row.bytes, fileCount: row.n };
}

function clearAllUploadRecords() {
  getDb().prepare('DELETE FROM custom_media').run();
  getDb().prepare('DELETE FROM uploads').run();
}

function loadCustomEmojisObject() {
  const emojiRows = getDb().prepare(`
    SELECT u.id, u.name, u.url, u.user_id, u.username, u.created_at
    FROM custom_media c JOIN uploads u ON u.id = c.id
    WHERE c.category = 'emoji' ORDER BY c.sort_order ASC
  `).all();
  const gifRows = getDb().prepare(`
    SELECT u.id, u.name, u.url, u.user_id, u.username, u.created_at
    FROM custom_media c JOIN uploads u ON u.id = c.id
    WHERE c.category = 'gif' ORDER BY c.sort_order ASC
  `).all();
  const mapEntry = (row) => ({
    id: row.id,
    name: row.name,
    url: row.url,
    userId: row.user_id,
    username: row.username,
    createdAt: row.created_at,
  });
  return {
    emojis: emojiRows.map(mapEntry),
    gifs: gifRows.map(mapEntry),
  };
}

function addCustomMedia(record, category) {
  const maxOrder = getDb().prepare('SELECT COALESCE(MAX(sort_order), -1) AS m FROM custom_media WHERE category = ?').get(category).m;
  getDb().prepare('INSERT OR REPLACE INTO custom_media (id, category, sort_order) VALUES (?, ?, ?)').run(record.id, category, maxOrder + 1);
  trimCustomMedia(category, 200);
}

function trimCustomMedia(category, limit) {
  const rows = getDb().prepare(`
    SELECT id FROM custom_media WHERE category = ? ORDER BY sort_order ASC
  `).all(category);
  if (rows.length <= limit) return;
  const excess = rows.slice(0, rows.length - limit);
  const del = getDb().prepare('DELETE FROM custom_media WHERE id = ?');
  for (const row of excess) del.run(row.id);
}

function clearCustomMediaRecords() {
  getDb().prepare('DELETE FROM custom_media').run();
}

// --- Activity ---

function insertActivityRow(entry) {
  const row = {
    id: entry.id || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    ts: entry.ts || Date.now(),
    event: entry.event,
    userId: entry.userId || null,
    username: entry.username || null,
    room: entry.room || null,
    meta: entry.meta || {},
  };
  getDb().prepare(`
    INSERT OR IGNORE INTO activity_log (id, ts, event, user_id, username, room_name, meta_json)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(row.id, row.ts, row.event, row.userId, row.username, row.room, JSON.stringify(row.meta));
  return row;
}

function readActivityRows({ room, limit = 80 } = {}) {
  let rows;
  if (room) {
    rows = getDb().prepare(`
      SELECT * FROM activity_log
      WHERE room_name = ?
         OR json_extract(meta_json, '$.fromRoom') = ?
         OR json_extract(meta_json, '$.toRoom') = ?
      ORDER BY ts DESC LIMIT ?
    `).all(room, room, room, limit);
  } else {
    rows = getDb().prepare('SELECT * FROM activity_log ORDER BY ts DESC LIMIT ?').all(limit);
  }
  return rows.map((row) => ({
    id: row.id,
    ts: row.ts,
    event: row.event,
    userId: row.user_id,
    username: row.username,
    room: row.room_name,
    meta: JSON.parse(row.meta_json || '{}'),
  }));
}

function countActivityRows() {
  return getDb().prepare('SELECT COUNT(*) AS n FROM activity_log').get().n;
}

function clearActivityRows() {
  getDb().prepare('DELETE FROM activity_log').run();
}

function wipePlatformDataExceptUser(keptUser) {
  const run = getDb().transaction((user) => {
    clearAllUploadRecords();
    clearCustomMediaRecords();
    clearActivityRows();
    clearRoomMeta();
    clearAuthSessions();
    clearRoomMessages();
    clearChatClients();
    replaceAllUsers([user]);
  });
  run(keptUser);
}

function insertAuthSession(token, userId, createdAt, expiresAt) {
  getDb().prepare(`
    INSERT INTO auth_sessions (token, user_id, created_at, expires_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(token) DO UPDATE SET
      user_id = excluded.user_id,
      created_at = excluded.created_at,
      expires_at = excluded.expires_at
  `).run(token, userId, createdAt, expiresAt);
}

function getAuthSession(token) {
  return getDb().prepare('SELECT * FROM auth_sessions WHERE token = ?').get(token);
}

function deleteAuthSession(token) {
  getDb().prepare('DELETE FROM auth_sessions WHERE token = ?').run(token);
}

function deleteAuthSessionsForUser(userId) {
  getDb().prepare('DELETE FROM auth_sessions WHERE user_id = ?').run(userId);
}

function countAuthSessions() {
  return getDb().prepare('SELECT COUNT(*) AS n FROM auth_sessions WHERE expires_at > ?').get(Date.now()).n;
}

function clearAuthSessions() {
  getDb().prepare('DELETE FROM auth_sessions').run();
}

function insertRoomMessage(roomName, payload) {
  const createdAt = payload.ts || Date.now();
  getDb().prepare(`
    INSERT OR REPLACE INTO room_messages (id, room_name, payload_json, created_at)
    VALUES (?, ?, ?, ?)
  `).run(payload.id, roomName, JSON.stringify(payload), createdAt);
}

function listRoomMessages(roomName, { since = 0, limit = 200 } = {}) {
  const rows = getDb().prepare(`
    SELECT payload_json FROM room_messages
    WHERE room_name = ? AND created_at > ?
    ORDER BY created_at ASC
    LIMIT ?
  `).all(roomName, since, limit);
  return rows.map((row) => JSON.parse(row.payload_json));
}

function countRoomMessages(roomName) {
  return getDb().prepare('SELECT COUNT(*) AS n FROM room_messages WHERE room_name = ?').get(roomName).n;
}

function clearRoomMessages(roomName = null) {
  if (roomName) {
    getDb().prepare('DELETE FROM room_messages WHERE room_name = ?').run(roomName);
  } else {
    getDb().prepare('DELETE FROM room_messages').run();
  }
}

function upsertChatClient(clientId, roomName, displayName, userId = null) {
  getDb().prepare(`
    INSERT INTO chat_clients (client_id, room_name, display_name, user_id, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(client_id) DO UPDATE SET
      room_name = excluded.room_name,
      display_name = excluded.display_name,
      user_id = excluded.user_id,
      updated_at = excluded.updated_at
  `).run(clientId, roomName, displayName, userId, Date.now());
}

function listChatClients(roomName, maxAgeMs = 90000) {
  const minTs = Date.now() - maxAgeMs;
  return getDb().prepare(`
    SELECT client_id, display_name, user_id FROM chat_clients
    WHERE room_name = ? AND updated_at >= ?
    ORDER BY updated_at DESC
  `).all(roomName, minTs);
}

function clearChatClients() {
  getDb().prepare('DELETE FROM chat_clients').run();
}

module.exports = {
  DB_FILE,
  initDb,
  ensureDbReady: initDb,
  getDb,
  listUsers,
  getUserById,
  getUserByUsername,
  upsertUser,
  deleteUserById,
  replaceAllUsers,
  countUsers,
  loadSettingsObject,
  saveSettingsObject,
  saveSettingsPatch,
  loadRoomStoreObject,
  saveRoomStoreObject,
  upsertRoomMeta,
  deleteRoomMeta,
  clearRoomMeta,
  insertUploadRecord,
  getUploadRecord,
  listUploadRecords,
  deleteUploadRecord,
  getUploadStorageStats,
  clearAllUploadRecords,
  loadCustomEmojisObject,
  addCustomMedia,
  clearCustomMediaRecords,
  insertActivityRow,
  readActivityRows,
  countActivityRows,
  clearActivityRows,
  wipePlatformDataExceptUser,
  insertAuthSession,
  getAuthSession,
  deleteAuthSession,
  deleteAuthSessionsForUser,
  countAuthSessions,
  clearAuthSessions,
  insertRoomMessage,
  listRoomMessages,
  countRoomMessages,
  clearRoomMessages,
  upsertChatClient,
  listChatClients,
  clearChatClients,
};
