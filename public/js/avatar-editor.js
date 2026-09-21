const OUTPUT = 256;

function coverScale(img, zoom) {
  return Math.max(OUTPUT / img.width, OUTPUT / img.height) * zoom;
}

export function openAvatarEditor(file) {
  const dialog = document.getElementById('avatar-editor');
  const canvas = document.getElementById('avatar-crop');
  const zoomInput = document.getElementById('avatar-zoom');
  const brightInput = document.getElementById('avatar-bright');
  const contrastInput = document.getElementById('avatar-contrast');
  const satInput = document.getElementById('avatar-sat');
  if (!dialog || !canvas) return Promise.resolve(null);

  return new Promise((resolve) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    let offsetX = 0;
    let offsetY = 0;
    let drag = null;
    let settled = false;

    const finish = (value) => {
      if (settled) return;
      settled = true;
      URL.revokeObjectURL(url);
      dialog.close();
      resolve(value);
    };

    const clamp = () => {
      const zoom = Number(zoomInput.value) || 1;
      const scale = coverScale(img, zoom);
      const maxX = Math.max(0, (img.width * scale - OUTPUT) / 2);
      const maxY = Math.max(0, (img.height * scale - OUTPUT) / 2);
      offsetX = Math.min(maxX, Math.max(-maxX, offsetX));
      offsetY = Math.min(maxY, Math.max(-maxY, offsetY));
    };

    const draw = () => {
      if (!img.naturalWidth) return;
      clamp();
      const ctx = canvas.getContext('2d');
      canvas.width = OUTPUT;
      canvas.height = OUTPUT;
      const zoom = Number(zoomInput.value) || 1;
      const scale = coverScale(img, zoom);
      const dw = img.width * scale;
      const dh = img.height * scale;
      ctx.clearRect(0, 0, OUTPUT, OUTPUT);
      ctx.filter = `brightness(${brightInput.value}) contrast(${contrastInput.value}) saturate(${satInput.value})`;
      ctx.drawImage(img, (OUTPUT - dw) / 2 + offsetX, (OUTPUT - dh) / 2 + offsetY, dw, dh);
      ctx.filter = 'none';
    };

    const onPointerDown = (event) => {
      canvas.setPointerCapture(event.pointerId);
      drag = { x: event.clientX, y: event.clientY, ox: offsetX, oy: offsetY };
    };
    const onPointerMove = (event) => {
      if (!drag) return;
      offsetX = drag.ox + (event.clientX - drag.x);
      offsetY = drag.oy + (event.clientY - drag.y);
      draw();
    };
    const onPointerUp = () => {
      drag = null;
    };

    const onDialogCancel = (event) => {
      event.preventDefault();
      onCancel();
    };

    const cleanup = () => {
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerup', onPointerUp);
      dialog.querySelector('[data-avatar-save]')?.removeEventListener('click', onSave);
      dialog.querySelector('[data-avatar-cancel]')?.removeEventListener('click', onCancel);
      dialog.querySelector('[data-avatar-reset]')?.removeEventListener('click', onReset);
      dialog.removeEventListener('cancel', onDialogCancel);
      zoomInput.removeEventListener('input', draw);
      brightInput.removeEventListener('input', draw);
      contrastInput.removeEventListener('input', draw);
      satInput.removeEventListener('input', draw);
    };

    const onSave = () => {
      draw();
      let quality = 0.86;
      let dataUrl = canvas.toDataURL('image/jpeg', quality);
      while (dataUrl.length > 100000 && quality > 0.5) {
        quality -= 0.08;
        dataUrl = canvas.toDataURL('image/jpeg', quality);
      }
      cleanup();
      finish(dataUrl.length > 120000 ? null : dataUrl);
    };
    const onCancel = () => {
      cleanup();
      finish(null);
    };
    const onReset = () => {
      offsetX = 0;
      offsetY = 0;
      zoomInput.value = '1';
      brightInput.value = '1';
      contrastInput.value = '1';
      satInput.value = '1';
      draw();
    };

    img.onload = () => {
      offsetX = 0;
      offsetY = 0;
      zoomInput.value = '1';
      brightInput.value = '1';
      contrastInput.value = '1';
      satInput.value = '1';
      canvas.addEventListener('pointerdown', onPointerDown);
      canvas.addEventListener('pointermove', onPointerMove);
      canvas.addEventListener('pointerup', onPointerUp);
      zoomInput.addEventListener('input', draw);
      brightInput.addEventListener('input', draw);
      contrastInput.addEventListener('input', draw);
      satInput.addEventListener('input', draw);
      dialog.querySelector('[data-avatar-save]')?.addEventListener('click', onSave);
      dialog.querySelector('[data-avatar-cancel]')?.addEventListener('click', onCancel);
      dialog.querySelector('[data-avatar-reset]')?.addEventListener('click', onReset);
      dialog.addEventListener('cancel', onDialogCancel);
      draw();
      if (!dialog.open) dialog.showModal();
    };
    img.onerror = () => finish(null);
    img.src = url;
  });
}

export function openAvatarView(avatar, name, paintAvatar) {
  const dialog = document.getElementById('avatar-view');
  const stage = document.getElementById('avatar-view-stage');
  if (!dialog || !stage) return;
  paintAvatar(stage, avatar, name);
  if (dialog.open) dialog.close();
  dialog.showModal();
}
