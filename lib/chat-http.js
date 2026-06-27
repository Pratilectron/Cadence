const { hasGateAccess } = require('./access-gate');
const { ensureDeviceCookie } = require('./client-identity');
const { buildDecoyMessages, sanitizeGuestName } = require('./guest-content');
const { readActivity } = require('./activity');
const { getDisplayRole, hasPermission } = require('./roles');

function jsonError(res, jsonResponse, status, message) {
  jsonResponse(res, status, { error: message });
}

function resolveChatUser(req, ctx) {
  const token = ctx.getTokenFromReq(req);
  if (token) {
    const user = ctx.getSessionUser(token);
    if (user) return { ...user, isGuest: false, token };
  }
  return { id: null, username: null, isGuest: true, token: null };
}

function resolveDisplayName(req, user) {
  if (user.id) return user.username;
  try {
    const body = req._chatBody;
    if (body?.guestName) return sanitizeGuestName(body.guestName);
  } catch {
    // ignore
  }
  return 'Guest';
}

function buildRoomList(ctx, userId, isGuest) {
  const list = [];
  const cfg = ctx.cfg();

  for (const [name, room] of Object.entries(ctx.rooms)) {
    const canView = userId
      ? ctx.userHasPermission(room, userId, 'VIEW_CHANNEL')
      : room.type === 'public' && cfg.guestChatEnabled;
    if (!canView && room.type !== 'locked') continue;
    if (!canView && room.type === 'locked') continue;

    const canJoin = userId
      ? ctx.userHasPermission(room, userId, 'VIEW_CHANNEL')
      : room.type === 'public' && cfg.guestChatEnabled;

    const memberCount = ctx.listChatClients(name).length;

    list.push({
      name,
      type: room.type,
      ownerId: room.ownerId,
      memberCount,
      pinnedCount: room.pinned.length,
      joinable: canJoin,
      isMember: true,
    });
  }

  return list;
}

function buildHistory(ctx, roomName, user) {
  const room = ctx.rooms[roomName];
  if (!room) return { messages: [], decoys: [], isGuest: false, hiddenCount: 0 };

  const cfg = ctx.cfg();
  const allMessages = ctx.listRoomMessages(roomName, { since: 0, limit: cfg.maxMessagesPerRoom });

  if (user.id && !ctx.userHasPermission(room, user.id, 'READ_MESSAGE_HISTORY')) {
    return { messages: [], decoys: [], isGuest: false, hiddenCount: 0 };
  }
  if (!user.id) {
    const visible = Math.max(0, cfg.guestHistoryVisible);
    const messages = allMessages.slice(-visible);
    const decoys = buildDecoyMessages(cfg.guestDecoyCount, roomName);
    const hiddenCount = Math.max(0, allMessages.length - visible);
    return { messages, decoys, isGuest: true, hiddenCount };
  }
  return { messages: allMessages, decoys: [], isGuest: false, hiddenCount: 0 };
}

function buildUserlist(ctx, roomName) {
  const room = ctx.rooms[roomName];
  if (!room) return [];
  return ctx.listChatClients(roomName).map((client, index) => ({
    id: client.client_id,
    name: client.display_name,
    userId: client.user_id || null,
    role: client.user_id ? getDisplayRole(room, client.user_id) : null,
    _index: index,
  }));
}

async function handleChatHello(req, res, jsonResponse, ctx) {
  if (req.method !== 'POST') {
    jsonError(res, jsonResponse, 405, 'Method not allowed.');
    return true;
  }
  if (!ctx.requireHttpGate(req, res)) return true;

  let body = {};
  try {
    body = await ctx.readJsonBody(req);
    req._chatBody = body;
  } catch {
    req._chatBody = {};
  }

  const user = resolveChatUser(req, ctx);
  const deviceId = ensureDeviceCookie(req, res);
  if (!deviceId) {
    jsonError(res, jsonResponse, 400, 'Client identity required.');
    return true;
  }

  const defaultRoom = ctx.cfg().defaultRooms[0] || 'General';
  const roomName = ctx.sanitizeRoomName(body.room) || defaultRoom;
  const room = ctx.rooms[roomName];
  if (!room) {
    jsonError(res, jsonResponse, 404, 'Room not found.');
    return true;
  }

  const displayName = user.id ? user.username : sanitizeGuestName(body.guestName);
  ctx.upsertChatClient(deviceId, roomName, displayName, user.id);

  const history = buildHistory(ctx, roomName, user);
  const pinned = user.id ? room.pinned : [];

  jsonResponse(res, 200, {
    ok: true,
    room: roomName,
    history,
    pinned,
    roomlist: buildRoomList(ctx, user.id, user.isGuest),
    userlist: buildUserlist(ctx, roomName),
    activityHistory: user.id ? readActivity({ room: roomName, limit: 60 }) : [],
    cursor: Date.now(),
  });
  return true;
}

async function handleChatPoll(req, res, jsonResponse, ctx) {
  if (req.method !== 'GET') {
    jsonError(res, jsonResponse, 405, 'Method not allowed.');
    return true;
  }
  if (!ctx.requireHttpGate(req, res)) return true;

  const user = resolveChatUser(req, ctx);
  const deviceId = ensureDeviceCookie(req, res);
  if (!deviceId) {
    jsonError(res, jsonResponse, 400, 'Client identity required.');
    return true;
  }

  const params = ctx.parseRequestUrl(req, ctx.port).searchParams;
  const since = Number(params.get('since')) || 0;
  const roomName = ctx.sanitizeRoomName(params.get('room')) || ctx.cfg().defaultRooms[0] || 'General';
  const room = ctx.rooms[roomName];
  if (!room) {
    jsonError(res, jsonResponse, 404, 'Room not found.');
    return true;
  }

  const displayName = user.id ? user.username : 'Guest';
  ctx.upsertChatClient(deviceId, roomName, displayName, user.id);

  const messages = ctx.listRoomMessages(roomName, { since, limit: 100 });
  const includeMeta = params.get('meta') === '1' || since === 0;

  jsonResponse(res, 200, {
    ok: true,
    messages,
    cursor: messages.length ? messages[messages.length - 1].ts : since,
    ...(includeMeta ? {
      roomlist: buildRoomList(ctx, user.id, user.isGuest),
      userlist: buildUserlist(ctx, roomName),
      pinned: user.id ? room.pinned : [],
    } : {}),
  });
  return true;
}

async function handleChatMessage(req, res, jsonResponse, ctx) {
  if (req.method !== 'POST') {
    jsonError(res, jsonResponse, 405, 'Method not allowed.');
    return true;
  }
  if (!ctx.requireHttpGate(req, res)) return true;

  const user = resolveChatUser(req, ctx);
  const deviceId = ensureDeviceCookie(req, res);
  if (!deviceId) {
    jsonError(res, jsonResponse, 400, 'Client identity required.');
    return true;
  }

  let body;
  try {
    body = await ctx.readJsonBody(req);
  } catch {
    jsonError(res, jsonResponse, 400, 'Invalid request body.');
    return true;
  }

  const roomName = ctx.sanitizeRoomName(body.room) || ctx.cfg().defaultRooms[0] || 'General';
  const room = ctx.rooms[roomName];
  if (!room) {
    jsonError(res, jsonResponse, 404, 'Room not found.');
    return true;
  }

  const rateKey = `httpmsg:${deviceId}`;
  if (!ctx.checkRateLimit(rateKey, ctx.cfg().rateLimitMessages, ctx.cfg().rateLimitMessageWindowSec * 1000)) {
    jsonError(res, jsonResponse, 429, 'Slow down.');
    return true;
  }

  const fakeSocket = {
    id: deviceId,
    user: user.id ? { id: user.id, username: user.username } : null,
    data: {
      name: user.id ? user.username : sanitizeGuestName(body.guestName),
      room: roomName,
    },
  };

  const fileId = body.fileId ? String(body.fileId) : null;
  if (fileId) {
    if (!ctx.requirePerm(fakeSocket, roomName, 'ATTACH_FILES')) {
      jsonError(res, jsonResponse, 403, 'Missing permission: Attach Files.');
      return true;
    }
  } else if (!ctx.requirePerm(fakeSocket, roomName, 'SEND_MESSAGES')) {
    jsonError(res, jsonResponse, 403, 'Missing permission: Send Messages.');
    return true;
  }

  const payload = ctx.buildMessagePayload(fakeSocket, {
    text: body.text,
    fileId,
    type: body.type || 'text',
  });
  if (!payload) {
    jsonError(res, jsonResponse, 400, 'Invalid message.');
    return true;
  }

  room.messages.push(payload);
  if (room.messages.length > ctx.cfg().maxMessagesPerRoom) room.messages.shift();
  ctx.insertRoomMessage(roomName, payload);
  ctx.upsertChatClient(deviceId, roomName, fakeSocket.data.name, user.id);
  ctx.logHttpActivity('message.sent', user, {
    room: roomName,
    messageType: payload.type,
    fileName: payload.file?.name || null,
  });

  jsonResponse(res, 200, { ok: true, message: payload });
  return true;
}

async function handleChatJoin(req, res, jsonResponse, ctx) {
  if (req.method !== 'POST') {
    jsonError(res, jsonResponse, 405, 'Method not allowed.');
    return true;
  }
  if (!ctx.requireHttpGate(req, res)) return true;

  const user = resolveChatUser(req, ctx);
  const deviceId = ensureDeviceCookie(req, res);
  if (!deviceId) {
    jsonError(res, jsonResponse, 400, 'Client identity required.');
    return true;
  }

  let body;
  try {
    body = await ctx.readJsonBody(req);
  } catch {
    jsonError(res, jsonResponse, 400, 'Invalid request body.');
    return true;
  }

  const roomName = ctx.sanitizeRoomName(body.room);
  const room = ctx.rooms[roomName];
  if (!room) {
    jsonError(res, jsonResponse, 404, 'Room not found.');
    return true;
  }

  const fakeSocket = {
    id: deviceId,
    user: user.id ? { id: user.id, username: user.username } : null,
    data: { name: user.id ? user.username : 'Guest', room: roomName },
  };
  const permission = ctx.canJoinRoom(roomName, fakeSocket);
  if (!permission.allowed) {
    jsonError(res, jsonResponse, 403, permission.reason);
    return true;
  }

  ctx.upsertChatClient(deviceId, roomName, fakeSocket.data.name, user.id);
  const history = buildHistory(ctx, roomName, user);

  jsonResponse(res, 200, {
    ok: true,
    room: roomName,
    history,
    pinned: user.id ? room.pinned : [],
    userlist: buildUserlist(ctx, roomName),
    roomlist: buildRoomList(ctx, user.id, user.isGuest),
  });
  return true;
}

module.exports = {
  handleChatHello,
  handleChatPoll,
  handleChatMessage,
  handleChatJoin,
};
