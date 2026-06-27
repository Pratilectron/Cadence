const { readFileSync, writeFileSync, existsSync } = require('fs');

function namedToPositional(sql, obj) {
  const keys = [];
  const positionalSql = sql.replace(/@(\w+)/g, (_, key) => {
    keys.push(key);
    return '?';
  });
  return [positionalSql, keys.map((key) => obj[key])];
}

function normalizeParams(sql, args) {
  if (!args.length) return [];
  if (args.length === 1) {
    const value = args[0];
    if (value && typeof value === 'object' && !Array.isArray(value) && sql.includes('@')) {
      return namedToPositional(sql, value)[1];
    }
    if (Array.isArray(value)) return value;
    return [value];
  }
  return args;
}

function wrapNative(raw) {
  return {
    driver: 'better-sqlite3',
    exec: (sql) => raw.exec(sql),
    prepare: (sql) => raw.prepare(sql),
    transaction: (fn) => raw.transaction(fn),
    close: () => raw.close(),
  };
}

function resolveStatement(sql, args) {
  if (
    args.length === 1
    && args[0]
    && typeof args[0] === 'object'
    && !Array.isArray(args[0])
    && sql.includes('@')
  ) {
    const [runSql, params] = namedToPositional(sql, args[0]);
    return [runSql, params];
  }
  return [sql, normalizeParams(sql, args)];
}

function wrapSqlJs(raw, persist) {
  const schedulePersist = () => {
    persist();
  };

  function prepare(sql) {
    return {
      run(...args) {
        const [runSql, params] = resolveStatement(sql, args);
        raw.run(runSql, params);
        schedulePersist();
      },
      get(...args) {
        const [runSql, params] = resolveStatement(sql, args);
        const stmt = raw.prepare(runSql);
        try {
          if (params.length) stmt.bind(params);
          if (!stmt.step()) return undefined;
          return stmt.getAsObject();
        } finally {
          stmt.free();
        }
      },
      all(...args) {
        const [runSql, params] = resolveStatement(sql, args);
        const stmt = raw.prepare(runSql);
        const rows = [];
        try {
          if (params.length) stmt.bind(params);
          while (stmt.step()) rows.push(stmt.getAsObject());
          return rows;
        } finally {
          stmt.free();
        }
      },
    };
  }

  return {
    driver: 'sql.js',
    exec: (sql) => {
      raw.exec(sql);
      schedulePersist();
    },
    prepare,
    transaction: (fn) => (...args) => {
      raw.run('BEGIN');
      try {
        fn(...args);
        raw.run('COMMIT');
        schedulePersist();
      } catch (err) {
        try { raw.run('ROLLBACK'); } catch { /* ignore */ }
        throw err;
      }
    },
    close: () => {
      schedulePersist();
      raw.close();
    },
  };
}

function tryOpenNative(path) {
  if (process.env.FORCE_SQLJS === '1') return null;
  let Database;
  try {
    Database = require('better-sqlite3');
  } catch {
    return null;
  }
  try {
    return wrapNative(new Database(path));
  } catch (err) {
    console.warn('[db] better-sqlite3 unavailable:', err.message);
    return null;
  }
}

async function openSqlJs(path) {
  let initSqlJs;
  try {
    initSqlJs = require('sql.js');
  } catch (err) {
    const hint = new Error(
      'sql.js is not installed. Run "npm install" in the application root on the server.',
    );
    hint.cause = err;
    throw hint;
  }

  const SQL = await initSqlJs();
  const buffer = existsSync(path) ? readFileSync(path) : null;
  const raw = buffer ? new SQL.Database(buffer) : new SQL.Database();
  const persist = () => {
    writeFileSync(path, Buffer.from(raw.export()));
  };
  return wrapSqlJs(raw, persist);
}

async function openDatabase(path) {
  const native = tryOpenNative(path);
  if (native) return native;
  console.warn('[db] falling back to sql.js (pure JS SQLite — no native build required)');
  return openSqlJs(path);
}

module.exports = { openDatabase };
