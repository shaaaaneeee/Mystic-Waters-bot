// src/models/invoice.js
import { query, getClient } from '../../config/database.js';

export const InvoiceModel = {

  async createWithClaims({ userId, claims }) {
    const total = claims.reduce((sum, c) => sum + parseFloat(c.price), 0);
    const client = await getClient();
    try {
      await client.query('BEGIN');
      const { rows: [invoice] } = await client.query(
        `INSERT INTO invoices (user_id, total_amount, status)
         VALUES ($1, $2, 'active') RETURNING *`,
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

  async deleteById(invoiceId) {
    await query(`DELETE FROM invoices WHERE id = $1`, [invoiceId]);
  },

  async markSent(invoiceId) {
    const { rows } = await query(
      `UPDATE invoices SET sent_at = NOW(), updated_at = NOW()
       WHERE id = $1 RETURNING *`,
      [invoiceId]
    );
    return rows[0];
  },

  async findById(invoiceId) {
    const { rows } = await query(
      `SELECT i.*, u.telegram_id, u.username, u.first_name
       FROM invoices i
       JOIN users u ON u.id = i.user_id
       WHERE i.id = $1`,
      [invoiceId]
    );
    return rows[0] || null;
  },

  async getClaimsForInvoice(invoiceId) {
    const { rows } = await query(
      `SELECT c.id AS claim_id, p.name, p.price, p.telegram_message_id
       FROM invoice_claims ic
       JOIN claims c ON c.id = ic.claim_id
       JOIN products p ON p.id = c.product_id
       WHERE ic.invoice_id = $1
       ORDER BY c.created_at ASC`,
      [invoiceId]
    );
    return rows;
  },

  // Confirm payment — only operates on status = 'active'. Returns updated row or null.
  async confirmPaid({ invoiceId, confirmedByTelegramId }) {
    const { rows } = await query(
      `UPDATE invoices SET
         status            = 'paid',
         paid_at           = NOW(),
         paid_confirmed_by = $2,
         updated_at        = NOW()
       WHERE id = $1 AND status = 'active'
       RETURNING *`,
      [invoiceId, confirmedByTelegramId]
    );
    return rows[0] || null;
  },

  // Cancel invoice — only operates on status = 'active'.
  // Removes invoice_claims so claims return to uninvoiced pool.
  async cancel({ invoiceId, cancelledByTelegramId, reason }) {
    const client = await getClient();
    try {
      await client.query('BEGIN');

      const { rows } = await client.query(
        `UPDATE invoices SET
           status        = 'cancelled',
           cancelled_at  = NOW(),
           cancelled_by  = $2,
           cancel_reason = $3,
           updated_at    = NOW()
         WHERE id = $1 AND status = 'active'
         RETURNING *`,
        [invoiceId, cancelledByTelegramId, reason || null]
      );

      if (!rows[0]) {
        await client.query('ROLLBACK');
        return null;
      }

      // Remove invoice_claims so linked claims become re-invoiceable
      await client.query(
        `DELETE FROM invoice_claims WHERE invoice_id = $1`,
        [invoiceId]
      );

      await client.query('COMMIT');
      return rows[0];
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  },

  // All uninvoiced confirmed claims — excludes claims tied to active/paid invoices
  async getPendingSummary() {
    const { rows } = await query(
      `SELECT u.telegram_id, u.username, u.first_name,
              COUNT(c.id) AS claim_count,
              SUM(p.price)::NUMERIC(10,2) AS total
       FROM claims c
       JOIN users u ON u.id = c.user_id
       JOIN products p ON p.id = c.product_id
       WHERE c.status = 'confirmed'
         AND c.id NOT IN (
           SELECT ic.claim_id FROM invoice_claims ic
           JOIN invoices inv ON inv.id = ic.invoice_id
           WHERE inv.status != 'cancelled'
         )
       GROUP BY u.id
       ORDER BY total DESC`
    );
    return rows;
  },

  async listActive() {
    const { rows } = await query(
      `SELECT i.*, u.telegram_id, u.username, u.first_name
       FROM invoices i
       JOIN users u ON u.id = i.user_id
       WHERE i.status = 'active'
       ORDER BY i.created_at DESC`
    );
    return rows;
  },

  async listHistory() {
    const { rows } = await query(
      `SELECT i.*, u.telegram_id, u.username, u.first_name
       FROM invoices i
       JOIN users u ON u.id = i.user_id
       WHERE i.status IN ('paid', 'cancelled')
       ORDER BY i.updated_at DESC
       LIMIT 50`
    );
    return rows;
  },
};
