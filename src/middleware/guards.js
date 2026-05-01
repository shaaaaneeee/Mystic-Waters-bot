// src/middleware/guards.js
import 'dotenv/config';

const ADMIN_IDS = new Set(
  (process.env.ADMIN_IDS || '').split(',').map(id => parseInt(id.trim(), 10)).filter(Boolean)
);

const COMMENT_GROUP_ID = parseInt(process.env.COMMENT_GROUP_ID, 10);

/**
 * Middleware: only allow admins through.
 * Use on admin-only command handlers.
 */
export function adminOnly(ctx, next) {
  console.log('[adminOnly] from.id:', ctx.from?.id, 'type:', typeof ctx.from?.id);
  console.log('[adminOnly] ADMIN_IDS:', process.env.ADMIN_IDS);
  console.log('[adminOnly] has access:', ADMIN_IDS.has(ctx.from?.id));
  if (!ADMIN_IDS.has(ctx.from?.id)) {
    return ctx.reply('⛔ Admin only.');
  }
  return next();
}

/**
 * Middleware: ensure message is in the linked comment group
 * and is a reply to a channel post.
 *
 * Telegram comment threading works like this:
 *   - The channel has a linked discussion group.
 *   - When someone comments on a channel post, Telegram
 *     sends a message in that discussion group.
 *   - ctx.message.reply_to_message.forward_from_message_id
 *     is the original CHANNEL POST message ID.
 *   - ctx.message.reply_to_message.forward_from_chat.id
 *     is the channel ID.
 *
 * We validate both to avoid processing unrelated group messages.
 */
export function commentOnly(ctx, next) {
  const msg = ctx.message;
  if (!msg) return; // not a message update

  // Must be in the comment group
  if (msg.chat.id !== COMMENT_GROUP_ID) return;

  // Must be a reply (comments are always replies to the forwarded post)
  if (!msg.reply_to_message) return;

  // Extract channel post ID from the forwarded header
  const fwd = msg.reply_to_message.forward_from_message_id;
  const fwdChat = msg.reply_to_message.forward_from_chat?.id
               || msg.reply_to_message.sender_chat?.id;

  if (!fwd || String(fwdChat) !== String(process.env.CHANNEL_ID)) return;

  // Attach for use in handlers
  ctx.channelPostId = fwd;

  return next();
}
