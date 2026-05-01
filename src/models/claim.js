// src/models/claim.js
import { query } from '../../config/database.js';

export const ClaimModel = {

  // Insert claim inside an existing transaction client
  async create({ userId, productId }, client) {
    const { rows } = await client.query(
      `INSERT INTO claims (user_id, product_id, status)
       VALUES ($1, $2, 'confirmed')
       RETURNING *`,
      [userId, productId]
    );
    return rows[0];
  },

  // Check if user already claimed this product
  async exists({ userId, productId }) {
    const { rows } = await query(
      `SELECT id FROM claims
       WHERE user_id = $1 AND product_id = $2`,
      [userId, productId]
    );
    return rows.length > 0;
  },

  // All confirmed claims for a user (for invoice generation)
  async getPendingInvoiceClaims(userId) {
    const { rows } = await query(
      `SELECT c.id AS claim_id, c.created_at,
              p.name, p.price, p.telegram_message_id
       FROM claims c
       JOIN products p ON p.id = c.product_id
       WHERE c.user_id = $1
         AND c.status = 'confirmed'
         AND c.id NOT IN (
           SELECT claim_id FROM invoice_claims
         )
       ORDER BY c.created_at ASC`,
      [userId]
    );
    return rows;
  },
};
