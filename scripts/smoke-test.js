const { join } = require('path');
const { io } = require(join(__dirname, '..', 'node_modules/socket.io/client-dist/socket.io.js'));

function client() {
  return io('http://localhost:3000', { transports: ['websocket'] });
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

    const res = await fetch('http://localhost:3000/api/upload', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${auth.token}`,
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
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
    const res = await fetch('http://localhost:3000/api/logs?room=General&limit=5');
    const data = await res.json();
    results.push(['activity logs', Array.isArray(data.logs) && data.logs.length > 0]);
  }

  {
    const res = await fetch('http://localhost:3000/api/storage');
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
