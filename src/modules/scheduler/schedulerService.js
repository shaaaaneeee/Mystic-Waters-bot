// src/modules/scheduler/schedulerService.js
import cron from 'node-cron';
import { query } from '../../../config/database.js';
import { ScheduledPostModel } from '../../models/scheduledPost.js';
import { ProductModel } from '../../models/product.js';
import { AuctionModel } from '../../models/auction.js';

const RATE_DELAY_MS = 150;

function buildPostContent(post) {
  if (post.type === 'free_form') return post.content || '';

  if (post.type === 'product_listing') {
    const priceStr = `$${parseFloat(post.product_price).toFixed(2)}`;
    const lines = [
      `📦 *${post.product_name}*`,
      '',
      post.product_description || null,
      post.product_description ? '' : null,
      `${priceStr} · ${post.product_quantity} unit(s)`,
      '',
      'Comment `claim` below to reserve yours!',
    ];
    return lines.filter(l => l !== null).join('\n').replace(/\n{3,}/g, '\n\n').trim();
  }

  if (post.type === 'auction_listing') {
    const endStr = new Date(post.auction_end_time).toLocaleString('en-SG', {
      timeZone: 'Asia/Singapore',
      day: '2-digit', month: '2-digit', year: 'numeric',
      hour: '2-digit', minute: '2-digit',
    });
    const lines = [
      `🔨 *Auction: ${post.auction_name}*`,
      '',
      post.auction_description || null,
      post.auction_description ? '' : null,
      `Starting bid: $${parseFloat(post.auction_starting_bid).toFixed(2)}`,
      `Min increment: $${parseFloat(post.auction_min_increment).toFixed(2)}`,
      `Ends: ${endStr} SGT`,
      '',
      'Comment `bid [amount]` to place a bid!',
    ];
    return lines.filter(l => l !== null).join('\n').replace(/\n{3,}/g, '\n\n').trim();
  }

  return '';
}

const activeTimeouts = new Map();

export function schedulePost(bot, post) {
  const msUntilPost = new Date(post.scheduled_at) - Date.now();
  if (msUntilPost <= 0) {
    firePost(bot, post);
    return;
  }
  const handle = setTimeout(() => firePost(bot, post), msUntilPost);
  activeTimeouts.set(post.id, handle);
}

export function cancelScheduledPost(postId) {
  const handle = activeTimeouts.get(postId);
  if (handle) {
    clearTimeout(handle);
    activeTimeouts.delete(postId);
  }
}

async function firePost(bot, post) {
  activeTimeouts.delete(post.id);
  const content = buildPostContent(post);

  let sentMsgId = null;
  try {
    let sentMsg;
    if (post.image_file_id) {
      sentMsg = await bot.telegram.sendPhoto(
        process.env.CHANNEL_ID,
        post.image_file_id,
        { caption: content, parse_mode: 'Markdown' }
      );
    } else {
      sentMsg = await bot.telegram.sendMessage(
        process.env.CHANNEL_ID,
        content,
        { parse_mode: 'Markdown' }
      );
    }
    sentMsgId = sentMsg.message_id;
    console.log(`[Scheduler] Sent post #${post.id} (${post.type}) → channel msg ${sentMsgId}`);
  } catch (err) {
    console.error(`[Scheduler] Failed post #${post.id}:`, err.message);
    await ScheduledPostModel.markFailed(post.id, err.message);
    return;
  }

  await ScheduledPostModel.markSent(post.id, sentMsgId);

  // Auto-register the channel post so claims/bids/invoices can reference it
  if (post.type === 'product_listing') {
    try {
      const product = await ProductModel.create({
        telegramMessageId: sentMsgId,
        name: post.product_name,
        price: post.product_price,
        quantity: post.product_quantity,
      });
      await query(
        `INSERT INTO post_registry (telegram_message_id, post_type, ref_id)
         VALUES ($1, 'product', $2) ON CONFLICT DO NOTHING`,
        [sentMsgId, product.id]
      );
      console.log(`[Scheduler] Registered product #${product.id} for channel msg ${sentMsgId}`);
    } catch (err) {
      console.error(`[Scheduler] Product registration failed for post #${post.id}:`, err.message);
    }
  } else if (post.type === 'auction_listing') {
    try {
      // AuctionModel.create inserts into post_registry atomically
      const auction = await AuctionModel.create({
        telegramMessageId: sentMsgId,
        name: post.auction_name,
        description: post.auction_description,
        startingBid: post.auction_starting_bid,
        minIncrement: post.auction_min_increment,
        endTime: post.auction_end_time,
        createdBy: post.created_by,
      });
      console.log(`[Scheduler] Registered auction #${auction.id} for channel msg ${sentMsgId}`);
    } catch (err) {
      console.error(`[Scheduler] Auction registration failed for post #${post.id}:`, err.message);
    }
  }
}

export async function init(bot) {
  const pending = await ScheduledPostModel.listPending();
  console.log(`[Scheduler] Rehydrating ${pending.length} pending post(s)`);

  for (const post of pending) {
    schedulePost(bot, post);
    await new Promise(r => setTimeout(r, RATE_DELAY_MS));
  }

  const adminId = parseInt((process.env.ADMIN_IDS || '').split(',')[0], 10);

  cron.schedule('* * * * *', async () => {
    try {
      const { runAuctionLifecycle } = await import('../auction/auctionService.js');
      await runAuctionLifecycle(bot.telegram, adminId);
    } catch (err) {
      console.error('[Cron] Auction lifecycle errors:', err.message);
    }
  });

  console.log('[Scheduler] Cron started');
}
