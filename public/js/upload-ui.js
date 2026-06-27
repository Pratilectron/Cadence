let dialog = null;
let fileNameEl = null;
let stageEl = null;
let progressBar = null;
let detailEl = null;
let active = false;

const STAGE_LABELS = {
  checking: 'Checking content',
  uploading: 'Uploading',
  verifying: 'Verifying',
  finishing: 'Finishing',
};

function $(id) {
  return document.getElementById(id);
}

export function initUploadUi() {
  dialog = $('upload-dialog');
  fileNameEl = $('upload-file-name');
  stageEl = $('upload-stage-label');
  progressBar = $('upload-progress-bar');
  detailEl = $('upload-detail');

  dialog?.addEventListener('cancel', (event) => {
    if (active) event.preventDefault();
  });
}

export function showUploadProgress({ fileName = '', stage = 'uploading', progress = 0, detail = '' } = {}) {
  if (!dialog) return;
  active = true;
  if (fileNameEl) fileNameEl.textContent = fileName;
  if (stageEl) stageEl.textContent = STAGE_LABELS[stage] || stage;
  if (detailEl) detailEl.textContent = detail;
  setUploadProgress(progress);
  if (typeof dialog.showModal === 'function' && !dialog.open) dialog.showModal();
}

export function updateUploadProgress(patch = {}) {
  if (!dialog?.open) return;
  if (patch.fileName != null && fileNameEl) fileNameEl.textContent = patch.fileName;
  if (patch.stage != null && stageEl) {
    stageEl.textContent = STAGE_LABELS[patch.stage] || patch.stage;
  }
  if (patch.detail != null && detailEl) detailEl.textContent = patch.detail;
  if (patch.progress != null) setUploadProgress(patch.progress);
}

function setUploadProgress(ratio) {
  if (!progressBar) return;
  const pct = Math.max(0, Math.min(100, Math.round((ratio || 0) * 100)));
  progressBar.style.width = `${pct}%`;
  progressBar.parentElement?.setAttribute('aria-valuenow', String(pct));
}

export function hideUploadProgress(delayMs = 350) {
  if (!dialog) return;
  window.setTimeout(() => {
    active = false;
    if (dialog.open) dialog.close();
    setUploadProgress(0);
    if (detailEl) detailEl.textContent = '';
  }, delayMs);
}

export function uploadWithProgress(url, formData, headers = {}, { onUploadProgress } = {}) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    let uploadDone = false;

    xhr.upload.addEventListener('progress', (event) => {
      if (!event.lengthComputable) return;
      const ratio = event.loaded / event.total;
      onUploadProgress?.(ratio, uploadDone);
      if (ratio >= 1 && !uploadDone) {
        uploadDone = true;
        onUploadProgress?.(1, true);
      }
    });

    xhr.addEventListener('load', () => {
      let data = {};
      try {
        data = JSON.parse(xhr.responseText || '{}');
      } catch {
        data = {};
      }
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(data);
        return;
      }
      const err = new Error(data.error || `Upload failed (${xhr.status})`);
      Object.assign(err, data);
      reject(err);
    });

    xhr.addEventListener('error', () => reject(new Error('Upload failed — network error.')));
    xhr.addEventListener('abort', () => reject(new Error('Upload cancelled.')));

    xhr.open('POST', url);
    Object.entries(headers).forEach(([key, value]) => {
      if (value) xhr.setRequestHeader(key, value);
    });
    xhr.send(formData);
  });
}
