const SESSION_KEY = 'cadence_session';

const $ = (id) => document.getElementById(id);

function getToken() {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    return raw ? JSON.parse(raw).token : null;
  } catch {
    return null;
  }
}

async function api(path, options = {}) {
  const token = getToken();
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

function toast(text, type = 'info') {
  const el = document.createElement('div');
  el.className = `toast ${type} show`;
  el.textContent = text;
  $('toast-stack').appendChild(el);
  setTimeout(() => el.remove(), 4000);
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

function switchSection(name) {
  document.querySelectorAll('.admin-section').forEach((s) => s.classList.remove('active'));
  document.querySelectorAll('.admin-link').forEach((l) => l.classList.remove('active'));
  $(`sec-${name}`)?.classList.add('active');
  document.querySelector(`.admin-link[data-section="${name}"]`)?.classList.add('active');
}

async function loadDashboard() {
  const stats = await api('/api/admin/stats');
  const grid = $('stats-grid');
  const items = [
    ['Users', stats.users],
    ['Rooms', stats.rooms],
    ['Online', stats.onlineSockets],
    ['Sessions', stats.activeSessions],
    ['Files', stats.files],
    ['Storage', formatBytes(stats.storageUsed)],
    ['Messages', stats.messagesInMemory],
    ['Activity', stats.activityEntries],
  ];
  grid.innerHTML = items.map(([label, value]) => `
    <div class="stat-card"><div class="label">${label}</div><div class="value">${value}</div></div>`).join('');
}

async function loadUsers() {
  const { users } = await api('/api/admin/users');
  $('users-table').innerHTML = `<table class="admin-table"><thead><tr>
    <th>Username</th><th>Super Admin</th><th>Algo</th><th>Actions</th>
  </tr></thead><tbody>${users.map((u) => `<tr>
    <td>${u.username}</td>
    <td>${u.superAdmin ? 'Yes' : 'No'}</td>
    <td>${u.algo}</td>
    <td>
      <button class="link-btn" data-act="toggle-sa" data-id="${u.id}">${u.superAdmin ? 'Revoke SA' : 'Make SA'}</button>
      <button class="link-btn" data-act="del-user" data-id="${u.id}">Delete</button>
    </td>
  </tr>`).join('')}</tbody></table>`;
}

async function loadRooms() {
  const { rooms, roomMeta } = await api('/api/admin/rooms');
  $('rooms-table').innerHTML = `<table class="admin-table"><thead><tr>
    <th>Room</th><th>Type</th><th>Members</th><th>Roles</th><th>Actions</th>
  </tr></thead><tbody>${rooms.map((r) => `<tr>
    <td>${r.name}</td><td>${r.type}</td><td>${r.members}</td>
    <td>${(r.roleNames || []).join(', ')}</td>
    <td><button class="link-btn" data-act="del-room" data-name="${r.name}">Delete</button></td>
  </tr>`).join('')}</tbody></table>`;
}

async function loadFiles() {
  const { files } = await api('/api/admin/files');
  $('files-table').innerHTML = `<table class="admin-table"><thead><tr>
    <th>Name</th><th>Kind</th><th>Size</th><th>User</th><th>Actions</th>
  </tr></thead><tbody>${files.map((f) => `<tr>
    <td>${f.name}</td><td>${f.kind}</td><td>${formatBytes(f.size)}</td><td>${f.username || '—'}</td>
    <td><button class="link-btn" data-act="del-file" data-id="${f.id}">Delete</button></td>
  </tr>`).join('')}</tbody></table>`;
}

async function loadLogs() {
  const { logs } = await api('/api/admin/logs?limit=150');
  $('logs-table').innerHTML = `<table class="admin-table"><thead><tr>
    <th>Time</th><th>Event</th><th>User</th><th>Room</th>
  </tr></thead><tbody>${logs.map((l) => `<tr>
    <td>${new Date(l.ts).toLocaleString()}</td><td>${l.event}</td><td>${l.username || '—'}</td><td>${l.room || '—'}</td>
  </tr>`).join('')}</tbody></table>`;
}

async function loadSettings() {
  const { settings } = await api('/api/admin/settings');
  const form = $('settings-form');
  const locked = settings.envLocked || {};

  form.innerHTML = `
    <label><span>App name</span><input name="appName" value="${settings.appName}" ${locked.appName ? 'disabled' : ''} /></label>
    <label><span>Max storage (GB)</span><input name="maxStorageGb" type="number" value="${settings.maxStorageGb}" ${locked.maxStorageGb ? 'disabled' : ''} />
      ${locked.maxStorageGb ? '<em class="locked">Locked by MAX_STORAGE_GB in .env</em>' : ''}</label>
    <label><span>Max file (MB)</span><input name="maxFileMb" type="number" value="${settings.maxFileMb}" ${locked.maxFileMb ? 'disabled' : ''} /></label>
    <label><span>Messages per room</span><input name="maxMessagesPerRoom" type="number" value="${settings.maxMessagesPerRoom}" /></label>
    <label><span>Pinned per room</span><input name="maxPinnedPerRoom" type="number" value="${settings.maxPinnedPerRoom}" /></label>
    <label><span>Default rooms (comma)</span><input name="defaultRooms" value="${(settings.defaultRooms || []).join(', ')}" /></label>
    <label><span>Super admins (comma)</span><input name="superAdminUsernames" value="${(settings.superAdminUsernames || []).join(', ')}" ${locked.superAdminUsernames ? 'disabled' : ''} />
      ${locked.superAdminUsernames ? '<em class="locked">Locked by SUPER_ADMIN_USERNAMES in .env</em>' : ''}</label>
    <div class="toggle-row"><span>Registration enabled</span><input name="registrationEnabled" type="checkbox" ${settings.registrationEnabled ? 'checked' : ''} /></div>
    <div class="toggle-row"><span>Guest chat enabled</span><input name="guestChatEnabled" type="checkbox" ${settings.guestChatEnabled ? 'checked' : ''} /></div>
    <div class="toggle-row"><span>Maintenance mode</span><input name="maintenanceMode" type="checkbox" ${settings.maintenanceMode ? 'checked' : ''} /></div>
    <button type="submit" class="pill-btn pill-accent">Save settings</button>`;

  form.onsubmit = async (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    const patch = {
      appName: fd.get('appName'),
      maxStorageGb: Number(fd.get('maxStorageGb')),
      maxFileMb: Number(fd.get('maxFileMb')),
      maxMessagesPerRoom: Number(fd.get('maxMessagesPerRoom')),
      maxPinnedPerRoom: Number(fd.get('maxPinnedPerRoom')),
      defaultRooms: String(fd.get('defaultRooms')).split(',').map((s) => s.trim()).filter(Boolean),
      superAdminUsernames: String(fd.get('superAdminUsernames')).split(',').map((s) => s.trim()).filter(Boolean),
      registrationEnabled: fd.get('registrationEnabled') === 'on',
      guestChatEnabled: fd.get('guestChatEnabled') === 'on',
      maintenanceMode: fd.get('maintenanceMode') === 'on',
    };
    await api('/api/admin/settings', { method: 'PUT', body: JSON.stringify(patch) });
    toast('Settings saved', 'success');
  };
}

document.querySelectorAll('.admin-link').forEach((btn) => {
  btn.addEventListener('click', async () => {
    const sec = btn.dataset.section;
    switchSection(sec);
    try {
      if (sec === 'dashboard') await loadDashboard();
      if (sec === 'users') await loadUsers();
      if (sec === 'rooms') await loadRooms();
      if (sec === 'storage') await loadFiles();
      if (sec === 'logs') await loadLogs();
      if (sec === 'settings') await loadSettings();
    } catch (err) {
      toast(err.message, 'error');
    }
  });
});

document.body.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  try {
    if (btn.dataset.act === 'toggle-sa') {
      const row = btn.closest('tr');
      const makeSa = btn.textContent.includes('Make');
      await api(`/api/admin/users/${btn.dataset.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ superAdmin: makeSa }),
      });
      toast('User updated', 'success');
      loadUsers();
    }
    if (btn.dataset.act === 'del-user') {
      if (!confirm('Delete this user?')) return;
      await api(`/api/admin/users/${btn.dataset.id}`, { method: 'DELETE' });
      toast('User deleted', 'success');
      loadUsers();
    }
    if (btn.dataset.act === 'del-room') {
      if (!confirm(`Delete room ${btn.dataset.name}?`)) return;
      await api(`/api/admin/rooms/${encodeURIComponent(btn.dataset.name)}`, { method: 'DELETE' });
      toast('Room deleted', 'success');
      loadRooms();
    }
    if (btn.dataset.act === 'del-file') {
      if (!confirm('Delete this file?')) return;
      await api(`/api/admin/files/${btn.dataset.id}`, { method: 'DELETE' });
      toast('File deleted', 'success');
      loadFiles();
    }
  } catch (err) {
    toast(err.message, 'error');
  }
});

$('revoke-sessions').addEventListener('click', async () => {
  if (!confirm('Revoke all sessions?')) return;
  try {
    const { revoked } = await api('/api/admin/sessions/revoke', { method: 'POST' });
    toast(`Revoked ${revoked} sessions`, 'success');
  } catch (err) {
    toast(err.message, 'error');
  }
});

$('wipe-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const errEl = $('wipe-error');
  errEl.textContent = '';
  const password = $('wipe-password').value;
  const confirmText = $('wipe-confirm').value.trim();
  if (confirmText !== 'WIPE') {
    errEl.textContent = 'Type WIPE exactly to confirm.';
    return;
  }
  if (!window.confirm('This permanently deletes all users except you, all files, logs, and custom rooms. Continue?')) {
    return;
  }
  try {
    const { result } = await api('/api/admin/wipe', {
      method: 'POST',
      body: JSON.stringify({ password, confirm: confirmText }),
    });
    $('wipe-password').value = '';
    $('wipe-confirm').value = '';
    toast(`Wiped: ${result.usersRemoved} users, ${result.filesRemoved} files, ${result.logsCleared} log entries`, 'success');
    await loadDashboard();
  } catch (err) {
    errEl.textContent = err.message;
    toast(err.message, 'error');
  }
});

(async function init() {
  if (!getToken()) {
    $('admin-user').textContent = 'Not signed in';
    toast('Sign in on the main app first', 'error');
    setTimeout(() => { window.location.href = '/'; }, 2000);
    return;
  }
  try {
    const { user } = await api('/api/admin/me');
    $('admin-user').textContent = user.username;
    await loadDashboard();
  } catch (err) {
    $('admin-user').textContent = 'Access denied';
    toast(err.message, 'error');
  }
})();
