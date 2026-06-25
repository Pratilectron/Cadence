let overlay = null;

function ensureOverlay() {
  if (overlay) return overlay;
  overlay = document.createElement('dialog');
  overlay.className = 'lightbox';
  overlay.id = 'image-lightbox';
  overlay.innerHTML = `
    <div class="lightbox-sheet">
      <button type="button" class="lightbox-close link-btn" aria-label="Close">✕ Close</button>
      <img class="lightbox-img" alt="" />
      <div class="lightbox-meta">
        <span class="lightbox-name"></span>
        <span class="lightbox-actions">
          <button type="button" class="pill-btn" data-action="zoom-in">+</button>
          <button type="button" class="pill-btn" data-action="zoom-out">−</button>
          <a class="pill-btn pill-accent" data-action="open" target="_blank" rel="noopener">Open</a>
        </span>
      </div>
    </div>`;
  document.body.appendChild(overlay);

  overlay.querySelector('.lightbox-close').addEventListener('click', () => overlay.close());
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.close(); });
  overlay.addEventListener('cancel', () => overlay.close());

  let scale = 1;
  const img = overlay.querySelector('.lightbox-img');
  overlay.querySelector('[data-action="zoom-in"]').addEventListener('click', () => {
    scale = Math.min(scale + 0.25, 3);
    img.style.transform = `scale(${scale})`;
  });
  overlay.querySelector('[data-action="zoom-out"]').addEventListener('click', () => {
    scale = Math.max(scale - 0.25, 0.5);
    img.style.transform = `scale(${scale})`;
  });

  return overlay;
}

export function openImageViewer({ url, name }) {
  const box = ensureOverlay();
  const img = box.querySelector('.lightbox-img');
  img.src = url;
  img.alt = name || 'Image';
  img.style.transform = 'scale(1)';
  box.querySelector('.lightbox-name').textContent = name || '';
  box.querySelector('[data-action="open"]').href = url;
  if (typeof box.showModal === 'function') box.showModal();
}

export function bindImageClick(img, file) {
  img.classList.add('msg-image-clickable');
  img.addEventListener('click', () => openImageViewer({ url: file.url, name: file.name }));
}
