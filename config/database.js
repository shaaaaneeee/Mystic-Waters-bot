// config/database.js
import pg from 'pg';
import 'dotenv/config';

const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 20,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
});

pool.on('error', (err) => {
  console.error('[DB] Unexpected pool error:', err.message);
});

// Thin wrapper: auto-releases clients, surfaces errors cleanly
export async function query(text, params) {
  const start = Date.now();
  try {
    const result = await pool.query(text, params);
    if (process.env.NODE_ENV === 'development') {
      console.debug(`[DB] ${Date.now() - start}ms — ${text.slice(0, 80)}`);
    }
    return result;
  } catch (err) {
    console.error('[DB] Query error:', err.message, '\nSQL:', text);
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

export default pool;
