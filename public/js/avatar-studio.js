import { filterAvatars, paintAvatar } from './avatars.js';
import { openAvatarEditor, openAvatarView } from './avatar-editor.js';

function selectedId(avatar) {
  return avatar?.kind === 'preset' ? avatar.id : '';
}

export function bindAvatarStudio({ roots, onCommit, getAvatar, getName }) {
  const grids = roots.map((root) => ({
    root,
    grid: root.querySelector('[data-avatar-grid]'),
    search: root.querySelector('[data-avatar-search]'),
    file: root.querySelector('[data-avatar-file]'),
  })).filter((entry) => entry.grid);

  const render = () => {
    const avatar = getAvatar();
    const current = selectedId(avatar);
    grids.forEach((entry) => {
      const matches = filterAvatars(entry.search?.value || '');
      entry.grid.replaceChildren();
      if (!matches.length) {
        const empty = document.createElement('p');
        empty.className = 'avatar-empty';
        empty.textContent = 'No avatars match.';
        entry.grid.appendChild(empty);
        return;
      }
      matches.forEach((item) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'avatar-choice';
        button.title = `${item.label} · ${item.id}`;
        button.setAttribute('aria-label', `${item.label} ${item.id}`);
        button.setAttribute('aria-pressed', String(item.id === current));
        if (item.id === current) button.classList.add('is-selected');
        button.innerHTML = item.svg;
        button.addEventListener('click', () => {
          onCommit({ kind: 'preset', id: item.id });
        });
        entry.grid.appendChild(button);
      });
    });
  };

  grids.forEach((entry) => {
    entry.search?.addEventListener('input', render);
    entry.root.querySelector('[data-avatar-upload]')?.addEventListener('click', () => entry.file?.click());
    entry.root.querySelector('[data-avatar-clear]')?.addEventListener('click', () => onCommit(null));
    entry.root.querySelector('[data-avatar-view]')?.addEventListener('click', () => {
      openAvatarView(getAvatar(), getName(), paintAvatar);
    });
    entry.file?.addEventListener('change', async () => {
      const file = entry.file.files?.[0];
      entry.file.value = '';
      if (!file || !file.type.startsWith('image/')) return;
      const dataUrl = await openAvatarEditor(file);
      if (!dataUrl) return;
      onCommit({ kind: 'image', dataUrl });
    });
  });

  document.getElementById('avatar-view-close')?.addEventListener('click', () => {
    document.getElementById('avatar-view')?.close();
  });
  document.getElementById('profile-hero-avatar')?.addEventListener('click', () => {
    openAvatarView(getAvatar(), getName(), paintAvatar);
  });

  render();
  return { render };
}
