// src/models/giveaway.js
import { query, getClient } from '../../config/database.js';
import { randomInt } from 'node:crypto';

export const GiveawayModel = {

  async createPool({ title, prizeDescription, notes, createdBy }) {
    const { rows } = await query(
      `INSERT INTO giveaway_pools (title, prize_description, notes, created_by)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [title, prizeDescription || null, notes || null, createdBy]
    );
    return rows[0];
  },

  async getActivePool() {
    const { rows } = await query(
      `SELECT * FROM giveaway_pools WHERE status = 'active' ORDER BY created_at DESC LIMIT 1`
    );
    return rows[0] || null;
  },

  async addEntries({ poolId, entries }) {
    if (!entries.length) return [];
    const placeholders = entries
      .map((_, i) => `($1, $${i * 3 + 2}, $${i * 3 + 3}, $${i * 3 + 4})`)
      .join(', ');
    const values = [poolId, ...entries.flatMap(e => [e.userId, e.invoiceId, e.claimId])];
    const { rows } = await query(
      `INSERT INTO giveaway_entries (pool_id, user_id, invoice_id, claim_id)
       VALUES ${placeholders}
       ON CONFLICT (pool_id, claim_id) DO NOTHING
       RETURNING *`,
      values
    );
    return rows;
  },

  async getPoolStats(poolId) {
    const { rows } = await query(
      `SELECT
         COUNT(*)::INTEGER             AS total_entries,
         COUNT(DISTINCT user_id)::INTEGER AS unique_users
       FROM giveaway_entries
       WHERE pool_id = $1`,
      [poolId]
    );
    return rows[0];
  },

  async getTopContributors(poolId) {
    const { rows } = await query(
      `SELECT u.username, u.first_name, u.telegram_id,
              COUNT(ge.id)::INTEGER AS entries
       FROM giveaway_entries ge
       JOIN users u ON u.id = ge.user_id
       WHERE ge.pool_id = $1
       GROUP BY u.id
       ORDER BY entries DESC
       LIMIT 10`,
      [poolId]
    );
    return rows;
  },

  async drawWinner({ poolId, drawnBy }) {
    const client = await getClient();
    try {
      await client.query('BEGIN');

      const { rows: entries } = await client.query(
        `SELECT * FROM giveaway_entries WHERE pool_id = $1`,
        [poolId]
      );

      if (!entries.length) {
        await client.query('ROLLBACK');
        return null;
      }

      const winner = entries[randomInt(0, entries.length)];

      await client.query(
        `INSERT INTO giveaway_draws (pool_id, winner_user_id, winning_entry_id, drawn_by)
         VALUES ($1, $2, $3, $4)`,
        [poolId, winner.user_id, winner.id, drawnBy]
      );

      await client.query(
        `UPDATE giveaway_pools SET status = 'drawn' WHERE id = $1`,
        [poolId]
      );

      await client.query('COMMIT');
      return winner;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  },

  async cancelPool(poolId) {
    const { rows } = await query(
      `UPDATE giveaway_pools SET status = 'cancelled'
       WHERE id = $1 AND status = 'active' RETURNING *`,
      [poolId]
    );
    return rows[0] || null;
  },
};
