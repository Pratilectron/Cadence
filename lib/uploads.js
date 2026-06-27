const {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} = require('fs');
const { join, extname } = require('path');
const crypto = require('crypto');
const busboy = require('busboy');
const {
  insertUploadRecord,
  getUploadRecord,
  listUploadRecords,
  deleteUploadRecord,
  getUploadStorageStats,
  clearAllUploadRecords,
  loadCustomEmojisObject,
  addCustomMedia,
  clearCustomMediaRecords,
} = require('./db');

const UPLOAD_DIR = join(__dirname, '..', 'data', 'uploads');
const { getConfig } = require('./config');
const { classifyBuffer, isImageMime } = require('./nsfw-check');
const { enrichBlockResult, ModerationBlockedError } = require('./moderation-strikes');

function getLimits() {
  const cfg = getConfig();
  return { MAX_STORAGE_BYTES: cfg.maxStorageBytes, MAX_FILE_BYTES: cfg.maxFileBytes };
}

const ALLOWED_EXT = new Set([
  '.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg', '.bmp',
  '.mp3', '.wav', '.ogg', '.m4a', '.aac', '.flac', '.webm', '.mp4',
  '.pdf', '.txt', '.md', '.csv', '.json', '.xml',
  '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
  '.zip', '.rar', '.7z', '.tar', '.gz',
]);

const MIME_MAP = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif',
  '.webp': 'image/webp', '.svg': 'image/svg+xml', '.bmp': 'image/bmp',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.m4a': 'audio/mp4',
  '.aac': 'audio/aac', '.flac': 'audio/flac', '.webm': 'video/webm', '.mp4': 'video/mp4',
  '.pdf': 'application/pdf', '.txt': 'text/plain', '.md': 'text/markdown',
  '.zip': 'application/zip', '.json': 'application/json',
};

mkdirSync(UPLOAD_DIR, { recursive: true });

function loadManifest() {
  const stats = getUploadStorageStats();
  const files = {};
  for (const record of listUploadRecords()) {
    files[record.id] = record;
  }
  return { totalBytes: stats.totalBytes, files };
}

function loadCustomEmojis() {
  return loadCustomEmojisObject();
}

function clearAllUploads() {
  const manifest = loadManifest();
  for (const record of Object.values(manifest.files)) {
    const diskPath = join(UPLOAD_DIR, `${record.id}${record.ext}`);
    if (existsSync(diskPath)) unlinkSync(diskPath);
  }
  clearAllUploadRecords();
}

function clearCustomEmojis() {
  clearCustomMediaRecords();
}

function classifyKind(mime, ext, tag) {
  if (tag === 'emoji') return 'emoji';
  if (tag === 'gif') return 'gif';
  if (mime.startsWith('image/')) return mime === 'image/gif' ? 'gif' : 'image';
  if (mime.startsWith('audio/')) return 'audio';
  if (mime.startsWith('video/')) return 'video';
  if (mime === 'application/pdf' || ['.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx'].includes(ext)) return 'document';
  return 'file';
}

function getFileRecord(id) {
  return getUploadRecord(id);
}

function getStorageStats() {
  const stats = getUploadStorageStats();
  const limits = getLimits();
  return {
    usedBytes: stats.totalBytes,
    maxBytes: limits.MAX_STORAGE_BYTES,
    usedPercent: Number(((stats.totalBytes / limits.MAX_STORAGE_BYTES) * 100).toFixed(2)),
    fileCount: stats.fileCount,
  };
}

function parseUpload(req, { userId, username, tag = 'file', isSuperAdmin = false, identity = null }) {
  return new Promise((resolve, reject) => {
    const bb = busboy({
      headers: req.headers,
      limits: { fileSize: getLimits().MAX_FILE_BYTES, files: 1 },
    });

    let uploadMeta = null;
    let fileError = null;
    let fileStarted = false;
    let settled = false;

    const finishUpload = (resolveFn) => {
      if (settled) return;
      if (fileError) {
        settled = true;
        reject(new Error(fileError));
        return;
      }
      if (uploadMeta) {
        settled = true;
        resolveFn(uploadMeta);
      }
    };

    bb.on('file', (fieldname, stream, info) => {
      fileStarted = true;
      const { filename, mimeType } = info;
      const ext = extname(filename || '').toLowerCase();
      if (!ALLOWED_EXT.has(ext)) {
        fileError = `File type ${ext || 'unknown'} is not allowed.`;
        stream.resume();
        return;
      }

      const manifest = loadManifest();
      if (manifest.totalBytes >= getLimits().MAX_STORAGE_BYTES) {
        fileError = 'Storage limit reached (20 GB).';
        stream.resume();
        return;
      }

      const id = crypto.randomUUID();
      const storedName = `${id}${ext}`;
      const diskPath = join(UPLOAD_DIR, storedName);
      const mime = mimeType || MIME_MAP[ext] || 'application/octet-stream';
      const kind = classifyKind(mime, ext, tag);
      let size = 0;
      let aborted = false;

      const saveRecord = () => {
        const record = {
          id,
          name: String(filename || storedName).slice(0, 255),
          mime,
          size,
          kind,
          ext,
          userId,
          username,
          tag,
          createdAt: Date.now(),
          url: `/media/${id}`,
        };
        insertUploadRecord(record);
        uploadMeta = record;
        if (tag === 'emoji' || tag === 'gif' || kind === 'emoji' || kind === 'gif') {
          addCustomMedia(record, kind === 'gif' || tag === 'gif' ? 'gif' : 'emoji');
        }
        finishUpload(resolve);
      };

      const rejectModeration = (moderation) => {
        const enriched = enrichBlockResult(
          moderation,
          identity || { userId, username },
          { isSuperAdmin },
        );
        settled = true;
        reject(new ModerationBlockedError(enriched.reason, enriched));
      };

      const finalizeImageBuffer = async (buffer) => {
        try {
          const moderation = await classifyBuffer(buffer);
          if (!moderation.ok) {
            rejectModeration(moderation);
            return;
          }
          writeFileSync(diskPath, buffer);
          saveRecord();
        } catch (err) {
          fileError = err.message || 'Upload moderation failed.';
          finishUpload(resolve);
        }
      };

      if (isImageMime(mime)) {
        const chunks = [];
        stream.on('data', (chunk) => {
          size += chunk.length;
          if (manifest.totalBytes + size > getLimits().MAX_STORAGE_BYTES) {
            fileError = 'Upload would exceed 20 GB storage limit.';
            aborted = true;
            stream.resume();
            return;
          }
          chunks.push(chunk);
        });
        stream.on('limit', () => {
          fileError = `File exceeds ${getLimits().MAX_FILE_BYTES / (1024 * 1024)} MB limit.`;
          aborted = true;
        });
        stream.on('end', () => {
          if (fileError || aborted) {
            finishUpload(resolve);
            return;
          }
          void finalizeImageBuffer(Buffer.concat(chunks));
        });
        return;
      }

      const out = createWriteStream(diskPath);

      stream.on('data', (chunk) => {
        size += chunk.length;
        if (manifest.totalBytes + size > getLimits().MAX_STORAGE_BYTES) {
          fileError = 'Upload would exceed 20 GB storage limit.';
          aborted = true;
          stream.unpipe(out);
          out.destroy();
          try { unlinkSync(diskPath); } catch { /* ignore */ }
        }
      });

      stream.pipe(out);

      stream.on('limit', () => {
        fileError = `File exceeds ${getLimits().MAX_FILE_BYTES / (1024 * 1024)} MB limit.`;
        aborted = true;
        try { unlinkSync(diskPath); } catch { /* ignore */ }
      });

      out.on('finish', () => {
        if (fileError || aborted) {
          try { unlinkSync(diskPath); } catch { /* ignore */ }
          finishUpload(resolve);
          return;
        }
        saveRecord();
      });

      out.on('error', () => {
        fileError = 'Failed to save uploaded file.';
        try { unlinkSync(diskPath); } catch { /* ignore */ }
        finishUpload(resolve);
      });
    });

    bb.on('error', reject);
    bb.on('finish', () => {
      if (!fileStarted) {
        reject(new Error('No file received.'));
        return;
      }
      finishUpload(resolve);
    });

    req.pipe(bb);
  });
}

function serveMedia(id, res, securityHeaders) {
  const record = getFileRecord(id);
  if (!record) {
    res.writeHead(404, securityHeaders);
    res.end('Not found');
    return;
  }
  const diskPath = join(UPLOAD_DIR, `${id}${record.ext}`);
  if (!existsSync(diskPath)) {
    res.writeHead(404, securityHeaders);
    res.end('Not found');
    return;
  }
  const stat = statSync(diskPath);
  res.writeHead(200, {
    ...securityHeaders,
    'Content-Type': record.mime,
    'Content-Length': stat.size,
    'Cache-Control': 'public, max-age=31536000, immutable',
    'Content-Disposition': `inline; filename="${record.name.replace(/"/g, '')}"`,
  });
  createReadStream(diskPath).pipe(res);
}

module.exports = {
  parseUpload,
  serveMedia,
  getFileRecord,
  getStorageStats,
  loadCustomEmojis,
  loadManifest,
  clearAllUploads,
  clearCustomEmojis,
  UPLOAD_DIR,
  getLimits,
};
