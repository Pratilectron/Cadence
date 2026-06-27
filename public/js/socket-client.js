/** Socket.IO client options tuned for Passenger / shared hosting. */
export function createSocketOptions(extra = {}) {
  const host = window.location.hostname;
  const localDev = host === 'localhost'
    || host === '127.0.0.1'
    || host.endsWith('.test')
    || host.endsWith('.local')
    || host.endsWith('.localhost');

  const production = !localDev;

  return {
    path: '/socket.io',
    withCredentials: true,
    transports: localDev ? ['polling', 'websocket'] : ['polling'],
    upgrade: localDev,
    ...(production ? {
      // Survive brief Passenger reloads without a full reconnect storm
      connectionStateRecovery: {
        maxDisconnectionDuration: 3 * 60 * 1000,
      },
      reconnectionDelay: 2000,
      reconnectionDelayMax: 15000,
      randomizationFactor: 0.4,
    } : {}),
    ...extra,
  };
}
