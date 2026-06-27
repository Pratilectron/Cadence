const { getConfig } = require('./config');
const { getPublicNsfwConfig } = require('./nsfw-check');

function getChatTransport() {
  const fromEnv = String(process.env.CHAT_TRANSPORT || '').trim().toLowerCase();
  if (fromEnv === 'http' || fromEnv === 'socket') return fromEnv;
  if (process.env.NODE_ENV === 'production') return 'http';
  return 'socket';
}

function getPublicAppConfig() {
  const cfg = getConfig();
  return {
    ...getPublicNsfwConfig(),
    appName: cfg.appName,
    guestChatEnabled: cfg.guestChatEnabled,
    registrationEnabled: cfg.registrationEnabled,
    guestHistoryVisible: cfg.guestHistoryVisible,
    guestDecoyCount: cfg.guestDecoyCount,
    chatTransport: getChatTransport(),
  };
}

module.exports = { getPublicAppConfig };
