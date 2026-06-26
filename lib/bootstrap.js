function setupProcessHandlers({ httpServer, io, appName }) {
  const label = appName || 'Cadence';

  process.on('uncaughtException', (err) => {
    console.error(`[${label}] uncaughtException:`, err);
    process.exit(1);
  });

  process.on('unhandledRejection', (reason) => {
    console.error(`[${label}] unhandledRejection:`, reason);
    process.exit(1);
  });

  const shutdown = (signal) => {
    console.log(`[${label}] ${signal} received — shutting down`);
    const forceExit = setTimeout(() => {
      console.error(`[${label}] forced exit after shutdown timeout`);
      process.exit(1);
    }, 10000);
    forceExit.unref();

    const finish = () => {
      clearTimeout(forceExit);
      console.log(`[${label}] shutdown complete`);
      process.exit(0);
    };

    if (io) {
      io.close(() => {
        if (httpServer) httpServer.close(finish);
        else finish();
      });
    } else if (httpServer) {
      httpServer.close(finish);
    } else {
      finish();
    }
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

function startHttpServer(httpServer, { port, host, onReady }) {
  const PORT = Number(process.env.PORT) || port || 3000;
  const HOST = process.env.HOST || host || '0.0.0.0';
  const underPassenger = Boolean(process.env.PASSENGER_APP_ENV)
    || typeof globalThis.PhusionPassenger !== 'undefined';

  httpServer.once('error', (err) => {
    console.error('[startup] listen failed:', err.message);
    process.exit(1);
  });

  if (underPassenger) {
    httpServer.listen('passenger', onReady);
    return { mode: 'passenger', port: PORT, host: HOST };
  }

  httpServer.listen(PORT, HOST, onReady);
  return { mode: 'standalone', port: PORT, host: HOST };
}

module.exports = { setupProcessHandlers, startHttpServer };
