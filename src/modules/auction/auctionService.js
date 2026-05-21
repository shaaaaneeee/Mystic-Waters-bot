// src/modules/auction/auctionService.js
import redis from '../../../config/redis.js';
import { getClient, query } from '../../../config/database.js';
import { AuctionModel } from '../../models/auction.js';
import { AuctionBidModel } from '../../models/auctionBid.js';
import { UserModel } from '../../models/user.js';

const LOCK_PREFIX = 'auction:lock:';
const LOCK_TTL_MS = 5000;

async function acquireLock(auctionId) {
  return (await redis.set(LOCK_PREFIX + auctionId, '1', 'NX', 'PX', LOCK_TTL_MS)) === 'OK';
}

async function releaseLock(auctionId) {
  await redis.del(LOCK_PREFIX + auctionId);
}

export async function placeBid({ telegramUser, auction, amount }) {
  const lockAcquired = await acquireLock(auction.id);
  if (!lockAcquired) return { success: false, reason: 'busy' };

  const client = await getClient();
  try {
    await client.query('BEGIN');

    const user = await UserModel.upsertAndGetStatus({
      telegramId: telegramUser.id,
      username: telegramUser.username,
      firstName: telegramUser.first_name,
      lastName: telegramUser.last_name,
    });

    const updatedAuction = await AuctionModel.placeBid(
      { auctionId: auction.id, userId: user.id, amount },
      client
    );

    if (!updatedAuction) {
      await client.query('ROLLBACK');
      const minRequired = auction.current_bid != null
        ? parseFloat(auction.current_bid) + parseFloat(auction.min_increment)
        : parseFloat(auction.starting_bid);
      return { success: false, reason: 'invalid_bid', minRequired };
    }

    const bid = await AuctionBidModel.insert(
      { auctionId: auction.id, userId: user.id, amount },
      client
    );

    await client.query('COMMIT');
    return { success: true, bid, auction: updatedAuction, user };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
    await releaseLock(auction.id);
  }
}

// Called by cron every 60s
export async function runAuctionLifecycle(bot, adminTelegramId) {
  const activated = await AuctionModel.activateDue();
  for (const a of activated) {
    console.log(`[Auction] Activated: ${a.name} (#${a.id})`);
  }

  const ended = await AuctionModel.endDue();
  for (let auction of ended) {
    console.log(`[Auction] Ended: ${auction.name} (#${auction.id}), winner_user_id=${auction.winner_user_id}, winner_bid=${auction.winner_bid}`);

    // Safety fallback: if endDue() didn't capture a winner, query auction_bids directly
    if (!auction.winner_user_id) {
      const { rows: bidRows } = await query(
        `SELECT user_id, amount FROM auction_bids
         WHERE auction_id = $1
         ORDER BY amount DESC
         LIMIT 1`,
        [auction.id]
      );
      if (bidRows[0]) {
        console.log(`[Auction] Fallback winner found for #${auction.id}: user_id=${bidRows[0].user_id}, amount=${bidRows[0].amount}`);
        // Persist the winner on the auction row
        await query(
          `UPDATE auctions SET winner_user_id = $1, winner_bid = $2 WHERE id = $3`,
          [bidRows[0].user_id, bidRows[0].amount, auction.id]
        );
        auction = { ...auction, winner_user_id: bidRows[0].user_id, winner_bid: bidRows[0].amount };
      }
    }

    await notifyAdminAuctionEnded(bot, adminTelegramId, auction).catch(err =>
      console.error(`[Auction] Notify failed for #${auction.id}:`, err.message)
    );
    if (auction.winner_user_id && auction.winner_bid) {
      await createAuctionWinClaim(auction).catch(err =>
        console.error(`[Auction] Failed to create win claim for #${auction.id}:`, err.message)
      );
    }
  }
}

// Creates a product + confirmed claim for the auction winner so they appear in /pending.
// Uses a negative synthetic telegram_message_id (-auction.id) to avoid clashing with
// real channel post IDs. Fully idempotent — safe to call multiple times.
async function createAuctionWinClaim(auction) {
  const syntheticMsgId = -auction.id; // negative = never a real Telegram message ID

  const client = await getClient();
  try {
    await client.query('BEGIN');

    // Upsert the product — if it already exists (re-run), just return it
    const { rows: [product] } = await client.query(
      `INSERT INTO products (telegram_message_id, name, price, quantity_total, quantity_remaining, status)
       VALUES ($1, $2, $3, 1, 0, 'sold_out')
       ON CONFLICT (telegram_message_id) DO UPDATE SET name = EXCLUDED.name
       RETURNING *`,
      [syntheticMsgId, `${auction.name} (Auction Win)`, auction.winner_bid]
    );

    // Upsert the claim — if it already exists, do nothing
    await client.query(
      `INSERT INTO claims (user_id, product_id, status)
       VALUES ($1, $2, 'confirmed')
       ON CONFLICT (user_id, product_id) DO NOTHING`,
      [auction.winner_user_id, product.id]
    );

    await client.query('COMMIT');
    console.log(`[Auction] Win claim created for auction #${auction.id}, user #${auction.winner_user_id}`);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(`[Auction] createAuctionWinClaim error for #${auction.id}:`, err.message);
    throw err;
  } finally {
    client.release();
  }
}

async function notifyAdminAuctionEnded(bot, adminTelegramId, auction) {
  // Build optional reply_to so the comment threads under the auction post
  const threadOpts = auction.discussion_message_id
    ? { reply_to_message_id: auction.discussion_message_id }
    : {};

  if (!auction.winner_user_id) {
    // Notify admin
    await bot.sendMessage(
      adminTelegramId,
      `🔔 Auction ended: *${auction.name}*\n\nNo bids were placed.`,
      { parse_mode: 'Markdown' }
    );
    // Post in comments under the auction
    if (process.env.COMMENT_GROUP_ID) {
      await bot.sendMessage(
        process.env.COMMENT_GROUP_ID,
        `🔒 *Auction Closed: ${auction.name}*\n\nNo bids were placed. This auction has ended.`,
        { parse_mode: 'Markdown', ...threadOpts }
      ).catch(err => console.error(`[Auction] Failed to post no-bids comment for #${auction.id}:`, err.message));
    }
    return;
  }

  const { rows } = await query('SELECT * FROM users WHERE id = $1', [auction.winner_user_id]);
  const w = rows[0];
  const handle = w
    ? (w.username ? `@${w.username}` : (w.first_name || `ID:${w.telegram_id}`))
    : 'Unknown';

  // Notify admin
  await bot.sendMessage(
    adminTelegramId,
    `🏆 *Auction Ended: ${auction.name}*\n\n` +
    `Winner: ${handle}\n` +
    `Winning bid: *$${parseFloat(auction.winner_bid).toFixed(2)}*\n\n` +
    `Use \`/invoice ${handle}\` to generate their invoice.`,
    { parse_mode: 'Markdown' }
  );

  // Post winner announcement in comments under the auction
  if (process.env.COMMENT_GROUP_ID) {
    await bot.sendMessage(
      process.env.COMMENT_GROUP_ID,
      `🏆 *Auction Ended!*\n\n` +
      `Winner: ${handle}\n` +
      `Winning bid: *$${parseFloat(auction.winner_bid).toFixed(2)}*\n\n` +
      `Congratulations! 🎉 The seller will be in touch shortly.`,
      { parse_mode: 'Markdown', ...threadOpts }
    ).catch(err => console.error(`[Auction] Failed to post winner comment for #${auction.id}:`, err.message));
  }
}
