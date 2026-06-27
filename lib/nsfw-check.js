const { readFileSync } = require('fs');
const { getConfig } = require('./config');

let model = null;
let modelError = null;
let modelLoading = null;
let tf = null;
let sharp = null;

const IMAGE_MIMES = new Set([
  'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/bmp',
]);

function isImageMime(mime) {
  return IMAGE_MIMES.has(mime) || (String(mime || '').startsWith('image/') && !String(mime).includes('svg'));
}

function scorePredictions(predictions, cfg) {
  const find = (name) => predictions.find((p) => p.className === name)?.probability || 0;
  const porn = find('Porn');
  const hentai = find('Hentai');
  const sexy = find('Sexy');
  const blocked = (porn + hentai) >= cfg.nsfwPornThreshold || sexy >= cfg.nsfwSexyThreshold;
  return { blocked, porn, hentai, sexy };
}

async function loadDeps() {
  if (!tf) {
    try {
      tf = require('@tensorflow/tfjs');
    } catch (err) {
      throw new Error(`TensorFlow unavailable: ${err.message}`);
    }
  }
  if (!sharp) {
    try {
      sharp = require('sharp');
    } catch (err) {
      throw new Error(`sharp unavailable: ${err.message}`);
    }
  }
}

async function bufferToTensor(buffer) {
  await loadDeps();
  const { data, info } = await sharp(buffer)
    .rotate()
    .resize(224, 224, { fit: 'cover', fastShrinkOnLoad: true })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const tensor = tf.tensor3d(new Uint8Array(data), [info.height, info.width, 3]);
  return tensor;
}

async function loadModel() {
  if (model) return model;
  if (modelError) throw modelError;
  if (modelLoading) return modelLoading;

  modelLoading = (async () => {
    try {
      await loadDeps();
      const nsfw = require('nsfwjs');
      const loaded = await nsfw.load();
      model = loaded;
      console.log('[nsfw] server moderation model loaded');
      return loaded;
    } catch (err) {
      modelError = err;
      console.error('[nsfw] failed to load model:', err.message);
      throw err;
    } finally {
      modelLoading = null;
    }
  })();

  return modelLoading;
}

async function classifyBuffer(buffer) {
  const cfg = getConfig();
  if (!cfg.nsfwEnabled) return { ok: true, skipped: true };

  let image;
  try {
    const loaded = await loadModel();
    image = await bufferToTensor(buffer);
    const predictions = await loaded.classify(image);
    const scores = scorePredictions(predictions, cfg);
    if (scores.blocked) {
      return {
        ok: false,
        reason: 'This content isn\'t allowed on Cadence. Upload stopped.',
        scores,
      };
    }
    return { ok: true, scores };
  } catch (err) {
    if (cfg.nsfwStrict) {
      return { ok: false, reason: 'Upload blocked: content moderation unavailable.' };
    }
    console.warn('[nsfw] check skipped:', err.message);
    return { ok: true, skipped: true };
  } finally {
    if (image) image.dispose();
  }
}

async function checkImageFile(diskPath, mime) {
  if (!isImageMime(mime)) return { ok: true, skipped: true };
  const buffer = readFileSync(diskPath);
  return classifyBuffer(buffer);
}

function getPublicNsfwConfig() {
  const cfg = getConfig();
  return {
    nsfwGuard: cfg.nsfwEnabled,
    nsfwPornThreshold: cfg.nsfwPornThreshold,
    nsfwSexyThreshold: cfg.nsfwSexyThreshold,
    nsfwMaxStrikes: cfg.nsfwMaxStrikes,
  };
}

async function warmUpNsfwModel() {
  const cfg = getConfig();
  if (!cfg.nsfwEnabled) return;
  try {
    await loadDeps();
    await loadModel();
    const buf = await sharp({
      create: { width: 224, height: 224, channels: 3, background: { r: 32, g: 32, b: 32 } },
    }).jpeg().toBuffer();
    await classifyBuffer(buf);
  } catch (err) {
    console.warn('[nsfw] warmup failed:', err.message);
  }
}

module.exports = {
  isImageMime,
  checkImageFile,
  classifyBuffer,
  getPublicNsfwConfig,
  warmUpNsfwModel,
};
