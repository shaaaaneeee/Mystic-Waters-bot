// src/handlers/claimHandler.js
import { query } from '../../config/database.js';
import { ProductModel } from '../models/product.js';
import { attemptClaim } from '../services/stockService.js';
import { handleBid } from './auctionHandler.js';
import { Markup } from 'telegraf';

const MAX_RETRIES    = 3;
const RETRY_DELAY_MS = 400;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

export async function handleClaim(ctx) {
  const text          = ctx.message?.text?.trim() || '';
  const channelPostId = ctx.channelPostId;

  // Route via post_registry
  const { rows: regRows } = await query(
    'SELECT post_type FROM post_registry WHERE telegram_message_id = $1',
    [channelPostId]
  );
  const postType = regRows[0]?.post_type;

  if (postType === 'auction') {
    if (/^bid\s+\d+(?:\.\d{1,2})?$/i.test(text)) return handleBid(ctx);
    return; // non-bid message on auction post — ignore
  }

  // Fixed-price claim
  if (!text.toLowerCase().includes('claim')) return;

  const product = await ProductModel.findByMessageId(channelPostId);
  if (!product) return;

  if (product.status === 'sold_out') {
    return ctx.reply(soldOutMessage(product), { reply_to_message_id: ctx.message.message_id });
  }
  if (product.status === 'cancelled') {
    return ctx.reply('❌ This listing has been cancelled.', { reply_to_message_id: ctx.message.message_id });
  }

  let result = null;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    result = await attemptClaim({ telegramUser: ctx.from, product });
    if (result.reason !== 'busy') break;
    await sleep(RETRY_DELAY_MS);
  }

  if (!result || result.reason === 'busy') {
    return ctx.reply('⏳ Processing a lot of claims — please try again in a moment.', {
      reply_to_message_id: ctx.message.message_id,
    });
  }

  if (result.success) {
    const { product: updatedProduct } = result;
    const remaining = updatedProduct.quantity_remaining;
    return ctx.reply(
      [
        `✅ Claimed! *${product.name}* is yours, ${formatName(ctx.from)}.`,
        ``,
        `You'll hear from the seller soon.`,
        remaining > 0
          ? `_(${remaining} unit${remaining === 1 ? '' : 's'} remaining)_`
          : `_(Last one! 🎉)_`,
      ].join('\n'),
      { parse_mode: 'Markdown', reply_to_message_id: ctx.message.message_id }
    );
  }

  switch (result.reason) {
    case 'sold_out':
      return ctx.reply(soldOutMessage(product), { reply_to_message_id: ctx.message.message_id });
    case 'duplicate':
      return ctx.reply(
        `You've already claimed *${product.name}*! The seller will be in touch.`,
        { parse_mode: 'Markdown', reply_to_message_id: ctx.message.message_id }
      );
    default:
      console.error('[claimHandler] Unexpected result:', result);
      return ctx.reply('Something went wrong — please try again.', {
        reply_to_message_id: ctx.message.message_id,
      });
  }
}

function soldOutMessage(product) {
  return `🔴 *${product.name}* is sold out. Better luck next time!`;
}

function formatName(user) {
  return user.first_name ? `@${user.username || user.first_name}` : 'friend';
}
