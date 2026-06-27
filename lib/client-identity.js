const crypto = require('crypto');

const DEVICE_COOKIE = 'cadence_device';
const GUEST_LABEL_COOKIE = 'cadence_guest_label';
const DEVICE_MAX_AGE_SEC = 365 * 24 * 60 * 60;
const GUEST_LABEL_MAX_AGE_SEC = 86400;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  header.split(';').forEach((part) => {
    const [key, ...rest] = part.trim().split('=');
    if (!key) return;
    out[key] = decodeURIComponent(rest.join('='));
  });
  return out;
}

function appendSetCookie(res, header) {
  const prev = res.getHeader('Set-Cookie');
  if (!prev) res.setHeader('Set-Cookie', header);
  else if (Array.isArray(prev)) res.setHeader('Set-Cookie', [...prev, header]);
  else res.setHeader('Set-Cookie', [prev, header]);
}

function useSecureCookies(req) {
  if (process.env.COOKIE_SECURE === 'false') return false;
  if (process.env.COOKIE_SECURE === 'true') return true;
  if (process.env.NODE_ENV !== 'production') return false;
  const proto = String(req?.headers?.['x-forwarded-proto'] || '').toLowerCase();
  if (proto === 'https') return true;
  if (req?.socket?.encrypted) return true;
  return false;
}

function secureSuffix(req) {
  return useSecureCookies(req) ? '; Secure' : '';
}

function deviceCookieHeader(deviceId, req) {
  return `${DEVICE_COOKIE}=${deviceId}; Path=/; Max-Age=${DEVICE_MAX_AGE_SEC}; HttpOnly; SameSite=Lax${secureSuffix(req)}`;
}

function guestLabelCookieHeader(name, req) {
  return `${GUEST_LABEL_COOKIE}=${encodeURIComponent(name)}; Path=/; Max-Age=${GUEST_LABEL_MAX_AGE_SEC}; SameSite=Lax${secureSuffix(req)}`;
}

function clearGuestLabelCookieHeader(req) {
  return `${GUEST_LABEL_COOKIE}=; Path=/; Max-Age=0; SameSite=Lax${secureSuffix(req)}`;
}

function setGuestLabelCookie(res, name, req) {
  if (!name) return;
  appendSetCookie(res, guestLabelCookieHeader(name, req));
}

function clearGuestLabelCookie(res, req) {
  appendSetCookie(res, clearGuestLabelCookieHeader(req));
}

function readGuestLabelCookie(cookieHeader) {
  const raw = parseCookies(cookieHeader)[GUEST_LABEL_COOKIE];
  if (!raw) return '';
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

function normalizeIp(value) {
  const raw = String(value || '').trim();
  if (!raw) return 'unknown';
  if (raw.startsWith('::ffff:')) return raw.slice(7);
  return raw;
}

function extractClientIp(req, fallbackAddress) {
  const trustProxy = ['1', 'true', 'yes', 'on'].includes(String(process.env.TRUST_PROXY || '').toLowerCase());
  if (trustProxy) {
    const forwarded = req?.headers?.['x-forwarded-for'];
    if (forwarded) {
      const first = String(forwarded).split(',')[0].trim();
      if (first) return normalizeIp(first);
    }
    const realIp = req?.headers?.['x-real-ip'];
    if (realIp) return normalizeIp(realIp);
  }
  if (fallbackAddress) return normalizeIp(fallbackAddress);
  if (req?.socket?.remoteAddress) return normalizeIp(req.socket.remoteAddress);
  return 'unknown';
}

function readDeviceId(req) {
  const cookies = parseCookies(req?.headers?.cookie);
  const value = cookies[DEVICE_COOKIE];
  return UUID_RE.test(value || '') ? value : null;
}

function ensureDeviceCookie(req, res) {
  const existing = readDeviceId(req);
  if (existing) return existing;
  const deviceId = crypto.randomUUID();
  appendSetCookie(res, deviceCookieHeader(deviceId, req));
  return deviceId;
}

function bindHttpIdentity(req, res, extra = {}) {
  const deviceId = ensureDeviceCookie(req, res);
  const ip = extractClientIp(req);
  return {
    ip,
    deviceId,
    userId: extra.userId || null,
    username: extra.username || null,
  };
}

function bindSocketIdentity(socket, extra = {}) {
  const req = socket.request || socket.handshake || {};
  const ip = extractClientIp(
    { headers: socket.handshake?.headers || {}, socket: socket.conn?.request?.socket },
    socket.handshake?.address,
  );
  const cookies = parseCookies(socket.handshake?.headers?.cookie);
  const deviceId = UUID_RE.test(cookies[DEVICE_COOKIE] || '') ? cookies[DEVICE_COOKIE] : null;
  return {
    ip,
    deviceId,
    userId: extra.userId || null,
    username: extra.username || null,
  };
}

module.exports = {
  DEVICE_COOKIE,
  GUEST_LABEL_COOKIE,
  parseCookies,
  appendSetCookie,
  extractClientIp,
  readDeviceId,
  ensureDeviceCookie,
  setGuestLabelCookie,
  clearGuestLabelCookie,
  readGuestLabelCookie,
  useSecureCookies,
  bindHttpIdentity,
  bindSocketIdentity,
};
