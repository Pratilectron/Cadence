const QUALITY_PRESETS = {
  low: { label: '720p · 2.5 Mbps', width: 1280, height: 720, videoBitsPerSecond: 2_500_000 },
  medium: { label: '1080p · 5 Mbps', width: 1920, height: 1080, videoBitsPerSecond: 5_000_000 },
  high: { label: '1440p · 8 Mbps', width: 2560, height: 1440, videoBitsPerSecond: 8_000_000 },
};

let dialog = null;
let previewStream = null;
let recordStream = null;
let recorder = null;
let chunks = [];
let onSend = null;

function stopStream(stream) {
  stream?.getTracks().forEach((t) => t.stop());
}

function ensureDialog() {
  if (dialog) return dialog;
  dialog = document.createElement('dialog');
  dialog.className = 'recorder-dialog';
  dialog.innerHTML = `
    <div class="recorder-sheet">
      <div class="recorder-head">
        <h3>Screen record</h3>
        <button type="button" class="link-btn recorder-close">✕</button>
      </div>
      <video class="recorder-preview" autoplay muted playsinline></video>
      <label class="recorder-quality">
        <span>Quality</span>
        <select id="record-quality">
          <option value="low">720p · 2.5 Mbps</option>
          <option value="medium" selected>1080p · 5 Mbps</option>
          <option value="high">1440p · 8 Mbps</option>
        </select>
      </label>
      <div class="recorder-status" id="record-status">Preview your screen, then hit Start.</div>
      <div class="recorder-actions">
        <button type="button" class="pill-btn" id="record-start">Start recording</button>
        <button type="button" class="pill-btn pill-accent" id="record-stop" hidden>Stop</button>
        <button type="button" class="pill-btn pill-accent" id="record-send" hidden>Send video</button>
      </div>
    </div>`;
  document.body.appendChild(dialog);

  dialog.querySelector('.recorder-close').addEventListener('click', () => closeRecorder());
  dialog.addEventListener('cancel', () => closeRecorder());

  return dialog;
}

async function startPreview() {
  const video = dialog.querySelector('.recorder-preview');
  const status = dialog.querySelector('#record-status');
  stopStream(previewStream);
  previewStream = await navigator.mediaDevices.getDisplayMedia({
    video: { frameRate: 30 },
    audio: true,
  });
  video.srcObject = previewStream;
  status.textContent = 'Preview ready — choose quality and press Start.';
}

export async function openRecorder(sendCallback) {
  onSend = sendCallback;
  chunks = [];
  ensureDialog();
  const status = dialog.querySelector('#record-status');
  const startBtn = dialog.querySelector('#record-start');
  const stopBtn = dialog.querySelector('#record-stop');
  const sendBtn = dialog.querySelector('#record-send');

  startBtn.hidden = false;
  stopBtn.hidden = true;
  sendBtn.hidden = true;

  startBtn.onclick = async () => {
    try {
      const preset = QUALITY_PRESETS[dialog.querySelector('#record-quality').value] || QUALITY_PRESETS.medium;
      stopStream(recordStream);
      recordStream = previewStream;
      previewStream = null;

      const mime = MediaRecorder.isTypeSupported('video/webm;codecs=vp9,opus')
        ? 'video/webm;codecs=vp9,opus'
        : 'video/webm';

      recorder = new MediaRecorder(recordStream, {
        mimeType: mime,
        videoBitsPerSecond: preset.videoBitsPerSecond,
      });
      chunks = [];
      recorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
      recorder.onstop = () => {
        status.textContent = 'Recording stopped — send or re-record.';
        sendBtn.hidden = false;
        startBtn.hidden = false;
        startBtn.textContent = 'Re-preview';
      };
      recorder.start(250);
      status.textContent = `Recording at ${preset.label}…`;
      startBtn.hidden = true;
      stopBtn.hidden = false;
    } catch (err) {
      status.textContent = err.message || 'Could not start recording.';
    }
  };

  stopBtn.onclick = () => {
    if (recorder?.state === 'recording') recorder.stop();
    stopBtn.hidden = true;
  };

  sendBtn.onclick = async () => {
    const blob = new Blob(chunks, { type: 'video/webm' });
    const file = new File([blob], `screen-${Date.now()}.webm`, { type: 'video/webm' });
    status.textContent = 'Uploading…';
    await onSend(file);
    closeRecorder();
  };

  startBtn.textContent = 'Start recording';
  if (typeof dialog.showModal === 'function') dialog.showModal();
  try {
    await startPreview();
  } catch (err) {
    status.textContent = 'Screen capture denied or unavailable.';
  }
}

export function closeRecorder() {
  if (recorder?.state === 'recording') recorder.stop();
  recorder = null;
  chunks = [];
  stopStream(previewStream);
  stopStream(recordStream);
  previewStream = null;
  recordStream = null;
  if (dialog?.open) dialog.close();
}
