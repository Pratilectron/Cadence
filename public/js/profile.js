export function avatarLetter(name) {
  const s = String(name || '?').trim();
  return (s[0] || '?').toUpperCase();
}

export function formatMemberSince(ts) {
  if (!ts) return 'Member since unknown';
  return `Member since ${new Date(ts).toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}`;
}

export async function apiProfile(token, path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      Authorization: token ? `Bearer ${token}` : '',
      ...(options.headers || {}),
    },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

export function renderProfileStats(container, stats, formatBytes) {
  const items = [
    ['Messages', stats.messagesSent],
    ['Uploads', stats.uploads],
    ['Storage', formatBytes(stats.storageBytes)],
    ['Rooms', stats.roomsJoined],
    ['Created', stats.roomsCreated],
    ['Invites', stats.invitesSent],
  ];
  container.innerHTML = items.map(([lbl, val]) => `
    <div class="profile-stat"><div class="val">${val}</div><div class="lbl">${lbl}</div></div>`).join('');
}

export function renderProfileData(container, profile) {
  const rows = [
    ['User ID', profile.id],
    ['Username', profile.username],
    ['Account', profile.superAdmin ? 'Super admin' : 'Standard'],
    ['Logins', String(profile.stats.logins)],
    ['Activity', `${profile.stats.activityEvents} events`],
    ['Pins', `${profile.stats.pinsCreated} created`],
  ];
  container.innerHTML = rows.map(([key, val]) => {
    const valueHtml = key === 'Account' && profile.superAdmin
      ? '<span class="profile-badge">Super admin</span>'
      : String(val).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return `<div class="profile-data-row"><span class="profile-data-key">${key}</span><span class="profile-data-val">${valueHtml}</span></div>`;
  }).join('');
}

export function bindProfileTabs(dialog) {
  dialog.querySelectorAll('.profile-tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      dialog.querySelectorAll('.profile-tab').forEach((t) => t.classList.remove('active'));
      dialog.querySelectorAll('.profile-panel').forEach((p) => p.classList.remove('active'));
      tab.classList.add('active');
      dialog.querySelector(`#profile-tab-${tab.dataset.tab}`)?.classList.add('active');
    });
  });
}

export function fillProfileForm(profile, els) {
  els.heroAvatar.textContent = avatarLetter(profile.displayName || profile.username);
  els.chipAvatar.textContent = avatarLetter(profile.displayName || profile.username);
  els.title.textContent = profile.displayName || profile.username;
  els.username.textContent = profile.username;
  els.memberSince.textContent = formatMemberSince(profile.createdAt);
  els.displayName.value = profile.displayName || '';
  els.bio.value = profile.bio || '';
  els.prefSound.checked = profile.preferences.soundEnabled;
  els.prefActivitySound.checked = profile.preferences.activitySounds;
  els.prefTimestamps.checked = profile.preferences.showTimestamps;
  renderProfileStats(els.stats, profile.stats, els.formatBytes);
  renderProfileData(els.dataList, profile);
}
