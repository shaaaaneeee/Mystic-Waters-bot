// migrations/run.js
import 'dotenv/config';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';
import pg from 'pg';

const { Client } = pg;
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const client = new Client({ connectionString: process.env.DATABASE_URL });

async function run() {
  await client.connect();
  console.log('[Migration] Connected to database');

  const sql = readFileSync(
    path.join(__dirname, '001_initial_schema.sql'),
    'utf8'
  );

  try {
    await client.query(sql);
    console.log('[Migration] Schema applied successfully');
  } catch (err) {
    console.error('[Migration] Error:', err.message);
    process.exit(1);
  } finally {
    await client.end();
  }
}

run();
