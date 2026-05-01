// src/models/product.js
import { query, getClient } from '../../config/database.js';

export const ProductModel = {

  // Find product by Telegram message ID (the channel post)
  async findByMessageId(telegramMessageId) {
    const { rows } = await query(
      'SELECT * FROM products WHERE telegram_message_id = $1',
      [telegramMessageId]
    );
    return rows[0] || null;
  },

  // Create a product when admin makes a post
  async create({ telegramMessageId, name, price, quantity }) {
    const { rows } = await query(
      `INSERT INTO products
         (telegram_message_id, name, price, quantity_total, quantity_remaining)
       VALUES ($1, $2, $3, $4, $4)
       RETURNING *`,
      [telegramMessageId, name, price, quantity]
    );
    return rows[0];
  },

  // Atomically decrement stock. Returns updated product or null if sold out.
  // Uses SELECT FOR UPDATE inside a transaction to prevent race conditions.
  async claimOneUnit(productId, client) {
    const { rows } = await client.query(
      `UPDATE products
       SET quantity_remaining = quantity_remaining - 1,
           status = CASE WHEN quantity_remaining - 1 = 0 THEN 'sold_out' ELSE status END
       WHERE id = $1
         AND quantity_remaining > 0
         AND status = 'active'
       RETURNING *`,
      [productId]
    );
    return rows[0] || null;
  },

  async listActive() {
    const { rows } = await query(
      `SELECT p.*,
              COUNT(c.id) FILTER (WHERE c.status = 'confirmed') AS confirmed_claims
       FROM products p
       LEFT JOIN claims c ON c.product_id = p.id
       WHERE p.status IN ('active','sold_out')
       GROUP BY p.id
       ORDER BY p.created_at DESC`
    );
    return rows;
  },

  async getClaimedUsers(productId) {
    const { rows } = await query(
      `SELECT u.telegram_id, u.username, u.first_name, u.last_name,
              c.status AS claim_status, c.created_at AS claimed_at
       FROM claims c
       JOIN users u ON u.id = c.user_id
       WHERE c.product_id = $1
       ORDER BY c.created_at ASC`,
      [productId]
    );
    return rows;
  },
};
