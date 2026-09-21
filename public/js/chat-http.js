import { readGuestName } from './preferences.js';
import { readSession } from './session.js';

const fetchOpts = { credentials: 'include' };

function authHeaders() {
  const saved = readSession();
  if (saved?.token) return { Authorization: `Bearer ${saved.token}` };
  return {};
}

export function createHttpChat() {
  const handlers = new Map();
  let cursor = 0;
  let currentRoom = null;
  let closed = false;
  let polling = false;
  const seenMessageIds = new Set();
  const metaSnap = { roomlist: '', userlist: '', pinned: '', roomRoles: '' };

  const api = {
    connected: false,
    auth: {},
    on(event, fn) {
      if (!handlers.has(event)) handlers.set(event, new Set());
      handlers.get(event).add(fn);
      return api;
    },
    off(event, fn) {
      handlers.get(event)?.delete(fn);
      return api;
    },
    once(event, fn) {
      const wrapper = (...args) => {
        api.off(event, wrapper);
        fn(...args);
      };
      return api.on(event, wrapper);
    },
    emit(event, data) {
      if (event === 'requestRoomList') return api.refreshMeta();
      if (event === 'joinRoom') return api.joinRoom(data);
      if (event === 'message') return api.sendMessage(data);
      if (event === 'deleteMessage') return api.deleteMessage(data);
      if (event === 'restoreSession') return Promise.resolve();
      if (event === 'requestHistory') return api.refreshHistory(data?.room);
      return undefined;
    },
    disconnect() {
      closed = true;
      api.connected = false;
    },
    async joinRoom(roomName) {
      const res = await fetch('/api/chat/join', {
        ...fetchOpts,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ room: roomName }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        fire('roomError', { room: roomName, reason: data.error || 'Could not join room.' });
        return;
      }
      currentRoom = data.room;
      rememberHistory(data.history?.messages);
      fire('roomJoined', { roomName: data.room, type: data.roomType || 'public' });
      if (data.roomRoles) fire('roomRoles', data.roomRoles);
      fire('history', data.history);
      fire('pinned', data.pinned || []);
      fire('userlist', data.userlist || []);
      fire('roomlist', data.roomlist || []);
    },
    async sendMessage(msg) {
      const res = await fetch('/api/chat/message', {
        ...fetchOpts,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({
          ...msg,
          room: currentRoom,
          guestName: readGuestName(),
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        fire('roomError', { reason: data.error || 'Message not sent.' });
        return;
      }
      if (data.message) deliverMessage(data.message);
    },
    async deleteMessage(msg) {
      const res = await fetch('/api/chat/message/action', {
        ...fetchOpts,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({
          ...msg,
          room: msg?.room || currentRoom,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        fire('messageActionError', { reason: data.error || 'Could not update that message.' });
        return;
      }
      if (data.message?.hidden || data.message?.purged) {
        fire('messageRemoved', { id: data.message.id });
        return;
      }
      if (data.message) fire('messageUpdated', data.message);
    },
    async refreshMeta() {
      await pollOnce(true);
    },
    async refreshHistory(room) {
      if (room) currentRoom = room;
      await pollOnce(true);
    },
    async connect() {
      if (closed) return;
      const res = await fetch('/api/chat/hello', {
        ...fetchOpts,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ guestName: readGuestName() }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        fire('connect_error', new Error(data.error || 'Chat unavailable'));
        return;
      }
      currentRoom = data.room;
      rememberHistory(data.history?.messages);
      if (!cursor) cursor = Date.now();
      api.connected = true;
      const saved = readSession();
      if (saved?.token) {
        const restored = await fetch('/api/auth/restore', {
          ...fetchOpts,
          method: 'POST',
          headers: { Authorization: `Bearer ${saved.token}` },
        });
        const auth = await restored.json().catch(() => ({}));
        if (restored.ok) fire('restoredSession', auth);
        else if (restored.status === 401) fire('sessionExpired');
      }
      fire('connect');
      fire('roomJoined', { roomName: data.room, type: data.roomType || 'public' });
      if (data.roomRoles) fire('roomRoles', data.roomRoles);
      fire('history', data.history);
      fire('pinned', data.pinned || []);
      fire('roomlist', data.roomlist || []);
      fire('userlist', data.userlist || []);
      if (data.activityHistory) fire('activityHistory', data.activityHistory);
      if (!polling) {
        polling = true;
        pollLoop();
      }
    },
  };

  function rememberHistory(messages = []) {
    for (const message of messages) {
      if (message?.id) seenMessageIds.add(message.id);
      if (message?.ts) cursor = Math.max(cursor, message.ts);
    }
  }

  function deliverMessage(message) {
    if (!message?.id || seenMessageIds.has(message.id)) return;
    seenMessageIds.add(message.id);
    if (message.ts) cursor = Math.max(cursor, message.ts);
    fire('message', message);
  }

  function fire(event, ...args) {
    const set = handlers.get(event);
    if (!set) return;
    for (const fn of set) {
      try { fn(...args); } catch (err) { console.error(`chat-http ${event}:`, err); }
    }
  }

  function fireIfChanged(key, event, value) {
    if (value == null) return;
    const snap = JSON.stringify(value);
    if (snap === metaSnap[key]) return;
    metaSnap[key] = snap;
    fire(event, value);
  }

  async function pollLoop() {
    while (!closed) {
      await pollOnce(false);
      if (closed) break;
    }
    polling = false;
  }

  async function pollOnce(forceMeta) {
    if (closed || !currentRoom) return;
    const qs = new URLSearchParams({
      since: String(cursor || 0),
      room: currentRoom,
      wait: '1',
      meta: '1',
    });
    try {
      const res = await fetch(`/api/chat/poll?${qs}`, {
        ...fetchOpts,
        headers: authHeaders(),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        api.connected = false;
        fire('connect_error', new Error(data.error || 'Poll failed'));
        await new Promise((resolve) => window.setTimeout(resolve, 2000));
        return;
      }
      api.connected = true;
      for (const message of data.messages || []) {
        if (message?.hidden || message?.purged) {
          if (message.id) seenMessageIds.add(message.id);
          fire('messageRemoved', { id: message.id });
          continue;
        }
        if (message?.id && seenMessageIds.has(message.id)) {
          fire('messageUpdated', message);
          continue;
        }
        deliverMessage(message);
      }
      if (Number(data.cursor) > cursor) cursor = Number(data.cursor);
      fireIfChanged('roomlist', 'roomlist', data.roomlist);
      fireIfChanged('userlist', 'userlist', data.userlist);
      fireIfChanged('pinned', 'pinned', data.pinned);
      fireIfChanged('roomRoles', 'roomRoles', data.roomRoles);
    } catch (err) {
      api.connected = false;
      fire('connect_error', err);
      await new Promise((resolve) => window.setTimeout(resolve, 2000));
    }
  }

  return api;
}
