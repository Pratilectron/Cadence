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
  let pollTimer = null;
  let cursor = 0;
  let currentRoom = null;
  let closed = false;
  let metaCounter = 0;
  const seenMessageIds = new Set();

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
      if (event === 'restoreSession') return Promise.resolve();
      if (event === 'requestHistory') return api.refreshHistory(data?.room);
      return undefined;
    },
    disconnect() {
      closed = true;
      api.connected = false;
      if (pollTimer) window.clearInterval(pollTimer);
      pollTimer = null;
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
      fire('roomJoined', { roomName: data.room, type: 'public' });
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
      fire('connect');
      fire('history', data.history);
      fire('pinned', data.pinned || []);
      fire('roomlist', data.roomlist || []);
      fire('userlist', data.userlist || []);
      if (data.activityHistory) fire('activityHistory', data.activityHistory);
      if (!pollTimer) {
        pollTimer = window.setInterval(() => pollOnce(false), 2500);
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

  async function pollOnce(forceMeta) {
    if (closed || !currentRoom) return;
    const includeMeta = forceMeta || metaCounter % 5 === 0;
    metaCounter += 1;
    const qs = new URLSearchParams({
      since: String(cursor || 0),
      room: currentRoom,
      ...(includeMeta ? { meta: '1' } : {}),
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
        return;
      }
      api.connected = true;
      for (const message of data.messages || []) {
        deliverMessage(message);
      }
      if (data.roomlist) fire('roomlist', data.roomlist);
      if (data.userlist) fire('userlist', data.userlist);
      if (data.pinned) fire('pinned', data.pinned);
    } catch (err) {
      api.connected = false;
      fire('connect_error', err);
    }
  }

  return api;
}
