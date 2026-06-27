const fetchOpts = { credentials: 'include' };

async function parseAuthResponse(res) {
  const data = await res.json().catch(() => ({}));
  if (data.error === 'session_expired' || (res.status === 401 && data.message)) {
    throw new Error(data.message || 'Session expired. Sign in again.');
  }
  if (data.accountLocked) {
    throw new Error(data.message || 'Account temporarily suspended.');
  }
  if (!res.ok) {
    throw new Error(data.message || data.error || 'Authentication failed.');
  }
  return data;
}

export async function httpLogin(username, password) {
  const res = await fetch('/api/auth/login', {
    ...fetchOpts,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  return parseAuthResponse(res);
}

export async function httpRegister(username, password) {
  const res = await fetch('/api/auth/register', {
    ...fetchOpts,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  return parseAuthResponse(res);
}

export async function httpRestoreSession(token) {
  const res = await fetch('/api/auth/restore', {
    ...fetchOpts,
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  });
  return parseAuthResponse(res);
}
