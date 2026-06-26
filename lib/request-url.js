function getRequestBaseUrl(req) {
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  if (!host) return null;
  const proto = String(req.headers['x-forwarded-proto'] || 'http').split(',')[0].trim();
  return `${proto}://${host}`;
}

function parseRequestUrl(req, fallbackPort) {
  const port = fallbackPort || Number(process.env.PORT) || 3000;
  const base = getRequestBaseUrl(req) || `http://127.0.0.1:${port}`;
  return new URL(req.url, base);
}

module.exports = { getRequestBaseUrl, parseRequestUrl };
