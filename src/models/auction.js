// src/models/auction.js
import { query, getClient } from '../../config/database.js';

export const AuctionModel = {

  async create({ telegramMessageId, name, description, startingBid, minIncrement, startTime, endTime, createdBy }) {
    const client = await getClient();
    try {
      await client.query('BEGIN');

      const { rows: [auction] } = await client.query(
        `INSERT INTO auctions
           (telegram_message_id, name, description, starting_bid, min_increment,
            start_time, end_time, created_by, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,
           CASE WHEN $6 IS NULL OR $6 <= NOW() THEN 'active' ELSE 'upcoming' END)
         RETURNING *`,
        [telegramMessageId, name, description || null, startingBid, minIncrement,
         startTime || null, endTime, createdBy]
      );

      await client.query(
        `INSERT INTO post_registry (telegram_message_id, post_type, ref_id)
         VALUES ($1, 'auction', $2) ON CONFLICT DO NOTHING`,
        [telegramMessageId, auction.id]
      );

      await client.query('COMMIT');
      return auction;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  },

  async findByMessageId(telegramMessageId) {
    const { rows } = await query(
      'SELECT * FROM auctions WHERE telegram_message_id = $1',
      [telegramMessageId]
    );
    return rows[0] || null;
  },

  async findById(id) {
    const { rows } = await query('SELECT * FROM auctions WHERE id = $1', [id]);
    return rows[0] || null;
  },

  // Activate upcoming auctions whose start_time has passed
  async activateDue() {
    const { rows } = await query(
      `UPDATE auctions SET status = 'active', updated_at = NOW()
       WHERE status = 'upcoming' AND start_time <= NOW()
       RETURNING *`
    );
    return rows;
  },

  // End active auctions whose end_time has passed; set winner from highest bid
  async endDue() {
    const { rows } = await query(
      `UPDATE auctions a SET
         status         = 'ended',
         ended_at       = NOW(),
         winner_user_id = (
           SELECT user_id FROM auction_bids
           WHERE auction_id = a.id AND is_winning = TRUE
           LIMIT 1
         ),
         winner_bid     = a.current_bid,
         updated_at     = NOW()
       WHERE a.status = 'active' AND a.end_time <= NOW()
       RETURNING a.*`
    );
    return rows;
  },

  // Atomically update bid — WHERE clause enforces increment + active status
  async placeBid({ auctionId, userId, amount }, client) {
    const { rows } = await client.query(
      `UPDATE auctions SET
         current_bid       = $3,
         current_leader_id = $2,
         end_time          = CASE
           WHEN end_time - NOW() < INTERVAL '2 minutes'
           THEN end_time + INTERVAL '2 minutes'
           ELSE end_time
         END,
         updated_at = NOW()
       WHERE id = $1
         AND status = 'active'
         AND (
           (current_bid IS NULL AND $3 >= starting_bid)
           OR
           ($3 >= current_bid + min_increment)
         )
       RETURNING *`,
      [auctionId, userId, amount]
    );
    return rows[0] || null;
  },

  async cancel(auctionId) {
    const { rows } = await query(
      `UPDATE auctions SET status = 'cancelled', updated_at = NOW()
       WHERE id = $1 AND status IN ('upcoming', 'active') RETURNING *`,
      [auctionId]
    );
    return rows[0] || null;
  },

  async forceEnd(auctionId) {
    const { rows } = await query(
      `UPDATE auctions SET end_time = NOW(), updated_at = NOW()
       WHERE id = $1 AND status = 'active' RETURNING *`,
      [auctionId]
    );
    return rows[0] || null;
  },
};
