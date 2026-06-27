import {
  persistSession,
  readSession,
  clearSession,
} from './session.js';
import { persistGuestName } from './preferences.js';
import { randomGuestName, sanitizeGuestNameInput } from './guest-names.js';
import { httpLogin, httpRegister, httpRestoreSession } from './auth-http.js';

const fetchOpts = { credentials: 'include' };

let authMode = 'login';
let appConfig = {
  guestChatEnabled: true,
  registrationEnabled: true,
};
let onGrantedCallback = null;
let gateDialog = null;
let elements = null;

function $(id) {
  return document.getElementById(id);
}

function bindElements() {
  elements = {
    dialog: $('access-gate-dialog'),
    authModeButton: $('gate-auth-mode-button'),
    authTitle: $('gate-auth-title'),
    authSubmit: $('gate-auth-submit'),
    authForm: $('gate-auth-form'),
    authUsername: $('gate-auth-username'),
    authPassword: $('gate-auth-password'),
    authError: $('gate-auth-error'),
    gateStatus: $('gate-gate-status'),
    gateCopy: $('gate-gate-copy'),
    guestZone: $('gate-guest-zone'),
    guestDivider: $('gate-guest-divider'),
    guestNameBlock: $('gate-guest-name-block'),
    guestNameInput: $('gate-guest-name-input'),
    guestRandomName: $('gate-guest-random-name'),
    guestContinue: $('gate-guest-continue'),
  };
  gateDialog = elements.dialog;
}

function setStatus(text, isError = false) {
  if (!elements?.gateStatus) return;
  if (!text) {
    elements.gateStatus.hidden = true;
    elements.gateStatus.textContent = '';
    return;
  }
  elements.gateStatus.hidden = false;
  elements.gateStatus.textContent = text;
  elements.gateStatus.className = isError ? 'form-error gate-page-status' : 'form-status gate-page-status';
}

function updateGuestVisibility() {
  const guestOn = Boolean(appConfig.guestChatEnabled) && authMode === 'login';
  if (elements.guestZone) elements.guestZone.hidden = !guestOn;
}

function setAuthMode(mode) {
  authMode = mode;
  const isLogin = mode === 'login';
  elements.authTitle.textContent = isLogin ? 'Sign in' : 'Create account';
  elements.authSubmit.textContent = isLogin ? 'Sign in' : 'Create account';
  elements.authModeButton.textContent = isLogin ? 'Need an account? Create one' : 'Already have an account? Sign in';
  elements.authPassword.autocomplete = isLogin ? 'current-password' : 'new-password';
  elements.gateCopy.textContent = isLogin
    ? 'Private rooms, pins, and uploads — or browse public rooms as a guest.'
    : 'Pick a username and password to join Cadence.';
  elements.authError.textContent = '';
  updateGuestVisibility();
}

function applyPublicConfig(config) {
  appConfig = { ...appConfig, ...config };
  const regOn = Boolean(appConfig.registrationEnabled);
  elements.authModeButton.hidden = !regOn;
  if (!appConfig.guestChatEnabled && !regOn) {
    elements.gateCopy.textContent = 'Sign in to enter Cadence.';
  }
  updateGuestVisibility();

  if (config.moderationLockedOut) {
    const mins = config.moderationLockoutMinutes || 10;
    elements.authForm.hidden = true;
    if (elements.guestZone) elements.guestZone.hidden = true;
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

async function fetchGateStatus() {
  try {
    const res = await fetch('/api/gate/status', fetchOpts);
    if (!res.ok) return { granted: false };
    return await res.json();
  } catch {
    return { granted: false };
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

function showGateModal() {
  document.body.classList.add('gate-locked');
  if (!gateDialog) return;
  if (typeof gateDialog.showModal === 'function' && !gateDialog.open) {
    gateDialog.showModal();
  }
}

function hideGateModal() {
  document.body.classList.remove('gate-locked');
  if (gateDialog?.open) gateDialog.close();
}

async function completeGranted(mode) {
  hideGateModal();
  if (onGrantedCallback) await onGrantedCallback(mode);
}

async function completeAuth(data) {
  persistSession(data.token, data.username);
  await acknowledgeUserGate(data.token);
  await completeGranted('user');
}

function resetAuthUi(message = '') {
  elements.authForm.hidden = false;
  resetGateFormUi();
  setAuthMode(authMode);
  if (message) {
    elements.authError.textContent = message;
    setStatus('Session found but chat access could not be restored. Sign in again.', true);
  } else {
    setStatus('');
  }
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
    await completeGranted('guest');
  } catch (err) {
    setStatus(err.message, true);
    elements.guestContinue.disabled = false;
    elements.guestContinue.classList.remove('is-loading');
  }
}

async function attemptSessionRestore({ silent = false } = {}) {
  const saved = readSession();
  if (!saved?.token) return false;

  if (!silent) {
    setStatus('Restoring your session…');
    elements.authForm.hidden = true;
    if (elements.guestZone) elements.guestZone.hidden = true;
  }

  try {
    const data = await httpRestoreSession(saved.token);
    await completeAuth(data);
    return true;
  } catch (err) {
    clearSession();
    if (!silent) resetAuthUi(err.message);
    return false;
  }
}

async function submitAuth(username, password) {
  elements.authError.textContent = '';
  elements.authSubmit.disabled = true;
  elements.authSubmit.classList.add('is-loading');

  try {
    const data = authMode === 'login'
      ? await httpLogin(username, password)
      : await httpRegister(username, password);
    await completeAuth(data);
  } catch (err) {
    clearSession();
    elements.authError.textContent = err.message || 'Authentication failed.';
    elements.authSubmit.disabled = false;
    elements.authSubmit.classList.remove('is-loading');
  }
}

function bindGateEvents() {
  if (elements.dialog?.dataset.bound === '1') return;
  elements.dialog.dataset.bound = '1';

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

  gateDialog.addEventListener('cancel', (event) => {
    event.preventDefault();
  });
}

function readQueryMessage() {
  const params = new URLSearchParams(window.location.search);
  if (params.get('signedout') === '1') {
    setStatus('Signed out.');
  }
  if (params.get('locked') === '1') {
    elements.authError.textContent = 'Your account is temporarily suspended. Try again later.';
  }
  if (params.has('signedout') || params.has('locked')) {
    window.history.replaceState({}, '', window.location.pathname);
  }
}

function resetGateFormUi() {
  if (!elements) return;
  elements.authSubmit.disabled = false;
  elements.authSubmit.classList.remove('is-loading');
  elements.guestContinue.disabled = false;
  elements.guestContinue.classList.remove('is-loading');
}

function primeAuthForm() {
  resetGateFormUi();
  setAuthMode('login');
  if (elements.guestNameInput) elements.guestNameInput.value = randomGuestName();
  const saved = readSession();
  if (saved?.username) elements.authUsername.value = saved.username;
}

export async function showAccessGate(detail = {}) {
  bindElements();
  await loadPublicConfig();
  primeAuthForm();
  if (detail.signedOut) setStatus('Signed out.');
  if (detail.locked) {
    elements.authError.textContent = 'Your account is temporarily suspended. Try again later.';
  }
  bindGateEvents();
  showGateModal();
  if (!appConfig.moderationLockedOut) {
    await attemptSessionRestore();
  }
}

export async function initAccessGate({ onGranted } = {}) {
  bindElements();
  onGrantedCallback = onGranted;
  readQueryMessage();
  await loadPublicConfig();
  bindGateEvents();

  const status = await fetchGateStatus();
  const saved = readSession();

  if (status.granted && status.mode === 'guest' && !saved?.token) {
    hideGateModal();
    return { granted: true, mode: 'guest' };
  }

  if (saved?.token) {
    const restored = await attemptSessionRestore({ silent: true });
    if (restored) return { granted: true, mode: 'user' };
  }

  if (status.granted) {
    hideGateModal();
    return { granted: true, mode: status.mode || 'guest' };
  }

  if (appConfig.moderationLockedOut) {
    primeAuthForm();
    showGateModal();
    return { granted: false };
  }

  primeAuthForm();
  showGateModal();
  await attemptSessionRestore();
  return { granted: false };
}
