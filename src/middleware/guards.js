// src/middleware/guards.js
import 'dotenv/config';
import { UserModel } from '../models/user.js';

const ADMIN_IDS = new Set(
  (process.env.ADMIN_IDS || '').split(',').map(id => parseInt(id.trim(), 10)).filter(Boolean)
);

const COMMENT_GROUP_ID = parseInt(process.env.COMMENT_GROUP_ID, 10);

export function isAdmin(userId) {
  return ADMIN_IDS.has(userId);
}

export function adminOnly(ctx, next) {
  if (!ADMIN_IDS.has(ctx.from?.id)) return ctx.reply('⛔ Admin only.');
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

// Gate: user must be registered before claiming or bidding.
// Upserts the user row so we always have a record, then checks registration_status.
export async function registrationRequired(ctx, next) {
  const from = ctx.from;
  if (!from) return;

  const user = await UserModel.upsertAndGetStatus({
    telegramId: from.id,
    username: from.username,
    firstName: from.first_name,
    lastName: from.last_name,
  });

  if (user.registration_status === 'registered') {
    ctx.dbUser = user;
    return next();
  }

  const botUsername = ctx.botInfo?.username;
  const link = botUsername
    ? `https://t.me/${botUsername}?start=register`
    : 'the bot DM';

  return ctx.reply(
    `👋 To participate, please register first → ${link}\n\nIt takes 10 seconds.`,
    { reply_to_message_id: ctx.message?.message_id }
  );
}
