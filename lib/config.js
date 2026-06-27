const { mkdirSync } = require('fs');
const { join } = require('path');
const { loadSettingsObject, saveSettingsPatch } = require('./db');
const ROOT = join(__dirname, '..');
const ENV_PATH = join(ROOT, '.env');

mkdirSync(join(ROOT, 'data'), { recursive: true });

require('dotenv').config({ path: ENV_PATH, quiet: true });

const DEFAULTS = {
  appName: 'Cadence',
  port: 3000,
  maxStorageGb: 20,
  maxFileMb: 100,
  maxMessagesPerRoom: 300,
  maxPinnedPerRoom: 20,
  maxActivityLogLines: 5000,
  rateLimitRegister: 8,
  rateLimitLogin: 10,
  rateLimitMessages: 30,
  rateLimitWindowMin: 15,
  rateLimitMessageWindowSec: 10,
  defaultRooms: ['General', 'Random'],
  registrationEnabled: true,
  guestChatEnabled: true,
  maintenanceMode: false,
  superAdminUsernames: [],
  allowedOrigins: [],
  nsfwEnabled: true,
  nsfwPornThreshold: 0.6,
  nsfwSexyThreshold: 0.75,
  nsfwStrict: false,
  nsfwMaxStrikes: 5,
  nsfwLockoutMinutes: 10,
  guestHistoryVisible: 2,
  guestDecoyCount: 15,
};

function loadSettingsFile() {
  try {
    return loadSettingsObject();
  } catch {
    return {};
  }
}

function parseList(value, fallback = []) {
  if (!value) return fallback;
  if (Array.isArray(value)) return value;
  return String(value).split(',').map((s) => s.trim()).filter(Boolean);
}

function parseBool(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

function parseNum(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function normalizeOrigin(value) {
  if (!value || typeof value !== 'string') return '';
  return value.trim().replace(/\/$/, '');
}

function expandOriginVariants(origin) {
  const trimmed = normalizeOrigin(origin);
  if (!trimmed) return [];
  const variants = new Set([trimmed]);
  try {
    const url = new URL(trimmed);
    if (url.hostname.startsWith('www.')) {
      variants.add(`${url.protocol}//${url.hostname.slice(4)}${url.port ? `:${url.port}` : ''}`);
    } else {
      variants.add(`${url.protocol}//www.${url.hostname}${url.port ? `:${url.port}` : ''}`);
    }
    if (url.protocol === 'http:') {
      variants.add(trimmed.replace('http://', 'https://'));
    }
  } catch {
    // keep literal origin only
  }
  return [...variants];
}

function buildDefaultOrigins(port) {
  const origins = [
    `http://localhost:${port}`,
    `http://127.0.0.1:${port}`,
  ];
  const publicUrl = process.env.PUBLIC_URL || process.env.APP_URL || '';
  if (publicUrl) origins.push(...expandOriginVariants(publicUrl));
  return [...new Set(origins.map(normalizeOrigin))];
}

function buildAllowedOrigins(port, originsRaw) {
  const explicit = parseList(originsRaw, []);
  const merged = [
    ...explicit,
    ...buildDefaultOrigins(port),
  ];
  return [...new Set(merged.flatMap(expandOriginVariants).map(normalizeOrigin).filter(Boolean))];
}

let cached = null;

function buildConfig() {
  const file = loadSettingsFile();
  const port = parseNum(process.env.PORT, parseNum(file.port, DEFAULTS.port));

  const originsRaw = process.env.ALLOWED_ORIGINS ?? file.allowedOrigins;
  const allowedOrigins = buildAllowedOrigins(port, originsRaw);

  const superAdminUsernames = parseList(
    process.env.SUPER_ADMIN_USERNAMES ?? file.superAdminUsernames,
    DEFAULTS.superAdminUsernames,
  ).map((u) => u.toLowerCase());

  const maxStorageGb = parseNum(process.env.MAX_STORAGE_GB ?? file.maxStorageGb, DEFAULTS.maxStorageGb);
  const maxFileMb = parseNum(process.env.MAX_FILE_MB ?? file.maxFileMb, DEFAULTS.maxFileMb);

  return {
    appName: process.env.APP_NAME || file.appName || DEFAULTS.appName,
    port,
    allowedOrigins,
    superAdminUsernames,
    maxStorageGb,
    maxFileMb,
    maxStorageBytes: maxStorageGb * 1024 * 1024 * 1024,
    maxFileBytes: maxFileMb * 1024 * 1024,
    maxMessagesPerRoom: parseNum(process.env.MAX_MESSAGES_PER_ROOM ?? file.maxMessagesPerRoom, DEFAULTS.maxMessagesPerRoom),
    maxPinnedPerRoom: parseNum(process.env.MAX_PINNED_PER_ROOM ?? file.maxPinnedPerRoom, DEFAULTS.maxPinnedPerRoom),
    maxActivityLogLines: parseNum(file.maxActivityLogLines, DEFAULTS.maxActivityLogLines),
    rateLimitRegister: parseNum(process.env.RATE_LIMIT_REGISTER ?? file.rateLimitRegister, DEFAULTS.rateLimitRegister),
    rateLimitLogin: parseNum(process.env.RATE_LIMIT_LOGIN ?? file.rateLimitLogin, DEFAULTS.rateLimitLogin),
    rateLimitMessages: parseNum(process.env.RATE_LIMIT_MESSAGES ?? file.rateLimitMessages, DEFAULTS.rateLimitMessages),
    rateLimitWindowMin: parseNum(process.env.RATE_LIMIT_WINDOW_MIN ?? file.rateLimitWindowMin, DEFAULTS.rateLimitWindowMin),
    rateLimitMessageWindowSec: parseNum(process.env.RATE_LIMIT_MSG_WINDOW_SEC ?? file.rateLimitMessageWindowSec, DEFAULTS.rateLimitMessageWindowSec),
    defaultRooms: parseList(process.env.DEFAULT_ROOMS ?? file.defaultRooms, DEFAULTS.defaultRooms),
    registrationEnabled: parseBool(process.env.REGISTRATION_ENABLED ?? file.registrationEnabled, DEFAULTS.registrationEnabled),
    guestChatEnabled: parseBool(process.env.GUEST_CHAT_ENABLED ?? file.guestChatEnabled, DEFAULTS.guestChatEnabled),
    maintenanceMode: parseBool(process.env.MAINTENANCE_MODE ?? file.maintenanceMode, DEFAULTS.maintenanceMode),
    publicUrl: (process.env.PUBLIC_URL || process.env.APP_URL || '').replace(/\/$/, ''),
    nsfwEnabled: parseBool(process.env.NSFW_ENABLED ?? file.nsfwEnabled, DEFAULTS.nsfwEnabled),
    nsfwPornThreshold: parseNum(process.env.NSFW_PORN_THRESHOLD ?? file.nsfwPornThreshold, DEFAULTS.nsfwPornThreshold),
    nsfwSexyThreshold: parseNum(process.env.NSFW_SEXY_THRESHOLD ?? file.nsfwSexyThreshold, DEFAULTS.nsfwSexyThreshold),
    nsfwStrict: parseBool(process.env.NSFW_STRICT ?? file.nsfwStrict, DEFAULTS.nsfwStrict),
    nsfwMaxStrikes: parseNum(process.env.NSFW_MAX_STRIKES ?? file.nsfwMaxStrikes, DEFAULTS.nsfwMaxStrikes),
    nsfwLockoutMinutes: parseNum(process.env.NSFW_LOCKOUT_MINUTES ?? file.nsfwLockoutMinutes, DEFAULTS.nsfwLockoutMinutes),
    guestHistoryVisible: parseNum(process.env.GUEST_HISTORY_VISIBLE ?? file.guestHistoryVisible, DEFAULTS.guestHistoryVisible),
    guestDecoyCount: parseNum(process.env.GUEST_DECOY_COUNT ?? file.guestDecoyCount, DEFAULTS.guestDecoyCount),
    envLocked: {
      port: Boolean(process.env.PORT),
      superAdminUsernames: Boolean(process.env.SUPER_ADMIN_USERNAMES),
      maxStorageGb: Boolean(process.env.MAX_STORAGE_GB),
      maxFileMb: Boolean(process.env.MAX_FILE_MB),
      allowedOrigins: Boolean(process.env.ALLOWED_ORIGINS),
    },
  };
}

function getConfig() {
  if (!cached) cached = buildConfig();
  return cached;
}

function reloadConfig() {
  cached = buildConfig();
  return cached;
}

function getEditableSettings() {
  const cfg = getConfig();
  return {
    appName: cfg.appName,
    maxStorageGb: cfg.maxStorageGb,
    maxFileMb: cfg.maxFileMb,
    maxMessagesPerRoom: cfg.maxMessagesPerRoom,
    maxPinnedPerRoom: cfg.maxPinnedPerRoom,
    maxActivityLogLines: cfg.maxActivityLogLines,
    rateLimitRegister: cfg.rateLimitRegister,
    rateLimitLogin: cfg.rateLimitLogin,
    rateLimitMessages: cfg.rateLimitMessages,
    rateLimitWindowMin: cfg.rateLimitWindowMin,
    rateLimitMessageWindowSec: cfg.rateLimitMessageWindowSec,
    defaultRooms: cfg.defaultRooms,
    registrationEnabled: cfg.registrationEnabled,
    guestChatEnabled: cfg.guestChatEnabled,
    maintenanceMode: cfg.maintenanceMode,
    superAdminUsernames: cfg.superAdminUsernames,
    allowedOrigins: cfg.allowedOrigins,
    nsfwEnabled: cfg.nsfwEnabled,
    nsfwPornThreshold: cfg.nsfwPornThreshold,
    nsfwSexyThreshold: cfg.nsfwSexyThreshold,
    envLocked: cfg.envLocked,
  };
}

function saveSettings(patch) {
  saveSettingsPatch(patch);
  reloadConfig();
  return getEditableSettings();
}

function isSuperAdminUsername(username) {
  if (!username) return false;
  return getConfig().superAdminUsernames.includes(String(username).toLowerCase());
}

module.exports = {
  getConfig,
  reloadConfig,
  getEditableSettings,
  saveSettings,
  isSuperAdminUsername,
};
