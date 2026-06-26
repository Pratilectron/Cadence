const { join } = require('path');
const { getConfig } = require('./config');
const { readActivity, clearActivityLog, countActivityRows } = require('./activity');
const { loadManifest, clearAllUploads, clearCustomEmojis, UPLOAD_DIR, getFileRecord } = require('./uploads');
const { deleteRoomMeta } = require('./roles');
const { countUsers, wipePlatformDataExceptUser, deleteUploadRecord } = require('./db');
const { existsSync, unlinkSync } = require('fs');

function isSuperAdminUser(user) {
  if (!user) return false;
  if (user.superAdmin === true) return true;
  const { isSuperAdminUsername } = require('./config');
  return isSuperAdminUsername(user.username);
}

function requireSuperAdmin(user) {
  if (!isSuperAdminUser(user)) {
    const err = new Error('Super admin access required.');
    err.status = 403;
    throw err;
  }
}

function getDashboardStats(ctx) {
  const { usersDb, rooms, sessions } = ctx;
  const manifest = loadManifest();
  const roomNames = Object.keys(rooms);
  let onlineUsers = 0;
  let totalMessages = 0;

  for (const room of Object.values(rooms)) {
    onlineUsers += room.users.size;
    totalMessages += room.messages.length;
  }

  return {
    users: usersDb.users.length,
    rooms: roomNames.length,
    onlineSockets: onlineUsers,
    activeSessions: sessions.size,
    files: Object.keys(manifest.files).length,
    storageUsed: manifest.totalBytes,
    storageMax: getConfig().maxStorageBytes,
    messagesInMemory: totalMessages,
    activityEntries: countActivityRows(),
  };
}

function listUsers(usersDb) {
  return usersDb.users.map(({ id, username, superAdmin, algo, createdAt }) => ({
    id,
    username,
    superAdmin: Boolean(superAdmin),
    algo: algo || 'legacy',
    createdAt: createdAt || null,
  }));
}

function updateUser(usersDb, saveUsersDb, userId, patch) {
  const user = usersDb.users.find((u) => u.id === userId);
  if (!user) throw new Error('User not found.');
  if (patch.superAdmin !== undefined) user.superAdmin = Boolean(patch.superAdmin);
  if (patch.username) user.username = String(patch.username).trim().slice(0, 32);
  saveUsersDb();
  return { id: user.id, username: user.username, superAdmin: Boolean(user.superAdmin) };
}

function deleteUser(usersDb, saveUsersDb, userId) {
  const idx = usersDb.users.findIndex((u) => u.id === userId);
  if (idx < 0) throw new Error('User not found.');
  const target = usersDb.users[idx];
  if (isSuperAdminUser(target)) {
    const superCount = usersDb.users.filter((u) => isSuperAdminUser(u)).length;
    if (superCount <= 1) throw new Error('Cannot delete the last super admin.');
  }
  usersDb.users.splice(idx, 1);
  saveUsersDb();
}

function listRooms(rooms) {
  return Object.entries(rooms).map(([name, room]) => ({
    name,
    type: room.type,
    ownerId: room.ownerId,
    members: room.users.size,
    messages: room.messages.length,
    pinned: room.pinned.length,
    roles: room.roles?.length || 0,
    roleNames: (room.roles || []).map((r) => r.name),
  }));
}

function deleteRoom(rooms, persistRoomMeta, name) {
  if (!rooms[name]) throw new Error('Room not found.');
  const cfg = getConfig();
  if (cfg.defaultRooms.includes(name)) throw new Error('Cannot delete a default room.');
  delete rooms[name];
  deleteRoomMeta(name);
}

function listFiles() {
  const manifest = loadManifest();
  return Object.values(manifest.files)
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, 200);
}

function deleteFile(fileId) {
  const record = getFileRecord(fileId);
  if (!record) throw new Error('File not found.');
  const diskPath = join(UPLOAD_DIR, `${fileId}${record.ext}`);
  if (existsSync(diskPath)) unlinkSync(diskPath);
  deleteUploadRecord(fileId);
}

function revokeAllSessions(sessions) {
  const count = sessions.size;
  sessions.clear();
  return count;
}

function wipeAllDataExceptSuperAdmin(ctx, actorUserId, options = {}) {
  const { password, confirm, keepToken } = options;
  if (String(confirm || '').trim() !== 'WIPE') {
    throw new Error('Type WIPE in the confirmation field to proceed.');
  }

  const actor = ctx.findUserById(actorUserId);
  if (!actor || !isSuperAdminUser(actor)) {
    throw new Error('Only a super admin can wipe platform data.');
  }
  if (!ctx.verifyPassword(String(password || ''), actor)) {
    throw new Error('Incorrect password.');
  }

  const usersBefore = countUsers();
  const manifest = loadManifest();
  const filesBefore = Object.keys(manifest.files).length;
  const logsBefore = countActivityRows();
  const roomsBefore = Object.keys(ctx.rooms).length;
  const sessionsBefore = ctx.sessions.size;

  clearAllUploads();
  clearCustomEmojis();
  clearActivityLog();

  const kept = {
    id: actor.id,
    username: actor.username,
    algo: actor.algo,
    passwordHash: actor.passwordHash,
    salt: actor.salt,
    superAdmin: true,
    displayName: actor.displayName || '',
    bio: actor.bio || '',
    preferences: actor.preferences || {},
    createdAt: actor.createdAt || Date.now(),
  };

  wipePlatformDataExceptUser(kept);
  ctx.usersDb.users = [kept];

  const keptSession = keepToken ? ctx.sessions.get(keepToken) : null;
  ctx.sessions.clear();
  if (keptSession?.userId === actorUserId) {
    ctx.sessions.set(keepToken, keptSession);
  }

  if (ctx.rateLimits) ctx.rateLimits.clear();

  if (typeof ctx.resetPlatformState === 'function') {
    ctx.resetPlatformState(actorUserId, keepToken);
  }

  return {
    keptUsername: kept.username,
    usersRemoved: Math.max(0, usersBefore - 1),
    filesRemoved: filesBefore,
    logsCleared: logsBefore,
    roomsReset: roomsBefore,
    sessionsRevoked: keptSession ? sessionsBefore - 1 : sessionsBefore,
  };
}

module.exports = {
  isSuperAdminUser,
  requireSuperAdmin,
  getDashboardStats,
  listUsers,
  updateUser,
  deleteUser,
  listRooms,
  deleteRoom,
  listFiles,
  deleteFile,
  revokeAllSessions,
  wipeAllDataExceptSuperAdmin,
};
