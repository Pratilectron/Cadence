const { initDb, listUsers, upsertUser, replaceAllUsers, deleteUserById } = require('./db');

const usersDb = { users: [] };
let savePending = false;

function initUsersStore() {
  initDb();
  reloadUsersCache();
}

function reloadUsersCache() {
  usersDb.users = listUsers();
  return usersDb;
}

function loadUsersDb() {
  return usersDb;
}

function saveUsersDb() {
  if (savePending) return;
  savePending = true;
  setImmediate(() => {
    savePending = false;
    replaceAllUsers(usersDb.users);
  });
}

function saveUserNow(user) {
  upsertUser(user);
}

function deleteUserNow(id) {
  deleteUserById(id);
}

module.exports = {
  initUsersStore,
  reloadUsersCache,
  loadUsersDb,
  saveUsersDb,
  saveUserNow,
  deleteUserNow,
  usersDb,
};
