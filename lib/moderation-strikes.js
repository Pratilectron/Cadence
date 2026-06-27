const { getConfig } = require('./config');
const { getDb } = require('./db');
const { logActivity } = require('./activity');

class ModerationBlockedError extends Error {
  constructor(message, moderation = {}) {
    super(message);
    this.name = 'ModerationBlockedError';
    this.moderation = moderation;
  }
}

function listSubjects(context = {}) {
  const subjects = [];
  if (context.userId) subjects.push({ type: 'user', key: String(context.userId) });
  if (context.ip && context.ip !== 'unknown') subjects.push({ type: 'ip', key: String(context.ip) });
  if (context.deviceId) subjects.push({ type: 'device', key: String(context.deviceId) });
  return subjects;
}

function readStrikeRow(subject) {
  return getDb().prepare(
    'SELECT * FROM moderation_strikes WHERE subject_type = ? AND subject_key = ?',
  ).get(subject.type, subject.key);
}

function writeStrikeRow(subject, strikeCount, lockoutUntil) {
  const now = Date.now();
  getDb().prepare(`
    INSERT INTO moderation_strikes (subject_type, subject_key, strike_count, lockout_until, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(subject_type, subject_key) DO UPDATE SET
      strike_count = excluded.strike_count,
      lockout_until = excluded.lockout_until,
      updated_at = excluded.updated_at
  `).run(subject.type, subject.key, strikeCount, lockoutUntil, now);
}

function clearExpiredLockout(subject) {
  const row = readStrikeRow(subject);
  if (!row) return;
  const now = Date.now();
  if (row.lockout_until > 0 && row.lockout_until <= now) {
    writeStrikeRow(subject, 0, 0);
  }
}

function minutesRemaining(lockoutUntil) {
  return Math.max(1, Math.ceil((lockoutUntil - Date.now()) / 60000));
}

function buildStatus(strikeCount = 0, lockoutUntil = 0) {
  const cfg = getConfig();
  const maxStrikes = cfg.nsfwMaxStrikes;
  const now = Date.now();
  const lockedOut = lockoutUntil > now;
  return {
    strikes: strikeCount,
    maxStrikes,
    remaining: lockedOut ? 0 : Math.max(0, maxStrikes - strikeCount),
    lockedOut,
    lockoutUntil: lockedOut ? lockoutUntil : 0,
    lockoutMinutes: lockedOut ? minutesRemaining(lockoutUntil) : 0,
  };
}

function getSubjectStatus(subject) {
  clearExpiredLockout(subject);
  const row = readStrikeRow(subject);
  if (!row) return buildStatus(0, 0);
  return buildStatus(row.strike_count, row.lockout_until);
}

function getModerationStatus(context = {}) {
  const subjects = listSubjects(context);
  if (!subjects.length) return buildStatus(0, 0);

  let strikeCount = 0;
  let lockoutUntil = 0;
  for (const subject of subjects) {
    try {
      const status = getSubjectStatus(subject);
      strikeCount = Math.max(strikeCount, status.strikes);
      lockoutUntil = Math.max(lockoutUntil, status.lockoutUntil);
    } catch (err) {
      console.error('[moderation] strike lookup failed:', err.message);
    }
  }
  return buildStatus(strikeCount, lockoutUntil);
}

function lockoutMessage(status, context = {}) {
  const mins = status.lockoutMinutes;
  const unit = mins === 1 ? 'minute' : 'minutes';
  if (context.userId) {
    return `Your account is suspended for ${mins} ${unit} due to repeated content policy violations.`;
  }
  return `Uploads are blocked for ${mins} ${unit} on this browser and connection due to repeated content policy violations.`;
}

function assertNotLockedOut(context = {}, { isSuperAdmin = false } = {}) {
  if (isSuperAdmin) return getModerationStatus(context);
  const status = getModerationStatus(context);
  if (!status.lockedOut) return status;
  const message = lockoutMessage(status, context);
  throw new ModerationBlockedError(message, { ...status, reason: message });
}

function recordSubjectStrike(subject, cfg) {
  const current = getSubjectStatus(subject);
  if (current.lockedOut) return { ...current, lockedOut: true };

  const nextStrikes = current.strikes + 1;
  if (nextStrikes >= cfg.nsfwMaxStrikes) {
    const lockoutUntil = Date.now() + cfg.nsfwLockoutMinutes * 60 * 1000;
    writeStrikeRow(subject, 0, lockoutUntil);
    return buildStatus(cfg.nsfwMaxStrikes, lockoutUntil);
  }

  writeStrikeRow(subject, nextStrikes, 0);
  return buildStatus(nextStrikes, 0);
}

function processNsfwBlock(context = {}, { isSuperAdmin = false } = {}) {
  const cfg = getConfig();
  const base = {
    strikes: 0,
    maxStrikes: cfg.nsfwMaxStrikes,
    remaining: cfg.nsfwMaxStrikes,
    lockedOut: false,
    lockoutUntil: 0,
    lockoutMinutes: 0,
  };

  if (isSuperAdmin) return base;

  const subjects = listSubjects(context);
  if (!subjects.length) return base;

  const current = getModerationStatus(context);
  if (current.lockedOut) {
    return { ...current, reason: lockoutMessage(current, context) };
  }

  let worst = base;
  for (const subject of subjects) {
    const result = recordSubjectStrike(subject, cfg);
    if (result.strikes > worst.strikes) worst = result;
    if (result.lockoutUntil > worst.lockoutUntil) worst = result;
    if (result.lockedOut) worst.lockedOut = true;
  }

  const status = getModerationStatus(context);
  const lockedOut = status.lockedOut;

  logActivity({
    event: lockedOut ? 'moderation.lockout' : 'moderation.blocked',
    userId: context.userId || null,
    username: context.username || null,
    meta: {
      strikes: status.strikes,
      maxStrikes: status.maxStrikes,
      remaining: status.remaining,
      lockoutMinutes: status.lockoutMinutes,
      ip: context.ip || null,
      deviceId: context.deviceId ? `${context.deviceId.slice(0, 8)}…` : null,
      subjects: subjects.map((s) => s.type),
    },
  });

  return status;
}

function enrichBlockResult(result, context = {}, options = {}) {
  if (result.ok !== false) return result;
  const strikeInfo = processNsfwBlock(context, options);
  return {
    ...result,
    ...strikeInfo,
    reason: strikeInfo.lockedOut
      ? `Limit reached (${strikeInfo.maxStrikes}/${strikeInfo.maxStrikes}). Blocked for ${strikeInfo.lockoutMinutes} minutes on this account, browser, and connection.`
      : (result.reason || `This content isn't allowed on Cadence. Warning ${strikeInfo.strikes} of ${strikeInfo.maxStrikes}.`),
  };
}

module.exports = {
  ModerationBlockedError,
  getModerationStatus,
  assertNotLockedOut,
  processNsfwBlock,
  enrichBlockResult,
  listSubjects,
};
