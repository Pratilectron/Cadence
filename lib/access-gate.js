const crypto = require('crypto');
const {
  parseCookies,
  appendSetCookie,
  bindHttpIdentity,
  readDeviceId,
  setGuestLabelCookie,
  clearGuestLabelCookie,
  useSecureCookies,
} = require('./client-identity');
const { assertNotLockedOut, ModerationBlockedError } = require('./moderation-strikes');
const { sanitizeGuestName } = require('./guest-content');

const GATE_COOKIE = 'cadence_gate';
const GATE_MAX_AGE_SEC = 86400;
const GATE_VERSION = 1;

let gateSecretCache = null;

function getGateSecret() {
  if (gateSecretCache) return gateSecretCache;
  const fromEnv = String(process.env.GATE_SECRET || '').trim();
  if (fromEnv.length >= 16) {
    gateSecretCache = fromEnv;
    return gateSecretCache;
  }
  if (process.env.NODE_ENV === 'production') {
    console.warn('[gate] GATE_SECRET is not set — using an ephemeral secret (tokens reset on restart).');
  }
  gateSecretCache = crypto.randomBytes(32).toString('hex');
  return gateSecretCache;
}

function base64urlEncode(value) {
  return Buffer.from(value).toString('base64url');
}

function base64urlDecode(value) {
  return Buffer.from(value, 'base64url');
}

function signPayload(payloadB64) {
  return crypto.createHmac('sha256', getGateSecret()).update(payloadB64).digest('base64url');
}

function createGateToken(mode, deviceId) {
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    v: GATE_VERSION,
    mode,
    deviceId,
    iat: now,
    exp: now + GATE_MAX_AGE_SEC,
  };
  const payloadB64 = base64urlEncode(JSON.stringify(payload));
  return `${payloadB64}.${signPayload(payloadB64)}`;
}

function verifyGateToken(token, deviceId) {
  if (!token || typeof token !== 'string' || !deviceId) return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [payloadB64, signature] = parts;
  const expected = signPayload(payloadB64);
  try {
    const sigBuf = Buffer.from(signature, 'base64url');
    const expBuf = Buffer.from(expected, 'base64url');
    if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) return null;
  } catch {
    return null;
  }

  let payload;
  try {
    payload = JSON.parse(base64urlDecode(payloadB64).toString('utf8'));
  } catch {
    return null;
  }

  if (payload?.v !== GATE_VERSION) return null;
  if (payload.deviceId !== deviceId) return null;
  if (payload.mode !== 'guest' && payload.mode !== 'user') return null;
  const now = Math.floor(Date.now() / 1000);
  if (!Number.isFinite(payload.exp) || payload.exp < now) return null;
  if (!Number.isFinite(payload.iat) || payload.iat > now + 60) return null;

  return { mode: payload.mode, deviceId: payload.deviceId, exp: payload.exp };
}

function gateCookieHeader(token, req) {
  const secure = useSecureCookies(req) ? '; Secure' : '';
  return `${GATE_COOKIE}=${token}; Path=/; Max-Age=${GATE_MAX_AGE_SEC}; HttpOnly; SameSite=Lax${secure}`;
}

function clearGateCookieHeader(req) {
  const secure = useSecureCookies(req) ? '; Secure' : '';
  return `${GATE_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax${secure}`;
}

function getGateAccess(req) {
  const deviceId = readDeviceId(req);
  if (!deviceId) return null;
  const token = parseCookies(req.headers.cookie)[GATE_COOKIE];
  const verified = verifyGateToken(token, deviceId);
  if (!verified) return null;
  return verified;
}

function getGateAccessFromSocket(socket) {
  const cookies = parseCookies(socket.handshake?.headers?.cookie);
  const deviceId = readDeviceId({ headers: { cookie: socket.handshake?.headers?.cookie } });
  if (!deviceId) return null;
  const token = cookies[GATE_COOKIE];
  return verifyGateToken(token, deviceId);
}

function hasGateAccess(req) {
  return Boolean(getGateAccess(req));
}

function setGateCookie(res, mode, deviceId, req) {
  const token = createGateToken(mode, deviceId);
  appendSetCookie(res, gateCookieHeader(token, req));
}

function clearGateCookie(res, req) {
  appendSetCookie(res, clearGateCookieHeader(req));
}

function rejectModerationLockout(res, jsonResponse, err) {
  jsonResponse(res, 403, {
    ok: false,
    error: err.message,
    ...(err.moderation || {}),
  });
}

async function handleGateGuest(req, res, jsonResponse, getConfig, readJsonBody) {
  if (req.method !== 'POST') {
    jsonResponse(res, 405, { error: 'Method not allowed.' });
    return true;
  }
  if (!getConfig().guestChatEnabled) {
    jsonResponse(res, 403, { error: 'Guest chat is disabled.' });
    return true;
  }

  const identity = bindHttpIdentity(req, res);
  try {
    assertNotLockedOut(identity);
  } catch (err) {
    if (err instanceof ModerationBlockedError) {
      rejectModerationLockout(res, jsonResponse, err);
      return true;
    }
    throw err;
  }

  let displayName = '';
  try {
    const body = await readJsonBody(req);
    displayName = sanitizeGuestName(body.displayName);
  } catch {
    displayName = sanitizeGuestName('');
  }

  setGateCookie(res, 'guest', identity.deviceId, req);
  setGuestLabelCookie(res, displayName, req);
  jsonResponse(res, 200, { ok: true, mode: 'guest', displayName });
  return true;
}

function handleGateAck(req, res, jsonResponse, getSessionUser, getTokenFromReq, options = {}) {
  if (req.method !== 'POST') {
    jsonResponse(res, 405, { error: 'Method not allowed.' });
    return true;
  }
  const user = getSessionUser(getTokenFromReq(req));
  if (!user) {
    jsonResponse(res, 401, { error: 'Authentication required.' });
    return true;
  }

  const record = options.findUserById?.(user.id);
  const isSuperAdmin = Boolean(options.isSuperAdmin?.(record));
  const identity = bindHttpIdentity(req, res, { userId: user.id, username: user.username });
  try {
    assertNotLockedOut(identity, { isSuperAdmin });
  } catch (err) {
    if (err instanceof ModerationBlockedError) {
      rejectModerationLockout(res, jsonResponse, err);
      return true;
    }
    throw err;
  }

  setGateCookie(res, 'user', identity.deviceId, req);
  clearGuestLabelCookie(res, req);
  jsonResponse(res, 200, { ok: true, mode: 'user', username: user.username });
  return true;
}

function handleGateClear(req, res, jsonResponse) {
  if (req.method !== 'POST') {
    jsonResponse(res, 405, { error: 'Method not allowed.' });
    return true;
  }
  clearGateCookie(res, req);
  clearGuestLabelCookie(res, req);
  jsonResponse(res, 200, { ok: true });
  return true;
}

function handleGateStatus(req, res, jsonResponse, getModerationStatus) {
  if (req.method !== 'GET') {
    jsonResponse(res, 405, { error: 'Method not allowed.' });
    return true;
  }
  const identity = bindHttpIdentity(req, res);
  const moderation = getModerationStatus(identity);
  const gate = getGateAccess(req);
  jsonResponse(res, 200, {
    granted: Boolean(gate),
    mode: gate?.mode || null,
    moderationLockedOut: moderation.lockedOut,
    moderationLockoutMinutes: moderation.lockoutMinutes,
    moderationLockoutUntil: moderation.lockoutUntil,
  });
  return true;
}

module.exports = {
  GATE_COOKIE,
  hasGateAccess,
  getGateAccess,
  getGateAccessFromSocket,
  verifyGateToken,
  setGateCookie,
  clearGateCookie,
  handleGateGuest,
  handleGateAck,
  handleGateClear,
  handleGateStatus,
};
