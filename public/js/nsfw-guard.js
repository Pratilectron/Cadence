let config = {
  nsfwGuard: true,
  nsfwPornThreshold: 0.6,
  nsfwSexyThreshold: 0.75,
  nsfwMaxStrikes: 5,
};

export const MODERATION_BLOCK_MESSAGE = 'This content isn\'t allowed on Cadence. Upload stopped.';

export function notifyModerationBlock(detail = {}) {
  const payload = typeof detail === 'string'
    ? { message: detail }
    : {
      message: detail.message || detail.reason || MODERATION_BLOCK_MESSAGE,
      ...detail,
    };
  document.dispatchEvent(new CustomEvent('cadence:moderation-blocked', { detail: payload }));
}

function normalizeBlockResult(data) {
  if (data?.ok === false || data?.blocked) {
    return {
      ok: false,
      reason: data.reason || data.error || MODERATION_BLOCK_MESSAGE,
      blocked: true,
      strikes: data.strikes,
      maxStrikes: data.maxStrikes,
      remaining: data.remaining,
      lockedOut: Boolean(data.lockedOut),
      lockoutMinutes: data.lockoutMinutes || 0,
      lockoutUntil: data.lockoutUntil || 0,
    };
  }
  return data;
}

function getToken() {
  try {
    const raw = localStorage.getItem('cadence_session') || sessionStorage.getItem('cadence_session');
    if (!raw) return null;
    return JSON.parse(raw).token || null;
  } catch {
    return null;
  }
}

export async function loadPublicConfig() {
  try {
    const res = await fetch('/api/public-config');
    if (res.ok) {
      const data = await res.json();
      Object.assign(config, data);
      return data;
    }
  } catch {
    // keep defaults
  }
  return { ...config };
}

export function isNsfwGuardEnabled() {
  return Boolean(config.nsfwGuard);
}

async function scanBlob(blob, filename = 'scan.jpg') {
  if (!config.nsfwGuard) return { ok: true };
  const token = getToken();
  if (!token) return { ok: true, skipped: true };

  const form = new FormData();
  form.append('file', blob, filename);

  const res = await fetch('/api/moderation/check', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const normalized = normalizeBlockResult({
      ok: false,
      reason: data.error || data.reason || MODERATION_BLOCK_MESSAGE,
      ...data,
    });
    const moderationHit = normalized.strikes || normalized.lockedOut || res.status === 403
      || /content|policy|allowed|blocked|suspended/i.test(normalized.reason || '');
    if (moderationHit) notifyModerationBlock(normalized);
    return normalized;
  }
  const normalized = normalizeBlockResult(data);
  if (!normalized.ok) {
    notifyModerationBlock(normalized);
  }
  return normalized;
}

export async function checkImageFile(file) {
  if (!config.nsfwGuard) return { ok: true };
  if (!file.type.startsWith('image/')) return { ok: true };
  const result = await scanBlob(file, file.name || 'upload.jpg');
  return result;
}

export async function checkImageElement(el) {
  if (!config.nsfwGuard) return { ok: true };
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  canvas.width = el.videoWidth || el.naturalWidth || el.width || 320;
  canvas.height = el.videoHeight || el.naturalHeight || el.height || 240;
  if (!canvas.width || !canvas.height) return { ok: true };
  ctx.drawImage(el, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.85));
  if (!blob) return { ok: true, skipped: true };
  const result = await scanBlob(blob, 'frame.jpg');
  return result;
}

export async function checkVideoFile(file) {
  if (!config.nsfwGuard) return { ok: true };
  if (!file.type.startsWith('video/')) return { ok: true };

  const url = URL.createObjectURL(file);
  try {
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.preload = 'auto';
    await new Promise((resolve, reject) => {
      video.onloadedmetadata = resolve;
      video.onerror = () => reject(new Error('Could not read video.'));
      video.src = url;
    });

    const duration = Math.max(video.duration || 1, 0.5);
    const sampleTimes = [0.35, 0.7];

    for (const pct of sampleTimes) {
      const t = Math.min(Math.max(duration * pct, 0), Math.max(duration - 0.05, 0));
      await new Promise((resolve) => {
        video.onseeked = resolve;
        video.currentTime = t;
      });
      const result = await checkImageElement(video);
      if (!result.ok) {
        return { ok: false, reason: result.reason || MODERATION_BLOCK_MESSAGE, ...result };
      }
    }
    return { ok: true };
  } catch (err) {
    console.warn('[nsfw-guard] video scan skipped:', err.message);
    return { ok: true, skipped: true };
  } finally {
    URL.revokeObjectURL(url);
  }
}

export async function checkVideoElement(videoEl) {
  return checkImageElement(videoEl);
}

// Server-side scanning — no client model to preload
export function ensureModel() {
  return Promise.resolve(null);
}
