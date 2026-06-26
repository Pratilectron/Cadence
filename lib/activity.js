const { insertActivityRow, readActivityRows, clearActivityRows } = require('./db');

function logActivity(entry) {
  return insertActivityRow(entry);
}

function readActivity(options = {}) {
  return readActivityRows(options);
}

function clearActivityLog() {
  clearActivityRows();
}

module.exports = { logActivity, readActivity, clearActivityLog };
