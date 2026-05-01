// config/database.js
import pg from 'pg';
import 'dotenv/config';

const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,

  ssl: {
    rejectUnauthorized: false,
  },

  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
});

pool.on('error', (err) => {
  console.error('[DB] Unexpected error', err);
});

// Thin wrapper: auto-releases clients, surfaces errors cleanly
export async function query(text, params, retries = 2) {
  const start = Date.now();
  try {
    const result = await pool.query(text, params);
    if (process.env.NODE_ENV === 'development') {
      console.debug(`[DB] ${Date.now() - start}ms — ${text.slice(0, 80)}`);
    }
    return result;
  } catch (err) {
    if (retries > 0) {
      console.log('[DB] Retrying query...', { retries, text: text.slice(0, 80) });
      return query(text, params, retries - 1);
    }
    console.error('[DB] Query error:', err, '\nSQL:', text);
    throw err;
  }
}

// Use this when you need manual transaction control
export async function getClient() {
  const client = await pool.connect();
  const release = client.release.bind(client);
  // Safety: auto-release after 30s in case of forgotten release
  const timeout = setTimeout(() => {
    console.error('[DB] Client checked out for >30s — force releasing');
    release();
  }, 30_000);
  client.release = () => {
    clearTimeout(timeout);
    release();
  };
  return client;
}

setInterval(() => {
  pool.query('SELECT 1').catch((err) => {
    console.error('[DB] Keepalive ping failed', err);
  });
}, 20_000);

export default pool;
