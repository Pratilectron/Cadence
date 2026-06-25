export const PERMISSION_LABELS = {
  VIEW_CHANNEL: 'View Channel',
  SEND_MESSAGES: 'Send Messages',
  SEND_TTS_MESSAGES: 'Send TTS',
  MANAGE_MESSAGES: 'Manage Messages',
  EMBED_LINKS: 'Embed Links',
  ATTACH_FILES: 'Attach Files',
  READ_MESSAGE_HISTORY: 'Read History',
  MENTION_EVERYONE: 'Mention @everyone',
  USE_EXTERNAL_EMOJIS: 'External Emojis',
  ADD_REACTIONS: 'Add Reactions',
  MANAGE_CHANNEL: 'Manage Channel',
  MANAGE_ROLES: 'Manage Roles',
  CREATE_INSTANT_INVITE: 'Create Invite',
  ADMINISTRATOR: 'Administrator',
};

export function can(state, perm) {
  return Boolean(state.myPermissions?.ADMINISTRATOR || state.myPermissions?.[perm]);
}

export function renderRolesPanel(container, state, socket, roomName) {
  container.replaceChildren();
  if (!state.roomRoles?.roles) {
    container.appendChild(Object.assign(document.createElement('p'), {
      className: 'empty-state',
      textContent: 'Loading roles…',
    }));
    return;
  }

  const head = document.createElement('div');
  head.className = 'roles-head';
  head.innerHTML = `<span class="role-you" style="color:${state.roomRoles.myRole?.color || '#8f877a'}">${state.roomRoles.myRole?.name || '@everyone'}</span>`;
  container.appendChild(head);

  if (can(state, 'MANAGE_ROLES')) {
    const form = document.createElement('form');
    form.className = 'role-form micro-form';
    form.innerHTML = `
      <input name="roleName" placeholder="New role name" maxlength="32" />
      <input name="roleColor" type="color" value="#d4a574" aria-label="Role color" />
      <button type="submit" class="pill-btn pill-wide">Create role</button>`;
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const fd = new FormData(form);
      socket.emit('createRole', {
        room: roomName,
        name: fd.get('roleName'),
        color: fd.get('roleColor'),
        permissions: { SEND_MESSAGES: true, ATTACH_FILES: true, READ_MESSAGE_HISTORY: true },
      });
      form.reset();
    });
    container.appendChild(form);
  }

  const list = document.createElement('div');
  list.className = 'roles-list';
  state.roomRoles.roles.forEach((role) => {
    const row = document.createElement('div');
    row.className = 'role-row';
    row.innerHTML = `
      <span class="role-dot" style="background:${role.color}"></span>
      <div class="role-info">
        <strong>${role.name}</strong>
        <span class="role-pos">Priority ${role.position}</span>
      </div>`;

    if (can(state, 'MANAGE_ROLES') && !role.managed) {
      const editBtn = document.createElement('button');
      editBtn.type = 'button';
      editBtn.className = 'link-btn';
      editBtn.textContent = 'Edit';
      editBtn.addEventListener('click', () => {
        const perms = Object.keys(PERMISSION_LABELS).filter((k) => role.permissions[k]);
        const picked = prompt(`Toggle permissions (comma keys):\n${Object.keys(PERMISSION_LABELS).join(', ')}`, perms.join(','));
        if (picked === null) return;
        const permissions = {};
        picked.split(',').map((s) => s.trim()).filter(Boolean).forEach((k) => { permissions[k] = true; });
        socket.emit('updateRole', { room: roomName, roleId: role.id, permissions });
      });
      row.appendChild(editBtn);

      const delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.className = 'link-btn';
      delBtn.textContent = 'Delete';
      delBtn.addEventListener('click', () => {
        if (confirm(`Delete role ${role.name}?`)) socket.emit('deleteRole', { room: roomName, roleId: role.id });
      });
      row.appendChild(delBtn);
    }

    list.appendChild(row);
  });
  container.appendChild(list);

  if (can(state, 'MANAGE_ROLES')) {
    const assign = document.createElement('form');
    assign.className = 'role-form micro-form';
    assign.innerHTML = `
      <input name="username" placeholder="Username" maxlength="32" />
      <select name="roleId">${state.roomRoles.roles.filter((r) => !r.managed).map((r) => `<option value="${r.id}">${r.name}</option>`).join('')}</select>
      <button type="submit" class="pill-btn">Assign</button>`;
    assign.addEventListener('submit', (e) => {
      e.preventDefault();
      const fd = new FormData(assign);
      socket.emit('assignRole', { room: roomName, username: fd.get('username'), roleId: fd.get('roleId') });
      assign.reset();
    });
    container.appendChild(assign);
  }
}
