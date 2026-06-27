const { readFileSync, writeFileSync, writeFile, existsSync } = require('fs');
const { join } = require('path');

const VENDOR_SQL = join(__dirname, '..', 'vendor', 'sql-asm.js');

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

function wrapSqlJs(raw, { persist, persistNow }) {
  let txDepth = 0;

  const schedulePersist = () => {
    if (txDepth > 0) return;
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
      txDepth += 1;
      try {
        raw.run('BEGIN TRANSACTION');
        fn(...args);
        raw.run('COMMIT');
        persistNow();
      } catch (err) {
        try { raw.run('ROLLBACK'); } catch { /* ignore */ }
        throw err;
      } finally {
        txDepth -= 1;
      }
    },
    close: () => {
      persistNow();
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
    const firstLine = String(err.message || err).split('\n')[0];
    console.warn('[db] better-sqlite3 unavailable:', firstLine);
    return null;
  }
}

function loadSqlJsInit() {
  const candidates = [];
  if (existsSync(VENDOR_SQL)) {
    candidates.push(['bundled vendor', VENDOR_SQL]);
  }
  candidates.push(
    ['npm package', 'sql.js'],
    ['npm asm build', 'sql.js/dist/sql-asm.js'],
    ['npm wasm build', 'sql.js/dist/sql-wasm.js'],
  );

  for (const [label, target] of candidates) {
    try {
      const initSqlJs = require(target);
      return { initSqlJs, label };
    } catch {
      // try next source
    }
  }

  throw new Error('No SQLite JS driver found (vendor/sql-asm.js should ship with the app).');
}

async function openDatabase(path) {
  const native = tryOpenNative(path);
  if (native) return native;

  const { initSqlJs, label } = loadSqlJsInit();
  console.warn(`[db] falling back to ${label} (no native SQLite build required)`);
  const SQL = await initSqlJs();
  const buffer = existsSync(path) ? readFileSync(path) : null;
  const raw = buffer ? new SQL.Database(buffer) : new SQL.Database();
  let persistTimer = null;
  const flushToDisk = () => {
    setImmediate(() => {
      try {
        const payload = Buffer.from(raw.export());
        writeFile(path, payload, (err) => {
          if (err) console.error('[db] persist failed:', err.message);
        });
      } catch (err) {
        console.error('[db] export failed:', err.message);
      }
    });
  };
  const persistNow = () => {
    if (persistTimer) {
      clearTimeout(persistTimer);
      persistTimer = null;
    }
    flushToDisk();
  };
  const persist = () => {
    if (persistTimer) clearTimeout(persistTimer);
    persistTimer = setTimeout(() => {
      persistTimer = null;
      flushToDisk();
    }, 1500);
  };
  const wrapped = wrapSqlJs(raw, { persist, persistNow });
  wrapped.driver = label.includes('vendor') ? 'sql.js (bundled)' : 'sql.js';
  return wrapped;
}

module.exports = { openDatabase };
