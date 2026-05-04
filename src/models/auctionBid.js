// src/models/auctionBid.js
import { query } from '../../config/database.js';

export const AuctionBidModel = {

  // Insert new bid — clears previous is_winning flags first (within transaction)
  async insert({ auctionId, userId, amount }, client) {
    await client.query(
      `UPDATE auction_bids SET is_winning = FALSE WHERE auction_id = $1`,
      [auctionId]
    );
    const { rows } = await client.query(
      `INSERT INTO auction_bids (auction_id, user_id, amount, is_winning)
       VALUES ($1, $2, $3, TRUE) RETURNING *`,
      [auctionId, userId, amount]
    );
    return rows[0];
  },

  async listForAuction(auctionId) {
    const { rows } = await query(
      `SELECT ab.*, u.username, u.first_name, u.telegram_id
       FROM auction_bids ab
       JOIN users u ON u.id = ab.user_id
       WHERE ab.auction_id = $1
       ORDER BY ab.amount DESC, ab.created_at ASC`,
      [auctionId]
    );
    return rows;
  },
};
