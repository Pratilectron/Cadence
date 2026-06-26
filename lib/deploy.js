const { spawn } = require('child_process');
const { join } = require('path');
const crypto = require('crypto');

const ROOT = join(__dirname, '..');
const DEPLOY_BRANCH = process.env.DEPLOY_BRANCH || 'main';
let deployRunning = false;

function readRawBody(req, maxBytes = 65536) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error('Body too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

function verifyDeployAuth(req, rawBody, secret) {
  const headerSecret = req.headers['x-deploy-secret'];
  if (typeof headerSecret === 'string' && headerSecret.length > 0) {
    return safeEqual(headerSecret, secret);
  }

  const ghSignature = req.headers['x-hub-signature-256'];
  if (typeof ghSignature === 'string' && ghSignature.startsWith('sha256=')) {
    const expected = `sha256=${crypto.createHmac('sha256', secret).update(rawBody).digest('hex')}`;
    return safeEqual(ghSignature, expected);
  }

  return false;
}

function shouldDeploy(payload) {
  if (!payload || typeof payload !== 'object') return true;
  if (payload.ref) return payload.ref === `refs/heads/${DEPLOY_BRANCH}`;
  if (payload.repository && payload.action === 'published') return false;
  return true;
}

function runDeployScript() {
  return new Promise((resolve, reject) => {
    const script = join(ROOT, 'scripts', 'deploy.js');
    const child = spawn(process.execPath, [script], {
      cwd: ROOT,
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
    child.on('error', reject);
    child.on('spawn', () => resolve(child.pid));
  });
}

async function handleDeployWebhook(req, res, jsonResponse) {
  const secret = process.env.DEPLOY_WEBHOOK_SECRET;
  if (!secret) {
    jsonResponse(res, 503, { error: 'Deploy webhook is not configured on this server.' });
    return;
  }

  if (req.method !== 'POST') {
    jsonResponse(res, 405, { error: 'Method not allowed.' });
    return;
  }

  let rawBody;
  try {
    rawBody = await readRawBody(req);
  } catch {
    jsonResponse(res, 413, { error: 'Payload too large.' });
    return;
  }

  if (!verifyDeployAuth(req, rawBody, secret)) {
    jsonResponse(res, 401, { error: 'Unauthorized.' });
    return;
  }

  let payload = {};
  if (rawBody.length) {
    try {
      payload = JSON.parse(rawBody.toString('utf8'));
    } catch {
      jsonResponse(res, 400, { error: 'Invalid JSON payload.' });
      return;
    }
  }

  if (!shouldDeploy(payload)) {
    jsonResponse(res, 200, { ok: true, skipped: true, reason: `Ignored event for non-${DEPLOY_BRANCH} branch.` });
    return;
  }

  if (deployRunning) {
    jsonResponse(res, 409, { error: 'Deploy already in progress.' });
    return;
  }

  deployRunning = true;
  const resetLock = () => {
    deployRunning = false;
  };
  setTimeout(resetLock, 5 * 60 * 1000).unref();

  try {
    const pid = await runDeployScript();
    jsonResponse(res, 202, {
      ok: true,
      message: 'Deploy started.',
      branch: DEPLOY_BRANCH,
      pid,
    });
  } catch (err) {
    resetLock();
    jsonResponse(res, 500, { error: err.message || 'Failed to start deploy.' });
  }
}

module.exports = { handleDeployWebhook };
