const { mkdirSync } = require('fs');
const { join } = require('path');
const crypto = require('crypto');
const {
  loadRoomStoreObject,
  saveRoomStoreObject,
  upsertRoomMeta,
  deleteRoomMeta,
} = require('./db');

mkdirSync(join(__dirname, '..', 'data'), { recursive: true });

const PERMISSION_KEYS = [
  'VIEW_CHANNEL',
  'SEND_MESSAGES',
  'SEND_TTS_MESSAGES',
  'MANAGE_MESSAGES',
  'EMBED_LINKS',
  'ATTACH_FILES',
  'READ_MESSAGE_HISTORY',
  'MENTION_EVERYONE',
  'USE_EXTERNAL_EMOJIS',
  'ADD_REACTIONS',
  'MANAGE_CHANNEL',
  'MANAGE_ROLES',
  'CREATE_INSTANT_INVITE',
  'ADMINISTRATOR',
];

function allPermissions(value = true) {
  return Object.fromEntries(PERMISSION_KEYS.map((k) => [k, value]));
}

function defaultEveryonePermissions(roomType) {
  if (roomType === 'public') {
    return {
      VIEW_CHANNEL: true,
      SEND_MESSAGES: true,
      ATTACH_FILES: true,
      READ_MESSAGE_HISTORY: true,
      EMBED_LINKS: true,
      ADD_REACTIONS: true,
      USE_EXTERNAL_EMOJIS: true,
      CREATE_INSTANT_INVITE: true,
      SEND_TTS_MESSAGES: false,
      MANAGE_MESSAGES: false,
      MENTION_EVERYONE: false,
      MANAGE_CHANNEL: false,
      MANAGE_ROLES: false,
      ADMINISTRATOR: false,
    };
  }
  if (roomType === 'private') {
    return {
      VIEW_CHANNEL: false,
      SEND_MESSAGES: false,
      ATTACH_FILES: false,
      READ_MESSAGE_HISTORY: false,
      EMBED_LINKS: false,
      ADD_REACTIONS: false,
      USE_EXTERNAL_EMOJIS: false,
      CREATE_INSTANT_INVITE: false,
      SEND_TTS_MESSAGES: false,
      MANAGE_MESSAGES: false,
      MENTION_EVERYONE: false,
      MANAGE_CHANNEL: false,
      MANAGE_ROLES: false,
      ADMINISTRATOR: false,
    };
  }
  return {
    VIEW_CHANNEL: false,
    SEND_MESSAGES: false,
    ATTACH_FILES: false,
    READ_MESSAGE_HISTORY: true,
    EMBED_LINKS: false,
    ADD_REACTIONS: false,
    USE_EXTERNAL_EMOJIS: false,
    CREATE_INSTANT_INVITE: false,
    SEND_TTS_MESSAGES: false,
    MANAGE_MESSAGES: false,
    MENTION_EVERYONE: false,
    MANAGE_CHANNEL: false,
    MANAGE_ROLES: false,
    ADMINISTRATOR: false,
  };
}

function createEveryoneRole(roomType) {
  return {
    id: '@everyone',
    name: '@everyone',
    color: '#8f877a',
    position: 0,
    managed: true,
    hoist: false,
    permissions: defaultEveryonePermissions(roomType),
  };
}

function createModeratorTemplate() {
  return {
    name: 'Moderator',
    color: '#8fae98',
    permissions: {
      ...defaultEveryonePermissions('public'),
      MANAGE_MESSAGES: true,
      MENTION_EVERYONE: true,
      CREATE_INSTANT_INVITE: true,
    },
  };
}

function loadRoomStore() {
  return loadRoomStoreObject();
}

let savePending = false;
function saveRoomStore(data) {
  if (savePending) return;
  savePending = true;
  setImmediate(() => {
    savePending = false;
    saveRoomStoreObject(data);
  });
}

function persistRoomMeta(roomName, room) {
  upsertRoomMeta(roomName, {
    roles: room.roles,
    memberRoles: room.memberRoles,
  });
}

function applyPersistedMeta(roomName, room) {
  const store = loadRoomStore();
  const saved = store[roomName];
  if (!saved) return;
  if (Array.isArray(saved.roles)) room.roles = saved.roles;
  if (saved.memberRoles) room.memberRoles = saved.memberRoles;
}

function initRoomRoles(room, roomType) {
  room.roles = [createEveryoneRole(roomType)];
  room.memberRoles = {};
  applyPersistedMeta(room.name || '', room);
  if (!room.roles?.length) room.roles = [createEveryoneRole(roomType)];
  if (!room.memberRoles) room.memberRoles = {};
}

function isRoomOwner(room, userId) {
  return Boolean(userId && room.ownerId === userId);
}

function getMemberRoleIds(room, userId) {
  const ids = ['@everyone'];
  if (userId && room.memberRoles[userId]) {
    ids.push(...room.memberRoles[userId]);
  }
  return ids;
}

function getEffectivePermissions(room, userId) {
  if (isRoomOwner(room, userId)) return allPermissions(true);

  const perms = Object.fromEntries(PERMISSION_KEYS.map((k) => [k, false]));
  const roleIds = getMemberRoleIds(room, userId);
  const sortedRoles = room.roles
    .filter((r) => roleIds.includes(r.id))
    .sort((a, b) => b.position - a.position);

  for (const role of sortedRoles) {
    for (const key of PERMISSION_KEYS) {
      if (role.permissions?.[key]) perms[key] = true;
    }
    if (role.permissions?.ADMINISTRATOR) return allPermissions(true);
  }

  if (room.type === 'private' && userId && room.invites.includes(userId)) {
    perms.VIEW_CHANNEL = true;
    perms.READ_MESSAGE_HISTORY = true;
    perms.SEND_MESSAGES = true;
    perms.ATTACH_FILES = true;
  }

  if (room.type === 'locked' && isRoomOwner(room, userId)) {
    return allPermissions(true);
  }

  return perms;
}

function hasPermission(room, userId, permission) {
  const perms = getEffectivePermissions(room, userId);
  return Boolean(perms.ADMINISTRATOR || perms[permission]);
}

function getDisplayRole(room, userId) {
  if (isRoomOwner(room, userId)) {
    return { name: 'Owner', color: '#d4a574' };
  }
  const roleIds = getMemberRoleIds(room, userId).filter((id) => id !== '@everyone');
  const custom = room.roles
    .filter((r) => roleIds.includes(r.id))
    .sort((a, b) => b.position - a.position)[0];
  if (custom) return { name: custom.name, color: custom.color };
  return { name: '@everyone', color: '#8f877a' };
}

function sanitizePermissions(input) {
  const out = Object.fromEntries(PERMISSION_KEYS.map((k) => [k, false]));
  if (!input || typeof input !== 'object') return out;
  for (const key of PERMISSION_KEYS) {
    if (input[key] === true) out[key] = true;
  }
  if (out.ADMINISTRATOR) return allPermissions(true);
  return out;
}

function createCustomRole(room, { name, color, permissions }) {
  const cleanName = String(name || '').trim().slice(0, 32);
  if (!cleanName || cleanName === '@everyone') {
    throw new Error('Invalid role name.');
  }
  const maxPos = room.roles.reduce((m, r) => Math.max(m, r.position || 0), 0);
  const role = {
    id: crypto.randomUUID(),
    name: cleanName,
    color: String(color || '#d4a574').slice(0, 7),
    position: maxPos + 1,
    managed: false,
    hoist: true,
    permissions: sanitizePermissions(permissions),
  };
  room.roles.push(role);
  return role;
}

function updateCustomRole(room, roleId, patch) {
  const role = room.roles.find((r) => r.id === roleId);
  if (!role || role.managed) throw new Error('Cannot edit this role.');
  if (patch.name) role.name = String(patch.name).trim().slice(0, 32);
  if (patch.color) role.color = String(patch.color).slice(0, 7);
  if (patch.permissions) role.permissions = sanitizePermissions(patch.permissions);
  return role;
}

function deleteCustomRole(room, roleId) {
  const idx = room.roles.findIndex((r) => r.id === roleId);
  if (idx < 0) throw new Error('Role not found.');
  if (room.roles[idx].managed) throw new Error('Cannot delete managed role.');
  room.roles.splice(idx, 1);
  for (const userId of Object.keys(room.memberRoles)) {
    room.memberRoles[userId] = room.memberRoles[userId].filter((id) => id !== roleId);
    if (!room.memberRoles[userId].length) delete room.memberRoles[userId];
  }
}

function assignRole(room, userId, roleId) {
  if (!room.roles.find((r) => r.id === roleId) || roleId === '@everyone') {
    throw new Error('Invalid role.');
  }
  if (!room.memberRoles[userId]) room.memberRoles[userId] = [];
  if (!room.memberRoles[userId].includes(roleId)) room.memberRoles[userId].push(roleId);
}

function removeRole(room, userId, roleId) {
  if (!room.memberRoles[userId]) return;
  room.memberRoles[userId] = room.memberRoles[userId].filter((id) => id !== roleId);
  if (!room.memberRoles[userId].length) delete room.memberRoles[userId];
}

function serializeRolesForClient(room, viewerUserId) {
  return {
    roles: room.roles.map(({ id, name, color, position, managed, hoist, permissions }) => ({
      id, name, color, position, managed, hoist, permissions,
    })),
    memberRoles: room.memberRoles,
    myPermissions: getEffectivePermissions(room, viewerUserId),
    myRole: getDisplayRole(room, viewerUserId),
  };
}

module.exports = {
  PERMISSION_KEYS,
  allPermissions,
  defaultEveryonePermissions,
  createEveryoneRole,
  createModeratorTemplate,
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
  loadRoomStore,
};
