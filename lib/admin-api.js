const admin = require('./admin');
const { getEditableSettings, saveSettings, getConfig } = require('./config');
const { readActivity } = require('./activity');
const { loadRoomStore } = require('./roles');

async function handleAdminApi(req, res, urlPath, ctx) {
  const { jsonResponse, readJsonBody, getSessionUser, getTokenFromReq, SECURITY_HEADERS } = ctx;
  const user = getSessionUser(getTokenFromReq(req));

  try {
    admin.requireSuperAdmin(user);
  } catch (err) {
    jsonResponse(res, err.status || 403, { error: err.message });
    return true;
  }

  if (urlPath === '/api/admin/stats' && req.method === 'GET') {
    jsonResponse(res, 200, admin.getDashboardStats(ctx));
    return true;
  }

  if (urlPath === '/api/admin/users' && req.method === 'GET') {
    jsonResponse(res, 200, { users: admin.listUsers(ctx.usersDb) });
    return true;
  }

  if (urlPath.startsWith('/api/admin/users/') && req.method === 'PATCH') {
    const userId = urlPath.split('/').pop();
    const body = await readJsonBody(req);
    const updated = admin.updateUser(ctx.usersDb, ctx.saveUsersDb, userId, body);
    jsonResponse(res, 200, { user: updated });
    return true;
  }

  if (urlPath.startsWith('/api/admin/users/') && req.method === 'DELETE') {
    const userId = urlPath.split('/').pop();
    admin.deleteUser(ctx.usersDb, ctx.saveUsersDb, userId);
    jsonResponse(res, 200, { ok: true });
    return true;
  }

  if (urlPath === '/api/admin/rooms' && req.method === 'GET') {
    const store = loadRoomStore();
    jsonResponse(res, 200, { rooms: admin.listRooms(ctx.rooms), roomMeta: store });
    return true;
  }

  if (urlPath.startsWith('/api/admin/rooms/') && req.method === 'DELETE') {
    const name = decodeURIComponent(urlPath.slice('/api/admin/rooms/'.length));
    admin.deleteRoom(ctx.rooms, null, name);
    jsonResponse(res, 200, { ok: true });
    return true;
  }

  if (urlPath === '/api/admin/files' && req.method === 'GET') {
    jsonResponse(res, 200, { files: admin.listFiles() });
    return true;
  }

  if (urlPath.startsWith('/api/admin/files/') && req.method === 'DELETE') {
    const fileId = urlPath.split('/').pop();
    admin.deleteFile(fileId);
    jsonResponse(res, 200, { ok: true });
    return true;
  }

  if (urlPath === '/api/admin/logs' && req.method === 'GET') {
    const params = new URL(req.url, 'http://localhost').searchParams;
    const limit = Math.min(Number(params.get('limit')) || 200, 500);
    const room = params.get('room') || null;
    jsonResponse(res, 200, { logs: readActivity({ room, limit }) });
    return true;
  }

  if (urlPath === '/api/admin/settings' && req.method === 'GET') {
    jsonResponse(res, 200, { settings: getEditableSettings() });
    return true;
  }

  if (urlPath === '/api/admin/settings' && req.method === 'PUT') {
    const body = await readJsonBody(req);
    const settings = saveSettings(body);
    jsonResponse(res, 200, { settings });
    return true;
  }

  if (urlPath === '/api/admin/sessions/revoke' && req.method === 'POST') {
    const count = admin.revokeAllSessions(ctx.sessions);
    jsonResponse(res, 200, { revoked: count });
    return true;
  }

  if (urlPath === '/api/admin/wipe' && req.method === 'POST') {
    try {
      const body = await readJsonBody(req);
      const token = getTokenFromReq(req);
      const result = admin.wipeAllDataExceptSuperAdmin(ctx, user.id, {
        password: body.password,
        confirm: body.confirm,
        keepToken: token,
      });
      jsonResponse(res, 200, { ok: true, result });
    } catch (err) {
      jsonResponse(res, 400, { error: err.message || 'Wipe failed.' });
    }
    return true;
  }

  if (urlPath === '/api/admin/me' && req.method === 'GET') {
    jsonResponse(res, 200, { user: { id: user.id, username: user.username, superAdmin: true } });
    return true;
  }

  jsonResponse(res, 404, { error: 'Admin route not found.' });
  return true;
}

module.exports = { handleAdminApi };
