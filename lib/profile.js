const { loadManifest } = require('./uploads');
const { readActivity } = require('./activity');
const { isSuperAdminUser } = require('./admin');

function buildProfile(userRecord) {
  if (!userRecord) return null;

  const manifest = loadManifest();
  const userFiles = Object.values(manifest.files).filter((f) => f.userId === userRecord.id);
  const logs = readActivity({ limit: 5000 }).filter((l) => l.userId === userRecord.id);

  return {
    id: userRecord.id,
    username: userRecord.username,
    displayName: userRecord.displayName || '',
    bio: userRecord.bio || '',
    avatar: publicAvatar(userRecord),
    createdAt: userRecord.createdAt || null,
    superAdmin: isSuperAdminUser(userRecord),
    preferences: {
      soundEnabled: userRecord.preferences?.soundEnabled !== false,
      sendSoundEnabled: userRecord.preferences?.sendSoundEnabled !== false,
      showTimestamps: userRecord.preferences?.showTimestamps !== false,
      activitySounds: userRecord.preferences?.activitySounds !== false,
      titleNotifications: userRecord.preferences?.titleNotifications !== false,
      desktopNotifications: Boolean(userRecord.preferences?.desktopNotifications),
    },
    stats: {
      uploads: userFiles.length,
      storageBytes: userFiles.reduce((sum, f) => sum + (f.size || 0), 0),
      messagesSent: logs.filter((l) => l.event === 'message.sent').length,
      roomsJoined: logs.filter((l) => l.event === 'room.joined').length,
      roomsCreated: logs.filter((l) => l.event === 'room.created').length,
      pinsCreated: logs.filter((l) => l.event === 'message.pinned').length,
      invitesSent: logs.filter((l) => l.event === 'room.invite').length,
      logins: logs.filter((l) => l.event === 'user.login').length,
      activityEvents: logs.length,
    },
  };
}

function updateProfile(usersDb, saveUsersDb, userId, patch) {
  const user = usersDb.users.find((u) => u.id === userId);
  if (!user) throw new Error('User not found.');

  if (patch.displayName !== undefined) {
    user.displayName = String(patch.displayName).trim().slice(0, 32);
  }
  if (patch.bio !== undefined) {
    user.bio = String(patch.bio).trim().slice(0, 160);
  }
  if (patch.avatar !== undefined) {
    user.avatar = sanitizeAvatar(patch.avatar);
  }
  if (patch.preferences && typeof patch.preferences === 'object') {
    user.preferences = { ...(user.preferences || {}), ...patch.preferences };
  }

  saveUsersDb();
  return buildProfile(user);
}

const PRESET_ID = /^mark-(0[1-9]|[12]\d|3[0-6])$/;
const AVATAR_DATA = /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/;
const MAX_AVATAR_URL = 120000;

function isPresetId(id) {
  return PRESET_ID.test(String(id || ''));
}

function sanitizeAvatar(input) {
  if (!input || input.kind === 'letter') return null;
  if (input.kind === 'preset' && isPresetId(input.id)) {
    return { kind: 'preset', id: input.id };
  }
  if (input.kind === 'image' && typeof input.dataUrl === 'string') {
    if (input.dataUrl.length > MAX_AVATAR_URL || !AVATAR_DATA.test(input.dataUrl)) {
      throw new Error('Avatar image must be a small JPEG, PNG, or WebP.');
    }
    return { kind: 'image', dataUrl: input.dataUrl };
  }
  throw new Error('Invalid avatar.');
}

function publicAvatar(user) {
  const avatar = user?.avatar;
  if (!avatar) return null;
  if (avatar.kind === 'preset' && isPresetId(avatar.id)) return { kind: 'preset', id: avatar.id };
  if (avatar.kind === 'image' && typeof avatar.dataUrl === 'string') {
    return { kind: 'image', dataUrl: avatar.dataUrl };
  }
  return null;
}

module.exports = { buildProfile, updateProfile, sanitizeAvatar, publicAvatar, isPresetId };
