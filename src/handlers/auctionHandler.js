// src/handlers/auctionHandler.js
import { AuctionModel } from '../models/auction.js';
import { placeBid } from '../modules/auction/auctionService.js';

const BID_REGEX    = /^(\d+(?:\.\d{1,2})?)$/;
const MAX_RETRIES  = 3;
const RETRY_DELAY  = 400;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

export async function handleBid(ctx) {
  const text  = ctx.message?.text?.trim() || '';
  const match = text.match(BID_REGEX);
  if (!match) return;

  const amount        = parseFloat(match[1]);
  const channelPostId = ctx.channelPostId;

  const auction = await AuctionModel.findByMessageId(channelPostId);
  if (!auction) return;

  if (auction.status !== 'active') {
    return ctx.reply(
      auction.status === 'ended'
        ? '🔒 This auction has ended.'
        : '⚠️ This auction is not currently active.',
      { reply_to_message_id: ctx.message.message_id }
    );
  }

  let result = null;
  for (let i = 0; i < MAX_RETRIES; i++) {
    result = await placeBid({ telegramUser: ctx.from, auction, amount });
    if (result.reason !== 'busy') break;
    await sleep(RETRY_DELAY);
  }

  if (!result || result.reason === 'busy') {
    return ctx.reply('⏳ High traffic — please try again in a moment.', {
      reply_to_message_id: ctx.message.message_id,
    });
  }

  if (result.success) {
    const { auction: updated } = result;
    const endStr = new Date(updated.end_time).toLocaleString('en-SG', {
      timeZone: 'Asia/Singapore', hour: '2-digit', minute: '2-digit',
    });
    return ctx.reply(
      `🏆 Bid of *$${amount.toFixed(2)}* accepted!\nYou're currently leading. Closes at ${endStr} SGT.`,
      { parse_mode: 'Markdown', reply_to_message_id: ctx.message.message_id }
    );
  }

  if (result.reason === 'invalid_bid') {
    return ctx.reply(
      `❌ Minimum bid is *$${result.minRequired.toFixed(2)}*. Try again.`,
      { parse_mode: 'Markdown', reply_to_message_id: ctx.message.message_id }
    );
  }
}
