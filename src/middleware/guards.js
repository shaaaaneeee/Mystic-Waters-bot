// src/middleware/guards.js
import 'dotenv/config';

const ADMIN_IDS = new Set(
  (process.env.ADMIN_IDS || '').split(',').map(id => parseInt(id.trim(), 10)).filter(Boolean)
);

const COMMENT_GROUP_ID = parseInt(process.env.COMMENT_GROUP_ID, 10);

export function adminOnly(ctx, next) {
  if (!ADMIN_IDS.has(ctx.from?.id)) {
    return ctx.reply('⛔ Admin only.');
  }
  return next();
}

export function commentOnly(ctx, next) {
  const msg = ctx.message;
  if (!msg) return;
  if (msg.chat.id !== COMMENT_GROUP_ID) return;
  if (!msg.reply_to_message) return;

  const fwd = msg.reply_to_message.forward_from_message_id;
  const fwdChat = msg.reply_to_message.forward_from_chat?.id
               || msg.reply_to_message.sender_chat?.id;

  if (!fwd || String(fwdChat) !== String(process.env.CHANNEL_ID)) return;

  ctx.channelPostId = fwd;
  return next();
}
