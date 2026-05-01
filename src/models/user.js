// src/models/user.js
import { query } from '../../config/database.js';

export const UserModel = {

  // Upsert user from Telegram context — called on every claim
  async upsert({ telegramId, username, firstName, lastName }, client) {
    const execute = client
      ? (text, params) => client.query(text, params)
      : query;

    const { rows } = await execute(
      `INSERT INTO users (telegram_id, username, first_name, last_name)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (telegram_id)
       DO UPDATE SET
         username   = EXCLUDED.username,
         first_name = EXCLUDED.first_name,
         last_name  = EXCLUDED.last_name,
         updated_at = NOW()
       RETURNING *`,
      [telegramId, username || null, firstName || null, lastName || null]
    );
    return rows[0];
  },

  async findByTelegramId(telegramId) {
    const { rows } = await query(
      'SELECT * FROM users WHERE telegram_id = $1',
      [telegramId]
    );
    return rows[0] || null;
  },

  async findByUsername(username) {
    const clean = username.replace(/^@/, '').toLowerCase();
    const { rows } = await query(
      'SELECT * FROM users WHERE LOWER(username) = $1 LIMIT 1',
      [clean]
    );
    return rows[0] || null;
  },
};
