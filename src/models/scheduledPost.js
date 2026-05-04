// src/models/scheduledPost.js
import { query } from '../../config/database.js';

export const ScheduledPostModel = {

  async create({ type, content, productId, auctionId, scheduledAt, createdBy }) {
    const { rows } = await query(
      `INSERT INTO scheduled_posts
         (type, content, product_id, auction_id, scheduled_at, created_by)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [type, content || null, productId || null, auctionId || null, scheduledAt, createdBy]
    );
    return rows[0];
  },

  async listPending() {
    const { rows } = await query(
      `SELECT sp.*,
              p.name AS product_name,
              a.name AS auction_name
       FROM scheduled_posts sp
       LEFT JOIN products p ON p.id = sp.product_id
       LEFT JOIN auctions a ON a.id = sp.auction_id
       WHERE sp.status = 'pending'
       ORDER BY sp.scheduled_at ASC`
    );
    return rows;
  },

  async findById(id) {
    const { rows } = await query(
      `SELECT sp.*, p.name AS product_name, a.name AS auction_name
       FROM scheduled_posts sp
       LEFT JOIN products p ON p.id = sp.product_id
       LEFT JOIN auctions a ON a.id = sp.auction_id
       WHERE sp.id = $1`,
      [id]
    );
    return rows[0] || null;
  },

  async markSent(id) {
    await query(
      `UPDATE scheduled_posts
       SET status = 'sent', sent_at = NOW(), updated_at = NOW()
       WHERE id = $1`,
      [id]
    );
  },

  async markFailed(id, reason) {
    await query(
      `UPDATE scheduled_posts
       SET status = 'failed', fail_reason = $2, updated_at = NOW()
       WHERE id = $1`,
      [id, reason]
    );
  },

  async cancel(id, reason) {
    const { rows } = await query(
      `UPDATE scheduled_posts
       SET status = 'cancelled', cancel_reason = $2, updated_at = NOW()
       WHERE id = $1 AND status = 'pending'
       RETURNING *`,
      [id, reason || null]
    );
    return rows[0] || null;
  },
};
