const { getConfig } = require('./config');
const { getPublicNsfwConfig } = require('./nsfw-check');

function getPublicAppConfig() {
  const cfg = getConfig();
  return {
    ...getPublicNsfwConfig(),
    appName: cfg.appName,
    guestChatEnabled: cfg.guestChatEnabled,
    registrationEnabled: cfg.registrationEnabled,
    guestHistoryVisible: cfg.guestHistoryVisible,
    guestDecoyCount: cfg.guestDecoyCount,
  };
}

module.exports = { getPublicAppConfig };
