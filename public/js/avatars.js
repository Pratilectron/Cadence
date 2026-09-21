const GUEST_KEY = 'cadence-avatar';

const LOOKS = [
  { bg: '#2a2118', fg: '#f3e6d4', accent: '#d4a574' },
  { bg: '#1a2420', fg: '#e7f3ec', accent: '#8fae98' },
  { bg: '#241820', fg: '#f8e4ec', accent: '#c98b9a' },
  { bg: '#1a2030', fg: '#e4eefb', accent: '#8aa4c8' },
  { bg: '#2a2416', fg: '#f8efd2', accent: '#c9a227' },
  { bg: '#1c1a18', fg: '#f4eee4', accent: '#a89880' },
  { bg: '#221610', fg: '#f8e4d8', accent: '#c47a58' },
  { bg: '#161820', fg: '#ece8f8', accent: '#9a94c0' },
  { bg: '#1a2218', fg: '#eef6d8', accent: '#8aaa62' },
  { bg: '#241c14', fg: '#f8efe4', accent: '#b98960' },
  { bg: '#14181c', fg: '#e6eef2', accent: '#7f98a3' },
  { bg: '#2a1818', fg: '#fbe4e0', accent: '#c07068' },
];

const NAMES = ['Orbit', 'Peak', 'Bars', 'Diamond', 'Arc', 'Cross', 'Dots', 'Wave', 'Split', 'Ring', 'Chevron', 'Spark'];

function shape(motif, fg, accent) {
  switch (motif) {
    case 0:
      return `<circle cx="32" cy="32" r="14" fill="none" stroke="${fg}" stroke-width="3"/><circle cx="32" cy="32" r="4" fill="${accent}"/>`;
    case 1:
      return `<path d="M16 44 L32 16 L48 44 Z" fill="none" stroke="${fg}" stroke-width="3"/><circle cx="32" cy="36" r="3" fill="${accent}"/>`;
    case 2:
      return `<path d="M20 22 H44 M20 32 H44 M20 42 H44" stroke="${fg}" stroke-width="3" stroke-linecap="round"/><circle cx="16" cy="32" r="3" fill="${accent}"/>`;
    case 3:
      return `<path d="M32 14 L48 32 L32 50 L16 32 Z" fill="${accent}" opacity="0.9"/><path d="M32 22 L40 32 L32 42 L24 32 Z" fill="${fg}"/>`;
    case 4:
      return `<path d="M16 40 A18 18 0 0 1 48 40" fill="none" stroke="${fg}" stroke-width="3"/><circle cx="32" cy="28" r="4" fill="${accent}"/>`;
    case 5:
      return `<path d="M32 16 V48 M18 32 H46" stroke="${fg}" stroke-width="3" stroke-linecap="round"/><circle cx="32" cy="32" r="5" fill="${accent}"/>`;
    case 6:
      return `<circle cx="22" cy="24" r="4" fill="${fg}"/><circle cx="42" cy="24" r="4" fill="${fg}"/><circle cx="32" cy="40" r="4" fill="${accent}"/><circle cx="22" cy="40" r="3" fill="${fg}" opacity="0.7"/><circle cx="42" cy="40" r="3" fill="${fg}" opacity="0.7"/>`;
    case 7:
      return `<path d="M12 36 C20 24 28 44 36 32 S52 24 56 34" fill="none" stroke="${fg}" stroke-width="3" stroke-linecap="round"/><circle cx="36" cy="32" r="3" fill="${accent}"/>`;
    case 8:
      return `<path d="M32 12 V52" stroke="${accent}" stroke-width="3"/><path d="M18 22 H32 V42 H46" fill="none" stroke="${fg}" stroke-width="3" stroke-linecap="round"/>`;
    case 9:
      return `<circle cx="32" cy="32" r="16" fill="none" stroke="${fg}" stroke-width="3"/><circle cx="32" cy="32" r="8" fill="none" stroke="${accent}" stroke-width="3"/>`;
    case 10:
      return `<path d="M16 26 L32 40 L48 26" fill="none" stroke="${fg}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/><path d="M16 38 L32 24 L48 38" fill="none" stroke="${accent}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>`;
    default:
      return `<path d="M32 14 L36 28 H50 L39 36 L43 50 L32 41 L21 50 L25 36 L14 28 H28 Z" fill="${accent}" stroke="${fg}" stroke-width="1.5"/>`;
  }
}

function svgFor(look, motif) {
  return `<svg viewBox="0 0 64 64" width="64" height="64" aria-hidden="true"><circle cx="32" cy="32" r="32" fill="${look.bg}"/>${shape(motif, look.fg, look.accent)}</svg>`;
}

export const AVATARS = Array.from({ length: 36 }, (_, index) => {
  const motif = index % 12;
  const look = LOOKS[(index * 5) % LOOKS.length];
  const id = `mark-${String(index + 1).padStart(2, '0')}`;
  const label = `${NAMES[motif]} ${Math.floor(index / 12) + 1}`;
  return { id, label, svg: svgFor(look, motif) };
});

export function avatarById(id) {
  return AVATARS.find((item) => item.id === id) || null;
}

export function filterAvatars(query) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return AVATARS;
  return AVATARS.filter((item) => item.label.toLowerCase().includes(q) || item.id.includes(q));
}

export function paintAvatar(el, avatar, name) {
  if (!el) return;
  el.classList.remove('has-image');
  el.replaceChildren();
  if (avatar?.kind === 'image' && avatar.dataUrl) {
    const img = document.createElement('img');
    img.src = avatar.dataUrl;
    img.alt = '';
    el.appendChild(img);
    el.classList.add('has-image');
    return;
  }
  if (avatar?.kind === 'preset') {
    const found = avatarById(avatar.id);
    if (found) {
      el.innerHTML = found.svg;
      return;
    }
  }
  const letter = String(name || '?').trim();
  el.textContent = (letter[0] || '?').toUpperCase();
}

export function readGuestAvatar() {
  try {
    const data = JSON.parse(localStorage.getItem(GUEST_KEY) || 'null');
    if (data?.kind === 'preset' && avatarById(data.id)) return { kind: 'preset', id: data.id };
    if (data?.kind === 'image' && typeof data.dataUrl === 'string' && data.dataUrl.startsWith('data:image/')) {
      return { kind: 'image', dataUrl: data.dataUrl };
    }
  } catch {
    return null;
  }
  return null;
}

export function writeGuestAvatar(avatar) {
  if (!avatar || avatar.kind === 'letter') {
    localStorage.removeItem(GUEST_KEY);
    return;
  }
  localStorage.setItem(GUEST_KEY, JSON.stringify(avatar));
}
