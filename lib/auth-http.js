const { bindHttpIdentity } = require('./client-identity');

function clientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) return String(forwarded).split(',')[0].trim();
  return req.socket?.remoteAddress || 'unknown';
}

async function handleAuthLogin(req, res, jsonResponse, ctx) {
  if (req.method !== 'POST') {
    jsonResponse(res, 405, { error: 'Method not allowed.' });
    return true;
  }

  let body;
  try {
    body = await ctx.readJsonBody(req);
  } catch {
    jsonResponse(res, 400, { error: 'Invalid request body.' });
    return true;
  }

  const rateKey = `login:${clientIp(req)}`;
  const cfg = ctx.config();
  if (!ctx.checkRateLimit(rateKey, cfg.rateLimitLogin, cfg.rateLimitWindowMin * 60 * 1000)) {
    jsonResponse(res, 429, { message: 'Too many login attempts. Try again later.' });
    return true;
  }

  const cleanUsername = ctx.sanitizeUsername(body.username);
  const cleanPassword = String(body.password || '');
  const user = ctx.findUserByUsername(cleanUsername);

  if (!user || !ctx.verifyPassword(cleanPassword, user)) {
    jsonResponse(res, 401, { message: 'Invalid username or password.' });
    return true;
  }

  const identity = bindHttpIdentity(req, res, { userId: user.id, username: user.username });
  const lockStatus = ctx.getModerationStatus(identity);
  if (lockStatus.lockedOut && !ctx.isSuperAdmin(user)) {
    jsonResponse(res, 403, {
      message: lockStatus.lockoutMinutes
        ? `Access suspended for ${lockStatus.lockoutMinutes} minute${lockStatus.lockoutMinutes === 1 ? '' : 's'} after repeated content policy violations.`
        : 'Access suspended after repeated content policy violations.',
      accountLocked: true,
    });
    return true;
  }

  if (cfg.maintenanceMode && !ctx.isSuperAdmin(user)) {
    jsonResponse(res, 403, { message: 'Maintenance mode is active.' });
    return true;
  }

  const token = ctx.createSession(user.id);
  ctx.logAuthEvent('user.login', user, req);
  jsonResponse(res, 200, ctx.authPayload(user, token));
  return true;
}

async function handleAuthRegister(req, res, jsonResponse, ctx) {
  if (req.method !== 'POST') {
    jsonResponse(res, 405, { error: 'Method not allowed.' });
    return true;
  }

  if (!ctx.config().registrationEnabled) {
    jsonResponse(res, 403, { message: 'Registration is disabled.' });
    return true;
  }

  let body;
  try {
    body = await ctx.readJsonBody(req);
  } catch {
    jsonResponse(res, 400, { error: 'Invalid request body.' });
    return true;
  }

  const rateKey = `register:${clientIp(req)}`;
  const cfg = ctx.config();
  if (!ctx.checkRateLimit(rateKey, cfg.rateLimitRegister, cfg.rateLimitWindowMin * 60 * 1000)) {
    jsonResponse(res, 429, { message: 'Too many attempts. Try again later.' });
    return true;
  }

  const cleanUsername = ctx.sanitizeUsername(body.username);
  const cleanPassword = String(body.password || '');

  if (cleanUsername.length < 3) {
    jsonResponse(res, 400, { message: 'Username must be at least 3 characters.' });
    return true;
  }
  if (cleanPassword.length < 8) {
    jsonResponse(res, 400, { message: 'Password must be at least 8 characters.' });
    return true;
  }
  if (ctx.findUserByUsername(cleanUsername)) {
    jsonResponse(res, 409, { message: 'Username already exists. Please log in.' });
    return true;
  }

  const { algo, salt, passwordHash } = ctx.hashPasswordScrypt(cleanPassword);
  const id = ctx.crypto.randomUUID();
  ctx.usersDb.users.push({
    id,
    username: cleanUsername,
    algo,
    passwordHash,
    salt,
    superAdmin: ctx.isSuperAdminUsername(cleanUsername),
    createdAt: Date.now(),
  });
  ctx.saveUsersDb();

  const token = ctx.createSession(id);
  const newUser = ctx.usersDb.users.find((u) => u.id === id);
  ctx.logAuthEvent('user.registered', newUser, req);
  jsonResponse(res, 200, ctx.authPayload(newUser, token));
  return true;
}

async function handleAuthRestore(req, res, jsonResponse, ctx) {
  if (req.method !== 'POST') {
    jsonResponse(res, 405, { error: 'Method not allowed.' });
    return true;
  }

  const token = ctx.getTokenFromReq(req);
  if (!token) {
    jsonResponse(res, 401, { error: 'session_expired', message: 'Session expired. Sign in again.' });
    return true;
  }

  const user = ctx.getSessionUser(token);
  if (!user) {
    jsonResponse(res, 401, { error: 'session_expired', message: 'Session expired. Sign in again.' });
    return true;
  }

  const record = ctx.findUserById(user.id);
  const identity = bindHttpIdentity(req, res, { userId: user.id, username: user.username });
  const lockStatus = ctx.getModerationStatus(identity);
  if (lockStatus.lockedOut && !ctx.isSuperAdmin(record)) {
    ctx.revokeSession(token);
    jsonResponse(res, 403, {
      message: lockStatus.lockoutMinutes
        ? `Access suspended for ${lockStatus.lockoutMinutes} minute${lockStatus.lockoutMinutes === 1 ? '' : 's'} due to repeated content policy violations.`
        : 'Access suspended due to repeated content policy violations.',
      accountLocked: true,
      lockoutMinutes: lockStatus.lockoutMinutes,
      lockoutUntil: lockStatus.lockoutUntil,
      strikes: lockStatus.strikes,
      maxStrikes: lockStatus.maxStrikes,
    });
    return true;
  }

  ctx.logAuthEvent('user.session_restored', user, req);
  jsonResponse(res, 200, ctx.authPayload(user, token));
  return true;
}

module.exports = {
  handleAuthLogin,
  handleAuthRegister,
  handleAuthRestore,
};
