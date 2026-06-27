import { animate, stagger, spring } from 'https://cdn.jsdelivr.net/npm/motion@11.15.0/+esm';
import { EMOJI_LIST } from './emojis.js';
import { renderRolesPanel, can } from './roles-ui.js';
import { bindImageClick } from './viewer.js';
import { openRecorder } from './recorder.js';
import {
  loadPublicConfig,
  checkVideoFile,
  notifyModerationBlock,
  MODERATION_BLOCK_MESSAGE,
} from './nsfw-guard.js';
import {
  initAccessGate,
  showAccessGate,
} from './access-gate.js';
import { createSocketOptions } from './socket-client.js';
import { createHttpChat } from './chat-http.js';
import {
  persistSession,
  readSession,
  clearSession,
  clearGateAccess,
} from './session.js';
import {
  loadLocalPreferences,
  saveLocalPreferences,
  readGuestName,
  persistGuestName,
  DEFAULT_PREFS,
} from './preferences.js';
import {
  playReceiveSound,
  playSendSound,
  playActivitySound,
  startTitlePulse,
  updateDocumentTitle,
  notifyDesktop,
  primeAudioOnGesture,
} from './chat-ux.js';
import { randomGuestName, sanitizeGuestNameInput } from './guest-names.js';
import {
  avatarLetter,
  apiProfile,
  bindProfileTabs,
  fillProfileForm,
} from './profile.js';
import {
  initUploadUi,
  showUploadProgress,
  updateUploadProgress,
  hideUploadProgress,
  uploadWithProgress,
} from './upload-ui.js';

(() => {
  'use strict';

  const SIDEBAR_KEY = 'cadence_sidebar';
  const PANEL_KEY = 'cadence_panel';
  const motionOk = !window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const state = {
    socket: null,
    user: null,
    sessionToken: null,
    activeRoom: 'General',
    activeRoomType: 'public',
    unread: Object.create(null),
    lastRoomList: [],
    messageIds: new Set(),
    customEmojis: { emojis: [], gifs: [] },
    pickerOpen: false,
    roomRoles: null,
    myPermissions: {},
    profile: null,
    isGuest: true,
    appName: 'Cadence',
    lastSender: '',
    guestHiddenCount: 0,
    preferences: { ...DEFAULT_PREFS },
    appStarted: false,
    gateMode: null,
    lastHistory: null,
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
    adminLink: $('admin-link'),
    signinBtn: $('signin-btn'),
    logoutBtn: $('logout-btn'),
    toastStack: $('toast-stack'),
    moderationDialog: $('moderation-dialog'),
    moderationTitle: $('moderation-title'),
    moderationMessage: $('moderation-message'),
    moderationStrikes: $('moderation-strikes'),
    moderationLockout: $('moderation-lockout'),
    moderationOk: $('moderation-ok'),
    guestSettingsDialog: $('guest-settings-dialog'),
    guestSettingsClose: $('guest-settings-close'),
    guestChatName: $('guest-chat-name'),
    guestChatRandom: $('guest-chat-random'),
    guestSettingsSave: $('guest-settings-save'),
    guestSettingsSignin: $('guest-settings-signin'),
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
    mobileDock: $('mobile-dock'),
  };

  let mobilePanels = null;

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
    // Background effects removed for performance.
  }

  function introReveal() {
    // One-shot layout animations disabled — they competed with header interaction.
  }

  function pulseStatusDot(color) {
    if (!motionOk) return;
    motion(elements.statusDot, { scale: [1, 1.5, 1], opacity: [1, 0.6, 1] }, { duration: 0.5 });
    elements.statusDot.style.background = color;
  }

  let awayStatusTimer = null;
  let connectErrorNotified = false;

  function updateStatus(text, color = '#c9a227') {
    if (text === 'Away') {
      clearTimeout(awayStatusTimer);
      awayStatusTimer = window.setTimeout(() => {
        if (!state.socket?.connected) {
          elements.statusText.textContent = 'Away';
          pulseStatusDot(color);
          elements.statusDot?.closest('.live-tag')?.classList.remove('is-live');
        }
      }, 4000);
      return;
    }
    clearTimeout(awayStatusTimer);
    elements.statusText.textContent = text;
    pulseStatusDot(color);
    elements.statusDot?.closest('.live-tag')?.classList.toggle('is-live', color === '#8fae98');
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
      'moderation.blocked': `${who} — policy warning ${row.meta?.strikes || '?'}/${row.meta?.maxStrikes || '?'}`,
      'moderation.lockout': `${who} — suspended ${row.meta?.lockoutMinutes || 10} min`,
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

  function updateAuthChrome() {
    const signedIn = Boolean(state.user);
    if (elements.logoutBtn) elements.logoutBtn.hidden = !signedIn;
    if (elements.signinBtn) elements.signinBtn.hidden = signedIn;
    if (elements.adminLink) {
      elements.adminLink.hidden = !signedIn || !state.user?.isSuperAdmin;
    }
  }

  async function leaveToGate(query = 'signedout=1') {
    clearSession();
    state.profile = null;
    state.user = null;
    state.sessionToken = null;
    state.appStarted = false;
    state.gateMode = null;
    if (state.socket) {
      state.socket.disconnect();
      state.socket = null;
    }
    updateUserChip('Guest');
    updateAuthChrome();
    if (elements.adminLink) elements.adminLink.hidden = true;
    elements.inviteBtn.hidden = true;
    await clearGateAccess();
    const detail = {};
    if (query.includes('signedout')) detail.signedOut = true;
    if (query.includes('locked')) detail.locked = true;
    await showAccessGate(detail);
  }

  function dismissToast(toast) {
    if (!toast?.isConnected) return;
    if (motionOk) {
      animate(toast, { opacity: [1, 0], x: [0, 10] }, { duration: 0.25 }).finished.then(() => toast.remove());
    } else {
      toast.remove();
    }
  }

  function showToast(text, type = 'info', ttl = 8000) {
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.setAttribute('role', 'status');

    const msg = document.createElement('span');
    msg.className = 'toast-msg';
    msg.textContent = text;

    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'toast-close';
    close.setAttribute('aria-label', 'Dismiss notification');
    close.textContent = '×';

    toast.append(msg, close);
    elements.toastStack.appendChild(toast);
    motion(toast, { opacity: [0, 1], x: [12, 0] }, { duration: 0.35, easing: spring() });

    let timer = window.setTimeout(() => dismissToast(toast), ttl);
    close.addEventListener('click', () => {
      window.clearTimeout(timer);
      dismissToast(toast);
    });
  }

  let lockoutUiActive = false;

  function showModerationModal(detail = {}) {
    const message = detail.message || detail.reason || MODERATION_BLOCK_MESSAGE;
    const lockedOut = Boolean(detail.lockedOut);
    elements.moderationTitle.textContent = lockedOut ? 'Account suspended' : 'Upload blocked';
    elements.moderationMessage.textContent = message;

    if (!lockedOut && detail.strikes && detail.maxStrikes) {
      elements.moderationStrikes.hidden = false;
      const remaining = detail.remaining ?? Math.max(0, detail.maxStrikes - detail.strikes);
      const lockoutMinutes = detail.lockoutMinutes || 10;
      elements.moderationStrikes.textContent = remaining > 0
        ? `Warning ${detail.strikes} of ${detail.maxStrikes}. ${remaining} more violation${remaining === 1 ? '' : 's'} before a ${lockoutMinutes}-minute sign-out.`
        : `Warning ${detail.strikes} of ${detail.maxStrikes}.`;
      elements.moderationLockout.hidden = true;
    } else if (lockedOut) {
      elements.moderationStrikes.hidden = true;
      elements.moderationLockout.hidden = false;
      const mins = detail.lockoutMinutes || 10;
      elements.moderationLockout.textContent = `You have been signed out for ${mins} minute${mins === 1 ? '' : 's'}. You cannot sign in again until the suspension ends.`;
    } else {
      elements.moderationStrikes.hidden = true;
      elements.moderationLockout.hidden = true;
    }

    elements.chatForm?.classList.add('composer-blocked');
    window.setTimeout(() => elements.chatForm?.classList.remove('composer-blocked'), 600);
    showModal(elements.moderationDialog);
  }

  function applyAccountLockout(detail = {}) {
    if (lockoutUiActive) return;
    lockoutUiActive = true;
    clearSession();
    state.user = null;
    state.sessionToken = null;
    state.profile = null;
    updateUserChip('Guest');
    updateAuthChrome();
    if (elements.adminLink) elements.adminLink.hidden = true;
    elements.inviteBtn.hidden = true;
    clearGateAccess();
    showModerationModal({
      message: detail.message || detail.reason || `Signed out for ${detail.lockoutMinutes || 10} minutes after repeated content policy violations.`,
      lockedOut: true,
      lockoutMinutes: detail.lockoutMinutes,
      lockoutUntil: detail.lockoutUntil,
      strikes: detail.strikes,
      maxStrikes: detail.maxStrikes,
    });
  }

  document.addEventListener('cadence:moderation-blocked', (event) => {
    const detail = event.detail || {};
    if (detail.lockedOut) applyAccountLockout(detail);
    else showModerationModal(detail);
  });

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
    get prefSendSound() { return $('pref-send-sound'); },
    get prefTitleAlerts() { return $('pref-title-alerts'); },
    get prefDesktop() { return $('pref-desktop'); },
    formatBytes,
  };

  function applyPreferences(prefs) {
    state.preferences = { ...DEFAULT_PREFS, ...prefs };
    saveLocalPreferences(state.preferences);
  }

  function totalUnread() {
    return Object.values(state.unread).reduce((sum, n) => sum + (n || 0), 0);
  }

  function isOwnMessage(msg) {
    if (msg.decoy) return false;
    if (state.user?.id && msg.senderUserId) return msg.senderUserId === state.user.id;
    if (state.user?.username && msg.senderName) {
      const name = String(msg.senderName).toLowerCase();
      const user = state.user.username.toLowerCase();
      const display = (state.profile?.displayName || '').toLowerCase();
      if (name === user || (display && name === display)) return true;
    }
    return msg.senderId === state.socket?.id;
  }

  function syncGuestDisplayName() {
    if (state.user?.id || !state.socket?.connected) return;
    const name = sanitizeGuestNameInput(readGuestName() || randomGuestName());
    persistGuestName(name);
    state.socket.emit('setDisplayName', { name });
    updateUserChip(name);
  }

  function openGuestSettings() {
    elements.guestChatName.value = readGuestName() || state.meName.textContent || randomGuestName();
    $('guest-pref-sound').checked = state.preferences.soundEnabled !== false;
    $('guest-pref-send-sound').checked = state.preferences.sendSoundEnabled !== false;
    $('guest-pref-title').checked = state.preferences.titleNotifications !== false;
    showModal(elements.guestSettingsDialog);
  }

  function saveGuestSettings() {
    const name = sanitizeGuestNameInput(elements.guestChatName.value);
    persistGuestName(name);
    applyPreferences({
      ...state.preferences,
      soundEnabled: $('guest-pref-sound').checked,
      sendSoundEnabled: $('guest-pref-send-sound').checked,
      titleNotifications: $('guest-pref-title').checked,
    });
    if (state.socket?.connected) state.socket.emit('setDisplayName', { name });
    updateUserChip(name);
    hideModal(elements.guestSettingsDialog);
    showToast('Guest settings saved', 'success');
  }

  async function openProfileDialog() {
    if (!state.sessionToken) {
      openGuestSettings();
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
        sendSoundEnabled: profileEls.prefSendSound?.checked !== false,
        activitySounds: profileEls.prefActivitySound.checked,
        titleNotifications: profileEls.prefTitleAlerts?.checked !== false,
        desktopNotifications: profileEls.prefDesktop?.checked === true,
        showTimestamps: profileEls.prefTimestamps.checked,
      };
      applyPreferences(prefs);
      if (state.sessionToken) {
        const { profile } = await apiProfile(state.sessionToken, '/api/profile', {
          method: 'PATCH',
          body: JSON.stringify({ preferences: prefs }),
        });
        state.profile = profile;
        state.preferences = { ...state.preferences, ...profile.preferences };
      }
      showToast('Preferences saved', 'success');
    } catch (err) {
      showToast(err.message, 'error');
    }
  }

  function initMobilePanels() {
    const dock = elements.mobileDock;
    const panels = document.querySelectorAll('[data-panel]');
    if (!dock || !panels.length) return null;

    const mq = window.matchMedia('(max-width: 1100px)');

    function setPanel(name, animate = true) {
      if (!mq.matches) return;
      panels.forEach((panel) => {
        const active = panel.dataset.panel === name;
        panel.classList.toggle('is-panel-active', active);
        if (active && animate && motionOk) {
          motion(panel, { opacity: [0.72, 1], y: [12, 0] }, { duration: 0.34, easing: spring() });
        }
      });
      dock.querySelectorAll('.dock-btn').forEach((btn) => {
        const active = btn.dataset.panel === name;
        btn.classList.toggle('active', active);
        btn.setAttribute('aria-pressed', String(active));
      });
      try {
        localStorage.setItem(PANEL_KEY, name);
      } catch { /* ignore */ }
    }

    function applyDesktop() {
      dock.hidden = true;
      panels.forEach((p) => p.classList.add('is-panel-active'));
    }

    function applyMobile() {
      dock.hidden = false;
      let saved = 'chat';
      try {
        saved = localStorage.getItem(PANEL_KEY) || 'chat';
      } catch { /* ignore */ }
      setPanel(saved, false);
    }

    function onBreakpointChange() {
      if (mq.matches) applyMobile();
      else applyDesktop();
    }

    dock.addEventListener('click', (e) => {
      const btn = e.target.closest('.dock-btn');
      if (!btn || !mq.matches) return;
      const name = btn.dataset.panel;
      if (btn.classList.contains('active') && name !== 'chat') {
        setPanel('chat');
        return;
      }
      setPanel(name);
    });

    mq.addEventListener('change', onBreakpointChange);
    onBreakpointChange();

    return { setPanel, isMobile: () => mq.matches };
  }

  function goToChatPanel() {
    mobilePanels?.setPanel?.('chat');
  }

  async function uploadFile(file, tag = 'file') {
    if (!state.sessionToken) {
      showToast('Sign in to upload files', 'error');
      return null;
    }

    showUploadProgress({
      fileName: file.name,
      stage: file.type.startsWith('video/') ? 'checking' : 'uploading',
      progress: 0,
      detail: file.type.startsWith('video/') ? 'Scanning video frames…' : 'Starting upload…',
    });

    if (file.type.startsWith('video/')) {
      const videoCheck = await checkVideoFile(file);
      if (!videoCheck.ok) {
        hideUploadProgress(0);
        elements.fileInput.value = '';
        return null;
      }
    }

    const form = new FormData();
    form.append('file', file);

    updateUploadProgress({
      stage: 'uploading',
      progress: 0,
      detail: 'Uploading… 0%',
    });

    try {
      const data = await uploadWithProgress(
        `/api/upload?tag=${encodeURIComponent(tag)}`,
        form,
        { Authorization: `Bearer ${state.sessionToken}` },
        {
          onUploadProgress(ratio, verifying) {
            if (verifying) {
              updateUploadProgress({
                stage: 'verifying',
                progress: ratio,
                detail: 'Checking content policy…',
              });
              return;
            }
            updateUploadProgress({
              stage: 'uploading',
              progress: ratio,
              detail: `Uploading… ${Math.round(ratio * 100)}%`,
            });
          },
        },
      );

      updateUploadProgress({ stage: 'finishing', progress: 1, detail: 'Done' });
      await refreshStorage();
      if (tag === 'emoji' || tag === 'gif') await refreshCustomEmojis();
      hideUploadProgress();
      return data.file;
    } catch (err) {
      hideUploadProgress(0);
      const msg = err.message || err.error || 'Upload failed';
      if (err.lockedOut || err.strikes) {
        notifyModerationBlock({ message: msg, ...err });
      } else if (/content policy|blocked|isn't allowed/i.test(msg)) {
        notifyModerationBlock({ message: msg });
      } else {
        showToast(msg, 'error');
      }
      elements.fileInput.value = '';
      elements.customEmojiInput.value = '';
      return null;
    }
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
    const localGuestName = !state.user?.id ? readGuestName() : '';
    users.forEach((user) => {
      const item = document.createElement('div');
      item.className = 'user-item';
      const nameSpan = document.createElement('span');
      let label = user.name || 'Guest';
      if (user.id === state.socket?.id && localGuestName && (label === 'Anonymous' || label === 'Guest')) {
        label = localGuestName;
      }
      nameSpan.textContent = label;
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

  function renderGuestUnlockCta(hiddenCount) {
    const wrap = document.createElement('div');
    wrap.className = 'guest-unlock-cta';
    const count = hiddenCount || state.guestHiddenCount || 15;
    wrap.innerHTML = `
      <p class="guest-unlock-eyebrow">You're only seeing a preview</p>
      <h3 class="guest-unlock-title">${count > 0 ? `${count} earlier messages hidden` : 'Full history hidden'}</h3>
      <p class="guest-unlock-copy">Sign in free to read the full conversation, upload files, pin messages, and join private rooms.</p>
      <div class="guest-unlock-actions">
        <button type="button" class="pill-btn pill-accent guest-unlock-btn" data-action="signin">Sign in free</button>
      </div>`;
    wrap.querySelector('[data-action="signin"]').addEventListener('click', () => showAccessGate());
    return wrap;
  }

  function appendDecoyMessage(payload) {
    const message = document.createElement('article');
    message.className = 'message them decoy-preview';
    message.setAttribute('aria-hidden', 'true');

    const body = document.createElement('div');
    body.className = 'message-body';
    body.textContent = payload.text || '';

    const meta = document.createElement('div');
    meta.className = 'message-meta';
    const sender = document.createElement('span');
    sender.textContent = payload.senderName || 'Someone';
    const time = document.createElement('span');
    time.textContent = state.preferences.showTimestamps ? formatTime(payload.ts) : '';
    time.hidden = !state.preferences.showTimestamps;
    meta.append(sender, time);
    message.append(body, meta);
    elements.messages.appendChild(message);
  }

  function renderHistory(payload) {
    const data = Array.isArray(payload)
      ? { messages: payload, decoys: [], isGuest: false, hiddenCount: 0 }
      : (payload || { messages: [], decoys: [], isGuest: false, hiddenCount: 0 });

    state.lastHistory = data;
    state.isGuest = Boolean(data.isGuest);
    state.guestHiddenCount = data.hiddenCount || 0;
    elements.messages.replaceChildren();
    state.messageIds.clear();

    if (state.isGuest && data.decoys?.length) {
      data.decoys.forEach((msg) => appendDecoyMessage(msg));
      elements.messages.appendChild(renderGuestUnlockCta(data.hiddenCount));
    }

    data.messages.forEach((msg) => {
      appendMessage(msg, isOwnMessage(msg) ? 'me' : 'them', false);
    });

    if (state.isGuest) {
      elements.inviteBtn.hidden = true;
      if (elements.adminLink) elements.adminLink.hidden = true;
    }

    staggerIn(elements.messages, '.message:not(.decoy-preview)');
    elements.messages.scrollTop = elements.messages.scrollHeight;
  }

  function refreshHistoryAlignment() {
    if (state.lastHistory) renderHistory(state.lastHistory);
  }

  function appendMessage(payload, type = 'them', shouldAnimate = true) {
    if (payload.decoy) {
      appendDecoyMessage(payload);
      return;
    }
    if (state.messageIds.has(payload.id)) return;
    state.messageIds.add(payload.id);

    const own = type === 'me' || isOwnMessage(payload);
    const message = document.createElement('article');
    message.className = `message${own ? ' me' : ' them'}${shouldAnimate ? ' message-enter' : ''}`;

    const body = document.createElement('div');
    body.className = 'message-body';
    if (payload.text) body.textContent = payload.text;
    if (payload.file) renderAttachment(body, payload.file);

    const meta = document.createElement('div');
    meta.className = 'message-meta';
    const sender = document.createElement('span');
    sender.textContent = own ? 'You' : (payload.senderName || 'Guest');
    const time = document.createElement('span');
    time.textContent = state.preferences.showTimestamps ? formatTime(payload.ts) : '';
    time.hidden = !state.preferences.showTimestamps;
    const pinButton = document.createElement('button');
    pinButton.type = 'button';
    pinButton.className = 'pin-button';
    pinButton.textContent = 'Pin';
    pinButton.hidden = !can(state, 'MANAGE_MESSAGES') || state.isGuest;
    pinButton.addEventListener('click', () => {
      if (state.socket?.connected && state.user) {
        state.socket.emit('pinMessage', { room: state.activeRoom, messageId: payload.id });
      }
    });
    meta.append(sender, time, pinButton);
    message.append(body, meta);
    elements.messages.appendChild(message);
    elements.messages.scrollTop = elements.messages.scrollHeight;
    if (shouldAnimate && motionOk) {
      motion(message, { opacity: [0, 1], y: [own ? 10 : 18, 0], x: [own ? 12 : -8, 0] }, { duration: 0.42, easing: spring() });
    }
  }

  function handleIncomingMessage(msg) {
    const own = isOwnMessage(msg);
    if (msg.room && msg.room !== state.activeRoom) {
      state.unread[msg.room] = (state.unread[msg.room] || 0) + 1;
      state.lastSender = msg.senderName || 'Someone';
      if (state.lastRoomList.length) renderRoomList(state.lastRoomList);
      playReceiveSound(state.preferences.soundEnabled);
      notifyDesktop({
        enabled: state.preferences.desktopNotifications,
        title: `${msg.senderName || 'Someone'} · ${msg.room}`,
        body: msg.text || 'New message',
      });
      showToast(`${msg.senderName} · ${msg.room}`, 'info');
      updateDocumentTitle({
        appName: state.appName,
        unread: totalUnread(),
        lastSender: state.lastSender,
      });
      return;
    }
    appendMessage(msg, own ? 'me' : 'them');
    if (!own) {
      playReceiveSound(state.preferences.soundEnabled);
      state.lastSender = msg.senderName || 'Someone';
      if (document.visibilityState !== 'visible') {
        notifyDesktop({
          enabled: state.preferences.desktopNotifications,
          title: msg.senderName || 'New message',
          body: msg.text || 'Sent a message',
        });
      }
    }
    updateDocumentTitle({ appName: state.appName, unread: totalUnread(), lastSender: state.lastSender });
  }

  function handleAuthSuccess(data) {
    lockoutUiActive = false;
    state.isGuest = false;
    state.user = { id: data.id, username: data.username, isSuperAdmin: data.isSuperAdmin };
    state.sessionToken = data.token;
    persistSession(data.token, data.username);
    updateUserChip(data.displayName || data.username);
    updateAuthChrome();
    showToast(`Welcome, ${data.username}`, 'success');
    refreshStorage();
    refreshCustomEmojis();
    updateInviteButton();
    fetch('/api/gate/ack', {
      method: 'POST',
      credentials: 'include',
      headers: { Authorization: `Bearer ${data.token}` },
    }).catch(() => {});
    apiProfile(data.token, '/api/profile').then(({ profile }) => {
      state.profile = profile;
      applyPreferences({ ...state.preferences, ...profile.preferences });
      updateUserChip(profile.displayName || profile.username);
    }).catch(() => {});
    if (state.socket?.connected) {
      state.socket.emit('requestHistory', { room: state.activeRoom });
    } else {
      refreshHistoryAlignment();
    }
  }

  function handleLoggedOut() {
    updateUserChip('Guest');
    if (elements.adminLink) elements.adminLink.hidden = true;
    elements.inviteBtn.hidden = true;
    showToast('Signed out', 'info');
    leaveToGate('signedout=1');
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
    goToChatPanel();
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

  function buildSocketAuth() {
    const saved = readSession();
    if (saved?.token) return { sessionToken: saved.token };
    return { guestName: readGuestName() || '' };
  }

  function wireChatHandlers(socket) {
    socket.on('gateRequired', () => {
      state.appStarted = false;
      showAccessGate();
    });
    socket.on('connect', () => {
      connectErrorNotified = false;
      updateStatus('Live', '#8fae98');
      if (state.chatTransport !== 'http') {
        socket.emit('requestRoomList');
        const saved = readSession();
        if (saved?.token) {
          socket.emit('restoreSession', { token: saved.token });
        } else {
          state.isGuest = true;
          syncGuestDisplayName();
          updateAuthChrome();
        }
      } else {
        state.isGuest = !readSession()?.token;
        if (state.isGuest) syncGuestDisplayName();
        updateAuthChrome();
      }
      refreshStorage();
    });

    socket.on('connect_error', (err) => {
      updateStatus('Offline', '#c98b8b');
      if (!connectErrorNotified) {
        connectErrorNotified = true;
        showToast('Cannot reach chat server. Check connection or try again shortly.', 'error');
      }
      console.error('Socket connect_error:', err?.message || err);
    });
    socket.on('disconnect', () => updateStatus('Away', '#c98b8b'));
    socket.on('reconnect_attempt', () => updateStatus('Returning', '#c9a227'));
    socket.on('reconnect', () => {
      updateStatus('Live', '#8fae98');
      if (socket.auth) socket.auth = buildSocketAuth();
      socket.emit('requestRoomList');
      const saved = readSession();
      if (saved?.token) socket.emit('restoreSession', { token: saved.token });
      else syncGuestDisplayName();
    });

    socket.on('authSuccess', handleAuthSuccess);
    socket.on('loggedOut', handleLoggedOut);
    socket.on('sessionExpired', () => {
      showToast('Session expired — sign in again.', 'error');
      leaveToGate();
    });
    socket.on('accountLocked', (payload) => {
      applyAccountLockout(payload || {});
    });

    socket.on('roomlist', (rooms) => {
      state.lastRoomList = rooms;
      renderRoomList(rooms);
      updateInviteButton();
    });
    socket.on('userlist', renderUserList);
    socket.on('displayNameSet', ({ name }) => {
      updateUserChip(name);
      persistGuestName(name);
    });

    socket.on('history', (payload) => {
      renderHistory(payload);
    });
    socket.on('message', (msg) => {
      handleIncomingMessage(msg);
    });
    socket.on('pinned', renderPinnedList);
    socket.on('roomJoined', ({ roomName, type }) => handleRoomChange(roomName, type));
    socket.on('roomError', (payload) => showToast(payload?.reason || 'Room error', 'error'));
    socket.on('inviteSuccess', (payload) => {
      elements.inviteNote.textContent = `${payload.username} invited to ${payload.room}.`;
      elements.inviteNote.className = 'form-status';
      showToast(`Invited ${payload.username}`, 'success');
    });
    socket.on('inviteError', (payload) => {
      elements.inviteNote.textContent = payload.reason || 'Invite failed.';
      elements.inviteNote.className = 'form-error';
      showToast(payload.reason || 'Invite failed.', 'error');
    });
    socket.on('activityHistory', renderActivityLog);
    socket.on('roomRoles', applyRoomRoles);
    socket.on('roleError', (p) => showToast(p.reason || 'Role error', 'error'));
    socket.on('roleSuccess', (p) => showToast(`Role ${p.action}`, 'success'));
    socket.on('activityLog', (row) => {
      if (row.room === state.activeRoom) {
        const item = document.createElement('div');
        item.className = 'activity-item';
        item.innerHTML = `<div class="activity-event">${escapeText(row.event.replace(/\./g, ' '))}</div><div>${escapeText(formatActivity(row))}</div><div>${formatTime(row.ts)}</div>`;
        if (elements.activityLog.querySelector('.empty-state')) elements.activityLog.replaceChildren();
        elements.activityLog.prepend(item);
      }
    });
  }

  async function loadSocketIoClient() {
    if (window.io) return;
    await new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = '/socket.io/socket.io.min.js';
      script.onload = resolve;
      script.onerror = () => reject(new Error('Socket.IO client failed to load'));
      document.head.appendChild(script);
    });
  }

  async function initChatTransport() {
    if (state.chatTransport === 'http') {
      state.socket = createHttpChat();
      wireChatHandlers(state.socket);
      await state.socket.connect();
      return;
    }
    await loadSocketIoClient();
    state.socket = window.io(createSocketOptions({
      auth: buildSocketAuth(),
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 1000,
    }));
    wireChatHandlers(state.socket);
  }

  function bindEvents() {
    elements.roomList.addEventListener('click', (event) => {
      const item = event.target.closest('.room-item');
      if (!item) return;
      const roomName = item.dataset.room;
      if (roomName === state.activeRoom || item.dataset.joinable !== 'true') return;
      state.socket.emit('joinRoom', roomName);
      state.unread[roomName] = 0;
      goToChatPanel();
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
    elements.moderationOk?.addEventListener('click', () => {
      hideModal(elements.moderationDialog);
      if (lockoutUiActive) leaveToGate('locked=1');
    });
    elements.moderationDialog?.addEventListener('cancel', (e) => {
      e.preventDefault();
      hideModal(elements.moderationDialog);
      if (lockoutUiActive) leaveToGate('locked=1');
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

    elements.signinBtn?.addEventListener('click', async () => {
      clearSession();
      state.appStarted = false;
      state.gateMode = null;
      if (state.socket) {
        state.socket.disconnect();
        state.socket = null;
      }
      await clearGateAccess();
      await showAccessGate();
    });
    elements.guestSettingsClose?.addEventListener('click', () => hideModal(elements.guestSettingsDialog));
    elements.guestSettingsSave?.addEventListener('click', saveGuestSettings);
    elements.guestChatRandom?.addEventListener('click', () => {
      elements.guestChatName.value = randomGuestName();
    });
    elements.guestSettingsSignin?.addEventListener('click', async () => {
      clearSession();
      state.appStarted = false;
      if (state.socket) {
        state.socket.disconnect();
        state.socket = null;
      }
      await clearGateAccess();
      hideModal(elements.guestSettingsDialog);
      await showAccessGate();
    });
    elements.guestSettingsDialog?.addEventListener('cancel', (e) => {
      e.preventDefault();
      hideModal(elements.guestSettingsDialog);
    });

    elements.logoutBtn.addEventListener('click', () => {
      if (state.socket?.connected) state.socket.emit('logout');
      else leaveToGate('signedout=1');
    });

    elements.chatForm.addEventListener('submit', (event) => {
      event.preventDefault();
      const text = elements.chatInput.value.trim();
      if (!text || !state.socket?.connected) return;
      if (!can(state, 'SEND_MESSAGES')) return showToast('Missing permission: Send Messages', 'error');
      state.socket.emit('message', { text, type: 'text' });
      playSendSound(state.preferences.sendSoundEnabled);
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

    document.addEventListener('click', (e) => {
      if (!state.pickerOpen) return;
      if (elements.picker.contains(e.target) || elements.emojiBtn.contains(e.target)) return;
      togglePicker(false);
    });
  }

  function startChatApp() {
    if (state.appStarted) return;
    state.appStarted = true;
    updateAuthChrome();
    initChatTransport();
    bindEvents();
    renderPicker();
    refreshStorage();
    refreshCustomEmojis();
  }

  document.addEventListener('DOMContentLoaded', async () => {
    applyPreferences(loadLocalPreferences());
    primeAudioOnGesture();
    const pubCfg = await loadPublicConfig();
    state.appName = pubCfg?.appName || 'Cadence';
    state.chatTransport = pubCfg?.chatTransport || 'socket';
    startTitlePulse(() => ({
      appName: state.appName,
      unreadTotal: totalUnread(),
      lastSender: state.lastSender,
      titleNotifications: state.preferences.titleNotifications,
    }));
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        updateDocumentTitle({ appName: state.appName, unread: 0 });
      }
    });
    initAmbient();
    introReveal();
    initSidebar();
    initUploadUi();
    mobilePanels = initMobilePanels();

    const gateResult = await initAccessGate({
      onGranted(mode) {
        state.gateMode = mode;
        startChatApp();
      },
    });
    if (gateResult.granted) {
      state.gateMode = gateResult.mode;
      startChatApp();
    }

    window.addEventListener('cadence:show-gate', (event) => {
      showAccessGate(event.detail || {});
    });
  });
})();
