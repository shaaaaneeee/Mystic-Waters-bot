// src/modules/scheduler/schedulerService.js
import cron from 'node-cron';
import { ScheduledPostModel } from '../../models/scheduledPost.js';

const RATE_DELAY_MS = 150; // buffer between sends to respect Telegram rate limits

function buildPostContent(post) {
  if (post.type === 'free_form') return post.content;
  if (post.type === 'product_listing') {
    return `📦 *${post.product_name}*\n\nComment \`claim\` below to reserve yours!`;
  }
  if (post.type === 'auction_listing') {
    return `🔨 *Auction: ${post.auction_name}*\n\nComment \`bid [amount]\` to place a bid!`;
  }
  return post.content || '';
}

const activeTimeouts = new Map(); // postId → timeoutHandle

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

  try {
    await bot.telegram.sendMessage(process.env.CHANNEL_ID, content, { parse_mode: 'Markdown' });
    await ScheduledPostModel.markSent(post.id);
    console.log(`[Scheduler] Sent post #${post.id} (${post.type})`);
  } catch (err) {
    console.error(`[Scheduler] Failed post #${post.id}:`, err.message);
    await ScheduledPostModel.markFailed(post.id, err.message);
  }
}

// Called at boot: loads pending posts from DB, schedules them, starts auction lifecycle cron
export async function init(bot) {
  const pending = await ScheduledPostModel.listPending();
  console.log(`[Scheduler] Rehydrating ${pending.length} pending post(s)`);

  for (const post of pending) {
    schedulePost(bot, post);
    await new Promise(r => setTimeout(r, RATE_DELAY_MS));
  }

  // Auction lifecycle: activate upcoming + end overdue, every 60s
  const adminId = parseInt((process.env.ADMIN_IDS || '').split(',')[0], 10);

  cron.schedule('* * * * *', async () => {
    try {
      const { runAuctionLifecycle } = await import('../auction/auctionService.js');
      await runAuctionLifecycle(bot.telegram, adminId);
    } catch (err) {
      console.error('[Cron] Auction lifecycle error:', err.message);
    }
  });

  console.log('[Scheduler] Cron started');
}
