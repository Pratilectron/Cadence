const { createServer } = require('http');
const { readFileSync, writeFileSync, existsSync, mkdirSync, statSync } = require('fs');
const { join, extname, normalize } = require('path');
const crypto = require('crypto');
const { Server } = require('socket.io');
const { logActivity, readActivity } = require('./lib/activity');
const {
  parseUpload,
  serveMedia,
  getFileRecord,
  getStorageStats,
  loadCustomEmojis,
} = require('./lib/uploads');
const {
  PERMISSION_KEYS,
  initRoomRoles,
  persistRoomMeta,
  hasPermission,
  getEffectivePermissions,
  getDisplayRole,
  createCustomRole,
  updateCustomRole,
  deleteCustomRole,
  assignRole,
  removeRole,
  serializeRolesForClient,
  isRoomOwner,
} = require('./lib/roles');
const { getConfig, reloadConfig, isSuperAdminUsername } = require('./lib/config');
const adminLib = require('./lib/admin');
const { handleAdminApi } = require('./lib/admin-api');
const { buildProfile, updateProfile } = require('./lib/profile');
const { parseRequestUrl } = require('./lib/request-url');
const { setupProcessHandlers, startHttpServer } = require('./lib/bootstrap');
const { handleDeployWebhook } = require('./lib/deploy');

const PORT = Number(process.env.PORT) || 3000;

function cfg() {
  return getConfig();
}

const PUBLIC_DIR = join(__dirname, 'public');
const DATA_DIR = join(__dirname, 'data');
const DB_PATH = join(DATA_DIR, 'users.json');
const LEGACY_DB_PATH = join(__dirname, 'users.json');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(self), microphone=(self), display-capture=(self), geolocation=()',
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self' https://cdn.jsdelivr.net; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self' ws: wss: https://cdn.jsdelivr.net; object-src 'none'; base-uri 'self'; frame-ancestors 'none'",
};

const SENSITIVE_PATH_PATTERNS = [
  /^\/\.env/i,
  /^\/data\//i,
  /^\/users\.json$/i,
  /^\/package\.json$/i,
  /^\/package-lock\.json$/i,
  /^\/node_modules\//i,
];

function isSensitivePath(urlPath) {
  const pathOnly = urlPath.split('?')[0].replace(/\\/g, '/');
  if (pathOnly.includes('..')) return true;
  return SENSITIVE_PATH_PATTERNS.some((re) => re.test(pathOnly));
}

mkdirSync(DATA_DIR, { recursive: true });
migrateLegacyDb();

const usersDb = loadUsersDb();
const sessions = new Map();
const rateLimits = new Map();

const rooms = {};
for (const roomName of cfg().defaultRooms) {
  rooms[roomName] = createRoom(roomName, 'public');
  rooms[roomName].name = roomName;
}

function createRoom(name, type, ownerId = null) {
  const room = {
    name,
    users: new Map(),
    messages: [],
    pinned: [],
    ownerId,
    type,
    invites: ownerId ? [ownerId] : [],
    roles: [],
    memberRoles: {},
  };
  initRoomRoles(room, type);
  return room;
}

function migrateLegacyDb() {
  if (existsSync(DB_PATH) || !existsSync(LEGACY_DB_PATH)) return;
  writeFileSync(DB_PATH, readFileSync(LEGACY_DB_PATH, 'utf8'), 'utf8');
}

function loadUsersDb() {
  if (!existsSync(DB_PATH)) return { users: [] };
  try {
    const raw = readFileSync(DB_PATH, 'utf8');
    return raw ? JSON.parse(raw) : { users: [] };
  } catch (error) {
    console.error('Failed to read users database:', error.message);
    return { users: [] };
  }
}

let savePending = false;
function saveUsersDb() {
  if (savePending) return;
  savePending = true;
  setImmediate(() => {
    savePending = false;
    writeFileSync(DB_PATH, JSON.stringify(usersDb, null, 2), 'utf8');
  });
}

function hashPasswordScrypt(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  return { algo: 'scrypt', salt: salt.toString('hex'), passwordHash: hash.toString('hex') };
}

function hashPasswordLegacy(password, saltHex) {
  return crypto.createHash('sha256').update(saltHex + password).digest('hex');
}

function verifyPassword(password, user) {
  if (user.algo === 'scrypt') {
    const derived = crypto.scryptSync(password, Buffer.from(user.salt, 'hex'), 64);
    const stored = Buffer.from(user.passwordHash, 'hex');
    if (derived.length !== stored.length) return false;
    return crypto.timingSafeEqual(derived, stored);
  }

  const attempt = hashPasswordLegacy(password, user.salt);
  if (attempt !== user.passwordHash) return false;

  const upgraded = hashPasswordScrypt(password);
  user.algo = upgraded.algo;
  user.salt = upgraded.salt;
  user.passwordHash = upgraded.passwordHash;
  saveUsersDb();
  return true;
}

function findUserByUsername(username) {
  return usersDb.users.find((user) => user.username.toLowerCase() === username.toLowerCase());
}

function findUserById(id) {
  return usersDb.users.find((user) => user.id === id);
}

function sanitizeUsername(value) {
  return String(value || '')
    .trim()
    .replace(/[<>"'&]/g, '')
    .slice(0, 32);
}

function sanitizeRoomName(value) {
  return String(value || '')
    .trim()
    .replace(/[^a-zA-Z0-9 _-]/g, '')
    .slice(0, 64);
}

function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, { userId, createdAt: Date.now() });
  return token;
}

function getSessionUser(token) {
  if (!token) return null;
  const session = sessions.get(token);
  if (!session) return null;
  const user = findUserById(session.userId);
  return user ? { id: user.id, username: user.username } : null;
}

function revokeSession(token) {
  if (token) sessions.delete(token);
}

function getTokenFromReq(req) {
  const header = req.headers.authorization || '';
  if (header.startsWith('Bearer ')) return header.slice(7).trim();
  return req.headers['x-session-token'] || null;
}

function checkRateLimit(key, maxAttempts, windowMs) {
  const now = Date.now();
  const entry = rateLimits.get(key) || { count: 0, resetAt: now + windowMs };
  if (now > entry.resetAt) {
    entry.count = 0;
    entry.resetAt = now + windowMs;
  }
  entry.count += 1;
  rateLimits.set(key, entry);
  return entry.count <= maxAttempts;
}

function isOriginAllowed(origin) {
  if (!origin) return true;
  return cfg().allowedOrigins.includes(origin);
}

function jsonResponse(res, status, body) {
  res.writeHead(status, { ...SECURITY_HEADERS, 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 1e6) reject(new Error('Body too large'));
    });
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function activityLog(event, socket, meta = {}) {
  const row = logActivity({
    event,
    userId: socket.user?.id || null,
    username: socket.user?.username || socket.data?.name || 'Anonymous',
    room: meta.room || socket.data?.room || null,
    meta,
  });
  const room = meta.room || socket.data?.room;
  if (room && rooms[room]) {
    io.to(room).emit('activityLog', row);
  }
  return row;
}

function serveStatic(req, res) {
  const urlPath = req.url.split('?')[0];
  if (isSensitivePath(urlPath)) {
    res.writeHead(404, SECURITY_HEADERS);
    res.end('Not Found');
    return;
  }
  const safePath = normalize(urlPath).replace(/^(\.\.[/\\])+/, '');
  let filePath = join(PUBLIC_DIR, safePath === '/' ? 'index.html' : safePath);

  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403, SECURITY_HEADERS);
    res.end('Forbidden');
    return;
  }

  if (!existsSync(filePath)) {
    filePath = join(PUBLIC_DIR, 'index.html');
  } else if (statSync(filePath).isDirectory()) {
    filePath = join(filePath, 'index.html');
    if (!existsSync(filePath)) {
      res.writeHead(404, SECURITY_HEADERS);
      res.end('Not Found');
      return;
    }
  }

  const ext = extname(filePath);
  const type = MIME_TYPES[ext] || 'application/octet-stream';
  const body = readFileSync(filePath);

  res.writeHead(200, {
    ...SECURITY_HEADERS,
    'Content-Type': type,
    'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=86400',
  });
  res.end(body);
}

async function handleHttp(req, res) {
  const urlPath = req.url.split('?')[0];

  if (isSensitivePath(urlPath)) {
    res.writeHead(404, SECURITY_HEADERS);
    res.end('Not Found');
    return;
  }

  if (urlPath.startsWith('/api/admin/')) {
    const handled = await handleAdminApi(req, res, urlPath, {
      jsonResponse,
      readJsonBody,
      getSessionUser,
      getTokenFromReq,
      SECURITY_HEADERS,
      usersDb,
      saveUsersDb,
      rooms,
      sessions,
      rateLimits,
      dbPath: DB_PATH,
      findUserById,
      verifyPassword,
      resetPlatformState,
    });
    if (handled) return;
  }

  if (urlPath.startsWith('/media/')) {
    const id = urlPath.slice('/media/'.length).split('/')[0];
    if (!/^[a-f0-9-]{36}$/i.test(id)) {
      res.writeHead(400, SECURITY_HEADERS);
      res.end('Bad request');
      return;
    }
    serveMedia(id, res, SECURITY_HEADERS);
    return;
  }

  if (urlPath === '/api/health' && req.method === 'GET') {
    jsonResponse(res, 200, {
      ok: true,
      app: cfg().appName,
      uptime: process.uptime(),
    });
    return;
  }

  if (urlPath === '/api/deploy/webhook') {
    await handleDeployWebhook(req, res, jsonResponse);
    return;
  }

  if (urlPath === '/api/storage' && req.method === 'GET') {
    jsonResponse(res, 200, getStorageStats());
    return;
  }

  if (urlPath === '/api/emojis' && req.method === 'GET') {
    jsonResponse(res, 200, loadCustomEmojis());
    return;
  }

  if (urlPath === '/api/logs' && req.method === 'GET') {
    const params = parseRequestUrl(req, PORT).searchParams;
    const room = params.get('room') || null;
    const limit = Math.min(Number(params.get('limit')) || 80, 200);
    jsonResponse(res, 200, { logs: readActivity({ room, limit }) });
    return;
  }

  if (urlPath === '/api/profile' && req.method === 'GET') {
    const sessionUser = getSessionUser(getTokenFromReq(req));
    if (!sessionUser) {
      jsonResponse(res, 401, { error: 'Authentication required.' });
      return;
    }
    const record = findUserById(sessionUser.id);
    if (!record) {
      jsonResponse(res, 404, { error: 'User not found.' });
      return;
    }
    jsonResponse(res, 200, { profile: buildProfile(record) });
    return;
  }

  if (urlPath === '/api/profile' && req.method === 'PATCH') {
    const sessionUser = getSessionUser(getTokenFromReq(req));
    if (!sessionUser) {
      jsonResponse(res, 401, { error: 'Authentication required.' });
      return;
    }
    try {
      const body = await readJsonBody(req);
      const profile = updateProfile(usersDb, saveUsersDb, sessionUser.id, body);
      jsonResponse(res, 200, { profile });
    } catch (err) {
      jsonResponse(res, 400, { error: err.message || 'Update failed.' });
    }
    return;
  }

  if (urlPath === '/api/profile/password' && req.method === 'PATCH') {
    const sessionUser = getSessionUser(getTokenFromReq(req));
    if (!sessionUser) {
      jsonResponse(res, 401, { error: 'Authentication required.' });
      return;
    }
    try {
      const body = await readJsonBody(req);
      const user = findUserById(sessionUser.id);
      if (!user) {
        jsonResponse(res, 404, { error: 'User not found.' });
        return;
      }
      if (!verifyPassword(String(body.currentPassword || ''), user)) {
        jsonResponse(res, 400, { error: 'Current password is incorrect.' });
        return;
      }
      const next = String(body.newPassword || '');
      if (next.length < 8) {
        jsonResponse(res, 400, { error: 'New password must be at least 8 characters.' });
        return;
      }
      const upgraded = hashPasswordScrypt(next);
      user.algo = upgraded.algo;
      user.salt = upgraded.salt;
      user.passwordHash = upgraded.passwordHash;
      saveUsersDb();
      jsonResponse(res, 200, { ok: true });
    } catch (err) {
      jsonResponse(res, 400, { error: err.message || 'Password change failed.' });
    }
    return;
  }

  if (urlPath === '/api/upload' && req.method === 'POST') {
    const user = getSessionUser(getTokenFromReq(req));
    if (!user) {
      jsonResponse(res, 401, { error: 'Authentication required.' });
      return;
    }
    const tag = parseRequestUrl(req, PORT).searchParams.get('tag') || 'file';
    try {
      const file = await parseUpload(req, { userId: user.id, username: user.username, tag });
      logActivity({
        event: 'file.uploaded',
        userId: user.id,
        username: user.username,
        meta: { fileName: file.name, size: file.size, kind: file.kind, tag },
      });
      jsonResponse(res, 201, { file });
    } catch (error) {
      jsonResponse(res, 400, { error: error.message || 'Upload failed.' });
    }
    return;
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, SECURITY_HEADERS);
    res.end('Method Not Allowed');
    return;
  }

  serveStatic(req, res);
}

const httpServer = createServer((req, res) => {
  if (req.url.startsWith('/socket.io')) return;
  handleHttp(req, res).catch((err) => {
    console.error('HTTP error:', err.message);
    if (!res.headersSent) jsonResponse(res, 500, { error: 'Internal server error.' });
  });
});

const io = new Server(httpServer, {
  cors: { origin: cfg().allowedOrigins, methods: ['GET', 'POST'] },
  maxHttpBufferSize: 8e3,
  pingTimeout: 20000,
  pingInterval: 10000,
});

function buildRoomListFor(socket) {
  const list = [];
  const userId = socket.user?.id;

  for (const [name, room] of Object.entries(rooms)) {
    const isMember = room.users.has(socket.id);
    const invited = Boolean(userId && room.invites.includes(userId));
    const isOwner = isRoomOwner(room, userId);
    const canView = userId
      ? userHasPermission(room, userId, 'VIEW_CHANNEL')
      : room.type === 'public' && cfg().guestChatEnabled;
    const visible = canView || isMember || invited || room.type === 'locked';
    if (!visible) continue;

    const canJoin = userId
      ? userHasPermission(room, userId, 'VIEW_CHANNEL') || isMember || invited || (room.type === 'locked' && isOwner)
      : room.type === 'public' && cfg().guestChatEnabled;

    list.push({
      name,
      type: room.type,
      ownerId: room.ownerId,
      memberCount: room.users.size,
      pinnedCount: room.pinned.length,
      joinable: canJoin,
      isMember,
    });
  }

  return list;
}

function sendRoomList(socket) {
  socket.emit('roomlist', buildRoomListFor(socket));
}

function broadcastRoomLists() {
  io.sockets.sockets.forEach((socket) => sendRoomList(socket));
}

function resetPlatformState(actorUserId, keepToken) {
  const defaultNames = cfg().defaultRooms;
  const defaultRoom = defaultNames[0] || 'General';

  for (const key of Object.keys(rooms)) {
    if (!defaultNames.includes(key)) delete rooms[key];
  }
  for (const name of defaultNames) {
    const room = createRoom(name, 'public');
    room.name = name;
    rooms[name] = room;
  }

  for (const socket of io.sockets.sockets.values()) {
    for (const room of [...socket.rooms]) {
      if (room !== socket.id) socket.leave(room);
    }

    const isKeeper = socket.user?.id === actorUserId && socket.data.sessionToken === keepToken;
    if (!isKeeper) {
      if (socket.data.sessionToken) revokeSession(socket.data.sessionToken);
      socket.user = null;
      socket.data.sessionToken = null;
      socket.data.name = 'Anonymous';
      socket.emit('loggedOut', {});
    }

    socket.join(defaultRoom);
    socket.data.room = defaultRoom;
    rooms[defaultRoom].users.set(socket.id, {
      name: socket.data.name || 'Anonymous',
      userId: socket.user?.id || null,
    });

    socket.emit('history', []);
    socket.emit('pinned', []);
    sendRoomList(socket);
    broadcastUserlist(defaultRoom);
  }

  for (const name of defaultNames) {
    if (name !== defaultRoom) broadcastUserlist(name);
  }
  broadcastRoomLists();
}

function broadcastUserlist(roomName) {
  const room = rooms[roomName];
  if (!room) return;

  const users = Array.from(room.users.entries()).map(([id, info]) => ({
    id,
    name: info.name,
    userId: info.userId || null,
    role: info.userId ? getDisplayRole(room, info.userId) : null,
  }));

  io.to(roomName).emit('userlist', users);
}

function sendRoomRoles(roomName, socket) {
  const room = rooms[roomName];
  if (!room) return;
  socket.emit('roomRoles', serializeRolesForClient(room, socket.user?.id || null));
}

function sendHistory(roomName, socket) {
  const room = rooms[roomName];
  if (!room) return;
  if (socket.user?.id && !userHasPermission(room, socket.user.id, 'READ_MESSAGE_HISTORY')) {
    socket.emit('history', []);
  } else {
    socket.emit('history', room.messages);
  }
  socket.emit('pinned', room.pinned);
  socket.emit('activityHistory', readActivity({ room: roomName, limit: 60 }));
  sendRoomRoles(roomName, socket);
}

function canJoinRoom(roomName, socket) {
  const room = rooms[roomName];
  if (!room) return { allowed: false, reason: 'Room not found.' };
  const userId = socket.user?.id;
  const isMember = room.users.has(socket.id);

  if (isMember) return { allowed: true };

  if (room.type === 'public') {
    if (!userId || hasPermission(room, userId, 'VIEW_CHANNEL')) return { allowed: true };
    return { allowed: false, reason: 'You cannot view this channel.' };
  }

  if (room.type === 'locked') {
    if (isRoomOwner(room, userId)) return { allowed: true };
    return { allowed: false, reason: 'Room is locked.' };
  }

  if (room.type === 'private') {
    if (userId && room.invites.includes(userId)) return { allowed: true };
    if (userId && hasPermission(room, userId, 'VIEW_CHANNEL')) return { allowed: true };
    return { allowed: false, reason: 'Private room — invite or role required.' };
  }

  return { allowed: false, reason: 'Room cannot be joined.' };
}

function logRoomLeave(socket, roomName) {
  if (!roomName || !rooms[roomName]) return;
  const joinedAt = socket.data.roomJoinedAt?.[roomName];
  const durationMs = joinedAt ? Date.now() - joinedAt : 0;
  activityLog('room.left', socket, { room: roomName, durationMs, durationSec: Math.round(durationMs / 1000) });
}

function joinRoom(socket, roomName) {
  const room = rooms[roomName];
  if (!room) {
    socket.emit('roomError', { room: roomName, reason: 'Room does not exist.' });
    return false;
  }

  const permission = canJoinRoom(roomName, socket);
  if (!permission.allowed) {
    socket.emit('roomError', { room: roomName, reason: permission.reason });
    return false;
  }

  const previousRoom = socket.data.room;
  if (previousRoom === roomName) return true;

  if (rooms[previousRoom]) {
    logRoomLeave(socket, previousRoom);
    rooms[previousRoom].users.delete(socket.id);
    broadcastUserlist(previousRoom);
    socket.leave(previousRoom);
  }

  socket.join(roomName);
  socket.data.room = roomName;
  if (!socket.data.roomJoinedAt) socket.data.roomJoinedAt = {};
  socket.data.roomJoinedAt[roomName] = Date.now();

  room.users.set(socket.id, {
    name: socket.data.name || 'Anonymous',
    userId: socket.user?.id || null,
  });

  activityLog('room.joined', socket, { room: roomName, roomType: room.type });
  broadcastUserlist(roomName);
  sendHistory(roomName, socket);
  sendRoomList(socket);
  broadcastRoomLists();
  socket.emit('roomJoined', { roomName, type: room.type });
  return true;
}

function requireAuth(socket) {
  return Boolean(socket.user?.id);
}

function isSuperAdmin(user) {
  return adminLib.isSuperAdminUser(user);
}

function userHasPermission(room, userId, perm) {
  if (userId) {
    const user = findUserById(userId);
    if (isSuperAdmin(user)) return true;
  }
  return hasPermission(room, userId, perm);
}

function requirePerm(socket, roomName, perm) {
  const room = rooms[roomName];
  if (!room) return false;
  if (socket.user && isSuperAdmin(socket.user)) return true;
  return userHasPermission(room, socket.user?.id || null, perm);
}

function authPayload(user, token) {
  const record = user.username ? findUserByUsername(user.username) || findUserById(user.id) : findUserById(user.id);
  const source = record || user;
  return {
    id: source.id,
    username: source.username,
    displayName: source.displayName || '',
    token,
    isSuperAdmin: isSuperAdmin(source),
  };
}

function attachUserFromToken(socket, token) {
  const user = getSessionUser(token);
  if (!user) return false;
  socket.user = user;
  socket.data.name = user.username;
  return true;
}

function buildMessagePayload(socket, msg) {
  const current = socket.data.room;
  const text = String((msg && msg.text) || '').trim();
  const fileId = msg && msg.fileId ? String(msg.fileId) : null;
  const type = msg && msg.type ? String(msg.type) : 'text';

  if (type === 'text' && !text) return null;
  if ((type === 'file' || type === 'gif' || type === 'emoji') && !fileId) return null;

  let file = null;
  if (fileId) {
    const record = getFileRecord(fileId);
    if (!record) return null;
    file = {
      id: record.id,
      url: record.url,
      name: record.name,
      mime: record.mime,
      size: record.size,
      kind: record.kind,
    };
  }

  const payload = {
    id: crypto.randomUUID(),
    type: file ? (file.kind === 'gif' ? 'gif' : file.kind === 'emoji' ? 'emoji' : 'file') : 'text',
    text: text.slice(0, 2000),
    file,
    senderId: socket.id,
    senderName: socket.data.name || 'Anonymous',
    ts: Date.now(),
    room: current,
  };

  if (payload.type === 'text' && !payload.text) return null;
  if (payload.type !== 'text' && !payload.file) return null;

  return payload;
}

function pinSummary(message) {
  return {
    id: message.id,
    type: message.type || 'text',
    text: message.text || '',
    file: message.file || null,
    senderName: message.senderName,
    ts: message.ts,
  };
}

io.use((socket, next) => {
  const origin = socket.handshake.headers.origin;
  if (origin && !isOriginAllowed(origin)) {
    next(new Error('Origin not allowed'));
    return;
  }
  next();
});

io.on('connection', (socket) => {
  const clientIp = socket.handshake.address;
  const defaultRoom = cfg().defaultRooms[0] || 'General';
  socket.user = null;
  socket.data = {
    name: 'Anonymous',
    room: defaultRoom,
    sessionToken: null,
    connectedAt: Date.now(),
    roomJoinedAt: { [defaultRoom]: Date.now() },
  };

  socket.join(defaultRoom);
  rooms[defaultRoom].users.set(socket.id, { name: 'Anonymous', userId: null });
  activityLog('user.connected', socket, { room: defaultRoom });
  broadcastUserlist(defaultRoom);
  sendHistory(defaultRoom, socket);
  sendRoomList(socket);

  socket.on('restoreSession', ({ token }) => {
    if (!token || typeof token !== 'string') return;
    if (!attachUserFromToken(socket, token)) {
      socket.emit('sessionExpired');
      return;
    }

    socket.data.sessionToken = token;
    const room = rooms[socket.data.room];
    if (room) {
      room.users.set(socket.id, { name: socket.user.username, userId: socket.user.id });
      broadcastUserlist(socket.data.room);
    }
    activityLog('user.session_restored', socket);
    socket.emit('authSuccess', authPayload(socket.user, token));
    sendRoomList(socket);
  });

  socket.on('register', ({ username, password }) => {
    if (!cfg().registrationEnabled) {
      socket.emit('authError', { message: 'Registration is disabled.' });
      return;
    }
    const rateKey = `register:${clientIp}`;
    if (!checkRateLimit(rateKey, cfg().rateLimitRegister, cfg().rateLimitWindowMin * 60 * 1000)) {
      socket.emit('authError', { message: 'Too many attempts. Try again later.' });
      return;
    }

    const cleanUsername = sanitizeUsername(username);
    const cleanPassword = String(password || '');

    if (cleanUsername.length < 3) {
      socket.emit('authError', { message: 'Username must be at least 3 characters.' });
      return;
    }
    if (cleanPassword.length < 8) {
      socket.emit('authError', { message: 'Password must be at least 8 characters.' });
      return;
    }
    if (findUserByUsername(cleanUsername)) {
      socket.emit('authError', { message: 'Username already exists. Please log in.' });
      return;
    }

    const { algo, salt, passwordHash } = hashPasswordScrypt(cleanPassword);
    const id = crypto.randomUUID();
    usersDb.users.push({
      id,
      username: cleanUsername,
      algo,
      passwordHash,
      salt,
      superAdmin: isSuperAdminUsername(cleanUsername),
      createdAt: Date.now(),
    });
    saveUsersDb();

    const token = createSession(id);
    socket.data.sessionToken = token;
    const newUser = usersDb.users.find((u) => u.id === id);
    socket.user = { id: newUser.id, username: newUser.username };
    socket.data.name = cleanUsername;

    rooms[socket.data.room].users.set(socket.id, { name: cleanUsername, userId: id });
    activityLog('user.registered', socket);
    broadcastUserlist(socket.data.room);
    socket.emit('authSuccess', authPayload(newUser, token));
    sendRoomList(socket);
  });

  socket.on('login', ({ username, password }) => {
    const rateKey = `login:${clientIp}`;
    if (!checkRateLimit(rateKey, cfg().rateLimitLogin, cfg().rateLimitWindowMin * 60 * 1000)) {
      socket.emit('authError', { message: 'Too many login attempts. Try again later.' });
      return;
    }

    const cleanUsername = sanitizeUsername(username);
    const cleanPassword = String(password || '');
    const user = findUserByUsername(cleanUsername);

    if (!user || !verifyPassword(cleanPassword, user)) {
      socket.emit('authError', { message: 'Invalid username or password.' });
      return;
    }

    if (cfg().maintenanceMode && !isSuperAdmin(user)) {
      socket.emit('authError', { message: 'Maintenance mode is active.' });
      return;
    }

    const token = createSession(user.id);
    socket.data.sessionToken = token;
    socket.user = { id: user.id, username: user.username };
    socket.data.name = user.username;

    rooms[socket.data.room].users.set(socket.id, { name: user.username, userId: user.id });
    activityLog('user.login', socket);
    broadcastUserlist(socket.data.room);
    socket.emit('authSuccess', authPayload(user, token));
    sendRoomList(socket);
  });

  socket.on('logout', () => {
    logRoomLeave(socket, socket.data.room);
    activityLog('user.logout', socket, {
      sessionDurationMs: Date.now() - socket.data.connectedAt,
    });
    revokeSession(socket.data.sessionToken);
    socket.data.sessionToken = null;
    socket.user = null;
    socket.data.name = 'Anonymous';

    const room = rooms[socket.data.room];
    if (room) {
      room.users.set(socket.id, { name: 'Anonymous', userId: null });
      broadcastUserlist(socket.data.room);
    }
    socket.emit('loggedOut');
    sendRoomList(socket);
  });

  socket.on('requestRoomList', () => sendRoomList(socket));

  socket.on('requestActivity', ({ room }) => {
    const target = room || socket.data.room;
    socket.emit('activityHistory', readActivity({ room: target, limit: 80 }));
  });

  socket.on('createRoom', ({ name, type }) => {
    const cleanName = sanitizeRoomName(name);
    const roomType = ['public', 'private', 'locked'].includes(type) ? type : 'public';

    if (!cleanName) {
      socket.emit('roomError', { reason: 'Room name cannot be empty.' });
      return;
    }
    if (rooms[cleanName]) {
      socket.emit('roomError', { reason: 'Room name already exists.' });
      return;
    }
    if (roomType !== 'public' && !requireAuth(socket)) {
      socket.emit('roomError', { reason: 'Login required to create private or locked rooms.' });
      return;
    }

    rooms[cleanName] = createRoom(cleanName, roomType, socket.user?.id || null);
    rooms[cleanName].name = cleanName;
    persistRoomMeta(cleanName, rooms[cleanName]);
    activityLog('room.created', socket, { room: cleanName, roomType });
    broadcastRoomLists();
    joinRoom(socket, cleanName);
  });

  socket.on('joinRoom', (roomName) => {
    if (typeof roomName !== 'string') return;
    joinRoom(socket, sanitizeRoomName(roomName) || roomName);
  });

  socket.on('inviteUser', ({ room, username }) => {
    const roomData = rooms[room];
    const targetUser = findUserByUsername(sanitizeUsername(username));

    if (!requireAuth(socket)) {
      socket.emit('inviteError', { reason: 'Login required to invite users.' });
      return;
    }
    if (!roomData) {
      socket.emit('inviteError', { reason: 'Room not found.' });
      return;
    }
    if (roomData.type === 'public') {
      socket.emit('inviteError', { reason: 'Public rooms do not require invites.' });
      return;
    }
    if (!requirePerm(socket, room, 'CREATE_INSTANT_INVITE') && !isRoomOwner(roomData, socket.user.id)) {
      socket.emit('inviteError', { reason: 'Missing permission: Create Invite.' });
      return;
    }
    if (!targetUser) {
      socket.emit('inviteError', { reason: 'User not found.' });
      return;
    }
    if (!roomData.invites.includes(targetUser.id)) {
      roomData.invites.push(targetUser.id);
    }

    activityLog('room.invite', socket, { room, invited: targetUser.username });
    socket.emit('inviteSuccess', { room, username: targetUser.username });
    broadcastRoomLists();
  });

  socket.on('pinMessage', ({ room, messageId }) => {
    const roomData = rooms[room];
    if (!roomData || socket.data.room !== room) return;
    if (!requirePerm(socket, room, 'MANAGE_MESSAGES')) {
      socket.emit('roomError', { reason: 'Missing permission: Manage Messages.' });
      return;
    }

    const message = roomData.messages.find((msg) => msg.id === messageId);
    if (!message) return;

    const pinnedIndex = roomData.pinned.findIndex((item) => item.id === messageId);
    if (pinnedIndex >= 0) {
      roomData.pinned.splice(pinnedIndex, 1);
      activityLog('message.unpinned', socket, { room, messageId });
    } else if (roomData.pinned.length < cfg().maxPinnedPerRoom) {
      roomData.pinned.unshift(pinSummary(message));
      activityLog('message.pinned', socket, { room, messageId });
    }

    io.to(room).emit('pinned', roomData.pinned);
  });

  socket.on('message', (msg) => {
    const rateKey = `msg:${socket.id}`;
    if (!checkRateLimit(rateKey, cfg().rateLimitMessages, cfg().rateLimitMessageWindowSec * 1000)) return;

    const roomName = socket.data.room;
    const room = rooms[roomName];
    if (!room) return;

    const fileId = msg && msg.fileId ? String(msg.fileId) : null;
    if (fileId) {
      if (!requirePerm(socket, roomName, 'ATTACH_FILES')) {
        socket.emit('roomError', { reason: 'Missing permission: Attach Files.' });
        return;
      }
    } else if (!requirePerm(socket, roomName, 'SEND_MESSAGES')) {
      socket.emit('roomError', { reason: 'Missing permission: Send Messages.' });
      return;
    }

    const payload = buildMessagePayload(socket, msg);
    if (!payload) return;

    room.messages.push(payload);
    if (room.messages.length > cfg().maxMessagesPerRoom) room.messages.shift();

    activityLog('message.sent', socket, {
      room: payload.room,
      messageType: payload.type,
      fileName: payload.file?.name || null,
    });

    io.to(payload.room).emit('message', payload);
  });

  socket.on('getRoomRoles', ({ room }) => {
    const roomName = room || socket.data.room;
    if (!rooms[roomName]) return;
    sendRoomRoles(roomName, socket);
  });

  socket.on('createRole', ({ room, name, color, permissions }) => {
    const roomName = room || socket.data.room;
    const roomData = rooms[roomName];
    if (!roomData) return;
    if (!requirePerm(socket, roomName, 'MANAGE_ROLES')) {
      socket.emit('roleError', { reason: 'Missing permission: Manage Roles.' });
      return;
    }
    try {
      const role = createCustomRole(roomData, { name, color, permissions });
      persistRoomMeta(roomName, roomData);
      activityLog('role.created', socket, { room: roomName, roleName: role.name });
      io.to(roomName).emit('roomRoles', serializeRolesForClient(roomData, socket.user.id));
      socket.emit('roleSuccess', { action: 'created', role });
    } catch (error) {
      socket.emit('roleError', { reason: error.message });
    }
  });

  socket.on('updateRole', ({ room, roleId, name, color, permissions }) => {
    const roomName = room || socket.data.room;
    const roomData = rooms[roomName];
    if (!roomData) return;
    if (!requirePerm(socket, roomName, 'MANAGE_ROLES')) {
      socket.emit('roleError', { reason: 'Missing permission: Manage Roles.' });
      return;
    }
    try {
      const role = updateCustomRole(roomData, roleId, { name, color, permissions });
      persistRoomMeta(roomName, roomData);
      io.to(roomName).emit('roomRoles', serializeRolesForClient(roomData, socket.user?.id || null));
      io.to(roomName).emit('userlist', Array.from(roomData.users.entries()).map(([id, info]) => ({
        id, name: info.name, userId: info.userId || null,
        role: info.userId ? getDisplayRole(roomData, info.userId) : null,
      })));
      socket.emit('roleSuccess', { action: 'updated', role });
    } catch (error) {
      socket.emit('roleError', { reason: error.message });
    }
  });

  socket.on('deleteRole', ({ room, roleId }) => {
    const roomName = room || socket.data.room;
    const roomData = rooms[roomName];
    if (!roomData) return;
    if (!requirePerm(socket, roomName, 'MANAGE_ROLES')) {
      socket.emit('roleError', { reason: 'Missing permission: Manage Roles.' });
      return;
    }
    try {
      deleteCustomRole(roomData, roleId);
      persistRoomMeta(roomName, roomData);
      io.to(roomName).emit('roomRoles', serializeRolesForClient(roomData, socket.user?.id || null));
      socket.emit('roleSuccess', { action: 'deleted', roleId });
    } catch (error) {
      socket.emit('roleError', { reason: error.message });
    }
  });

  socket.on('assignRole', ({ room, username, roleId }) => {
    const roomName = room || socket.data.room;
    const roomData = rooms[roomName];
    const target = findUserByUsername(sanitizeUsername(username));
    if (!roomData || !target) {
      socket.emit('roleError', { reason: 'Room or user not found.' });
      return;
    }
    if (!requirePerm(socket, roomName, 'MANAGE_ROLES')) {
      socket.emit('roleError', { reason: 'Missing permission: Manage Roles.' });
      return;
    }
    try {
      assignRole(roomData, target.id, roleId);
      persistRoomMeta(roomName, roomData);
      activityLog('role.assigned', socket, { room: roomName, target: target.username, roleId });
      io.to(roomName).emit('roomRoles', serializeRolesForClient(roomData, socket.user?.id || null));
      broadcastUserlist(roomName);
      socket.emit('roleSuccess', { action: 'assigned', username: target.username, roleId });
    } catch (error) {
      socket.emit('roleError', { reason: error.message });
    }
  });

  socket.on('removeRole', ({ room, username, roleId }) => {
    const roomName = room || socket.data.room;
    const roomData = rooms[roomName];
    const target = findUserByUsername(sanitizeUsername(username));
    if (!roomData || !target) {
      socket.emit('roleError', { reason: 'Room or user not found.' });
      return;
    }
    if (!requirePerm(socket, roomName, 'MANAGE_ROLES')) {
      socket.emit('roleError', { reason: 'Missing permission: Manage Roles.' });
      return;
    }
    try {
      removeRole(roomData, target.id, roleId);
      persistRoomMeta(roomName, roomData);
      io.to(roomName).emit('roomRoles', serializeRolesForClient(roomData, socket.user?.id || null));
      broadcastUserlist(roomName);
      socket.emit('roleSuccess', { action: 'removed', username: target.username, roleId });
    } catch (error) {
      socket.emit('roleError', { reason: error.message });
    }
  });

  socket.on('disconnect', () => {
    const roomName = socket.data.room;
    if (rooms[roomName]) {
      logRoomLeave(socket, roomName);
      activityLog('user.disconnected', socket, {
        room: roomName,
        sessionDurationMs: Date.now() - socket.data.connectedAt,
      });
      rooms[roomName].users.delete(socket.id);
      broadcastUserlist(roomName);
      broadcastRoomLists();
    }
  });
});

function logStartup(mode) {
  reloadConfig();
  const appCfg = cfg();
  const base = appCfg.publicUrl
    || (mode === 'passenger'
      ? '(set PUBLIC_URL for display)'
      : `http://localhost:${PORT}`);
  console.log(`[${appCfg.appName}] started (${process.env.NODE_ENV || 'development'}, ${mode})`);
  console.log(`[${appCfg.appName}] listening on port ${PORT}`);
  console.log(`[${appCfg.appName}] URL: ${base}`);
  console.log(`[${appCfg.appName}] admin: ${base === '(set PUBLIC_URL for display)' ? '/admin.html' : `${base}/admin.html`}`);
}

function startServer() {
  const { mode } = startHttpServer(httpServer, {
    port: PORT,
    onReady: () => logStartup(mode),
  });
}

setupProcessHandlers({ httpServer, io, appName: cfg().appName });
module.exports = httpServer;

const shouldAutoStart = require.main === module || Boolean(process.env.PASSENGER_APP_ENV);
if (shouldAutoStart) {
  startServer();
}
