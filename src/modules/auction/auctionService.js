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
  for (const auction of ended) {
    await notifyAdminAuctionEnded(bot, adminTelegramId, auction).catch(err =>
      console.error(`[Auction] Notify failed for #${auction.id}:`, err.message)
    );
  }
}

async function notifyAdminAuctionEnded(bot, adminTelegramId, auction) {
  if (!auction.winner_user_id) {
    await bot.sendMessage(
      adminTelegramId,
      `🔔 Auction ended: *${auction.name}*\n\nNo bids were placed.`,
      { parse_mode: 'Markdown' }
    );
    return;
  }

  const { rows } = await query('SELECT * FROM users WHERE id = $1', [auction.winner_user_id]);
  const w = rows[0];
  const handle = w
    ? (w.username ? `@${w.username}` : (w.first_name || `ID:${w.telegram_id}`))
    : 'Unknown';

  await bot.sendMessage(
    adminTelegramId,
    `🏆 *Auction Ended: ${auction.name}*\n\n` +
    `Winner: ${handle}\n` +
    `Winning bid: *$${parseFloat(auction.winner_bid).toFixed(2)}*\n\n` +
    `Use \`/invoice ${handle}\` to generate their invoice.`,
    { parse_mode: 'Markdown' }
  );
}
