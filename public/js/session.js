export const SESSION_KEY = 'cadence_session';
export const CHAT_PATH = '/';

export function persistSession(token, username) {
  const payload = JSON.stringify({ token, username });
  localStorage.setItem(SESSION_KEY, payload);
  try {
    sessionStorage.removeItem(SESSION_KEY);
  } catch {
    // ignore
  }
}

export function readSession() {
  try {
    let raw = localStorage.getItem(SESSION_KEY);
    if (!raw) {
      raw = sessionStorage.getItem(SESSION_KEY);
      if (raw) {
        localStorage.setItem(SESSION_KEY, raw);
        sessionStorage.removeItem(SESSION_KEY);
      }
    }
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function clearSession() {
  localStorage.removeItem(SESSION_KEY);
  try {
    sessionStorage.removeItem(SESSION_KEY);
  } catch {
    // ignore
  }
}

export async function clearGateAccess() {
  try {
    await fetch('/api/gate/clear', { method: 'POST', credentials: 'include' });
  } catch {
    // ignore network errors during sign-out redirect
  }
}

export function redirectToGate(params = '') {
  const detail = {};
  const query = params.startsWith('?') ? params.slice(1) : params;
  const search = new URLSearchParams(query);
  if (search.get('signedout') === '1') detail.signedOut = true;
  if (search.get('locked') === '1') detail.locked = true;
  window.dispatchEvent(new CustomEvent('cadence:show-gate', { detail }));
}
