// src/models/scheduledPost.js
import { query } from '../../config/database.js';

export const ScheduledPostModel = {

  async create({
    type, content,
    productName, productPrice, productQuantity, productDescription,
    auctionName, auctionDescription, auctionStartingBid, auctionMinIncrement, auctionEndTime,
    scheduledAt, createdBy,
  }) {
    const { rows } = await query(
      `INSERT INTO scheduled_posts
         (type, content,
          product_name, product_price, product_quantity, product_description,
          auction_name, auction_description, auction_starting_bid, auction_min_increment, auction_end_time,
          scheduled_at, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       RETURNING *`,
      [
        type, content || null,
        productName || null, productPrice || null, productQuantity || null, productDescription || null,
        auctionName || null, auctionDescription || null, auctionStartingBid || null,
        auctionMinIncrement || null, auctionEndTime || null,
        scheduledAt, createdBy,
      ]
    );
    return rows[0];
  },

  async listPending() {
    const { rows } = await query(
      `SELECT * FROM scheduled_posts WHERE status = 'pending' ORDER BY scheduled_at ASC`
    );
    return rows;
  },

  async findById(id) {
    const { rows } = await query(
      `SELECT * FROM scheduled_posts WHERE id = $1`,
      [id]
    );
    return rows[0] || null;
  },

  async markSent(id, channelMessageId) {
    await query(
      `UPDATE scheduled_posts
       SET status = 'sent', sent_at = NOW(), channel_message_id = $2, updated_at = NOW()
       WHERE id = $1`,
      [id, channelMessageId || null]
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
