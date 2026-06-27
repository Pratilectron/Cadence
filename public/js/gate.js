import {
  SESSION_KEY,
  CHAT_PATH,
  persistSession,
  readSession,
  clearSession,
} from './session.js';
import { persistGuestName } from './preferences.js';
import { randomGuestName, sanitizeGuestNameInput } from './guest-names.js';

const $ = (id) => document.getElementById(id);

const elements = {
  authModeButton: $('auth-mode-button'),
  authTitle: $('auth-title'),
  authSubmit: $('auth-submit'),
  authForm: $('auth-form'),
  authUsername: $('auth-username'),
  authPassword: $('auth-password'),
  authError: $('auth-error'),
  gateStatus: $('gate-status'),
  gateCopy: $('gate-copy'),
  guestDivider: $('guest-divider'),
  guestNameBlock: $('guest-name-block'),
  guestNameInput: $('guest-name-input'),
  guestRandomName: $('guest-random-name'),
  guestContinue: $('guest-continue'),
  guestNote: $('guest-note'),
};

let socket = null;
let authMode = 'login';
let enteringChat = false;
let appConfig = {
  guestChatEnabled: true,
  registrationEnabled: true,
};

const fetchOpts = { credentials: 'include' };

function setStatus(text, isError = false) {
  if (!text) {
    elements.gateStatus.hidden = true;
    elements.gateStatus.textContent = '';
    return;
  }
  elements.gateStatus.hidden = false;
  elements.gateStatus.textContent = text;
  elements.gateStatus.className = isError ? 'form-error gate-page-status' : 'form-status gate-page-status';
}

function setAuthMode(mode) {
  authMode = mode;
  const isLogin = mode === 'login';
  elements.authTitle.textContent = isLogin ? 'Sign in' : 'Create account';
  elements.authSubmit.textContent = isLogin ? 'Sign in' : 'Register';
  elements.authModeButton.textContent = isLogin ? 'Create account' : 'Sign in';
  elements.authPassword.autocomplete = isLogin ? 'current-password' : 'new-password';
  elements.authError.textContent = '';
}

function applyPublicConfig(config) {
  appConfig = { ...appConfig, ...config };
  const guestOn = Boolean(appConfig.guestChatEnabled);
  const regOn = Boolean(appConfig.registrationEnabled);
  elements.guestNameBlock.hidden = !guestOn;
  elements.guestDivider.hidden = !guestOn;
  elements.authModeButton.hidden = !regOn;
  if (!guestOn && !regOn) {
    elements.gateCopy.textContent = 'Sign in to enter Cadence.';
  }

  if (config.moderationLockedOut) {
    const mins = config.moderationLockoutMinutes || 10;
    elements.authForm.hidden = true;
    elements.guestNameBlock.hidden = true;
    elements.guestDivider.hidden = true;
    elements.authModeButton.hidden = true;
    elements.authError.textContent = `Uploads are blocked for ${mins} minute${mins === 1 ? '' : 's'} on this browser and connection. Clearing cookies or refreshing will not lift the block.`;
    setStatus('');
  }
}

async function loadPublicConfig() {
  try {
    const res = await fetch('/api/public-config', fetchOpts);
    if (res.ok) applyPublicConfig(await res.json());
  } catch {
    // keep defaults
  }
}

async function acknowledgeUserGate(token) {
  const res = await fetch('/api/gate/ack', {
    ...fetchOpts,
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || 'Could not open chat.');
  }
}

async function enterChat() {
  if (enteringChat) return;
  enteringChat = true;
  window.location.assign(CHAT_PATH);
}

async function completeAuth(data) {
  persistSession(data.token, data.username);
  await acknowledgeUserGate(data.token);
  await enterChat();
}

function resetAuthUi(message = '') {
  elements.authForm.hidden = false;
  applyPublicConfig(appConfig);
  elements.authSubmit.disabled = false;
  elements.authSubmit.classList.remove('is-loading');
  enteringChat = false;
  if (message) {
    elements.authError.textContent = message;
    setStatus('Session found but chat access could not be restored. Sign in again.', true);
  } else {
    setStatus('');
  }
}

function waitForAuthResult(timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      cleanup();
      reject(new Error('Request timed out. Try again.'));
    }, timeoutMs);

    function cleanup() {
      window.clearTimeout(timer);
      socket.off('authSuccess', onSuccess);
      socket.off('authError', onError);
      socket.off('accountLocked', onLocked);
      socket.off('sessionExpired', onExpired);
    }

    function onSuccess(payload) {
      cleanup();
      resolve(payload);
    }

    function onError(payload) {
      cleanup();
      reject(new Error(payload?.message || 'Authentication failed.'));
    }

    function onLocked(payload) {
      cleanup();
      reject(new Error(payload?.message || 'Account temporarily suspended.'));
    }

    function onExpired() {
      cleanup();
      reject(new Error('Session expired. Sign in again.'));
    }

    socket.once('authSuccess', onSuccess);
    socket.once('authError', onError);
    socket.once('accountLocked', onLocked);
    socket.once('sessionExpired', onExpired);
  });
}

async function continueAsGuest() {
  const name = sanitizeGuestNameInput(elements.guestNameInput.value);
  elements.guestNameInput.value = name;
  persistGuestName(name);
  setStatus('Opening chat…');
  elements.guestContinue.disabled = true;
  elements.guestContinue.classList.add('is-loading');
  try {
    const res = await fetch('/api/gate/guest', {
      ...fetchOpts,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ displayName: name }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Guest access is unavailable.');
    if (data.displayName) persistGuestName(data.displayName);
    await enterChat();
  } catch (err) {
    setStatus(err.message, true);
    elements.guestContinue.disabled = false;
    elements.guestContinue.classList.remove('is-loading');
  }
}

function initSocket() {
  return new Promise((resolve) => {
    socket = io({ transports: ['polling', 'websocket'] });

    socket.on('connect', () => {
      setStatus('');
      resolve();
    });
    socket.on('connect_error', () => {
      setStatus('Could not reach the server. Try again shortly.', true);
    });

    socket.on('sessionExpired', () => {
      clearSession();
      resetAuthUi();
    });
  });
}

async function tryRestoreSession() {
  const saved = readSession();
  if (!saved?.token) return false;

  setStatus('Restoring your session…');
  elements.authForm.hidden = true;
  elements.guestNameBlock.hidden = true;
  elements.guestDivider.hidden = true;

  try {
    socket.emit('restoreSession', { token: saved.token });
    const data = await waitForAuthResult();
    await completeAuth(data);
    return true;
  } catch (err) {
    clearSession();
    resetAuthUi(err.message);
    return false;
  }
}

async function submitAuth(username, password) {
  if (!socket?.connected) {
    elements.authError.textContent = 'Not connected to server.';
    return;
  }

  elements.authError.textContent = '';
  elements.authSubmit.disabled = true;
  elements.authSubmit.classList.add('is-loading');

  try {
    socket.emit(authMode === 'login' ? 'login' : 'register', { username, password });
    const data = await waitForAuthResult();
    await completeAuth(data);
  } catch (err) {
    clearSession();
    elements.authError.textContent = err.message || 'Authentication failed.';
    elements.authSubmit.disabled = false;
    elements.authSubmit.classList.remove('is-loading');
    enteringChat = false;
  }
}

function bindEvents() {
  elements.authModeButton.addEventListener('click', () => {
    setAuthMode(authMode === 'login' ? 'register' : 'login');
  });

  elements.authForm.addEventListener('submit', (event) => {
    event.preventDefault();
    const username = elements.authUsername.value.trim();
    const password = elements.authPassword.value;
    if (!username || !password) return;
    submitAuth(username, password);
  });

  elements.guestRandomName.addEventListener('click', () => {
    elements.guestNameInput.value = randomGuestName();
  });

  elements.guestContinue.addEventListener('click', continueAsGuest);
}

function readQueryMessage() {
  const params = new URLSearchParams(window.location.search);
  if (params.get('signedout') === '1') {
    setStatus('Signed out.');
  }
  if (params.get('locked') === '1') {
    elements.authError.textContent = 'Your account is temporarily suspended. Try again later.';
  }
}

document.addEventListener('DOMContentLoaded', async () => {
  readQueryMessage();
  await loadPublicConfig();
  if (appConfig.moderationLockedOut) {
    bindEvents();
    return;
  }
  setAuthMode('login');
  elements.guestNameInput.value = randomGuestName();

  const saved = readSession();
  if (saved?.username) elements.authUsername.value = saved.username;

  await initSocket();
  bindEvents();
  await tryRestoreSession();
});
