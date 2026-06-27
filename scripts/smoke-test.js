const { join } = require('path');
const { io } = require(join(__dirname, '..', 'node_modules/socket.io/client-dist/socket.io.js'));

const BASE_URL = process.env.TEST_URL || `http://127.0.0.1:${process.env.PORT || 3000}`;

const cookies = new Map();

function mergeCookies(res) {
  const lines = typeof res.headers.getSetCookie === 'function'
    ? res.headers.getSetCookie()
    : [];
  const single = res.headers.get('set-cookie');
  const all = lines.length ? lines : (single ? [single] : []);
  for (const line of all) {
    const part = line.split(';')[0];
    const eq = part.indexOf('=');
    if (eq > 0) cookies.set(part.slice(0, eq), part.slice(eq + 1));
  }
}

function cookieHeader() {
  if (!cookies.size) return {};
  return { Cookie: [...cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ') };
}

async function ensureGuestGate() {
  const statusRes = await fetch(`${BASE_URL}/api/gate/status`, { headers: cookieHeader() });
  mergeCookies(statusRes);
  const status = await statusRes.json().catch(() => ({}));
  if (status.granted) return;

  const guestRes = await fetch(`${BASE_URL}/api/gate/guest`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...cookieHeader() },
    body: JSON.stringify({ displayName: 'SmokeTester' }),
  });
  mergeCookies(guestRes);
  if (!guestRes.ok) {
    const data = await guestRes.json().catch(() => ({}));
    throw new Error(data.error || 'Could not obtain guest gate access.');
  }
}

function client() {
  return io(BASE_URL, {
    transports: ['websocket'],
    extraHeaders: cookieHeader(),
  });
}

function once(socket, event, timeout = 8000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timeout: ${event}`)), timeout);
    socket.once(event, (data) => {
      clearTimeout(timer);
      resolve(data);
    });
  });
}

async function register(socket, tag) {
  socket.emit('register', { username: `${tag}_${Date.now()}`, password: 'password123' });
  return once(socket, 'authSuccess');
}

async function run() {
  await ensureGuestGate();
  const results = [];

  {
    const s = client();
    await once(s, 'connect');
    await register(s, 'owner');
    const roomName = `Locked_${Date.now()}`;
    s.emit('createRoom', { name: roomName, type: 'locked' });
    const joined = await once(s, 'roomJoined');
    results.push(['owner creates locked room', joined.roomName === roomName]);
    s.close();
  }

  {
    const s = client();
    await once(s, 'connect');
    await register(s, 'msg');
    s.emit('message', { text: 'hello', type: 'text' });
    const msg = await once(s, 'message');
    results.push(['text message', msg.text === 'hello']);
    s.close();
  }

  {
    const auth = await (async () => {
      const s = client();
      await once(s, 'connect');
      return register(s, 'up');
    })();

    const boundary = '----testboundary';
    const body = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="test.txt"\r\nContent-Type: text/plain\r\n\r\nhello file\r\n--${boundary}--\r\n`;

    const res = await fetch(`${BASE_URL}/api/upload`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${auth.token}`,
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        ...cookieHeader(),
      },
      body,
    });
    const data = await res.json();
    results.push(['file upload', res.status === 201 && data.file?.id]);

    const s = client();
    await once(s, 'connect');
    s.emit('restoreSession', { token: auth.token });
    await once(s, 'authSuccess');
    s.emit('message', { type: 'file', fileId: data.file.id, text: 'see file' });
    const msg = await once(s, 'message');
    results.push(['file message', msg.file?.id === data.file.id]);
    s.close();
  }

  {
    const res = await fetch(`${BASE_URL}/api/logs?room=General&limit=5`, { headers: cookieHeader() });
    const data = await res.json();
    results.push(['activity logs', Array.isArray(data.logs) && data.logs.length > 0]);
  }

  {
    const res = await fetch(`${BASE_URL}/api/storage`, { headers: cookieHeader() });
    const data = await res.json();
    results.push(['storage stats', data.maxBytes === 20 * 1024 ** 3]);
  }

  let failed = 0;
  for (const [name, ok] of results) {
    console.log(ok ? 'PASS' : 'FAIL', name);
    if (!ok) failed += 1;
  }
  process.exit(failed ? 1 : 0);
}

run().catch((err) => {
  console.error('ERROR', err.message);
  process.exit(1);
});
