// The connector's own state (sender rules, sweep progress, the undo log,
// confirmations, health notes) lives in D1. Cloudflare's free plan allows about
// 1,000 KV writes a day for the whole account, and the rule sweep every 15 minutes
// would use them up and break sign-in (OAuthProvider stores grants in KV). D1's free
// tier allows 100,000 writes a day.
//
// store(env) gives a KV-shaped object (get, put, delete, list) backed by D1.

const stores = new WeakMap();
let tableReady = null;

function ensureTable(db) {
  if (!tableReady) {
    tableReady = db
      .prepare('CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL, exp INTEGER)')
      .run()
      .catch((e) => {
        tableReady = null;
        throw e;
      });
  }
  return tableReady;
}

function parse(value, type) {
  if (value == null) return null;
  return type === 'json' || type?.type === 'json' ? JSON.parse(value) : value;
}

export function store(env) {
  let s = stores.get(env);
  if (s) return s;
  const db = env.STATE_DB;

  async function rawPut(key, value, ttlSeconds) {
    await ensureTable(db);
    const exp = ttlSeconds ? Date.now() + ttlSeconds * 1000 : null;
    await db.prepare('INSERT OR REPLACE INTO kv (k, v, exp) VALUES (?, ?, ?)').bind(key, String(value), exp).run();
  }

  s = {
    async get(key, type) {
      await ensureTable(db);
      const row = await db.prepare('SELECT v, exp FROM kv WHERE k = ?').bind(key).first();
      if (row) {
        if (row.exp != null && row.exp <= Date.now()) return null;
        return parse(row.v, type);
      }
      return null;
    },

    async put(key, value, options = {}) {
      await rawPut(key, value, options.expirationTtl);
    },

    async delete(key) {
      await ensureTable(db);
      await db.prepare('DELETE FROM kv WHERE k = ?').bind(key).run();
    },

    async list({ prefix = '', limit = 1000 } = {}) {
      await ensureTable(db);
      const now = Date.now();
      const { results } = await db
        .prepare('SELECT k, v FROM kv WHERE substr(k, 1, ?) = ? AND (exp IS NULL OR exp > ?) ORDER BY k LIMIT ?')
        .bind(prefix.length, prefix, now, limit)
        .all();
      const keys = results.map((r) => ({ name: r.k }));
      return { keys, list_complete: true };
    },

    // Housekeeping: drop expired rows (run from the hourly cron).
    async purgeExpired() {
      await ensureTable(db);
      await db.prepare('DELETE FROM kv WHERE exp IS NOT NULL AND exp <= ?').bind(Date.now()).run();
    },
  };
  stores.set(env, s);
  return s;
}
