const busboy = require('busboy');
const { classifyBuffer } = require('./nsfw-check');
const { assertNotLockedOut, enrichBlockResult } = require('./moderation-strikes');
const { bindHttpIdentity } = require('./client-identity');

const MAX_BYTES = 8 * 1024 * 1024;

function readImageBuffer(req) {
  return new Promise((resolve, reject) => {
    const bb = busboy({
      headers: req.headers,
      limits: { fileSize: MAX_BYTES, files: 1 },
    });

    let buffer = null;
    let mime = '';
    let received = false;

    bb.on('file', (fieldname, stream, info) => {
      received = true;
      mime = info.mimeType || '';
      const chunks = [];
      let size = 0;

      stream.on('data', (chunk) => {
        size += chunk.length;
        if (size > MAX_BYTES) {
          reject(new Error('Image too large for moderation scan.'));
          stream.resume();
          return;
        }
        chunks.push(chunk);
      });

      stream.on('end', () => {
        buffer = Buffer.concat(chunks);
      });
    });

    bb.on('error', reject);
    bb.on('finish', () => {
      if (!received || !buffer?.length) {
        reject(new Error('No image received.'));
        return;
      }
      resolve({ buffer, mime });
    });

    req.pipe(bb);
  });
}

async function handleModerationCheck(req, res, jsonResponse, getSessionUser, getTokenFromReq, options = {}) {
  const user = getSessionUser(getTokenFromReq(req));
  if (!user) {
    jsonResponse(res, 401, { ok: false, error: 'Authentication required.' });
    return;
  }

  const record = options.findUserById?.(user.id);
  const isSuperAdmin = Boolean(options.isSuperAdmin?.(record));
  const identity = bindHttpIdentity(req, res, { userId: user.id, username: user.username });

  try {
    assertNotLockedOut(identity, { isSuperAdmin });
  } catch (err) {
    jsonResponse(res, 403, { ok: false, error: err.message, ...(err.moderation || {}) });
    return;
  }

  try {
    const { buffer, mime } = await readImageBuffer(req);
    if (!mime.startsWith('image/')) {
      jsonResponse(res, 400, { ok: false, error: 'Only images can be scanned.' });
      return;
    }
    const result = await classifyBuffer(buffer);
    const enriched = enrichBlockResult(result, identity, { isSuperAdmin });
    if (enriched.lockedOut && options.onUserLockedOut) {
      options.onUserLockedOut(user.id, enriched);
    }
    jsonResponse(res, 200, enriched);
  } catch (err) {
    jsonResponse(res, 400, { ok: false, error: err.message || 'Moderation scan failed.' });
  }
}

module.exports = { handleModerationCheck };
