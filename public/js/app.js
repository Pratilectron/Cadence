import { animate, stagger, spring } from 'https://cdn.jsdelivr.net/npm/motion@11.15.0/+esm';
import { EMOJI_LIST } from './emojis.js';
import { renderRolesPanel, can } from './roles-ui.js';
import { bindImageClick } from './viewer.js';
import { openRecorder } from './recorder.js';
import {
  avatarLetter,
  apiProfile,
  bindProfileTabs,
  fillProfileForm,
} from './profile.js';

(() => {
  'use strict';

  const SESSION_KEY = 'cadence_session';
  const SIDEBAR_KEY = 'cadence_sidebar';
  const motionOk = !window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const state = {
    socket: null,
    user: null,
    sessionToken: null,
    activeRoom: 'General',
    activeRoomType: 'public',
    authMode: 'login',
    unread: Object.create(null),
    lastRoomList: [],
    messageIds: new Set(),
    customEmojis: { emojis: [], gifs: [] },
    pickerOpen: false,
    roomRoles: null,
    myPermissions: {},
    profile: null,
    preferences: {
      soundEnabled: true,
      activitySounds: true,
      showTimestamps: true,
    },
  };

  const $ = (id) => document.getElementById(id);

  const elements = {
    messages: $('messages'),
    chatForm: $('chat-form'),
    chatInput: $('chat-input'),
    statusText: $('status-text'),
    statusDot: $('status-dot'),
    meName: $('me-name'),
    userList: $('user-list'),
    pinnedList: $('pinned-list'),
    roomList: $('room-list'),
    activeRoom: $('active-room'),
    roomTypeLabel: $('room-type-label'),
    createRoomForm: $('create-room-form'),
    roomNameInput: $('room-name'),
    roomTypeSelect: $('room-type'),
    inviteForm: $('invite-form'),
    inviteUsername: $('invite-username'),
    inviteNote: $('invite-note'),
    inviteBtn: $('invite-btn'),
    inviteDialog: $('invite-dialog'),
    inviteClose: $('invite-close'),
    inviteRoomName: $('invite-room-name'),
    profileBtn: $('profile-btn'),
    profileAvatar: $('profile-avatar'),
    profileDialog: $('profile-dialog'),
    profileClose: $('profile-close'),
    logoutBtn: $('logout-btn'),
    adminLink: $('admin-link'),
    authDialog: $('auth-dialog'),
    authForm: $('auth-form'),
    authModeButton: $('auth-mode-button'),
    authTitle: $('auth-title'),
    authSubmit: $('auth-submit'),
    authUsername: $('auth-username'),
    authPassword: $('auth-password'),
    authError: $('auth-error'),
    toastStack: $('toast-stack'),
    attachBtn: $('attach-btn'),
    emojiBtn: $('emoji-btn'),
    fileInput: $('file-input'),
    picker: $('picker'),
    pickerEmoji: $('picker-emoji'),
    pickerGif: $('picker-gif'),
    uploadEmojiBtn: $('upload-emoji-btn'),
    customEmojiInput: $('custom-emoji-input'),
    storageHint: $('storage-hint'),
    activityLog: $('activity-log'),
    rolesPanel: $('roles-panel'),
    recordBtn: $('record-btn'),
  };

  function motion(el, keyframes, options) {
    if (!motionOk || !el) return;
    animate(el, keyframes, options);
  }

  function staggerIn(container, selector) {
    if (!motionOk || !container) return;
    const items = container.querySelectorAll(selector);
    if (!items.length) return;
    animate(items, { opacity: [0, 1], y: [14, 0] }, { delay: stagger(0.04), duration: 0.45, easing: spring() });
  }

  function initAmbient() {
    if (!motionOk) return;
    animate('.orb-a', { x: [0, 40, -20, 0], y: [0, 30, -10, 0], scale: [1, 1.08, 0.96, 1] }, { duration: 22, repeat: Infinity, easing: 'ease-in-out' });
    animate('.orb-b', { x: [0, -50, 20, 0], y: [0, -30, 15, 0], scale: [1, 0.92, 1.06, 1] }, { duration: 26, repeat: Infinity, easing: 'ease-in-out' });
    animate('.orb-c', { x: [0, 25, -35, 0], y: [0, -20, 25, 0] }, { duration: 18, repeat: Infinity, easing: 'ease-in-out' });
  }

  function introReveal() {
    if (!motionOk) return;
    animate('.masthead', { opacity: [0, 1], y: [-12, 0] }, { duration: 0.6, easing: spring() });
    animate('.folio', { opacity: [0, 1], y: [28, 0] }, { delay: stagger(0.1, { start: 0.15 }), duration: 0.65, easing: spring() });
  }

  function pulseStatusDot(color) {
    if (!motionOk) return;
    motion(elements.statusDot, { scale: [1, 1.5, 1], opacity: [1, 0.6, 1] }, { duration: 0.5 });
    elements.statusDot.style.background = color;
  }

  function updateStatus(text, color = '#c9a227') {
    elements.statusText.textContent = text;
    pulseStatusDot(color);
  }

  function escapeText(value) {
    return String(value ?? '');
  }

  function formatTime(ts) {
    return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  function formatBytes(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  }

  function formatActivity(row) {
    const who = row.username || 'Someone';
    const map = {
      'user.connected': `${who} connected`,
      'user.disconnected': `${who} left${row.meta?.sessionDurationMs ? ` (online ${Math.round(row.meta.sessionDurationMs / 60000)}m)` : ''}`,
      'user.login': `${who} signed in`,
      'user.logout': `${who} signed out`,
      'user.registered': `${who} registered`,
      'room.joined': `${who} joined`,
      'room.left': `${who} left${row.meta?.durationSec ? ` (stayed ${row.meta.durationSec}s)` : ''}`,
      'room.created': `${who} created room`,
      'room.invite': `${who} invited ${row.meta?.invited || 'someone'}`,
      'message.sent': `${who} sent ${row.meta?.messageType || 'a message'}${row.meta?.fileName ? `: ${row.meta.fileName}` : ''}`,
      'message.pinned': `${who} pinned a message`,
      'message.unpinned': `${who} unpinned a message`,
      'role.created': `${who} created role ${row.meta?.roleName || ''}`,
      'role.assigned': `${who} assigned a role to ${row.meta?.target || 'someone'}`,
    };
    return map[row.event] || `${who} · ${row.event}`;
  }

  async function refreshStorage() {
    try {
      const res = await fetch('/api/storage');
      const data = await res.json();
      elements.storageHint.textContent = `${formatBytes(data.usedBytes)} / 20 GB`;
    } catch { /* ignore */ }
  }

  async function refreshCustomEmojis() {
    try {
      const res = await fetch('/api/emojis');
      state.customEmojis = await res.json();
      renderPicker();
    } catch { /* ignore */ }
  }

  function showAuthDialog() {
    if (typeof elements.authDialog.showModal === 'function') elements.authDialog.showModal();
    const sheet = elements.authDialog.querySelector('.gate-sheet');
    motion(sheet, { opacity: [0, 1], scale: [0.94, 1], y: [20, 0] }, { duration: 0.5, easing: spring() });
    elements.authUsername.focus();
  }

  function hideAuthDialog() {
    if (!elements.authDialog.open) return;
    const sheet = elements.authDialog.querySelector('.gate-sheet');
    if (motionOk) {
      animate(sheet, { opacity: [1, 0], scale: [1, 0.96], y: [0, 10] }, { duration: 0.28 }).finished.then(() => elements.authDialog.close());
    } else {
      elements.authDialog.close();
    }
  }

  function setAuthMode(mode) {
    state.authMode = mode;
    const isLogin = mode === 'login';
    elements.authTitle.textContent = isLogin ? 'Sign in' : 'Create account';
    elements.authSubmit.textContent = isLogin ? 'Sign in' : 'Register';
    elements.authModeButton.textContent = isLogin ? 'Create account' : 'Sign in';
    elements.authPassword.autocomplete = isLogin ? 'current-password' : 'new-password';
    elements.authError.textContent = '';
  }

  function showToast(text, type = 'info', ttl = 4200) {
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.textContent = text;
    elements.toastStack.appendChild(toast);
    motion(toast, { opacity: [0, 1], y: [10, 0] }, { duration: 0.35, easing: spring() });
    window.setTimeout(() => {
      if (motionOk) animate(toast, { opacity: [1, 0], y: [0, 8] }, { duration: 0.25 }).finished.then(() => toast.remove());
      else toast.remove();
    }, ttl);
  }

  function showModal(dialog) {
    if (typeof dialog.showModal !== 'function') return;
    dialog.showModal();
    const sheet = dialog.querySelector('.gate-sheet');
    motion(sheet, { opacity: [0, 1], scale: [0.94, 1], y: [20, 0] }, { duration: 0.45, easing: spring() });
  }

  function hideModal(dialog) {
    if (!dialog?.open) return;
    const sheet = dialog.querySelector('.gate-sheet');
    if (motionOk && sheet) {
      animate(sheet, { opacity: [1, 0], scale: [1, 0.96], y: [0, 10] }, { duration: 0.25 }).finished.then(() => dialog.close());
    } else {
      dialog.close();
    }
  }

  function readSidebarState() {
    try {
      const raw = localStorage.getItem(SIDEBAR_KEY);
      return raw ? JSON.parse(raw) : { pinned: false, here: true, roles: true, activity: true };
    } catch {
      return { pinned: false, here: true, roles: true, activity: true };
    }
  }

  function saveSidebarState(next) {
    localStorage.setItem(SIDEBAR_KEY, JSON.stringify(next));
  }

  function initSidebar() {
    const saved = readSidebarState();
    document.querySelectorAll('.side-section').forEach((section) => {
      const key = section.dataset.section;
      let expanded;
      if (key === 'pinned' && saved.pinned === undefined) {
        expanded = false;
      } else {
        expanded = saved[key] !== false;
      }
      section.classList.toggle('is-collapsed', !expanded);
      section.querySelector('.side-head')?.setAttribute('aria-expanded', String(expanded));
    });
  }

  function toggleSidebarSection(section) {
    const key = section.dataset.section;
    const collapsed = section.classList.toggle('is-collapsed');
    const expanded = !collapsed;
    section.querySelector('.side-head')?.setAttribute('aria-expanded', String(expanded));
    const saved = readSidebarState();
    saved[key] = expanded;
    saveSidebarState(saved);
  }

  function updateUserChip(name) {
    const label = name || 'Guest';
    elements.meName.textContent = label;
    elements.profileAvatar.textContent = avatarLetter(label);
  }

  function updateInviteButton() {
    const room = state.lastRoomList.find((r) => r.name === state.activeRoom);
    const type = room?.type || state.activeRoomType;
    const show = Boolean(state.user) && (type === 'private' || type === 'locked');
    elements.inviteBtn.hidden = !show;
  }

  function openInviteDialog() {
    elements.inviteRoomName.textContent = state.activeRoom;
    elements.inviteNote.textContent = '';
    elements.inviteNote.className = 'form-status';
    elements.inviteUsername.value = '';
    showModal(elements.inviteDialog);
    elements.inviteUsername.focus();
  }

  const profileEls = {
    get heroAvatar() { return $('profile-hero-avatar'); },
    get chipAvatar() { return elements.profileAvatar; },
    get title() { return $('profile-title'); },
    get username() { return $('profile-username'); },
    get memberSince() { return $('profile-member-since'); },
    get displayName() { return $('profile-display-name'); },
    get bio() { return $('profile-bio'); },
    get stats() { return $('profile-stats'); },
    get dataList() { return $('profile-data-list'); },
    get prefSound() { return $('pref-sound'); },
    get prefActivitySound() { return $('pref-activity-sound'); },
    get prefTimestamps() { return $('pref-timestamps'); },
    formatBytes,
  };

  async function openProfileDialog() {
    if (!state.sessionToken) {
      showAuthDialog();
      return;
    }
    try {
      const { profile } = await apiProfile(state.sessionToken, '/api/profile');
      state.profile = profile;
      state.preferences = { ...state.preferences, ...profile.preferences };
      fillProfileForm(profile, profileEls);
      showModal(elements.profileDialog);
    } catch (err) {
      showToast(err.message, 'error');
    }
  }

  async function saveProfileFields() {
    try {
      const { profile } = await apiProfile(state.sessionToken, '/api/profile', {
        method: 'PATCH',
        body: JSON.stringify({
          displayName: profileEls.displayName.value.trim(),
          bio: profileEls.bio.value.trim(),
        }),
      });
      state.profile = profile;
      const chipName = profile.displayName || profile.username;
      updateUserChip(chipName);
      fillProfileForm(profile, profileEls);
      showToast('Profile saved', 'success');
    } catch (err) {
      showToast(err.message, 'error');
    }
  }

  async function saveProfilePreferences() {
    try {
      const prefs = {
        soundEnabled: profileEls.prefSound.checked,
        activitySounds: profileEls.prefActivitySound.checked,
        showTimestamps: profileEls.prefTimestamps.checked,
      };
      const { profile } = await apiProfile(state.sessionToken, '/api/profile', {
        method: 'PATCH',
        body: JSON.stringify({ preferences: prefs }),
      });
      state.profile = profile;
      state.preferences = { ...state.preferences, ...profile.preferences };
      showToast('Preferences saved', 'success');
    } catch (err) {
      showToast(err.message, 'error');
    }
  }

  function persistSession(token, username) {
    sessionStorage.setItem(SESSION_KEY, JSON.stringify({ token, username }));
  }

  function readSession() {
    try {
      const raw = sessionStorage.getItem(SESSION_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }

  function clearSession() {
    sessionStorage.removeItem(SESSION_KEY);
    state.sessionToken = null;
    state.user = null;
  }

  async function uploadFile(file, tag = 'file') {
    if (!state.sessionToken) {
      showToast('Sign in to upload files', 'error');
      return null;
    }
    const form = new FormData();
    form.append('file', file);
    showToast(`Uploading ${file.name}…`, 'info', 2000);
    const res = await fetch(`/api/upload?tag=${tag}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${state.sessionToken}` },
      body: form,
    });
    const data = await res.json();
    if (!res.ok) {
      showToast(data.error || 'Upload failed', 'error');
      return null;
    }
    await refreshStorage();
    if (tag === 'emoji' || tag === 'gif') await refreshCustomEmojis();
    return data.file;
  }

  function sendFileMessage(file, caption = '') {
    if (!state.socket?.connected || !file) return;
    state.socket.emit('message', {
      type: file.kind === 'gif' ? 'gif' : file.kind === 'emoji' ? 'emoji' : 'file',
      fileId: file.id,
      text: caption,
    });
  }

  function renderActivityLog(logs) {
    if (!logs?.length) {
      elements.activityLog.replaceChildren(Object.assign(document.createElement('p'), {
        className: 'empty-state',
        textContent: 'No activity yet.',
      }));
      return;
    }
    const fragment = document.createDocumentFragment();
    logs.forEach((row) => {
      const item = document.createElement('div');
      item.className = 'activity-item';
      item.innerHTML = `<div class="activity-event">${escapeText(row.event.replace(/\./g, ' '))}</div><div>${escapeText(formatActivity(row))}</div><div>${formatTime(row.ts)}</div>`;
      fragment.appendChild(item);
    });
    elements.activityLog.replaceChildren(fragment);
  }

  function renderPicker() {
    elements.pickerEmoji.replaceChildren();
    const emojiGrid = document.createElement('div');
    emojiGrid.className = 'emoji-grid';
    EMOJI_LIST.forEach((emoji) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = emoji;
      btn.addEventListener('click', () => {
        elements.chatInput.value += emoji;
        elements.chatInput.focus();
      });
      emojiGrid.appendChild(btn);
    });
    elements.pickerEmoji.appendChild(emojiGrid);

    elements.pickerGif.replaceChildren();
    const gifGrid = document.createElement('div');
    gifGrid.className = 'gif-grid';
    if (!state.customEmojis.gifs.length) {
      gifGrid.appendChild(Object.assign(document.createElement('p'), {
        className: 'empty-state',
        textContent: 'Upload GIFs in the Custom tab.',
      }));
    } else {
      state.customEmojis.gifs.forEach((gif) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.title = gif.name;
        const img = document.createElement('img');
        img.src = gif.url;
        img.alt = gif.name;
        btn.appendChild(img);
        btn.addEventListener('click', () => {
          if (!state.sessionToken) return showToast('Sign in to send GIFs', 'error');
          sendFileMessage({ id: gif.id, kind: 'gif', url: gif.url, name: gif.name });
          togglePicker(false);
        });
        gifGrid.appendChild(btn);
      });
    }
    elements.pickerGif.appendChild(gifGrid);
  }

  function togglePicker(open) {
    state.pickerOpen = open ?? !state.pickerOpen;
    elements.picker.hidden = !state.pickerOpen;
  }

  function renderAttachment(body, file) {
    if (!file) return;
    const wrap = document.createElement('div');
    wrap.className = 'msg-attachment';

    if (file.kind === 'image' || file.kind === 'gif' || file.kind === 'emoji') {
      const img = document.createElement('img');
      img.src = file.url;
      img.alt = file.name;
      img.loading = 'lazy';
      bindImageClick(img, file);
      wrap.appendChild(img);
    } else if (file.kind === 'audio') {
      const audio = document.createElement('audio');
      audio.controls = true;
      audio.src = file.url;
      wrap.appendChild(audio);
    } else if (file.kind === 'video') {
      const video = document.createElement('video');
      video.controls = true;
      video.src = file.url;
      wrap.appendChild(video);
    } else {
      const link = document.createElement('a');
      link.className = 'file-card';
      link.href = file.url;
      link.target = '_blank';
      link.rel = 'noopener';
      link.innerHTML = `<span class="file-icon">${escapeText(file.kind || 'file')}</span><span>${escapeText(file.name)}</span><span class="file-size">${formatBytes(file.size || 0)}</span>`;
      wrap.appendChild(link);
    }
    body.appendChild(wrap);
  }

  function renderRoomList(rooms) {
    const fragment = document.createDocumentFragment();
    if (!rooms.length) {
      fragment.appendChild(Object.assign(document.createElement('p'), {
        className: 'empty-state',
        textContent: 'Silence. Create the first room.',
      }));
    }
    rooms.forEach((room) => {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'room-item';
      if (room.name === state.activeRoom) item.classList.add('active');
      if (!room.joinable) item.classList.add('locked');
      item.dataset.room = room.name;
      item.dataset.joinable = String(room.joinable);
      const unread = state.unread[room.name] || 0;
      const joinLabel = room.isMember ? 'Here' : room.joinable ? 'Enter' : 'Locked';
      item.innerHTML = `
        <div class="room-top">
          <span class="room-name">${escapeText(room.name)}${unread > 0 ? `<span class="room-badge">${unread}</span>` : ''}</span>
          <span class="room-type">${escapeText(room.type)}</span>
        </div>
        <div class="room-meta">${room.memberCount} present · ${room.pinnedCount} pinned</div>
        <div class="room-meta">${joinLabel}</div>`;
      fragment.appendChild(item);
    });
    elements.roomList.replaceChildren(fragment);
    staggerIn(elements.roomList, '.room-item');
  }

  function renderUserList(users) {
    const fragment = document.createDocumentFragment();
    users.forEach((user) => {
      const item = document.createElement('div');
      item.className = 'user-item';
      const nameSpan = document.createElement('span');
      nameSpan.textContent = user.name || 'Anonymous';
      item.appendChild(nameSpan);
      if (user.role) {
        const roleSpan = document.createElement('span');
        roleSpan.className = 'user-role';
        roleSpan.style.color = user.role.color;
        roleSpan.textContent = ` · ${user.role.name}`;
        item.appendChild(roleSpan);
      }
      if (user.id === state.socket?.id) {
        const you = document.createElement('em');
        you.textContent = ' — you';
        item.appendChild(you);
      }
      fragment.appendChild(item);
    });
    elements.userList.replaceChildren(fragment);
    staggerIn(elements.userList, '.user-item');
  }

  function renderPinnedList(pinned) {
    if (!pinned.length) {
      elements.pinnedList.replaceChildren(Object.assign(document.createElement('p'), {
        className: 'empty-state',
        textContent: 'Nothing pinned yet.',
      }));
      return;
    }
    const fragment = document.createDocumentFragment();
    pinned.forEach((item) => {
      const node = document.createElement('div');
      node.className = 'pin-item';
      const body = document.createElement('div');
      body.className = 'message-body';
      if (item.text) body.textContent = item.text;
      if (item.file) renderAttachment(body, item.file);
      const meta = document.createElement('div');
      meta.className = 'pin-meta';
      meta.textContent = `${item.senderName} · ${formatTime(item.ts)}`;
      node.append(body, meta);
      fragment.appendChild(node);
    });
    elements.pinnedList.replaceChildren(fragment);
    staggerIn(elements.pinnedList, '.pin-item');
  }

  function appendMessage(payload, type = 'them', shouldAnimate = true) {
    if (state.messageIds.has(payload.id)) return;
    state.messageIds.add(payload.id);

    const message = document.createElement('article');
    message.className = `message${type === 'me' ? ' me' : ''}`;

    const body = document.createElement('div');
    body.className = 'message-body';
    if (payload.text) body.textContent = payload.text;
    if (payload.file) renderAttachment(body, payload.file);

    const meta = document.createElement('div');
    meta.className = 'message-meta';
    const sender = document.createElement('span');
    sender.textContent = payload.senderName || (type === 'me' ? 'You' : 'Guest');
    const time = document.createElement('span');
    time.textContent = state.preferences.showTimestamps ? formatTime(payload.ts) : '';
    time.hidden = !state.preferences.showTimestamps;
    const pinButton = document.createElement('button');
    pinButton.type = 'button';
    pinButton.className = 'pin-button';
    pinButton.textContent = 'Pin';
    pinButton.hidden = !can(state, 'MANAGE_MESSAGES');
    pinButton.addEventListener('click', () => {
      if (state.socket?.connected && state.user) {
        state.socket.emit('pinMessage', { room: state.activeRoom, messageId: payload.id });
      }
    });
    meta.append(sender, time, pinButton);
    message.append(body, meta);
    elements.messages.appendChild(message);
    elements.messages.scrollTop = elements.messages.scrollHeight;
    if (shouldAnimate) motion(message, { opacity: [0, 1], y: [18, 0] }, { duration: 0.4, easing: spring() });
  }

  function handleAuthSuccess(data) {
    state.user = { id: data.id, username: data.username, isSuperAdmin: data.isSuperAdmin };
    state.sessionToken = data.token;
    persistSession(data.token, data.username);
    updateUserChip(data.displayName || data.username);
    elements.logoutBtn.hidden = false;
    if (elements.adminLink) elements.adminLink.hidden = !data.isSuperAdmin;
    hideAuthDialog();
    showToast(`Welcome, ${data.username}`, 'success');
    refreshStorage();
    refreshCustomEmojis();
    updateInviteButton();
    apiProfile(data.token, '/api/profile').then(({ profile }) => {
      state.profile = profile;
      state.preferences = { ...state.preferences, ...profile.preferences };
      updateUserChip(profile.displayName || profile.username);
    }).catch(() => {});
  }

  function handleLoggedOut() {
    clearSession();
    state.profile = null;
    updateUserChip('Guest');
    elements.logoutBtn.hidden = true;
    if (elements.adminLink) elements.adminLink.hidden = true;
    elements.inviteBtn.hidden = true;
    setAuthMode('login');
    showAuthDialog();
    showToast('Signed out', 'info');
  }

  function handleRoomChange(roomName, type) {
    state.activeRoom = roomName;
    state.activeRoomType = type;
    state.messageIds.clear();
    state.unread[roomName] = 0;
    motion(elements.activeRoom, { opacity: [0.4, 1], y: [8, 0] }, { duration: 0.35, easing: spring() });
    elements.activeRoom.textContent = roomName;
    elements.roomTypeLabel.textContent = type;
    if (state.lastRoomList.length) renderRoomList(state.lastRoomList);
    state.socket?.emit('requestActivity', { room: roomName });
    state.socket?.emit('getRoomRoles', { room: roomName });
    updateInviteButton();
  }

  function applyRoomRoles(payload) {
    state.roomRoles = payload;
    state.myPermissions = payload.myPermissions || {};
    renderRolesPanel(elements.rolesPanel, state, state.socket, state.activeRoom);
  }

  async function handleFiles(fileList, tag = 'file') {
    if (!can(state, 'ATTACH_FILES')) {
      showToast('Missing permission: Attach Files', 'error');
      return;
    }
    for (const file of fileList) {
      const uploaded = await uploadFile(file, tag);
      if (uploaded) sendFileMessage(uploaded, elements.chatInput.value.trim());
    }
    elements.chatInput.value = '';
  }

  function initSocket() {
    state.socket = io({
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 1000,
    });

    state.socket.on('connect', () => {
      updateStatus('Live', '#8fae98');
      state.socket.emit('requestRoomList');
      const saved = readSession();
      if (saved?.token) state.socket.emit('restoreSession', { token: saved.token });
      refreshStorage();
    });

    state.socket.on('connect_error', () => updateStatus('Offline', '#c98b8b'));
    state.socket.on('disconnect', () => updateStatus('Away', '#c98b8b'));
    state.socket.on('reconnect_attempt', () => updateStatus('Returning', '#c9a227'));
    state.socket.on('reconnect', () => {
      updateStatus('Live', '#8fae98');
      state.socket.emit('requestRoomList');
      const saved = readSession();
      if (saved?.token) state.socket.emit('restoreSession', { token: saved.token });
    });

    state.socket.on('authSuccess', handleAuthSuccess);
    state.socket.on('loggedOut', handleLoggedOut);
    state.socket.on('sessionExpired', () => {
      clearSession();
      showToast('Session expired', 'error');
      showAuthDialog();
    });
    state.socket.on('authError', (payload) => {
      elements.authError.textContent = payload.message || 'Authentication failed.';
      showToast(payload.message || 'Authentication failed.', 'error');
    });

    state.socket.on('roomlist', (rooms) => {
      state.lastRoomList = rooms;
      renderRoomList(rooms);
      updateInviteButton();
    });
    state.socket.on('userlist', renderUserList);
    state.socket.on('history', (messages) => {
      elements.messages.replaceChildren();
      state.messageIds.clear();
      messages.forEach((msg) => appendMessage(msg, msg.senderId === state.socket.id ? 'me' : 'them', false));
      staggerIn(elements.messages, '.message');
    });
    state.socket.on('message', (msg) => {
      if (msg.room && msg.room !== state.activeRoom) {
        state.unread[msg.room] = (state.unread[msg.room] || 0) + 1;
        if (state.lastRoomList.length) renderRoomList(state.lastRoomList);
        showToast(`${msg.senderName} · ${msg.room}`, 'info');
        return;
      }
      appendMessage(msg, msg.senderId === state.socket.id ? 'me' : 'them');
    });
    state.socket.on('pinned', renderPinnedList);
    state.socket.on('roomJoined', ({ roomName, type }) => handleRoomChange(roomName, type));
    state.socket.on('roomError', (payload) => showToast(payload?.reason || 'Room error', 'error'));
    state.socket.on('inviteSuccess', (payload) => {
      elements.inviteNote.textContent = `${payload.username} invited to ${payload.room}.`;
      elements.inviteNote.className = 'form-status';
      showToast(`Invited ${payload.username}`, 'success');
    });
    state.socket.on('inviteError', (payload) => {
      elements.inviteNote.textContent = payload.reason || 'Invite failed.';
      elements.inviteNote.className = 'form-error';
      showToast(payload.reason || 'Invite failed.', 'error');
    });
    state.socket.on('activityHistory', renderActivityLog);
    state.socket.on('roomRoles', applyRoomRoles);
    state.socket.on('roleError', (p) => showToast(p.reason || 'Role error', 'error'));
    state.socket.on('roleSuccess', (p) => showToast(`Role ${p.action}`, 'success'));
    state.socket.on('activityLog', (row) => {
      if (row.room === state.activeRoom) {
        const item = document.createElement('div');
        item.className = 'activity-item';
        item.innerHTML = `<div class="activity-event">${escapeText(row.event.replace(/\./g, ' '))}</div><div>${escapeText(formatActivity(row))}</div><div>${formatTime(row.ts)}</div>`;
        if (elements.activityLog.querySelector('.empty-state')) elements.activityLog.replaceChildren();
        elements.activityLog.prepend(item);
      }
    });
  }

  function bindEvents() {
    elements.roomList.addEventListener('click', (event) => {
      const item = event.target.closest('.room-item');
      if (!item) return;
      const roomName = item.dataset.room;
      if (roomName === state.activeRoom || item.dataset.joinable !== 'true') return;
      state.socket.emit('joinRoom', roomName);
      state.unread[roomName] = 0;
    });

    elements.authModeButton.addEventListener('click', () => setAuthMode(state.authMode === 'login' ? 'register' : 'login'));
    elements.authForm.addEventListener('submit', (event) => {
      event.preventDefault();
      const username = elements.authUsername.value.trim();
      const password = elements.authPassword.value;
      if (!username || !password) {
        elements.authError.textContent = 'Username and password are required.';
        return;
      }
      if (!state.socket?.connected) {
        elements.authError.textContent = 'Not connected to server.';
        return;
      }
      elements.authError.textContent = '';
      state.socket.emit(state.authMode === 'login' ? 'login' : 'register', { username, password });
    });

    elements.createRoomForm.addEventListener('submit', (event) => {
      event.preventDefault();
      const name = elements.roomNameInput.value.trim();
      if (!name) return;
      state.socket.emit('createRoom', { name, type: elements.roomTypeSelect.value });
      elements.roomNameInput.value = '';
    });

    elements.inviteForm.addEventListener('submit', (event) => {
      event.preventDefault();
      const username = elements.inviteUsername.value.trim();
      if (!username) {
        elements.inviteNote.textContent = 'Enter a username.';
        elements.inviteNote.className = 'form-error';
        return;
      }
      state.socket.emit('inviteUser', { room: state.activeRoom, username });
      elements.inviteUsername.value = '';
    });

    elements.inviteBtn.addEventListener('click', openInviteDialog);
    elements.inviteClose.addEventListener('click', () => hideModal(elements.inviteDialog));
    elements.inviteDialog.addEventListener('cancel', (e) => {
      e.preventDefault();
      hideModal(elements.inviteDialog);
    });

    elements.profileBtn.addEventListener('click', openProfileDialog);
    elements.profileClose.addEventListener('click', () => hideModal(elements.profileDialog));
    elements.profileDialog.addEventListener('cancel', (e) => {
      e.preventDefault();
      hideModal(elements.profileDialog);
    });
    bindProfileTabs(elements.profileDialog);
    $('profile-save')?.addEventListener('click', saveProfileFields);
    $('profile-save-prefs')?.addEventListener('click', saveProfilePreferences);
    $('password-form')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const errEl = $('profile-password-error');
      errEl.textContent = '';
      try {
        await apiProfile(state.sessionToken, '/api/profile/password', {
          method: 'PATCH',
          body: JSON.stringify({
            currentPassword: $('profile-current-password').value,
            newPassword: $('profile-new-password').value,
          }),
        });
        $('profile-current-password').value = '';
        $('profile-new-password').value = '';
        showToast('Password updated', 'success');
      } catch (err) {
        errEl.textContent = err.message;
      }
    });

    document.querySelectorAll('.side-section .side-head').forEach((head) => {
      head.addEventListener('click', () => {
        toggleSidebarSection(head.closest('.side-section'));
      });
    });

    elements.logoutBtn.addEventListener('click', () => {
      if (state.socket?.connected) state.socket.emit('logout');
      else handleLoggedOut();
    });

    elements.chatForm.addEventListener('submit', (event) => {
      event.preventDefault();
      const text = elements.chatInput.value.trim();
      if (!text || !state.socket?.connected) return;
      if (!can(state, 'SEND_MESSAGES')) return showToast('Missing permission: Send Messages', 'error');
      state.socket.emit('message', { text, type: 'text' });
      elements.chatInput.value = '';
    });

    elements.chatInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        elements.chatForm.requestSubmit();
      }
    });

    elements.attachBtn.addEventListener('click', () => elements.fileInput.click());

    elements.recordBtn.addEventListener('click', async () => {
      if (!state.sessionToken) return showToast('Sign in to record', 'error');
      if (!can(state, 'ATTACH_FILES')) return showToast('Missing permission: Attach Files', 'error');
      await openRecorder(async (file) => {
        const uploaded = await uploadFile(file, 'file');
        if (uploaded) sendFileMessage(uploaded, 'Screen recording');
      });
    });
    elements.fileInput.addEventListener('change', () => {
      if (elements.fileInput.files?.length) handleFiles(elements.fileInput.files, 'file');
      elements.fileInput.value = '';
    });

    elements.emojiBtn.addEventListener('click', () => togglePicker());
    document.querySelectorAll('.picker-tab').forEach((tab) => {
      tab.addEventListener('click', () => {
        document.querySelectorAll('.picker-tab').forEach((t) => t.classList.remove('active'));
        document.querySelectorAll('.picker-panel').forEach((p) => p.classList.remove('active'));
        tab.classList.add('active');
        document.getElementById(`picker-${tab.dataset.tab}`).classList.add('active');
      });
    });

    elements.uploadEmojiBtn.addEventListener('click', () => elements.customEmojiInput.click());
    elements.customEmojiInput.addEventListener('change', async () => {
      const file = elements.customEmojiInput.files?.[0];
      if (!file) return;
      const tag = file.type === 'image/gif' || file.name.endsWith('.gif') ? 'gif' : 'emoji';
      await uploadFile(file, tag);
      elements.customEmojiInput.value = '';
    });

    elements.messages.addEventListener('dragover', (e) => { e.preventDefault(); });
    elements.messages.addEventListener('drop', (e) => {
      e.preventDefault();
      if (e.dataTransfer?.files?.length) handleFiles(e.dataTransfer.files, 'file');
    });

    elements.authDialog.addEventListener('cancel', (event) => {
      if (!state.user) event.preventDefault();
    });

    document.addEventListener('click', (e) => {
      if (!state.pickerOpen) return;
      if (elements.picker.contains(e.target) || elements.emojiBtn.contains(e.target)) return;
      togglePicker(false);
    });
  }

  document.addEventListener('DOMContentLoaded', () => {
    initAmbient();
    introReveal();
    initSidebar();
    initSocket();
    bindEvents();
    renderPicker();
    setAuthMode('login');

    const saved = readSession();
    if (saved?.username) elements.authUsername.value = saved.username;
    if (!saved?.token) showAuthDialog();
    refreshStorage();
    refreshCustomEmojis();
  });
})();
