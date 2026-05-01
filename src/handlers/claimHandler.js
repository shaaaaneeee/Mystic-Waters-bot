// src/handlers/claimHandler.js
/**
 * CLAIM HANDLER
 * ─────────────
 * Listens for text messages containing "claim" (case-insensitive)
 * in the linked comment group.
 *
 * Flow:
 *   1. commentOnly middleware confirms this is a comment on a channel post
 *      and sets ctx.channelPostId = the original post's message_id
 *   2. Look up the product by that message_id
 *   3. Attempt atomic claim via stockService
 *   4. Reply in the comment thread accordingly
 */

import { ProductModel } from '../models/product.js';
import { attemptClaim } from '../services/stockService.js';

// Retry config for "busy" (lock-contention) case
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 400;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export async function handleClaim(ctx) {
  const text = ctx.message?.text?.toLowerCase() || '';
  if (!text.includes('claim')) return; // not a claim message

  const channelPostId = ctx.channelPostId;
  const fromUser = ctx.from;

  // ── Find the product this post represents ────────────────────
  const product = await ProductModel.findByMessageId(channelPostId);

  if (!product) {
    // Silently ignore — comment on a non-product post
    return;
  }

  // Quick pre-check (non-atomic, just for fast UX)
  if (product.status === 'sold_out') {
    return ctx.reply(soldOutMessage(product), {
      reply_to_message_id: ctx.message.message_id,
    });
  }

  if (product.status === 'cancelled') {
    return ctx.reply('❌ This listing has been cancelled.', {
      reply_to_message_id: ctx.message.message_id,
    });
  }

  // ── Attempt the claim (with retry for lock contention) ───────
  let result = null;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    result = await attemptClaim({ telegramUser: fromUser, product });

    if (result.reason !== 'busy') break;
    await sleep(RETRY_DELAY_MS);
  }

  // ── Respond based on outcome ─────────────────────────────────
  if (!result || result.reason === 'busy') {
    return ctx.reply(
      '⏳ We\'re processing a lot of claims right now — please try again in a moment.',
      { reply_to_message_id: ctx.message.message_id }
    );
  }

  if (result.success) {
    const { product: updatedProduct } = result;
    const remaining = updatedProduct.quantity_remaining;

    const confirmMsg = [
      `✅ Claimed! *${product.name}* is yours, ${formatName(fromUser)}.`,
      ``,
      `You'll receive an invoice with payment details soon.`,
      remaining > 0
        ? `_(${remaining} unit${remaining === 1 ? '' : 's'} remaining)_`
        : `_(Last one! 🎉)_`,
    ].join('\n');

    return ctx.reply(confirmMsg, {
      parse_mode: 'Markdown',
      reply_to_message_id: ctx.message.message_id,
    });
  }

  // Not successful
  switch (result.reason) {
    case 'sold_out':
      return ctx.reply(soldOutMessage(product), {
        reply_to_message_id: ctx.message.message_id,
      });

    case 'duplicate':
      return ctx.reply(
        `You've already claimed *${product.name}*! We'll include it in your invoice.`,
        { parse_mode: 'Markdown', reply_to_message_id: ctx.message.message_id }
      );

    default:
      console.error('[claimHandler] Unexpected result:', result);
      return ctx.reply('Something went wrong — please try again.', {
        reply_to_message_id: ctx.message.message_id,
      });
  }
}

// ── Helpers ──────────────────────────────────────────────────────

function soldOutMessage(product) {
  return `🔴 *${product.name}* is sold out. Better luck next time!`;
}

function formatName(user) {
  return user.first_name
    ? `@${user.username || user.first_name}`
    : 'friend';
}
