const {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  statSync,
  unlinkSync,
} = require('fs');
const { join, extname } = require('path');
const crypto = require('crypto');
const busboy = require('busboy');

const UPLOAD_DIR = join(__dirname, '..', 'data', 'uploads');
const MANIFEST_PATH = join(__dirname, '..', 'data', 'uploads-manifest.json');
const EMOJI_PATH = join(__dirname, '..', 'data', 'custom-emojis.json');

const { getConfig } = require('./config');

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
  if (!existsSync(MANIFEST_PATH)) return { totalBytes: 0, files: {} };
  try {
    return JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));
  } catch {
    return { totalBytes: 0, files: {} };
  }
}

function saveManifest(manifest) {
  writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2), 'utf8');
}

function loadCustomEmojis() {
  if (!existsSync(EMOJI_PATH)) return { emojis: [], gifs: [] };
  try {
    return JSON.parse(readFileSync(EMOJI_PATH, 'utf8'));
  } catch {
    return { emojis: [], gifs: [] };
  }
}

function saveCustomEmojis(data) {
  writeFileSync(EMOJI_PATH, JSON.stringify(data, null, 2), 'utf8');
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
  const manifest = loadManifest();
  return manifest.files[id] || null;
}

function getStorageStats() {
  const manifest = loadManifest();
  const limits = getLimits();
  return {
    usedBytes: manifest.totalBytes,
    maxBytes: limits.MAX_STORAGE_BYTES,
    usedPercent: Number(((manifest.totalBytes / limits.MAX_STORAGE_BYTES) * 100).toFixed(2)),
    fileCount: Object.keys(manifest.files).length,
  };
}

function parseUpload(req, { userId, username, tag = 'file' }) {
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
      let size = 0;
      let aborted = false;
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
          return;
        }
        const mime = mimeType || MIME_MAP[ext] || 'application/octet-stream';
        const kind = classifyKind(mime, ext, tag);
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
        manifest.files[id] = record;
        manifest.totalBytes += size;
        saveManifest(manifest);
        uploadMeta = record;

        if (tag === 'emoji' || tag === 'gif' || kind === 'emoji' || kind === 'gif') {
          const custom = loadCustomEmojis();
          const entry = { id, name: record.name, url: record.url, userId, username, createdAt: record.createdAt };
          if (kind === 'gif' || tag === 'gif') custom.gifs.unshift(entry);
          else custom.emojis.unshift(entry);
          custom.emojis = custom.emojis.slice(0, 200);
          custom.gifs = custom.gifs.slice(0, 200);
          saveCustomEmojis(custom);
        }
        finishUpload(resolve);
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
  UPLOAD_DIR,
  getLimits,
};
