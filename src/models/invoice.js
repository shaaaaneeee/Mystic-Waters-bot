// src/models/invoice.js
import { query, getClient } from '../../config/database.js';

export const InvoiceModel = {

  // Create invoice and link claims atomically
  async createWithClaims({ userId, claims }) {
    const total = claims.reduce((sum, c) => sum + parseFloat(c.price), 0);
    const client = await getClient();
    try {
      await client.query('BEGIN');

      const { rows: [invoice] } = await client.query(
        `INSERT INTO invoices (user_id, total_amount, status)
         VALUES ($1, $2, 'draft')
         RETURNING *`,
        [userId, total.toFixed(2)]
      );

      for (const claim of claims) {
        await client.query(
          `INSERT INTO invoice_claims (invoice_id, claim_id) VALUES ($1, $2)`,
          [invoice.id, claim.claim_id]
        );
      }

      await client.query('COMMIT');
      return { ...invoice, claims };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  },

  async markSent(invoiceId) {
    const { rows } = await query(
      `UPDATE invoices SET status = 'sent', sent_at = NOW()
       WHERE id = $1 RETURNING *`,
      [invoiceId]
    );
    return rows[0];
  },

  // All uninvoiced confirmed claims across all users — for admin dashboard
  async getPendingSummary() {
    const { rows } = await query(
      `SELECT u.telegram_id, u.username, u.first_name,
              COUNT(c.id) AS claim_count,
              SUM(p.price)::NUMERIC(10,2) AS total
       FROM claims c
       JOIN users u ON u.id = c.user_id
       JOIN products p ON p.id = c.product_id
       WHERE c.status = 'confirmed'
         AND c.id NOT IN (SELECT claim_id FROM invoice_claims)
       GROUP BY u.id
       ORDER BY total DESC`
    );
    return rows;
  },
};
