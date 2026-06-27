/** Socket.IO client options tuned for Passenger / shared hosting. */
export function createSocketOptions(extra = {}) {
  const host = window.location.hostname;
  const localDev = host === 'localhost'
    || host === '127.0.0.1'
    || host.endsWith('.test')
    || host.endsWith('.local')
    || host.endsWith('.localhost');

  return {
    path: '/socket.io',
    withCredentials: true,
    // Polling-only on production — WebSocket upgrades often fail behind Passenger/Apache
    transports: localDev ? ['polling', 'websocket'] : ['polling'],
    upgrade: localDev,
    ...extra,
  };
}
